"""Synthetic registry -> disposable-worker integration workload; no network."""
from __future__ import annotations

import argparse
import asyncio
import gc
from contextvars import ContextVar
import json
import os
from pathlib import Path
import sys
import tempfile
import tracemalloc
from unittest.mock import patch

# Also support direct invocation from the adapter directory.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter_host.kodi.process_manager import KodiWorkerError, KodiWorkerProcessManager
from adapter_host.kodi_installed_resolver import KodiInstalledResolver
from adapter_host.models import MediaItem
from adapter_host.registry import ResolverRegistry
from tests.test_kodi_worker import manager
from tests.worker_diagnostics import WorkerDiagnostics
from tests.worker_integration import HEALTHY_WORKER_SECONDS, BLOCKED_WORKER_SECONDS, RESOLVER_SECONDS


def handle_count():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        count = wintypes.DWORD()
        if not kernel.GetProcessHandleCount(kernel.GetCurrentProcess(), ctypes.byref(count)):
            raise ctypes.WinError(ctypes.get_last_error())
        return count.value
    descriptors = Path("/proc/self/fd")
    return len(list(descriptors.iterdir())) if descriptors.is_dir() else None


async def run_stress(cycles: int, request_concurrency: int = 2, *,
                     healthy_timeout: float = HEALTHY_WORKER_SECONDS) -> dict:
    registry = ResolverRegistry(default_timeout_seconds=RESOLVER_SECONDS, max_concurrent_resolvers=2)
    blocked_registry = ResolverRegistry(default_timeout_seconds=RESOLVER_SECONDS, max_concurrent_resolvers=2)
    # Separate immutable managers: concurrent negative requests must never lower
    # a healthy recovery request's deadline by mutating shared configuration.
    healthy = [manager(healthy_timeout) for _ in range(3)]
    blocked = [manager(BLOCKED_WORKER_SECONDS) for _ in range(3)]
    managers: list[KodiWorkerProcessManager] = healthy + blocked
    diagnostics = WorkerDiagnostics(managers)
    for target, workers in ((registry, healthy), (blocked_registry, blocked)):
        for index, worker in enumerate(workers):
            target.register(KodiInstalledResolver(worker, resolver_id=f"synthetic_{index}"))
    processes: list[asyncio.subprocess.Process] = []
    peak = 0
    spawned = 0
    owned_processes = ContextVar("stress_owned_processes")
    owned_errors = ContextVar("stress_owned_errors")
    owned_successes = ContextVar("stress_owned_successes")
    next_cycle = 0
    completed = 0
    samples = []
    errors = []
    loop = asyncio.get_running_loop()
    old_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: errors.append(context["message"]))
    create_process = asyncio.create_subprocess_exec
    resolve_worker = KodiWorkerProcessManager.resolve
    temporary_directory = tempfile.TemporaryDirectory
    owned_tracing = not tracemalloc.is_tracing()
    if owned_tracing:
        tracemalloc.start()

    async def observe_resolve(worker, item):
        try:
            results = await resolve_worker(worker, item)
            owned_successes.get().append(len(results))
            return results
        except KodiWorkerError as error:
            owned_errors.get().append(str(error))
            raise

    async def observe(*args, **kwargs):
        nonlocal peak, spawned
        process = await create_process(*args, **kwargs)
        processes.append(process)
        owned_processes.get().append(process)
        spawned += 1
        diagnostics.process_created(process)
        peak = max(peak, sum(child.returncode is None for child in processes))
        diagnostics.observe_peak(peak)
        return process

    async def until_started(task, owned):
        deadline = loop.time() + 5
        while not owned and not task.done() and loop.time() < deadline:
            await asyncio.sleep(0.005)
        assert owned, "worker did not start"

    async def lane():
        nonlocal next_cycle, completed
        while next_cycle < cycles:
            index = next_cycle
            next_cycle += 1
            mode = index % 5
            identifier = ("fixture:ok", "fixture:exception", "fixture:block",
                          "fixture:ignore-cancellation", "fixture:block")[mode]
            owned = []
            operation_errors = []
            operation_successes = []
            token = owned_processes.set(owned)
            error_token = owned_errors.set(operation_errors)
            success_token = owned_successes.set(operation_successes)
            request_token = diagnostics.request.set(index + 1)
            diagnostics.record("request_start")
            target = blocked_registry if mode == 2 else registry
            task = asyncio.create_task(target.resolve_all(MediaItem(identifier, "movie", "Synthetic")))
            diagnostics.request.reset(request_token)
            owned_processes.reset(token)
            owned_errors.reset(error_token)
            owned_successes.reset(success_token)
            try:
                if mode in {3, 4}:
                    # Observe this request's worker via call-local process context below.
                    await until_started(task, owned)
                    if mode == 3:
                        diagnostics.record("request_cancel", request=index + 1)
                        task.cancel()
                        try:
                            await task
                            raise AssertionError("cancellation was swallowed")
                        except asyncio.CancelledError:
                            pass
                    else:
                        # Failure at the real process boundary; sibling failure isolation
                        # and retry recovery are checked by subsequent successful cycles.
                        for child in owned:
                            if child.returncode is None:
                                diagnostics.record("process_kill", request=index + 1,
                                                   process=diagnostics.process_ordinal(child))
                                child.kill()
                        await task
                else:
                    streams = await task
                    if mode == 0:
                        # All three workers return the same sources. Registry
                        # deduplication retains the first resolver's three.
                        assert len(streams) == 3, "healthy recovery lost worker sources"
                        assert [source["providerId"] for source in streams] == ["synthetic_0"] * 3
                        assert [(source["type"], source.get("url"), source.get("infoHash"), source.get("fileIndex"))
                                for source in streams] == [
                                    ("https", "https://example.invalid/fixture.mp4", None, None),
                                    ("magnet", None, "a" * 40, None), ("magnet", None, "b" * 40, 2),
                                ], "healthy recovery returned different sources"
                        assert operation_errors == [], "healthy recovery encountered worker errors"
                        assert operation_successes == [3] * 3, "healthy resolver did not complete"
                    else:
                        assert streams == []
                        expected = "module_error" if mode == 1 else "worker_timeout"
                        assert operation_errors == [expected] * 3, "wrong negative worker error category"
                completed += 1
            finally:
                if not task.done():
                    diagnostics.record("request_cancel", request=index + 1)
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                diagnostics.record("request_end", request=index + 1)

    try:
        with temporary_directory(prefix="synthetic-stress-") as directory:
            root = Path(directory)

            def confined_temporary(*args, **kwargs):
                return temporary_directory(*args, **kwargs, dir=root)

            with diagnostics.observe(subprocesses=False), patch("asyncio.create_subprocess_exec", observe), patch.object(
                    KodiWorkerProcessManager, "resolve", observe_resolve), patch(
                    "adapter_host.kodi.process_manager.tempfile.TemporaryDirectory", confined_temporary):
                # Fixed batches make resource samples comparable at quiescent boundaries.
                for offset in range(0, cycles, 10):
                    batch_end = min(offset + 10, cycles)
                    # Bound admission without changing production limits.
                    original_cycles = cycles
                    cycles = batch_end
                    lanes = [asyncio.create_task(lane()) for _ in range(request_concurrency)]
                    try:
                        await asyncio.gather(*lanes)
                    finally:
                        # gather does not cancel siblings when one lane fails.
                        # Drain them before leaving the owned temporary root.
                        for task in lanes:
                            if not task.done():
                                task.cancel()
                        await asyncio.gather(*lanes, return_exceptions=True)
                        cycles = original_cycles
                    assert all(worker.active_count == 0 for worker in managers)
                    assert all(child.returncode is not None for child in processes)
                    assert list(root.iterdir()) == [], "temporary worker profiles survived"
                    diagnostics.release_processes()
                    processes.clear()  # Exclude harness-owned process history from memory samples.
                    gc.collect()
                    # Proactor pipe close callbacks run after Process.wait() returns.
                    await asyncio.sleep(0)
                    await asyncio.sleep(0)
                    current, high = tracemalloc.get_traced_memory()
                    samples.append({"completed": completed, "tracedBytes": current, "peakTracedBytes": high,
                                    "activeWorkers": 0, "temporaryEntries": 0,
                                    "openHandles": handle_count(),
                                    "retainedPidEntries": sum(len(worker.completed_pids) for worker in managers)})
        assert completed == cycles
        assert peak <= request_concurrency * registry.max_concurrent_resolvers
        assert all(len(worker.completed_pids) <= 100 for worker in managers)
        if len(samples) >= 3 and samples[0]["openHandles"] is not None:
            # Runtime caches may initialize after the first batch. Require a
            # quiescent plateau at the end, rather than an absolute machine limit.
            tail = [sample["openHandles"] for sample in samples[-3:]]
            assert tail[-1] <= min(tail[:-1]), ("continued handle growth", tail)
        assert not errors, errors
        return {"cycles": completed, "peakWorkers": peak, "spawned": spawned,
                "activeAtEnd": 0, "temporaryEntriesAtEnd": 0, "samples": samples}
    except BaseException:
        diagnostics.emit("concurrency", peak=peak,
                         limit=request_concurrency * registry.max_concurrent_resolvers)
        raise
    finally:
        # Defensive cleanup also runs when an assertion fails.
        try:
            for child in processes:
                if child.returncode is None:
                    child.kill()
                await child.wait()
        finally:
            diagnostics.close()
            loop.set_exception_handler(old_handler)
            if owned_tracing:
                tracemalloc.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=100, choices=range(100, 501), metavar="100..500")
    args = parser.parse_args()
    print(json.dumps({"python": asyncio.run(run_stress(args.cycles))}))
