import re

import numpy as np
import torch
from qwen_tts import Qwen3TTSModel

LIMIT = 60
BATCH = 8
SENTENCE_END = re.compile(r"[。！？!?；;…\n.]['\"”’）)\]]*$")
CLAUSE_END = re.compile(r"[，,、：:]['\"”’）)\]]*$")
WIDE = re.compile(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")
BREAKS = (
    re.compile(r"(?<=[。！？!?；;…\n])|(?<=[.!?;:]\s)"),
    re.compile(r"(?<=[，,、：:])"),
    re.compile(r"(?<=\s)"),
)


def load(options: dict) -> Qwen3TTSModel:
    return Qwen3TTSModel.from_pretrained(
        options["path"], device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa"
    )


def weight(text: str) -> int:
    return len(text) + len(WIDE.findall(text))


def pack(parts: list[str]) -> list[str]:
    pieces: list[str] = []
    for part in parts:
        if pieces and weight(pieces[-1]) + weight(part) <= LIMIT:
            pieces[-1] += part
        else:
            pieces.append(part)
    return pieces


def split(text: str) -> list[str]:
    if weight(text) <= LIMIT:
        return [text]
    for pattern in BREAKS:
        parts = [part for part in pattern.split(text) if part]
        if len(parts) > 1:
            return pack([piece for part in parts for piece in split(part)])
    middle = len(text) // 2
    return split(text[:middle]) + split(text[middle:])


def synthesize(model: Qwen3TTSModel, texts: list[str], voice: str, language: str) -> tuple[list[np.ndarray], int]:
    input_ids = model._tokenize_texts([model._build_assistant_text(text) for text in texts])
    options = model._merge_generate_kwargs(max_new_tokens=min(4096, 60 + 4 * max(weight(text) for text in texts)))
    codes, _ = model.model.generate(
        input_ids=input_ids,
        instruct_ids=[None] * len(texts),
        languages=[language] * len(texts),
        speakers=[voice] * len(texts),
        non_streaming_mode=True,
        **options,
    )
    waves, rate = [], 24000
    for code in codes:
        decoded, rate = model.model.speech_tokenizer.decode([{"audio_codes": code}])
        waves.append(np.asarray(decoded[0], dtype=np.float32).reshape(-1))
    return waves, rate


def pause(piece: str) -> float:
    if SENTENCE_END.search(piece):
        return 0.25
    if CLAUSE_END.search(piece):
        return 0.12
    return 0.03


def run(model: Qwen3TTSModel, request: dict) -> dict:
    pieces = [piece.strip() for piece in split(request["text"]) if piece.strip()]
    waves: list[np.ndarray] = []
    rate = 24000
    for first in range(0, len(pieces), BATCH):
        with torch.inference_mode():
            generated, rate = synthesize(model, pieces[first : first + BATCH], request["voice"], request["language"])
        waves += generated
    parts: list[np.ndarray] = []
    for index, wave in enumerate(waves):
        if index:
            parts.append(np.zeros(int(rate * pause(pieces[index - 1])), dtype=np.float32))
        parts.append(wave)
    samples = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return {"pcm": pcm, "rate": int(rate)}
