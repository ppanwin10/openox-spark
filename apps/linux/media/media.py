import base64
import functools
import io
import os
import re
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

LONG_SIDE = 1024
JPEG_QUALITY = 80
SCALE = f"scale='min({LONG_SIDE},iw)':'min({LONG_SIDE},ih)':force_original_aspect_ratio=decrease"
INPUT = re.compile(r"^Input #0, (.+?), from ", re.MULTILINE)
DURATION = re.compile(r"Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
STREAM = re.compile(r"^\s*Stream #0:\d+\S*: (\w+): (.*)$")
SIZE = re.compile(r", (\d{2,5})x(\d{2,5})(?=[ ,\[]|$)")
RATE = re.compile(r", (\d+(?:\.\d+)?) fps")
ROTATION = re.compile(r"rotation of (-?\d+(?:\.\d+)?) degrees|^\s*rotate\s*:\s*(-?\d+)", re.IGNORECASE | re.MULTILINE)
PROGRESS = re.compile(r"^out_time_us=(\d+)$", re.MULTILINE)
PLAYLISTS = {"hls", "applehttp", "dash", "concat", "ffconcat", "webm_dash_manifest", "imf", "mpjpeg"}
CODECS = {
    "mp3": ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"],
    "flac": ["-c:a", "flac", "-f", "flac"],
}


class MediaError(Exception):
    pass


@dataclass(frozen=True)
class Video:
    codec: str
    width: int
    height: int
    fps: float | None


@dataclass(frozen=True)
class Probe:
    container: str
    duration: float | None
    video: Video | None
    audio: bool

    @property
    def still(self) -> bool:
        return self.video is not None and (self.container == "image2" or self.container.endswith("_pipe"))


@functools.cache
def ffmpeg() -> str:
    if os.environ.get("OPENOX_MEDIA_FFMPEG"):
        return os.environ["OPENOX_MEDIA_FFMPEG"]
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def run(arguments: list[str], timeout: float, data: bytes | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run([ffmpeg(), "-nostdin", "-hide_banner", *arguments], input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise MediaError("Reading the file took too long") from error


def reason(result: subprocess.CompletedProcess) -> str:
    lines = [line.strip() for line in result.stderr.decode("utf-8", "replace").splitlines() if line.strip()]
    return lines[-1] if lines else f"ffmpeg exited with status {result.returncode}"


def streams(text: str) -> list[tuple[str, str, str]]:
    found: list[tuple[str, str, list[str]]] = []
    details: list[str] | None = None
    for line in text.splitlines():
        match = STREAM.match(line)
        if match:
            details = []
            found.append((match.group(1), match.group(2), details))
        elif details is not None and line.startswith("    "):
            details.append(line)
        else:
            details = None
    return [(kind, header, "\n".join(lines)) for kind, header, lines in found]


def video(header: str, details: str) -> Video | None:
    if "(attached pic)" in header:
        return None
    size = SIZE.search(header)
    if size is None:
        return None
    width, height = int(size.group(1)), int(size.group(2))
    rotation = ROTATION.search(details)
    if rotation and round(abs(float(rotation.group(1) or rotation.group(2)))) % 180 == 90:
        width, height = height, width
    rate = RATE.search(header)
    return Video(header.split()[0].strip(","), width, height, float(rate.group(1)) if rate else None)


def probe(path: Path) -> Probe:
    text = run(["-i", str(path)], 60).stderr.decode("utf-8", "replace")
    container = INPUT.search(text)
    if container is None or PLAYLISTS & set(container.group(1).split(",")):
        raise MediaError("The file is not a readable audio or video file")
    found = streams(text)
    videos = [video(header, details) for kind, header, details in found if kind == "Video"]
    first = next((item for item in videos if item is not None), None)
    duration = DURATION.search(text)
    seconds = int(duration.group(1)) * 3600 + int(duration.group(2)) * 60 + float(duration.group(3)) if duration else None
    return Probe(container.group(1), seconds, first, any(kind == "Audio" for kind, _, _ in found))


def measure(path: Path, stream: str) -> float:
    result = run(
        ["-v", "error", "-i", str(path), "-map", f"0:{stream}", "-c", "copy", "-f", "null", "-progress", "pipe:1", "-nostats", "-"],
        600,
    )
    values = PROGRESS.findall(result.stdout.decode("ascii", "replace"))
    if result.returncode != 0 or not values:
        raise MediaError(f"Could not read the media duration: {reason(result)}")
    return int(values[-1]) / 1e6


def pcm(path: Path, rate: int, limit: float) -> bytes:
    result = run(
        ["-v", "error", "-i", str(path), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(rate), "-t", f"{limit + 1:.0f}", "-f", "s16le", "-"],
        900,
    )
    if result.returncode != 0:
        raise MediaError(f"Could not decode the audio: {reason(result)}")
    return result.stdout


def frame(path: Path, at: float, fast: bool) -> bytes | None:
    seek = ["-ss", f"{at:.3f}"]
    source = [*seek, "-i", str(path)] if fast else ["-i", str(path), *seek]
    output = ["-map", "0:v:0", "-frames:v", "1", "-vf", SCALE, "-f", "image2pipe", "-c:v", "ppm", "-"]
    result = run(["-v", "error", "-threads", "4", *source, *output], 120 if fast else 600)
    if result.returncode != 0 or not result.stdout:
        return None
    with Image.open(io.BytesIO(result.stdout)) as picture:
        buffer = io.BytesIO()
        picture.convert("RGB").save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue()


def frames(path: Path, duration: float, count: int, fps: float | None) -> list[dict]:
    if fps:
        count = min(count, max(1, int(duration * fps)))
    times = [duration * (index + 0.5) / count for index in range(count)]
    pictures = []
    for at in times:
        picture = frame(path, at, True) or frame(path, at, False)
        if picture is not None:
            pictures.append({"time": round(at, 3), "jpeg_b64": base64.b64encode(picture).decode("ascii")})
    if not pictures:
        raise MediaError("Could not decode any video frame")
    return pictures


def encode(samples: bytes, rate: int, kind: str) -> bytes:
    if kind == "pcm":
        return samples
    if kind == "wav":
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(samples)
        return buffer.getvalue()
    result = run(["-v", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0", *CODECS[kind], "pipe:1"], 300, samples)
    if result.returncode != 0:
        raise RuntimeError(f"Could not encode {kind}: {reason(result)}")
    return result.stdout
