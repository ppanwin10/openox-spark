import ctypes
import gc
import importlib
import os
import signal
import sys
import time
import traceback
from multiprocessing.connection import Connection

PR_SET_PDEATHSIG = 1
CUDA_ATTEMPTS = 30


def follow_parent(parent: int) -> None:
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
    if os.getppid() != parent:
        sys.exit(1)


def failure(error: BaseException) -> dict:
    lines = str(error).strip().splitlines()
    summary = lines[0] if lines else type(error).__name__
    if isinstance(error, MemoryError) or type(error).__name__ == "OutOfMemoryError" or "out of memory" in summary.lower():
        return {"ok": False, "type": "insufficient_memory", "message": f"Not enough memory: {summary}"[:300]}
    return {"ok": False, "type": "server_error", "message": f"{type(error).__name__}: {summary}"[:300]}


def start_cuda() -> None:
    import torch

    for attempt in range(CUDA_ATTEMPTS):
        try:
            torch.cuda.mem_get_info()
            return
        except RuntimeError as error:
            if "out of memory" not in str(error).lower() or attempt == CUDA_ATTEMPTS - 1:
                raise
            time.sleep(0.5)


def peak() -> int:
    torch = sys.modules.get("torch")
    return torch.cuda.max_memory_allocated() if torch is not None and torch.cuda.is_initialized() else 0


def reset() -> None:
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_initialized():
        torch.cuda.reset_peak_memory_stats()


def release() -> None:
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_initialized():
        torch.cuda.empty_cache()
    ctypes.CDLL("libc.so.6").malloc_trim(0)


def main() -> int:
    capability, descriptor, parent = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    follow_parent(parent)
    connection = Connection(descriptor)
    options = connection.recv()
    started = time.monotonic()
    try:
        start_cuda()
        backend = importlib.import_module(capability)
        model = backend.load(options)
        release()
    except BaseException as error:
        traceback.print_exc()
        connection.send(failure(error))
        return 1
    connection.send({"ok": True, "seconds": time.monotonic() - started, "peakAllocatedBytes": peak()})
    while True:
        try:
            request = connection.recv()
        except EOFError:
            return 0
        if request is None:
            return 0
        reset()
        started = time.monotonic()
        try:
            result = backend.run(model, request)
        except Exception as error:
            traceback.print_exc()
            connection.send(failure(error))
            continue
        finally:
            release()
        connection.send(
            {"ok": True, "result": result, "seconds": time.monotonic() - started, "peakAllocatedBytes": peak()}
        )


if __name__ == "__main__":
    sys.exit(main())
