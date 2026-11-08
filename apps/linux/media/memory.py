import os
from pathlib import Path

GIB = 1024**3


def available() -> int:
    with open("/proc/meminfo", "rb") as file:
        for line in file:
            if line.startswith(b"MemAvailable:"):
                return int(line.split()[1]) * 1024
    raise RuntimeError("/proc/meminfo reports no MemAvailable")


def gib(name: str, default: float) -> int:
    value = float(os.environ.get(name) or default)
    if value < 0:
        raise ValueError(f"{name} must not be negative")
    return int(value * GIB)


def margin() -> int:
    return gib("OPENOX_MEDIA_MARGIN_GIB", 4)


def floor() -> int:
    return gib("OPENOX_MEDIA_FLOOR_GIB", 3)


def describe(size: int) -> str:
    return f"{size / GIB:.1f} GiB"


def drop_cache(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.posix_fadvise(descriptor, 0, 0, os.POSIX_FADV_DONTNEED)
    finally:
        os.close(descriptor)
