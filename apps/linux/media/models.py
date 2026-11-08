import json
import os
from dataclasses import dataclass
from pathlib import Path

GIB = 1024**3


@dataclass(frozen=True)
class Repo:
    id: str
    patterns: tuple[str, ...] | None
    files: tuple[str, ...]
    indexes: tuple[str, ...] = ()


@dataclass(frozen=True)
class Voice:
    id: str
    language: str
    description: str


TRANSCRIPTION = Repo(
    "Qwen/Qwen3-ASR-0.6B-hf",
    None,
    (
        "config.json",
        "generation_config.json",
        "model.safetensors",
        "processor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "chat_template.jinja",
    ),
)

SPEECH = Repo(
    "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    None,
    (
        "config.json",
        "generation_config.json",
        "model.safetensors",
        "merges.txt",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "vocab.json",
        "speech_tokenizer/config.json",
        "speech_tokenizer/model.safetensors",
        "speech_tokenizer/preprocessor_config.json",
    ),
)

IMAGE = Repo(
    "Tongyi-MAI/Z-Image-Turbo",
    ("model_index.json", "scheduler/*", "text_encoder/*", "tokenizer/*", "transformer/*", "vae/*"),
    (
        "model_index.json",
        "scheduler/scheduler_config.json",
        "text_encoder/config.json",
        "tokenizer/tokenizer.json",
        "tokenizer/tokenizer_config.json",
        "transformer/config.json",
        "vae/config.json",
        "vae/diffusion_pytorch_model.safetensors",
    ),
    ("text_encoder/model.safetensors.index.json", "transformer/diffusion_pytorch_model.safetensors.index.json"),
)

REPOS = {"transcription": TRANSCRIPTION, "speech": SPEECH, "image": IMAGE}

VOICES = (
    Voice("serena", "zh", "Warm, gentle young female voice"),
    Voice("vivian", "zh", "Bright young female voice"),
    Voice("uncle_fu", "zh", "Seasoned male voice with a mellow timbre"),
    Voice("dylan", "zh", "Youthful Beijing male voice"),
    Voice("eric", "zh", "Lively Chengdu male voice"),
    Voice("aiden", "en", "Sunny American male voice"),
    Voice("ryan", "en", "Dynamic male voice with rhythm"),
    Voice("ono_anna", "ja", "Playful Japanese female voice"),
    Voice("sohee", "ko", "Warm Korean female voice"),
)

DEFAULT_VOICES = {"zh": "serena", "en": "aiden", "ja": "ono_anna", "ko": "sohee"}

SPEECH_LANGUAGES = {"zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "ru": "Russian", "auto": "Auto"}

TRANSCRIPTION_LANGUAGES = {
    "ar": "Arabic",
    "yue": "Cantonese",
    "zh": "Chinese",
    "cs": "Czech",
    "da": "Danish",
    "nl": "Dutch",
    "en": "English",
    "fil": "Filipino",
    "fi": "Finnish",
    "fr": "French",
    "de": "German",
    "el": "Greek",
    "hi": "Hindi",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "mk": "Macedonian",
    "ms": "Malay",
    "fa": "Persian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "es": "Spanish",
    "sv": "Swedish",
    "th": "Thai",
    "tr": "Turkish",
    "vi": "Vietnamese",
}


def home() -> Path:
    return Path(os.environ.get("OPENOX_MEDIA_HOME") or Path.home() / ".local/share/openox-media")


def hub_cache() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    return Path(os.environ.get("HF_HOME") or home() / "hf") / "hub"


def snapshot(repo: Repo) -> Path | None:
    root = hub_cache() / ("models--" + repo.id.replace("/", "--"))
    try:
        revision = (root / "refs" / "main").read_text().strip()
    except OSError:
        return None
    path = root / "snapshots" / revision
    names = [*repo.files, *repo.indexes]
    for index in repo.indexes:
        try:
            shards = set(json.loads((path / index).read_text())["weight_map"].values())
        except (OSError, ValueError, KeyError):
            return None
        names += [str(Path(index).parent / shard) for shard in shards]
    return path if all((path / name).is_file() for name in names) else None


def shards(index: Path) -> list[Path]:
    names = sorted(set(json.loads(index.read_text())["weight_map"].values()))
    return [index.parent / name for name in names]
