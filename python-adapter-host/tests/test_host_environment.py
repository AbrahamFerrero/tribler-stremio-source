from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from urllib.request import ProxyHandler, Request, build_opener

HOST = Path(__file__).resolve().parents[1]
# CI run 39294967656 took 24.1s in PS 5.1 and also exhausted 30s.
# These are integration startup budgets, not functional worker deadlines.
POWERSHELL_51_TIMEOUT = 60
POWERSHELL_7_TIMEOUT = 30
LAUNCHER_CLEANUP_TIMEOUT = 10
FORBIDDEN = {
    "TRIBLER_API_KEY": "SYNTHETIC_SECRET",
    "TRIBLER_URL": "http://127.0.0.1:12345",
    "UNRELATED_SECRET": "SYNTHETIC_UNRELATED",
    "HTTPS_PROXY": "http://127.0.0.1:12346",
    "PYTHONPATH": "SYNTHETIC_STARTUP_PATH",
    "PYTHONINSPECT": "1",
    "NON_SECRET_RUNTIME": "synthetic",
}


def synthetic_environment() -> dict[str, str]:
    # Never copy the operator's adapter settings or secrets into test processes.
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"}}
    env.update(FORBIDDEN)
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    env["PYTHON_ADAPTER_MAX_TOTAL_RESULTS"] = "17"
    return env


def stop_launcher_job(job):
    """Terminate and drain the test tree before releasing any temporary files."""
    import ctypes
    from ctypes import wintypes

    class Accounting(ctypes.Structure):
        _fields_ = [(name, ctypes.c_int64) for name in (
            "TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime"
        )] + [(name, wintypes.DWORD) for name in (
            "TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]

    class ProcessIds(ctypes.Structure):
        # Fixtures have at most a shell, Python and one grandchild. Overflow fails.
        _fields_ = [("Assigned", wintypes.DWORD), ("Count", wintypes.DWORD),
                    ("Ids", ctypes.c_size_t * 16)]

    # Test-only access keeps waiting policy out of the production worker helper.
    kernel = job._kernel
    kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateJobObject.restype = wintypes.BOOL
    kernel.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    kernel.QueryInformationJobObject.restype = wintypes.BOOL
    kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.IsProcessInJob.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD

    def query(kind, result):
        if not kernel.QueryInformationJobObject(
                job._handle, kind, ctypes.byref(result), ctypes.sizeof(result), None):
            raise ctypes.WinError(ctypes.get_last_error())

    deadline = time.monotonic() + LAUNCHER_CLEANUP_TIMEOUT
    accounting = Accounting()
    query(1, accounting)  # JobObjectBasicAccountingInformation
    total = accounting.TotalProcesses
    processes = ProcessIds()
    query(3, processes)  # JobObjectBasicProcessIdList
    handles = []
    try:
        for pid in processes.Ids[:processes.Count]:
            handle = kernel.OpenProcess(0x101000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
            if not handle:
                if ctypes.get_last_error() == 87:  # Process already exited, no handle remains to wait on.
                    continue
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(handle)
            owned = wintypes.BOOL()
            if not kernel.IsProcessInJob(handle, job._handle, ctypes.byref(owned)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not owned.value:
                raise AssertionError("launcher process no longer belongs to its Job Object")
        if not kernel.TerminateJobObject(job._handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())
        # Zero active processes can precede signaled handles / released file locks.
        for handle in handles:
            remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
            result = kernel.WaitForSingleObject(handle, remaining_ms)
            if result == 0x102:
                raise AssertionError("launcher process did not terminate within cleanup budget")
            if result != 0:
                raise ctypes.WinError(ctypes.get_last_error())
        while True:
            query(1, accounting)
            if accounting.ActiveProcesses == 0:
                if accounting.TotalProcesses != total:
                    raise AssertionError("launcher tree changed while acquiring cleanup handles")
                return
            if time.monotonic() >= deadline:
                raise AssertionError("launcher Job Object did not drain within cleanup budget")
            time.sleep(0.01)
    finally:
        for handle in handles:
            kernel.CloseHandle(handle)


@contextmanager
def owned_launcher(host, env, stdout, stderr, *, script="start-local.ps1", shell="powershell"):
    from adapter_host.kodi.windows_job import WindowsWorkerJob

    # Keep the existing file handshake only for ownership, with a fail-closed deadline.
    # The launcher cannot create descendants before successful Job Object assignment.
    signal = host / f"launcher-ready-{uuid.uuid4().hex}"
    signal_path = str(signal).replace("'", "''")
    gate = host / "owned-launcher.ps1"
    gate.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        "$gateTimer = [Diagnostics.Stopwatch]::StartNew()\n"
        f"while (-not [IO.File]::Exists('{signal_path}')) {{\n"
        "    if ($gateTimer.Elapsed.TotalSeconds -ge 10) { throw 'Launcher ownership timed out' }\n"
        "    [Threading.Thread]::Sleep(10)\n}\n"
        f"& (Join-Path $PSScriptRoot '{script}')\n"
        "exit $LASTEXITCODE\n",
        encoding="utf-8")
    job = WindowsWorkerJob()
    launcher = None
    try:
        # Regular output files avoid inherited PIPE readers blocking on descendants.
        launcher = subprocess.Popen(
            [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(gate)],
            env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
        # EOF only; NUL is a Windows character device and can trigger Python's prompt.
        launcher.stdin.close()
        job.assign(launcher.pid)
        signal.touch(exist_ok=False)
        yield launcher
    finally:
        try:
            stop_launcher_job(job)
        finally:
            # Kill-on-close remains the fallback even if termination/draining failed.
            job.close()
            if launcher is not None:
                if launcher.poll() is None:
                    launcher.kill()  # Also covers assignment failure, before the gate opens.
                launcher.wait(timeout=5)
            signal.unlink(missing_ok=True)


class HostEnvironmentTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows launcher ownership regression")
    def test_launcher_cleanup_after_exit_stops_only_owned_descendants(self) -> None:
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile() as stdout, \
                tempfile.TemporaryFile() as stderr:
            root = Path(directory)
            evidence = root / "child.json"
            (root / "spawn.py").write_text(
                "import json, subprocess, sys\nfrom pathlib import Path\n"
                "child = subprocess.Popen([sys.executable, '-c', "
                "\"import time; print('synthetic inherited output', flush=True); time.sleep(120)\"])\n"
                f"Path({str(evidence)!r}).write_text(json.dumps({{'pid': child.pid}}))\n",
                encoding="utf-8")
            (root / "start-local.ps1").write_text(
                "& python (Join-Path $PSScriptRoot 'spawn.py')\n"
                "exit $LASTEXITCODE\n",
                encoding="utf-8")
            unrelated = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(120)"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=synthetic_environment())
            handle = None
            try:
                with owned_launcher(root, synthetic_environment(), stdout, stderr) as launcher:
                    self.assertEqual(launcher.wait(timeout=POWERSHELL_51_TIMEOUT), 0)
                    pid = json.loads(evidence.read_text())["pid"]
                    handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
                    self.assertTrue(handle)
                    self.assertEqual(kernel.WaitForSingleObject(handle, 0), 0x102)
                    started = time.monotonic()
                self.assertLess(time.monotonic() - started, LAUNCHER_CLEANUP_TIMEOUT + 6)
                self.assertEqual(kernel.WaitForSingleObject(handle, 0), 0)
                self.assertIsNone(unrelated.poll(), "cleanup killed an unrelated process")
                stdout.seek(0)
                stderr.seek(0)
                self.assertEqual(stderr.read(), b"")
                stdout.read()  # Must return even though the launcher exited first.
            finally:
                if handle:
                    kernel.CloseHandle(handle)
                if unrelated.poll() is None:
                    unrelated.kill()
                unrelated.wait(timeout=5)

    @unittest.skipUnless(os.name == "nt", "supported Windows launcher")
    def test_launcher_real_host_http_and_startup_hook_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host = root / "python-adapter-host"
            host.mkdir()
            shutil.copy2(HOST / "start-local.ps1", host / "start-local.ps1")
            shutil.copytree(HOST / "adapter_host", host / "adapter_host",
                            ignore=shutil.ignore_patterns("__pycache__"))
            evidence = root / "child.json"
            marker = root / "hook-ran"
            hook = root / "hook"
            hook.mkdir()
            (hook / "sitecustomize.py").write_text(
                f"from pathlib import Path; Path({str(marker)!r}).touch()", encoding="utf-8")
            # Test-only observation at package import; production host and main are unchanged.
            (host / "adapter_host" / "__init__.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                f"Path({str(evidence)!r}).write_text(json.dumps({{'pid': os.getpid(), "
                f"'present': {{n: n in os.environ for n in {list(FORBIDDEN)!r}}}}}))\n",
                encoding="utf-8")
            import socket
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            (root / ".env").write_text(f"PYTHON_ADAPTER_PORT={port}\n", encoding="utf-8")
            env = synthetic_environment()
            env["PYTHONPATH"] = str(hook)
            with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
                with owned_launcher(host, env, stdout_file, stderr_file) as launcher:
                    self.assert_real_host_ready(port, evidence, marker, launcher)
                stdout_file.seek(0)
                stderr_file.seek(0)
                stdout = stdout_file.read().decode("utf-8", errors="replace")
                stderr = stderr_file.read().decode("utf-8", errors="replace")
            for value in ("SYNTHETIC_SECRET", "SYNTHETIC_UNRELATED", str(root)):
                self.assertNotIn(value, stdout + stderr)

    def assert_real_host_ready(self, port, evidence, marker, launcher) -> None:
        deadline = time.monotonic() + POWERSHELL_51_TIMEOUT
        opener = build_opener(ProxyHandler({}))
        while time.monotonic() < deadline:
            try:
                with opener.open(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
                    health = json.load(response)
                break
            except OSError:
                if launcher.poll() is not None:
                    self.fail("real launcher exited before HTTP readiness")
                time.sleep(0.05)
        else:
            self.fail("real launcher host did not become ready")
        observed = json.loads(evidence.read_text())
        self.assertFalse(any(observed["present"].values()))
        self.assertTrue(health["ok"])
        request = Request(f"http://127.0.0.1:{port}/resolve",
                          data=json.dumps({"id": "python-adapter:test", "type": "movie",
                                           "title": "Synthetic fixture"}).encode(),
                          headers={"Content-Type": "application/json"})
        with opener.open(request, timeout=3) as response:
            self.assertEqual(len(json.load(response)["streams"]), 2)
        self.assertFalse(marker.exists())

    @unittest.skipUnless(os.name == "nt", "supported Windows launcher")
    def test_launcher_child_environment_and_parent_unchanged(self) -> None:
        for shell in ("powershell", "pwsh"):
            if shutil.which(shell) is None:
                continue
            with self.subTest(shell=shell), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                host = root / "python-adapter-host"
                host.mkdir()
                shutil.copy2(HOST / "start-local.ps1", host / "start-local.ps1")
                package = host / "adapter_host"
                package.mkdir()
                (package / "__init__.py").write_text("", encoding="utf-8")
                (root / ".env").write_text(
                    'TRIBLER_API_KEY=placeholder-synthetic\nPYTHON_ADAPTER_PORT="7109"\n',
                    encoding="utf-8")
                # A real Python child observes its environment before any app filtering.
                (package / "__main__.py").write_text(
                    "import json, os, ssl, tempfile\nfrom pathlib import Path\n"
                    f"names = {list(FORBIDDEN)!r}\n"
                    "print(json.dumps({'present': {n: n in os.environ for n in names}, "
                    "'port': os.getenv('PYTHON_ADAPTER_PORT'), "
                    "'limit': os.getenv('PYTHON_ADAPTER_MAX_TOTAL_RESULTS'), "
                    "'runtime': bool(ssl.create_default_context()) and "
                    "Path(tempfile.gettempdir()).is_dir()}))\n",
                    encoding="utf-8")
                wrapper = root / "probe.ps1"
                wrapper.write_text(
                    "$before = @{}\nGet-ChildItem Env: | ForEach-Object { $before[$_.Name] = $_.Value }\n"
                    "& (Join-Path $PSScriptRoot 'python-adapter-host/start-local.ps1')\n"
                    "$after = @{}\nGet-ChildItem Env: | ForEach-Object { $after[$_.Name] = $_.Value }\n"
                    "$same = $before.Count -eq $after.Count\n"
                    "foreach ($key in $before.Keys) { if ($before[$key] -cne $after[$key]) { $same = $false } }\n"
                    "Write-Output ('PARENT_UNCHANGED=' + $same)\n",
                    encoding="utf-8")
                env = synthetic_environment()
                env["tRiBlEr_ApI_KeY"] = env.pop("TRIBLER_API_KEY")
                with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                    with owned_launcher(root, env, stdout, stderr, script="probe.ps1", shell=shell) as launcher:
                        budget = POWERSHELL_51_TIMEOUT if shell == "powershell" else POWERSHELL_7_TIMEOUT
                        self.assertEqual(launcher.wait(timeout=budget), 0)
                    stdout.seek(0)
                    lines = stdout.read().decode("utf-8").splitlines()
                observed = json.loads(next(line for line in lines if line.startswith("{")))
                self.assertFalse(any(observed["present"].values()), observed["present"])
                self.assertEqual(observed["port"], "7109")
                self.assertEqual(observed["limit"], "17")
                self.assertTrue(observed["runtime"])
                self.assertIn("PARENT_UNCHANGED=True", lines)

    def test_direct_and_embedded_refuse_tribler_environment(self) -> None:
        for args in (["-m", "adapter_host"], ["-c", "from adapter_host.app import create_server; create_server(0)"],
                     ["-c", "from adapter_host.app import create_server; from adapter_host.config import AdapterSettings; "
                      "from adapter_host.registry import ResolverRegistry; "
                      "create_server(0, registry=ResolverRegistry(), settings=AdapterSettings())"]):
            for key in ("TRIBLER_API_KEY", "TRIBLER_URL", "tRiBlEr_ApI_KeY"):
                with self.subTest(args=args, key=key):
                    env = {k: v for k, v in synthetic_environment().items() if k not in FORBIDDEN}
                    env[key] = "SYNTHETIC_SECRET"
                    try:
                        result = subprocess.run([sys.executable, *args], cwd=HOST, env=env,
                                                capture_output=True, text=True, timeout=3)
                    except subprocess.TimeoutExpired:
                        self.fail("host started despite forbidden environment")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("forbidden Tribler environment", result.stderr)
                    self.assertNotIn("SYNTHETIC_SECRET", result.stderr)

    def test_direct_empty_forbidden_and_malformed_configuration(self) -> None:
        for override in ({"TRIBLER_URL": ""}, {"PYTHON_ADAPTER_PORT": "SYNTHETIC_SECRET"}):
            env = {k: v for k, v in synthetic_environment().items() if k not in FORBIDDEN}
            env.update(override)
            result = subprocess.run([sys.executable, "-m", "adapter_host"], cwd=HOST, env=env,
                                    capture_output=True, text=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Adapter startup refused", result.stderr)
            self.assertNotIn("SYNTHETIC_SECRET", result.stderr)
            self.assertNotIn(str(HOST), result.stderr)


if __name__ == "__main__":
    unittest.main()
