import ctypes
import fcntl
import gc
import io
import json
import re
import shutil
import time
from pathlib import Path

import torch

import fp8
import memory
import models

STEPS = 9
MAX_TOKENS = 512
CONVERSION_PEAK = 3 * memory.GIB
TEXT_LINEAR = re.compile(r"layers\.\d+\.(self_attn\.[qkvo]_proj|mlp\.(gate|up|down)_proj)")
DIT_LINEAR = re.compile(
    r"(layers|noise_refiner|context_refiner)\.\d+\.(attention\.(to_q|to_k|to_v|to_out\.0)|feed_forward\.w[123])"
)


class Context:
    def __init__(self, source: Path, cache: Path, device: torch.device):
        self.source = source
        self.cache = cache
        self.device = device

    def weights(self, part: str) -> list[Path]:
        return sorted((self.cache / part).glob("part-*.safetensors"))


def cache_path(source: Path) -> Path:
    return models.home() / "fp8" / models.IMAGE.id.replace("/", "--") / source.name


def text_name(key: str) -> str | None:
    return None if key.startswith("lm_head.") else key.removeprefix("model.")


def prepare(source: Path, device: torch.device) -> Path:
    target = cache_path(source)
    if (target / "manifest.json").is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target.parent / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (target / "manifest.json").is_file():
            return target
        need = CONVERSION_PEAK + memory.margin()
        if memory.available() < need:
            raise MemoryError(
                f"Preparing the FP8 image weights needs {memory.describe(need)} available memory; "
                f"{memory.describe(memory.available())} is available"
            )
        partial = target.with_name(target.name + ".partial")
        shutil.rmtree(partial, ignore_errors=True)
        partial.mkdir()
        started = time.monotonic()
        parts = {
            "text_encoder": fp8.convert(
                models.shards(source / "text_encoder/model.safetensors.index.json"),
                partial / "text_encoder",
                TEXT_LINEAR,
                text_name,
                device,
            ),
            "transformer": fp8.convert(
                models.shards(source / "transformer/diffusion_pytorch_model.safetensors.index.json"),
                partial / "transformer",
                DIT_LINEAR,
                lambda key: key,
                device,
            ),
        }
        manifest = {
            "model": models.IMAGE.id,
            "revision": source.name,
            "weights": "float8_e4m3fn with one bfloat16 scale per output row",
            "parts": parts,
            "seconds": round(time.monotonic() - started, 1),
        }
        (partial / "manifest.json").write_text(json.dumps(manifest, indent=2))
        partial.rename(target)
    return target


def release() -> None:
    gc.collect()
    torch.cuda.empty_cache()
    ctypes.CDLL("libc.so.6").malloc_trim(0)


def load(options: dict) -> Context:
    device = torch.device("cuda")
    torch.cuda.init()
    source = Path(options["path"])
    return Context(source, prepare(source, device), device)


def encode(context: Context, prompt: str) -> torch.Tensor:
    from accelerate import init_empty_weights
    from transformers import AutoConfig, AutoTokenizer, Qwen3Model

    tokenizer = AutoTokenizer.from_pretrained(context.source / "tokenizer")
    config = AutoConfig.from_pretrained(context.source / "text_encoder")
    config._attn_implementation = "sdpa"
    with init_empty_weights():
        model = Qwen3Model(config)
    fp8.swap(model, TEXT_LINEAR)
    fp8.load(model, context.weights("text_encoder"), context.device)
    model.eval()
    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True, enable_thinking=True
    )
    tokens = tokenizer([text], max_length=MAX_TOKENS, truncation=True, return_tensors="pt").to(context.device)
    with torch.inference_mode():
        hidden = model(
            input_ids=tokens.input_ids, attention_mask=tokens.attention_mask, output_hidden_states=True
        ).hidden_states[-2]
        embeds = hidden[0].clone()
    del model, hidden
    release()
    return embeds


def denoise(context: Context, embeds: torch.Tensor, width: int, height: int, seed: int) -> torch.Tensor:
    from accelerate import init_empty_weights
    from diffusers import FlowMatchEulerDiscreteScheduler, ZImagePipeline, ZImageTransformer2DModel

    config = ZImageTransformer2DModel.load_config(context.source / "transformer")
    with init_empty_weights():
        model = ZImageTransformer2DModel.from_config(config)
    fp8.swap(model, DIT_LINEAR)
    fp8.load(model, context.weights("transformer"), context.device)
    model.eval()
    scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(context.source / "scheduler")
    pipeline = ZImagePipeline(scheduler=scheduler, vae=None, text_encoder=None, tokenizer=None, transformer=model)
    pipeline.set_progress_bar_config(disable=True)
    generator = torch.Generator(device=context.device).manual_seed(seed)
    with torch.inference_mode():
        latents = pipeline(
            prompt_embeds=[embeds],
            height=height,
            width=width,
            num_inference_steps=STEPS,
            guidance_scale=0.0,
            generator=generator,
            output_type="latent",
            return_dict=False,
        )[0]
    del pipeline, model
    release()
    return latents


def decode(context: Context, latents: torch.Tensor, width: int, height: int) -> bytes:
    from diffusers import AutoencoderKL
    from diffusers.image_processor import VaeImageProcessor

    vae = AutoencoderKL.from_pretrained(context.source / "vae", torch_dtype=torch.bfloat16).to(context.device)
    if max(width, height) > 1024:
        vae.enable_tiling()
    with torch.inference_mode():
        scaled = latents.to(vae.dtype) / vae.config.scaling_factor + vae.config.shift_factor
        pixels = vae.decode(scaled, return_dict=False)[0]
        picture = VaeImageProcessor(vae_scale_factor=16).postprocess(pixels, output_type="pil")[0]
    del vae, pixels, scaled
    release()
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")
    return buffer.getvalue()


def run(context: Context, request: dict) -> dict:
    phases: dict[str, dict] = {}

    def measure(name, action):
        torch.cuda.reset_peak_memory_stats()
        started = time.monotonic()
        result = action()
        phases[name] = {
            "seconds": round(time.monotonic() - started, 2),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
        }
        return result

    width, height = request["width"], request["height"]
    embeds = measure("encode", lambda: encode(context, request["prompt"]))
    latents = measure("denoise", lambda: denoise(context, embeds, width, height, request["seed"]))
    png = measure("decode", lambda: decode(context, latents, width, height))
    return {"png": png, "phases": phases}
