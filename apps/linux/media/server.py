import asyncio
import base64
import contextlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel
from starlette.exceptions import HTTPException

import media
import memory
import models
from engine import Capability, Engine, ServiceError, event

os.environ.setdefault("HF_HOME", str(models.home() / "hf"))
logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
log = logging.getLogger("openox.media")

MIB = 1024**2
MAX_UPLOAD = int(float(os.environ.get("OPENOX_MEDIA_MAX_UPLOAD_MB") or 200) * MIB)
MAX_AUDIO_SECONDS = float(os.environ.get("OPENOX_MEDIA_MAX_AUDIO_SECONDS") or 7200)
MAX_SPEECH_CHARACTERS = 2000
MAX_PROMPT_CHARACTERS = 4000
MAX_FRAMES = 64
IMAGE_SIDES = range(512, 1537, 64)
TEMPORARY = Path(os.environ.get("OPENOX_MEDIA_TMP") or Path.home() / ".cache/openox-media/tmp")
AUDIO_TYPES = {"wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac", "pcm": "audio/pcm"}
VOICE_IDS = {voice.id for voice in models.VOICES}
STARTED = int(time.time())
MEDIA_SUFFIXES = {
    ".3g2", ".3gp", ".aac", ".aif", ".aiff", ".amr", ".avi", ".caf", ".flac", ".flv", ".gif", ".heic", ".jpeg", ".jpg",
    ".m2ts", ".m4a", ".m4v", ".mka", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg", ".mpg", ".mts", ".oga", ".ogg", ".ogv",
    ".opus", ".png", ".ts", ".wav", ".weba", ".webm", ".webp", ".wma", ".wmv",
}


def seconds(name: str, default: float) -> float:
    return float(os.environ.get(name) or default)


def capabilities() -> list[Capability]:
    main = Path(sys.executable)
    speech = Path(os.environ.get("OPENOX_MEDIA_SPEECH_PYTHON") or models.home() / "venv-tts/bin/python")
    return [
        Capability(
            "transcription",
            models.TRANSCRIPTION,
            main,
            memory.gib("OPENOX_MEDIA_TRANSCRIPTION_PEAK_GIB", 4.5),
            seconds("OPENOX_MEDIA_TRANSCRIPTION_IDLE_SECONDS", 1800),
            300,
        ),
        Capability(
            "speech",
            models.SPEECH,
            speech,
            memory.gib("OPENOX_MEDIA_SPEECH_PEAK_GIB", 5.5),
            seconds("OPENOX_MEDIA_SPEECH_IDLE_SECONDS", 600),
            300,
        ),
        Capability(
            "image",
            models.IMAGE,
            main,
            memory.gib("OPENOX_MEDIA_IMAGE_PEAK_GIB", 10),
            seconds("OPENOX_MEDIA_IMAGE_IDLE_SECONDS", 0),
            3600,
        ),
    ]


def failure(status: int, kind: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": kind}}, status_code=status)


def invalid(message: str) -> ServiceError:
    return ServiceError(400, "invalid_request_error", message)


def access_token() -> str:
    path = models.home() / "token"
    with contextlib.suppress(FileNotFoundError):
        if token := path.read_text().strip():
            return token
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = secrets.token_urlsafe(32)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
        handle.write(token + "\n")
    path.chmod(0o600)
    return token


class Authorized:
    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or (scope["method"] == "GET" and scope["path"] == "/health"):
            return await self.app(scope, receive, send)
        if hmac.compare_digest(dict(scope["headers"]).get(b"authorization", b""), self.expected):
            return await self.app(scope, receive, send)
        body = json.dumps({"error": {"message": "The media service token is missing or wrong", "type": "unauthorized"}}).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        await send({"type": "http.response.start", "status": 401, "headers": headers})
        await send({"type": "http.response.body", "body": body})


class BodyLimit:
    def __init__(self, app, limit: int):
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = dict(scope["headers"]).get(b"content-length", b"")
        if length.isdigit() and int(length) > self.limit:
            return await self.reject(send)
        received = 0
        exceeded = False
        started = False

        async def limited():
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit:
                    exceeded = True
                    raise ServiceError(413, "request_too_large", self.message())
            return message

        async def guarded(message):
            nonlocal started
            if exceeded:
                return
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, limited, guarded)
        except ServiceError:
            if not exceeded:
                raise
        if exceeded and not started:
            await self.reject(send)

    def message(self) -> str:
        return f"The upload is larger than {MAX_UPLOAD // MIB} MB"

    async def reject(self, send) -> None:
        body = json.dumps({"error": {"message": self.message(), "type": "request_too_large"}}).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        await send({"type": "http.response.start", "status": 413, "headers": headers})
        await send({"type": "http.response.body", "body": body})


@contextlib.asynccontextmanager
async def lifespan(application: FastAPI):
    TEMPORARY.mkdir(parents=True, exist_ok=True, mode=0o700)
    for leftover in TEMPORARY.iterdir():
        if leftover.is_file():
            leftover.unlink()
    tempfile.tempdir = str(TEMPORARY)
    await application.state.engine.start()
    event("started", memAvailableBytes=memory.available(), reserveBytes=memory.margin(), floorBytes=memory.floor())
    yield
    await application.state.engine.close()


app = FastAPI(title="OpenOx media", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.state.engine = Engine(capabilities())
app.add_middleware(BodyLimit, limit=MAX_UPLOAD + MIB)
app.add_middleware(Authorized, token=access_token())


@app.exception_handler(ServiceError)
async def service_error(request, error: ServiceError):
    return failure(error.status, error.kind, error.message)


@app.exception_handler(media.MediaError)
async def media_error(request, error: media.MediaError):
    return failure(400, "invalid_request_error", str(error))


@app.exception_handler(RequestValidationError)
async def validation_error(request, error: RequestValidationError):
    details = [f"{'.'.join(str(part) for part in item['loc'][1:]) or 'body'}: {item['msg']}" for item in error.errors()]
    return failure(400, "invalid_request_error", "; ".join(details) or "Invalid request")


@app.exception_handler(HTTPException)
async def http_error(request, error: HTTPException):
    kind = "invalid_request_error" if error.status_code < 500 else "server_error"
    return failure(error.status_code, kind, str(error.detail))


@app.exception_handler(Exception)
async def unexpected_error(request, error: Exception):
    log.exception("Unhandled error")
    return failure(500, "server_error", "Internal error")


@contextlib.asynccontextmanager
async def stored(upload: UploadFile):
    suffix = Path(upload.filename or "").suffix.lower()
    descriptor, name = tempfile.mkstemp(dir=TEMPORARY, suffix=suffix if suffix in MEDIA_SUFFIXES else "")
    path = Path(name)
    try:
        size = 0
        with os.fdopen(descriptor, "wb") as target:
            while chunk := await upload.read(MIB):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise ServiceError(413, "request_too_large", f"The file is larger than {MAX_UPLOAD // MIB} MB")
                target.write(chunk)
        if size == 0:
            raise invalid("The file is empty")
        yield path
    finally:
        path.unlink(missing_ok=True)
        await upload.close()


def transcription_language(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    key = value.strip().lower().replace("_", "-")
    names = {name.lower(): name for name in models.TRANSCRIPTION_LANGUAGES.values()}
    found = models.TRANSCRIPTION_LANGUAGES.get(key) or models.TRANSCRIPTION_LANGUAGES.get(key.split("-")[0])
    if found or key in names:
        return found or names[key]
    raise invalid(f"Unsupported language {value!r}")


async def transcribe(path: Path, found: media.Probe, language: str | None = None, prompt: str | None = None) -> dict:
    if not found.audio:
        raise invalid("The file has no audio track")
    if found.duration and found.duration > MAX_AUDIO_SECONDS + 1:
        raise invalid(f"The audio is longer than {MAX_AUDIO_SECONDS / 60:.0f} minutes")
    samples = await asyncio.to_thread(media.pcm, path, 16000, MAX_AUDIO_SECONDS)
    duration = len(samples) / 32000
    if duration > MAX_AUDIO_SECONDS:
        raise invalid(f"The audio is longer than {MAX_AUDIO_SECONDS / 60:.0f} minutes")
    result = await app.state.engine.run(
        "transcription", {"pcm": samples, "language": language, "prompt": prompt}, 120 + duration
    )
    spoken = result["language"]
    return {"text": result["text"], "language": spoken.lower() if spoken else None, "duration": round(duration, 3)}


@app.get("/health")
async def health():
    return app.state.engine.health()


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": slot.capability.repo.id,
                "object": "model",
                "created": STARTED,
                "owned_by": "openox-media",
                "capability": slot.capability.id,
            }
            for slot in app.state.engine.slots.values()
        ],
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    response_format: str = Form("json"),
):
    if response_format not in ("json", "verbose_json", "text"):
        raise invalid("response_format must be json, verbose_json or text")
    name = transcription_language(language)
    async with stored(file) as path:
        found = await asyncio.to_thread(media.probe, path)
        result = await transcribe(path, found, name, (prompt or "").strip() or None)
    if response_format == "text":
        return PlainTextResponse(result["text"])
    return result


class SpeechRequest(BaseModel):
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float | None = None


def text_language(text: str) -> str:
    kana = len(re.findall(r"[\u3040-\u30ff]", text))
    hangul = len(re.findall(r"[\u1100-\u11ff\uac00-\ud7af]", text))
    han = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", text))
    cyrillic = len(re.findall(r"[\u0400-\u04ff]", text))
    latin = len(re.findall(r"[A-Za-z\u00c0-\u024f]", text))
    if kana and kana * 4 >= han:
        return "ja"
    if hangul and hangul >= han:
        return "ko"
    if han:
        return "zh"
    if cyrillic > latin:
        return "ru"
    if re.search(r"[\u00c0-\u024f]", text):
        return "auto"
    return "en"


def speech_voice(requested: str | None, language: str) -> str:
    key = (requested or "").strip().lower()
    if key in ("", "auto"):
        return models.DEFAULT_VOICES.get(language, models.DEFAULT_VOICES["en"])
    if key in VOICE_IDS:
        return key
    raise invalid(f"Unknown voice {requested!r}; use one of {', '.join(sorted(VOICE_IDS))}")


@app.get("/v1/audio/voices")
async def voices():
    return {
        "object": "list",
        "data": [
            {
                "id": voice.id,
                "language": voice.language,
                "description": voice.description,
                "default": models.DEFAULT_VOICES.get(voice.language) == voice.id,
            }
            for voice in models.VOICES
        ],
    }


@app.post("/v1/audio/speech")
async def speech(body: SpeechRequest):
    text = re.sub(r"[ \t\r\f\v]+", " ", body.input).strip()
    if not text:
        raise invalid("input is empty")
    if len(text) > MAX_SPEECH_CHARACTERS:
        raise invalid(f"input is longer than {MAX_SPEECH_CHARACTERS} characters")
    kind = body.response_format.lower()
    if kind not in AUDIO_TYPES:
        raise invalid(f"response_format must be one of {', '.join(AUDIO_TYPES)}")
    if body.speed is not None and abs(body.speed - 1) > 1e-6:
        raise invalid("speed is not supported; omit it or use 1.0")
    language = text_language(text)
    voice = speech_voice(body.voice, language)
    result = await app.state.engine.run(
        "speech", {"text": text, "voice": voice, "language": models.SPEECH_LANGUAGES[language]}, 120 + len(text)
    )
    audio = await asyncio.to_thread(media.encode, result["pcm"], result["rate"], kind)
    return Response(audio, media_type=AUDIO_TYPES[kind], headers={"X-Voice": voice, "X-Sample-Rate": str(result["rate"])})


class ImageRequest(BaseModel):
    prompt: str
    size: str = "1024x1024"
    n: int = 1
    response_format: str = "b64_json"
    seed: int | None = None


def image_size(value: str) -> tuple[int, int]:
    if value == "auto":
        return 1024, 1024
    match = re.fullmatch(r"(\d+)x(\d+)", value.strip())
    if match is None or int(match.group(1)) not in IMAGE_SIDES or int(match.group(2)) not in IMAGE_SIDES:
        raise invalid("size must be WIDTHxHEIGHT with each side from 512 to 1536 in steps of 64")
    return int(match.group(1)), int(match.group(2))


@app.post("/v1/images/generations")
async def images(body: ImageRequest):
    prompt = body.prompt.strip()
    if not prompt:
        raise invalid("prompt is empty")
    if len(prompt) > MAX_PROMPT_CHARACTERS:
        raise invalid(f"prompt is longer than {MAX_PROMPT_CHARACTERS} characters")
    if body.n != 1:
        raise invalid("n must be 1")
    if body.response_format != "b64_json":
        raise invalid("response_format must be b64_json")
    width, height = image_size(body.size)
    seed = secrets.randbelow(2**31) if body.seed is None else body.seed
    if not 0 <= seed < 2**63:
        raise invalid("seed must be between 0 and 2^63 - 1")
    result = await app.state.engine.run(
        "image", {"prompt": prompt, "width": width, "height": height, "seed": seed}, 900
    )
    return {"created": int(time.time()), "data": [{"b64_json": base64.b64encode(result["png"]).decode("ascii"), "seed": seed}]}


@app.post("/v1/media/extract")
async def extract(file: UploadFile = File(...), max_frames: int = Form(12), transcribe_audio: bool = Form(True, alias="transcribe")):
    if not 1 <= max_frames <= MAX_FRAMES:
        raise invalid(f"max_frames must be between 1 and {MAX_FRAMES}")
    async with stored(file) as path:
        found = await asyncio.to_thread(media.probe, path)
        if found.still:
            raise invalid("The file is a still image; send images to the model directly")
        if found.video is not None:
            duration = found.duration or await asyncio.to_thread(media.measure, path, "v:0")
            frames = await asyncio.to_thread(media.frames, path, duration, max_frames, found.video.fps)
            transcript = (await transcribe(path, found))["text"] if transcribe_audio and found.audio else None
            return {
                "kind": "video",
                "duration": round(duration, 3),
                "width": found.video.width,
                "height": found.video.height,
                "frames": frames,
                "transcript": transcript,
            }
        if found.audio:
            result = await transcribe(path, found) if transcribe_audio else None
            duration = found.duration or (result["duration"] if result else await asyncio.to_thread(media.measure, path, "a:0"))
            return {"kind": "audio", "duration": round(duration, 3), "transcript": result["text"] if result else None}
        raise invalid("The file has no audio or video stream")
