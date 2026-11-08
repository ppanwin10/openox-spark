import re

import numpy as np
import torch
from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration

RATE = 16000
CHUNK_SECONDS = 30
SEARCH_SECONDS = 5
MIN_SECONDS = 0.5
BATCH = 4
TOKENS_PER_SECOND = 10
TAG = re.compile(r"^\s*language\s+\S*\s*<asr_text>", re.IGNORECASE)
WIDE = re.compile(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")


class Model:
    def __init__(self, path: str):
        self.processor = AutoProcessor.from_pretrained(path)
        self.network = Qwen3ASRForConditionalGeneration.from_pretrained(
            path, dtype=torch.bfloat16, device_map="cuda"
        ).eval()


def load(options: dict) -> Model:
    return Model(options["path"])


def pieces(audio: np.ndarray) -> list[np.ndarray]:
    limit = CHUNK_SECONDS * RATE
    search = SEARCH_SECONDS * RATE
    window = RATE // 10
    result = []
    start = 0
    while audio.size - start > limit:
        low = start + limit - search
        energy = np.convolve(np.abs(audio[low : start + limit]), np.ones(window, dtype=np.float32), mode="valid")
        cut = low + int(np.argmin(energy)) + window // 2
        result.append(audio[start:cut])
        start = cut
    result.append(audio[start:])
    minimum = int(MIN_SECONDS * RATE)
    return [np.pad(piece, (0, max(0, minimum - piece.size))) for piece in result]


def join(parts: list[str]) -> str:
    text = ""
    for part in parts:
        if not part:
            continue
        if text and not text[-1].isspace() and not WIDE.match(text[-1]) and not WIDE.match(part[0]):
            text += " "
        text += part
    return text


def run(model: Model, request: dict) -> dict:
    audio = np.frombuffer(request["pcm"], dtype=np.int16).astype(np.float32) / 32768.0
    language = request.get("language")
    prompt = request.get("prompt")
    texts: list[str] = []
    detected: dict[str, int] = {}
    chunks = pieces(audio)
    for first in range(0, len(chunks), BATCH):
        batch = chunks[first : first + BATCH]
        inputs = model.processor.apply_transcription_request(
            audio=batch, language=language, prompt=[prompt] * len(batch) if prompt else None
        ).to(model.network.device, model.network.dtype)
        budget = int(max(piece.size for piece in batch) / RATE * TOKENS_PER_SECOND) + 64
        with torch.inference_mode():
            output = model.network.generate(**inputs, max_new_tokens=budget, do_sample=False)
        generated = output[:, inputs["input_ids"].shape[1] :]
        for piece, parsed in zip(batch, model.processor.decode(generated, return_format="parsed")):
            texts.append(TAG.sub("", parsed["transcription"] or "").strip())
            if parsed["language"]:
                detected[parsed["language"]] = detected.get(parsed["language"], 0) + piece.size
    spoken = language or (max(detected, key=detected.get) if detected else None)
    return {"text": join(texts), "language": spoken}
