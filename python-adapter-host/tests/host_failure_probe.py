"""Opt-in Windows hard-host-death characterization, with independent cleanup.

Not an acceptance test: reports whether the ownership guarantee exists. Uses a
real process handle, so cleanup cannot target an unrelated reused PID.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def probe():
    if os.name != "nt":
        return {"status": "INSUFFICIENT EVIDENCE", "reason": "probe requires Windows process handles"}
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    # Fixed project-owned fixture setup; no request-controlled code or arguments.
    code = """
import asyncio
import json
from tests.test_kodi_worker import manager, media
async def main():
    worker = manager(5)
    task = asyncio.create_task(worker.resolve(media('fixture:block')))
    while not worker.active_count:
        await asyncio.sleep(0.005)
    print(json.dumps({'pid': next(iter(worker._active))}), flush=True)
    await task
asyncio.run(main())
"""
    with tempfile.TemporaryDirectory(prefix="synthetic-owner-probe-") as directory:
        env = {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "TEMP": directory, "TMP": directory}
        if "SYSTEMROOT" in os.environ:
            env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        host = subprocess.Popen([sys.executable, "-B", "-c", code],
                                cwd=Path(__file__).resolve().parents[1], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        handle = None
        try:
            # communicate cannot be used here: the fixture deliberately blocks.
            assert host.stdout is not None
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=1) as reader:
                future = reader.submit(host.stdout.readline)
                try:
                    line = future.result(timeout=5)
                except BaseException:
                    host.kill()
                    host.wait(timeout=5)
                    raise
            pid = json.loads(line)["pid"]
            handle = kernel.OpenProcess(0x00100001, False, pid)  # SYNCHRONIZE | TERMINATE
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            host.kill()
            host.wait(timeout=5)
            survived = kernel.WaitForSingleObject(handle, 5000) == 0x102
            if survived:
                if not kernel.TerminateProcess(handle, 1):
                    raise ctypes.WinError(ctypes.get_last_error())
            assert kernel.WaitForSingleObject(handle, 5000) == 0, "probe worker survived cleanup"
            return {"workerSurvivedHostDeath": survived, "workerStoppedByProbe": survived,
                    "remainingTemporaryEntries": len(list(Path(directory).iterdir()))}
        finally:
            if host.poll() is None:
                host.kill()
                host.wait(timeout=5)
            if host.stdout is not None:
                host.stdout.close()
            if handle:
                if kernel.WaitForSingleObject(handle, 0) == 0x102:
                    kernel.TerminateProcess(handle, 1)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)


if __name__ == "__main__":
    print(json.dumps(probe()))
