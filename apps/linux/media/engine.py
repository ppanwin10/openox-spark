import asyncio
import enum
import json
import logging
import os
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path

import memory
import models

HERE = Path(__file__).resolve().parent
JOB_MINIMUM = 512 * 1024**2
REAP_SECONDS = 5
STOP_SECONDS = 30
STUCK: list[subprocess.Popen] = []
STATUS = {"insufficient_memory": 503, "not_installed": 503, "server_error": 500}
log = logging.getLogger("openox.media")


class ServiceError(Exception):
    def __init__(self, status: int, kind: str, message: str):
        super().__init__(message)
        self.status = status
        self.kind = kind
        self.message = message


def event(name: str, **fields) -> None:
    log.info(json.dumps({"event": name, **{key: value for key, value in fields.items() if value is not None}}, ensure_ascii=False))


@dataclass(frozen=True)
class Capability:
    id: str
    repo: models.Repo
    python: Path
    peak: int
    idle: float
    load_timeout: float


class State(enum.Enum):
    UNLOADED = "unloaded"
    LOADING = "loading"
    READY = "ready"


def worker_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment.update(
        {
            "PYTHONUNBUFFERED": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "TRANSFORMERS_VERBOSITY": "error",
            "DIFFUSERS_VERBOSITY": "error",
            "TQDM_DISABLE": "1",
        }
    )
    environment.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    return environment


class Worker:
    def __init__(self, capability: Capability, options: dict):
        parent, child = socket.socketpair()
        try:
            self.process = subprocess.Popen(
                [str(capability.python), str(HERE / "worker.py"), capability.id, str(child.fileno()), str(os.getpid())],
                pass_fds=(child.fileno(),),
                stdin=subprocess.DEVNULL,
                cwd=HERE,
                env=worker_environment(),
            )
        finally:
            child.close()
        self.connection = Connection(parent.detach())
        self.connection.send(options)

    def receive(self, timeout: float) -> dict:
        if not self.connection.poll(timeout):
            raise TimeoutError
        return self.connection.recv()

    def request(self, payload: dict, timeout: float) -> dict:
        self.connection.send(payload)
        return self.receive(timeout)

    def alive(self) -> bool:
        return self.process.poll() is None

    def kill(self) -> None:
        if self.alive():
            self.process.kill()

    def stop(self, graceful: bool) -> None:
        if graceful:
            try:
                self.connection.send(None)
                self.process.wait(15)
            except (OSError, subprocess.TimeoutExpired):
                pass
        self.kill()
        try:
            self.process.wait(STOP_SECONDS)
        except subprocess.TimeoutExpired:
            event("worker_stuck", pid=self.process.pid)
            STUCK.append(self.process)
        self.connection.close()


class Watch:
    def __init__(self, floor: int, breach):
        self.floor = floor
        self.breach = breach
        self.start = memory.available()
        self.minimum = self.start
        self.breached = False
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def __enter__(self) -> "Watch":
        self.thread.start()
        return self

    def __exit__(self, *details) -> None:
        self.done.set()
        self.thread.join()

    def sample(self) -> None:
        while not self.done.wait(0.1):
            available = memory.available()
            self.minimum = min(self.minimum, available)
            if available < self.floor and not self.breached:
                self.breached = True
                self.breach()


class Slot:
    def __init__(self, capability: Capability):
        self.capability = capability
        self.state = State.UNLOADED
        self.worker: Worker | None = None
        self.resident = 0
        self.used = 0.0


class Engine:
    def __init__(self, capabilities: list[Capability]):
        self.slots = {capability.id: Slot(capability) for capability in capabilities}
        self.lock = asyncio.Lock()
        self.margin = memory.margin()
        self.floor = memory.floor()
        self.reaper: asyncio.Task | None = None

    async def start(self) -> None:
        self.reaper = asyncio.create_task(self.reap())

    async def close(self) -> None:
        if self.reaper is not None:
            self.reaper.cancel()
        for slot in self.slots.values():
            await self.unload(slot, "shutdown")

    def installed(self, slot: Slot) -> Path | None:
        if not slot.capability.python.is_file():
            return None
        return models.snapshot(slot.capability.repo)

    def health(self) -> dict:
        available = memory.available()
        return {
            "status": "ok",
            "memAvailableBytes": available,
            "reserveBytes": self.margin,
            "capabilities": [
                {
                    "id": slot.capability.id,
                    "model": slot.capability.repo.id,
                    "state": self.describe(slot, available),
                    "estimatedPeakBytes": slot.capability.peak,
                }
                for slot in self.slots.values()
            ],
        }

    def describe(self, slot: Slot, available: int) -> str:
        if slot.state is State.LOADING:
            return "loading"
        if slot.state is State.READY and slot.worker is not None and slot.worker.alive():
            return "ready"
        if self.installed(slot) is None:
            return "not_installed"
        reclaimable = sum(other.resident for other in self.slots.values() if other is not slot and other.worker)
        if available + reclaimable < slot.capability.peak + self.margin:
            return "insufficient_memory"
        return "loads_on_use"

    async def run(self, name: str, request: dict, timeout: float) -> dict:
        slot = self.slots[name]
        async with self.lock:
            if slot.worker is not None and not slot.worker.alive():
                await self.unload(slot, "exited", graceful=False)
            if slot.state is State.UNLOADED:
                path = self.installed(slot)
                if path is None:
                    raise ServiceError(
                        503,
                        "not_installed",
                        f"{slot.capability.repo.id} is not installed; run apps/linux/deploy/media.sh --download",
                    )
                await self.reserve(slot)
                await self.load(slot, path)
            else:
                self.check(slot)
            try:
                return await self.call(slot, request, timeout)
            finally:
                if slot.capability.idle <= 0:
                    await self.unload(slot, "finished")

    async def reserve(self, slot: Slot) -> None:
        need = slot.capability.peak + self.margin
        others = sorted((other for other in self.slots.values() if other.worker), key=lambda other: other.used)
        if memory.available() + sum(other.capability.peak for other in others) >= need:
            for other in others:
                if memory.available() >= need:
                    break
                await self.unload(other, "make_room")
        available = memory.available()
        if available < need:
            event("refused", capability=slot.capability.id, needBytes=need, memAvailableBytes=available)
            raise ServiceError(
                503,
                "insufficient_memory",
                f"Not enough free memory to load {slot.capability.repo.id}: it needs {memory.describe(need)} "
                f"available (estimated peak {memory.describe(slot.capability.peak)} plus "
                f"{memory.describe(self.margin)} reserve) and {memory.describe(available)} is available",
            )

    def check(self, slot: Slot) -> None:
        need = max(slot.capability.peak - slot.resident, JOB_MINIMUM) + self.margin
        available = memory.available()
        if available < need:
            event("refused", capability=slot.capability.id, needBytes=need, memAvailableBytes=available)
            raise ServiceError(
                503,
                "insufficient_memory",
                f"Not enough free memory to run {slot.capability.repo.id}: it needs {memory.describe(need)} "
                f"available and {memory.describe(available)} is available",
            )

    async def load(self, slot: Slot, path: Path) -> None:
        capability = slot.capability
        slot.state = State.LOADING
        started = time.monotonic()
        try:
            slot.worker = Worker(capability, {"path": str(path)})
        except OSError as error:
            slot.state = State.UNLOADED
            raise ServiceError(500, "server_error", f"Could not start the {capability.id} worker: {error}")
        watch = Watch(self.floor, slot.worker.kill)
        try:
            with watch:
                reply = await asyncio.to_thread(slot.worker.receive, capability.load_timeout)
        except asyncio.CancelledError:
            await self.unload(slot, "cancelled", graceful=False)
            raise
        except (EOFError, OSError, TimeoutError) as error:
            await self.unload(slot, "load_failed", graceful=False)
            raise self.failure(slot, watch, error, "loading")
        if not reply["ok"]:
            await self.unload(slot, "load_failed", graceful=False)
            raise ServiceError(STATUS[reply["type"]], reply["type"], reply["message"])
        after = memory.available()
        slot.state = State.READY
        slot.resident = max(0, watch.start - after)
        slot.used = time.monotonic()
        event(
            "loaded",
            capability=capability.id,
            model=capability.repo.id,
            seconds=round(time.monotonic() - started, 2),
            residentBytes=slot.resident,
            memAvailableBefore=watch.start,
            memAvailableAfter=after,
            memAvailableMinimum=watch.minimum,
            peakAllocatedBytes=reply["peakAllocatedBytes"],
        )

    async def call(self, slot: Slot, request: dict, timeout: float) -> dict:
        capability = slot.capability
        started = time.monotonic()
        watch = Watch(self.floor, slot.worker.kill)
        try:
            with watch:
                reply = await asyncio.to_thread(slot.worker.request, request, timeout)
        except asyncio.CancelledError:
            await self.unload(slot, "cancelled", graceful=False)
            raise
        except (EOFError, OSError, TimeoutError) as error:
            await self.unload(slot, "failed", graceful=False)
            raise self.failure(slot, watch, error, "running")
        finally:
            slot.used = time.monotonic()
        result = reply.get("result") or {}
        phases = result.get("phases") or {}
        peak = max([reply.get("peakAllocatedBytes") or 0, *(phase["peakAllocatedBytes"] for phase in phases.values())])
        event(
            "job",
            capability=capability.id,
            ok=reply["ok"],
            seconds=round(time.monotonic() - started, 2),
            peakAllocatedBytes=peak,
            memAvailableBefore=watch.start,
            memAvailableMinimum=watch.minimum,
            peakDropBytes=watch.start - watch.minimum,
            phases=phases or None,
        )
        if not reply["ok"]:
            await self.unload(slot, "failed", graceful=False)
            raise ServiceError(STATUS[reply["type"]], reply["type"], reply["message"])
        return result

    def failure(self, slot: Slot, watch: Watch, error: BaseException, stage: str) -> ServiceError:
        model = slot.capability.repo.id
        if watch.breached:
            return ServiceError(
                503,
                "insufficient_memory",
                f"Stopped {stage} {model} because available memory fell below {memory.describe(self.floor)}",
            )
        if isinstance(error, TimeoutError):
            return ServiceError(500, "server_error", f"{model} did not finish {stage} in time")
        return ServiceError(500, "server_error", f"The {slot.capability.id} worker stopped unexpectedly while {stage}")

    async def unload(self, slot: Slot, reason: str, graceful: bool = True) -> None:
        worker, slot.worker = slot.worker, None
        slot.state = State.UNLOADED
        slot.resident = 0
        if worker is None:
            return
        before = memory.available()
        await asyncio.to_thread(worker.stop, graceful)
        event(
            "unloaded",
            capability=slot.capability.id,
            reason=reason,
            memAvailableBefore=before,
            memAvailableAfter=memory.available(),
        )

    async def reap(self) -> None:
        while True:
            await asyncio.sleep(REAP_SECONDS)
            STUCK[:] = [process for process in STUCK if process.poll() is None]
            for slot in self.slots.values():
                if slot.worker is None or self.lock.locked():
                    continue
                idle = time.monotonic() - slot.used >= slot.capability.idle
                if slot.worker.alive() and not idle:
                    continue
                try:
                    async with self.lock:
                        worker = slot.worker
                        if worker is None or slot.state is not State.READY:
                            continue
                        if not worker.alive():
                            await self.unload(slot, "exited", graceful=False)
                        elif time.monotonic() - slot.used >= slot.capability.idle:
                            await self.unload(slot, "idle")
                except Exception:
                    log.exception("Unloading %s failed", slot.capability.id)
