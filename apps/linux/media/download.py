import argparse
import os
import sys

import models

os.environ.setdefault("HF_HOME", str(models.home() / "hf"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the OpenOx media models and prepare the FP8 image weights")
    parser.add_argument("--skip-convert", action="store_true", help="Do not prepare the FP8 image weights now")
    arguments = parser.parse_args()

    from huggingface_hub import snapshot_download

    for name, repo in models.REPOS.items():
        snapshot_download(repo.id, allow_patterns=list(repo.patterns) if repo.patterns else None)
        if models.snapshot(repo) is None:
            print(f"error: {repo.id} is incomplete after downloading", file=sys.stderr)
            return 1
        print(f"{name}: {repo.id} is ready")
    if arguments.skip_convert:
        return 0

    import torch

    import image

    try:
        target = image.prepare(models.snapshot(models.IMAGE), torch.device("cpu"))
    except MemoryError as error:
        print(f"warning: {error}; the image service prepares them on first use", file=sys.stderr)
        return 0
    print(f"image: FP8 weights are ready in {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
