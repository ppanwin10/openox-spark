import re
from collections.abc import Callable
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file
from torch import nn
from torch.nn import functional as F

import memory

FORMAT = torch.float8_e4m3fn
LIMIT = torch.finfo(FORMAT).max
SHARD_BYTES = 1024**3


class Float8Linear(nn.Module):
    def __init__(self, in_features: int, out_features: int, bias: bool):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.register_buffer("weight", torch.empty(out_features, in_features, dtype=FORMAT, device="meta"))
        self.register_buffer("scale", torch.empty(out_features, dtype=torch.bfloat16, device="meta"))
        if bias:
            self.register_buffer("bias", torch.empty(out_features, dtype=torch.bfloat16, device="meta"))
        else:
            self.bias = None

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        output = F.linear(input, self.weight.to(input.dtype)) * self.scale.to(input.dtype)
        return output if self.bias is None else output + self.bias.to(input.dtype)


def quantize(weight: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    values = weight.to(torch.float32)
    scale = (values.abs().amax(dim=1) / LIMIT).clamp(min=1e-12).to(torch.bfloat16)
    quantized = (values / scale.to(torch.float32)[:, None]).clamp(-LIMIT, LIMIT).to(FORMAT)
    return quantized, scale


def convert(
    sources: list[Path],
    target: Path,
    selected: re.Pattern,
    rename: Callable[[str], str | None],
    device: torch.device,
) -> list[str]:
    target.mkdir(parents=True)
    files: list[str] = []
    shard: dict[str, torch.Tensor] = {}
    size = 0

    def flush() -> None:
        nonlocal shard, size
        if shard:
            name = f"part-{len(files):05d}.safetensors"
            save_file(shard, target / name, metadata={"format": "pt"})
            files.append(name)
            shard, size = {}, 0

    for source in sources:
        with safe_open(source, framework="pt", device="cpu") as handle:
            for key in handle.keys():
                name = rename(key)
                if name is None:
                    continue
                tensor = handle.get_tensor(key).to(device)
                module, _, leaf = name.rpartition(".")
                if leaf == "weight" and tensor.ndim == 2 and selected.fullmatch(module):
                    weight, scale = (part.cpu() for part in quantize(tensor))
                    shard[name], shard[f"{module}.scale"] = weight, scale
                    size += weight.nbytes + scale.nbytes
                else:
                    value = tensor.to(torch.bfloat16).cpu().contiguous()
                    shard[name] = value
                    size += value.nbytes
                del tensor
                if size >= SHARD_BYTES:
                    flush()
        memory.drop_cache(source.resolve())
    flush()
    return files


def swap(model: nn.Module, selected: re.Pattern) -> int:
    count = 0
    for name, module in list(model.named_modules()):
        if isinstance(module, nn.Linear) and selected.fullmatch(name):
            path, _, leaf = name.rpartition(".")
            setattr(model.get_submodule(path), leaf, Float8Linear(module.in_features, module.out_features, module.bias is not None))
            count += 1
    return count


def assign(model: nn.Module, name: str, tensor: torch.Tensor) -> None:
    path, _, leaf = name.rpartition(".")
    module = model.get_submodule(path)
    if leaf in module._parameters:
        module._parameters[leaf] = nn.Parameter(tensor, requires_grad=False)
    elif leaf in module._buffers:
        module._buffers[leaf] = tensor
    else:
        raise KeyError(f"Unexpected weight {name}")


def load(model: nn.Module, files: list[Path], device: torch.device) -> None:
    for file in files:
        with safe_open(file, framework="pt", device=str(device)) as handle:
            for key in handle.keys():
                assign(model, key, handle.get_tensor(key))
    missing = [name for name, tensor in [*model.named_parameters(), *model.named_buffers()] if tensor.is_meta]
    if missing:
        raise RuntimeError(f"Weights are missing for {', '.join(missing[:5])}")
    model.to(device)
