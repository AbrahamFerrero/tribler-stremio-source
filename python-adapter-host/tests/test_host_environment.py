from __future__ import annotations

from contextlib import contextmanager
from collections import deque
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
# Preparation and functional completion have separate bounded budgets.
# Neither changes worker deadlines or the negative 100ms assertions.
POWERSHELL_51_TIMEOUT = 60
POWERSHELL_7_TIMEOUT = 30
LAUNCHER_CLEANUP_TIMEOUT = 10
# Only the environment contract needs the production launcher's command/provider
# machinery prepared. The cleanup fixture uses .NET paths and a fixed interpreter.
ENVIRONMENT_PREPARATION = (
    "Get-Command Get-ChildItem, Get-Content, Get-Command, Select-Object, "
    "New-Object, Join-Path, Split-Path, Test-Path -ErrorAction Stop | Out-Null\n"
    "$null = Get-ChildItem Env:\n"
)
FORBIDDEN = {
    "TRIBLER_API_KEY": "SYNTHETIC_SECRET",
    "TRIBLER_URL": "http://127.0.0.1:12345",
    "UNRELATED_SECRET": "SYNTHETIC_UNRELATED",
    "HTTPS_PROXY": "http://127.0.0.1:12346",
    "PYTHONPATH": "SYNTHETIC_STARTUP_PATH",
    "PYTHONINSPECT": "1",
    "NON_SECRET_RUNTIME": "synthetic",
}


class LauncherPhases:
    """Failure-only observations of this synthetic fixture, never process output.

    Each source reports its own monotonic elapsed time; clocks are not merged.
    Markers bracket the production call, not its unobservable internal phases.
    """
    SHELL = ("gate_enter", "gate_released", "script_call", "wrapper_enter",
             "environment_before", "adapter_call", "adapter_returned",
             "environment_after", "parent_output_buffered")
    CHILD = ("child_enter", "imports_complete", "runtime_start", "runtime_complete",
             "child_output_buffered")
    # Append codes without renumbering historical observations.
    INVOCATION = ("script_returned", "script_invocation_error", "script_path_ready", "script_resolved",
                  "lookup_restored")
    PARENT = frozenset({"spawn_start", "spawn_returned", "stdin_closed", "job_assigned",
                        "gate_opened", "wait_start", "wait_returned", "output_read",
                        "cleanup_start", "cleanup_drained", "job_closed", "shell_reaped"})

    def __init__(self, root):
        self.path = root / "launcher-phases.txt"
        self.started = time.monotonic()
        self.events = deque(maxlen=32)

    def mark(self, phase):
        if phase in self.PARENT:
            self.events.append({"phase": phase, "ms": min(1_000_000, max(
                0, round((time.monotonic() - self.started) * 1000)))})

    def shell(self, phase):
        code = (self.SHELL + self.CHILD + self.INVOCATION).index(phase) + 1
        path = str(self.path).replace("'", "''")
        return (f"[IO.File]::AppendAllText('{path}', '{code} ' + "
                "[int64]$launcherDiagnosticClock.Elapsed.TotalMilliseconds + [Environment]::NewLine)\n")

    def python_prelude(self):
        return ("import time as _diag_time\n_diag_started = _diag_time.monotonic()\n"
                "def _diag_mark(code):\n"
                f"    with open({str(self.path)!r}, 'a', encoding='ascii') as _diag_file:\n"
                "        _diag_file.write(str(code) + ' ' + str(int((_diag_time.monotonic() - "
                "_diag_started) * 1000)) + '\\n')\n_diag_mark(10)\n")

    def observed(self):
        observed = []
        try:
            with self.path.open("rb") as stream:
                raw = stream.read(4096)
            for line in raw.splitlines()[:32]:
                fields = line.split()
                if len(fields) != 2 or not all(field.isdigit() and len(field) <= 7 for field in fields):
                    continue
                code, elapsed = map(int, fields)
                names = self.SHELL + self.CHILD + self.INVOCATION
                if 1 <= code <= len(names) and elapsed <= 1_000_000:
                    observed.append({"phase": names[code - 1], "ms": elapsed,
                                     "source": "child" if 10 <= code <= 14 else "shell"})
        except OSError:
            pass
        return observed

    def failure_category(self, timed_out=False):
        names = {event["phase"] for event in self.observed()}
        if "script_invocation_error" in names:
            return "script_invocation_error"
        if timed_out:
            # Absence is an observation, not proof that the first statement
            # never executed: even the marker's file append could be blocked.
            return "wrapper_active_timeout" if "wrapper_enter" in names else "wrapper_not_observed_timeout"
        return "launcher_early_exit"

    @contextmanager
    def on_failure(self):
        try:
            yield self
        except BaseException:
            print("LAUNCHER_PHASE_DIAGNOSTIC " + json.dumps({
                "clock": "per_source_elapsed_ms", "parent": list(self.events),
                "fixture": self.observed()}), file=sys.stderr)
            raise
        finally:
            self.events.clear()


class LauncherFailure(AssertionError):
    """Closed categories only; never stringify commands, paths or output."""


def wait_launcher(launcher, phases, budget):
    phases.mark("wait_start")
    try:
        result = launcher.wait(timeout=budget)
    except subprocess.TimeoutExpired:
        raise LauncherFailure(phases.failure_category(timed_out=True)) from None
    phases.mark("wait_returned")
    if result != 0:
        raise LauncherFailure(phases.failure_category())


class LauncherPhaseTests(unittest.TestCase):
    def test_phase_failure_output_is_closed_bounded_and_preserves_error(self):
        from contextlib import redirect_stderr
        import io

        canary = "PRIVATE_CANARY/environment/arguments/output"
        with tempfile.TemporaryDirectory() as directory:
            phases = LauncherPhases(Path(directory))
            phases.path.write_text(canary + "\n1 12\n14 20\n99 1\n1 1000001\n" + "2 13\n" * 40)
            for _ in range(40):
                phases.mark("wait_start")
            phases.mark(canary)
            failure = AssertionError(canary)
            output = io.StringIO()
            with redirect_stderr(output), self.assertRaises(AssertionError) as caught:
                with phases.on_failure():
                    raise failure
            self.assertIs(caught.exception, failure)
            self.assertNotIn(canary, output.getvalue())
            self.assertNotIn(str(directory), output.getvalue())
            payload = json.loads(output.getvalue().split(" ", 1)[1])
            self.assertEqual(len(payload["parent"]), 32)
            self.assertLessEqual(len(payload["fixture"]), 32)
            self.assertEqual(payload["fixture"][0]["phase"], "gate_enter")
            self.assertEqual(payload["fixture"][1]["phase"], "child_output_buffered")
            self.assertEqual(list(phases.events), [])

    def test_phase_pass_is_silent_and_missing_markers_preserve_failure(self):
        from contextlib import redirect_stderr
        import io

        with tempfile.TemporaryDirectory() as directory:
            phases = LauncherPhases(Path(directory))
            output = io.StringIO()
            with redirect_stderr(output), phases.on_failure():
                phases.mark("spawn_start")
            self.assertEqual(output.getvalue(), "")
            failure = subprocess.TimeoutExpired("synthetic", 60)
            with redirect_stderr(output), self.assertRaises(subprocess.TimeoutExpired) as caught:
                with phases.on_failure():
                    raise failure
            self.assertIs(caught.exception, failure)
            self.assertEqual(json.loads(output.getvalue().split(" ", 1)[1])["fixture"], [])


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
def owned_launcher(host, env, stdout, stderr, *, script="start-local.ps1", shell="powershell", phases=None,
                   preparation="", observe_lookup=False):
    from adapter_host.kodi.windows_job import WindowsWorkerJob

    # Keep the existing file handshake only for ownership, with a fail-closed deadline.
    # The launcher cannot create descendants before successful Job Object assignment.
    signal = host / f"launcher-ready-{uuid.uuid4().hex}"
    signal_path = str(signal).replace("'", "''")
    prepared = host / "launcher-prepared"
    begin = host / "launcher-begin"
    prepared_path = str(prepared).replace("'", "''")
    begin_path = str(begin).replace("'", "''")
    budget = POWERSHELL_51_TIMEOUT if shell == "powershell" else POWERSHELL_7_TIMEOUT
    gate = host / "owned-launcher.ps1"
    gate.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        + ("$launcherDiagnosticClock = [Diagnostics.Stopwatch]::StartNew()\n"
           + phases.shell("gate_enter") if phases else "") +
        "$gateTimer = [Diagnostics.Stopwatch]::StartNew()\n"
        f"while (-not [IO.File]::Exists('{signal_path}')) {{\n"
        "    if ($gateTimer.Elapsed.TotalSeconds -ge 10) { throw 'Launcher ownership timed out' }\n"
        "    [Threading.Thread]::Sleep(10)\n}\n"
        + (phases.shell("gate_released") + phases.shell("script_call") if phases else "") +
        "try {\n"
        # Both operands are filesystem paths under this fixture's root. Avoid
        # initializing a cmdlet/module merely to construct a synthetic path;
        # command discovery for the direct script invocation remains unchanged.
        f"$launcherScript = [IO.Path]::Combine($PSScriptRoot, '{script}')\n"
        + (phases.shell("script_path_ready") if phases else "") +
        ("if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {\n"
         "    throw 'Windows PowerShell 5.1 required'\n}\n" if shell == "powershell" else "") +
        # Preparation never invokes production or Python; their errors surface
        # during the real call. Empty preparation also retains cold-host coverage.
        preparation +
        f"[IO.File]::WriteAllText('{prepared_path}', 'ready')\n"
        "$beginTimer = [Diagnostics.Stopwatch]::StartNew()\n"
        f"while (-not [IO.File]::Exists('{begin_path}')) {{\n"
        "    if ($beginTimer.Elapsed.TotalSeconds -ge 10) { throw 'Launcher phase timed out' }\n"
        "    [Threading.Thread]::Sleep(10)\n}\n" +
        # Observe the actual direct invocation's lookup, without pre-resolving
        # or passing ExternalScriptInfo (which skips that lookup at invocation).
        ("$previousLookupAction = $ExecutionContext.InvokeCommand.PostCommandLookupAction\n"
         "$ExecutionContext.InvokeCommand.PostCommandLookupAction = {\n"
         "    param($sender, $lookup)\n"
         "    if ($lookup.CommandName -eq $launcherScript -and $null -ne $lookup.Command) {\n"
         + phases.shell("script_resolved") + "    }\n}\n" if phases and observe_lookup else "") +
        "try { & $launcherScript } finally {\n"
        + ("$ExecutionContext.InvokeCommand.PostCommandLookupAction = $previousLookupAction\n"
           + phases.shell("lookup_restored") if phases and observe_lookup else "") +
        "}\n"
        + (phases.shell("script_returned") if phases else "") +
        "exit $LASTEXITCODE\n} catch {\n"
        + (phases.shell("script_invocation_error") if phases else "") +
        "exit 73\n}\n",
        encoding="utf-8")
    job = WindowsWorkerJob()
    launcher = None
    preparation_deadline = time.monotonic() + budget
    try:
        if phases:
            phases.mark("spawn_start")
        # Regular output files avoid inherited PIPE readers blocking on descendants.
        launcher = subprocess.Popen(
            [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(gate)],
            env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
        if phases:
            phases.mark("spawn_returned")
        # EOF only; NUL is a Windows character device and can trigger Python's prompt.
        launcher.stdin.close()
        if phases:
            phases.mark("stdin_closed")
        job.assign(launcher.pid)
        if phases:
            phases.mark("job_assigned")
        signal.touch(exist_ok=False)
        if phases:
            phases.mark("gate_opened")
        while not prepared.exists():
            if launcher.poll() is not None:
                raise LauncherFailure("launcher_preparation_failed")
            if time.monotonic() >= preparation_deadline:
                raise LauncherFailure("launcher_preparation_timeout")
            time.sleep(0.005)
        if time.monotonic() >= preparation_deadline:
            raise LauncherFailure("launcher_preparation_timeout")
        begin.touch(exist_ok=False)
        yield launcher
    finally:
        try:
            if phases:
                phases.mark("cleanup_start")
            stop_launcher_job(job)
            if phases:
                phases.mark("cleanup_drained")
        finally:
            # Kill-on-close remains the fallback even if termination/draining failed.
            job.close()
            if phases:
                phases.mark("job_closed")
            if launcher is not None:
                if launcher.poll() is None:
                    launcher.kill()  # Also covers assignment failure, before the gate opens.
                launcher.wait(timeout=5)
                if phases:
                    phases.mark("shell_reaped")
            signal.unlink(missing_ok=True)
            prepared.unlink(missing_ok=True)
            begin.unlink(missing_ok=True)


class HostEnvironmentTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows late preparation boundary")
    def test_late_prepared_signal_is_rejected_and_reaped(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile() as stdout, \
                tempfile.TemporaryFile() as stderr:
            root = Path(directory)
            phases = LauncherPhases(root)
            prepared, begin = root / "launcher-prepared", root / "launcher-begin"
            (root / "probe.ps1").write_text(phases.shell("wrapper_enter"), encoding="utf-8")
            monotonic, sleep = time.monotonic, time.sleep
            offset = 0
            clock = SimpleNamespace(monotonic=lambda: monotonic() + offset, sleep=sleep)
            create, touch, drain = subprocess.Popen, Path.touch, stop_launcher_job
            processes, jobs, admissions, late_signals = [], [], [], []

            def spawn(*args, **kwargs):
                process = create(*args, **kwargs)
                processes.append(process)
                return process

            def signal(path, *args, **kwargs):
                nonlocal offset
                if path == begin:
                    admissions.append(path)
                result = touch(path, *args, **kwargs)
                if path.name.startswith("launcher-ready-"):
                    # Hold the parent before its first readiness check until the
                    # real shell is prepared, then expire only the harness clock.
                    deadline = monotonic() + POWERSHELL_51_TIMEOUT
                    while not prepared.exists() and processes[0].poll() is None and monotonic() < deadline:
                        sleep(0.005)
                    self.assertTrue(prepared.exists(), "real shell did not prepare")
                    self.assertIsNone(processes[0].poll())
                    self.assertFalse(begin.exists())
                    offset = POWERSHELL_51_TIMEOUT
                    late_signals.append(prepared)
                return result

            def cleanup(job):
                jobs.append(job)
                drain(job)

            with patch(__name__ + ".time", clock), patch("subprocess.Popen", spawn), \
                    patch.object(Path, "touch", signal), patch(__name__ + ".stop_launcher_job", cleanup):
                with self.assertRaisesRegex(LauncherFailure, "^launcher_preparation_timeout$"):
                    with owned_launcher(root, synthetic_environment(), stdout, stderr,
                                        script="probe.ps1", phases=phases):
                        self.fail("expired preparation admitted the contract")
            self.assertEqual(late_signals, [prepared])
            self.assertEqual(admissions, [])
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0].returncode)
            self.assertEqual(len(jobs), 1)
            self.assertIsNone(jobs[0]._handle)
            names = [event["phase"] for event in phases.events]
            for phase in ("job_assigned", "cleanup_start", "cleanup_drained", "job_closed", "shell_reaped"):
                self.assertEqual(names.count(phase), 1)
            self.assertNotIn("wrapper_enter", {event["phase"] for event in phases.observed()})
            self.assertFalse(list(root.glob("launcher-ready-*")))
            self.assertFalse(prepared.exists())
            self.assertFalse(begin.exists())

    @unittest.skipUnless(os.name == "nt", "Windows shell preparation boundary")
    def test_preparation_delay_does_not_spend_contract_budget(self):
        from concurrent.futures import ThreadPoolExecutor, TimeoutError

        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile() as stdout, \
                tempfile.TemporaryFile() as stderr:
            root = Path(directory)
            ready, release = root / "preparing", root / "release-preparation"
            ready_path = str(ready).replace("'", "''")
            release_path = str(release).replace("'", "''")
            (root / "probe.ps1").write_text("exit 0\n", encoding="utf-8")
            preparation = (
                f"[IO.File]::WriteAllText('{ready_path}', 'ready')\n"
                "$timer = [Diagnostics.Stopwatch]::StartNew()\n"
                f"while (-not [IO.File]::Exists('{release_path}')) {{\n"
                " if ($timer.Elapsed.TotalSeconds -ge 10) { throw 'Preparation barrier timed out' }\n"
                " [Threading.Thread]::Sleep(10)\n}\n")

            def run():
                with owned_launcher(root, synthetic_environment(), stdout, stderr,
                                    script="probe.ps1", preparation=preparation) as launcher:
                    self.assertTrue(release.exists())
                    self.assertEqual(launcher.wait(timeout=POWERSHELL_51_TIMEOUT), 0)
                self.assertIsNotNone(launcher.returncode)

            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(run)
                try:
                    deadline = time.monotonic() + POWERSHELL_51_TIMEOUT
                    while not ready.exists() and not future.done() and time.monotonic() < deadline:
                        time.sleep(0.005)
                    self.assertTrue(ready.exists(), "preparation barrier not reached")
                    # Hold preparation beyond the negative contract's 100ms limit;
                    # no sleeps, retry, or favorable scheduling can admit it early.
                    with self.assertRaises(TimeoutError):
                        future.result(timeout=0.1)
                    self.assertFalse((root / "launcher-begin").exists())
                finally:
                    release.touch()
                future.result(timeout=POWERSHELL_51_TIMEOUT)
            self.assertFalse(list(root.glob("launcher-ready-*")))
            self.assertFalse((root / "launcher-prepared").exists())
            self.assertFalse((root / "launcher-begin").exists())

    @unittest.skipUnless(os.name == "nt", "Windows launcher failure containment")
    def test_preparation_environment_and_cleanup_errors_remain_failures(self):
        from unittest.mock import patch

        for mode in ("preparation", "environment", "cleanup"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, \
                    tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                root = Path(directory)
                host = root / "host"
                host.mkdir()
                phases = LauncherPhases(root)
                # Missing .env is a real error in the unchanged production launcher.
                shutil.copy2(HOST / "start-local.ps1", host / "probe.ps1")
                jobs = []
                drain = stop_launcher_job

                def cleanup(job):
                    jobs.append(job)
                    drain(job)
                    if mode == "cleanup":
                        raise OSError("synthetic_cleanup_failure")

                expected = "launcher_preparation_failed" if mode == "preparation" else (
                    "synthetic_cleanup_failure" if mode == "cleanup" else "script_invocation_error")
                with patch(__name__ + ".stop_launcher_job", cleanup):
                    with self.assertRaisesRegex((LauncherFailure, OSError), "^" + expected + "$"):
                        with owned_launcher(host, synthetic_environment(), stdout, stderr,
                                            script="probe.ps1", phases=phases,
                                            preparation="throw 'synthetic preparation error'\n"
                                            if mode == "preparation" else "") as launcher:
                            if mode == "cleanup":
                                launcher.wait(timeout=POWERSHELL_51_TIMEOUT)
                            else:
                                wait_launcher(launcher, phases, POWERSHELL_51_TIMEOUT)
                            self.assertEqual(launcher.returncode, 73)
                self.assertEqual(len(jobs), 1)
                self.assertIsNone(jobs[0]._handle)
                if mode != "preparation":
                    self.assertEqual(launcher.returncode, 73)
                    self.assertIn("script_invocation_error", {event["phase"] for event in phases.observed()})
                    self.assertIn("shell_reaped", {event["phase"] for event in phases.events})
                self.assertFalse(list(host.glob("launcher-ready-*")))
                self.assertFalse((host / "launcher-prepared").exists())
                self.assertFalse((host / "launcher-begin").exists())

    @unittest.skipUnless(os.name == "nt", "Windows launcher phase contracts")
    def test_controlled_wrapper_invocation_and_timeout_categories(self):
        scenarios = {
            "normal": None,
            "delayed": None,
            "never_observed": "wrapper_not_observed_timeout",
            "active": "wrapper_active_timeout",
            "missing": "script_invocation_error",
            "syntax": "script_invocation_error",
            "early": "launcher_early_exit",
        }
        for mode, expected in scenarios.items():
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, \
                    tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                root = Path(directory)
                phases = LauncherPhases(root)
                ready, release = root / "ready", root / "release"
                ready_path = str(ready).replace("'", "''")
                release_path = str(release).replace("'", "''")
                signal = f"[IO.File]::WriteAllText('{ready_path}', 'ready')\n"
                wait = (f"while (-not [IO.File]::Exists('{release_path}')) {{ "
                        "[Threading.Thread]::Sleep(10) }\n")
                script = {
                    "normal": phases.shell("wrapper_enter"),
                    "delayed": signal + wait + phases.shell("wrapper_enter"),
                    "never_observed": signal + wait,
                    "active": phases.shell("wrapper_enter") + signal + wait,
                    "syntax": "function {\n",
                    "early": "exit 7\n",
                }.get(mode)
                if script is not None:
                    (root / "probe.ps1").write_text(script, encoding="utf-8")
                env = synthetic_environment()
                before = dict(env)
                with phases.on_failure():
                    with owned_launcher(root, env, stdout, stderr, script="probe.ps1", phases=phases,
                                        observe_lookup=True) as launcher:
                        # Preparation has completed; the 100ms negative assertion
                        # still begins only at the synthetic wrapper barrier.
                        deadline = time.monotonic() + POWERSHELL_51_TIMEOUT
                        if mode in {"delayed", "never_observed", "active"}:
                            while not ready.exists() and launcher.poll() is None and time.monotonic() < deadline:
                                time.sleep(0.005)
                            self.assertTrue(ready.exists(), "synthetic wrapper barrier not reached")
                            names = {event["phase"] for event in phases.observed()}
                            self.assertIn("script_resolved", names)
                            self.assertEqual("wrapper_enter" in names, mode == "active")
                            if mode == "delayed":
                                release.touch()
                        if expected:
                            with self.assertRaisesRegex(LauncherFailure, "^" + expected + "$"):
                                wait_launcher(launcher, phases, 0.1 if mode in {"never_observed", "active"}
                                              else max(0, deadline - time.monotonic()))
                            if mode in {"never_observed", "active"}:
                                self.assertIsNone(launcher.poll(), "synthetic block exited instead of timing out")
                            else:
                                self.assertEqual(launcher.returncode, 7 if mode == "early" else 73)
                        else:
                            wait_launcher(launcher, phases, max(0, deadline - time.monotonic()))
                            self.assertIn("wrapper_enter", {event["phase"] for event in phases.observed()})
                    self.assertIsNotNone(launcher.returncode)
                    self.assertEqual(env, before)
                    self.assertFalse(list(root.glob("launcher-ready-*")))
                    names = {event["phase"] for event in phases.observed()}
                    self.assertIn("script_path_ready", names)
                    self.assertEqual("script_resolved" in names, mode != "missing")
                    if mode not in {"never_observed", "active"}:
                        self.assertIn("lookup_restored", names)
                    if mode in {"normal", "delayed", "active"}:
                        ordered = [event["phase"] for event in phases.observed()]
                        self.assertEqual(ordered.count("script_resolved"), 1)
                        self.assertLess(ordered.index("script_path_ready"), ordered.index("script_resolved"))
                        self.assertLess(ordered.index("script_resolved"), ordered.index("wrapper_enter"))

    @unittest.skipUnless(os.name == "nt", "Windows launcher ownership contract")
    def test_assignment_failure_never_opens_gate_and_reaps_shell(self):
        from unittest.mock import patch

        processes = []
        create = subprocess.Popen

        def observe(*args, **kwargs):
            process = create(*args, **kwargs)
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile() as stdout, \
                tempfile.TemporaryFile() as stderr:
            root = Path(directory)
            phases = LauncherPhases(root)
            (root / "probe.ps1").write_text(phases.shell("wrapper_enter"), encoding="utf-8")
            with patch("subprocess.Popen", observe), patch(
                    "adapter_host.kodi.windows_job.WindowsWorkerJob.assign", side_effect=OSError("synthetic")):
                with self.assertRaisesRegex(OSError, "^synthetic$"):
                    with owned_launcher(root, synthetic_environment(), stdout, stderr, script="probe.ps1", phases=phases):
                        self.fail("ownership failure admitted launcher")
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0].returncode)
            self.assertNotIn("gate_opened", {event["phase"] for event in phases.events})
            self.assertNotIn("wrapper_enter", {event["phase"] for event in phases.observed()})

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
            python_path = str(Path(sys.executable)).replace("'", "''")
            (root / "spawn.py").write_text(
                "import json, subprocess, sys\nfrom pathlib import Path\n"
                "child = subprocess.Popen([sys.executable, '-c', "
                "\"import time; print('synthetic inherited output', flush=True); time.sleep(120)\"])\n"
                f"Path({str(evidence)!r}).write_text(json.dumps({{'pid': child.pid}}))\n",
                encoding="utf-8")
            (root / "start-local.ps1").write_text(
                f"& '{python_path}' "
                "([IO.Path]::Combine($PSScriptRoot, 'spawn.py'))\n"
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
            if shell == "pwsh" and shutil.which(shell) is None:
                continue
            self.assertIsNotNone(shutil.which(shell), "mandatory Windows PowerShell missing")
            with self.subTest(shell=shell), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                host = root / "python-adapter-host"
                host.mkdir()
                shutil.copy2(HOST / "start-local.ps1", host / "start-local.ps1")
                package = host / "adapter_host"
                package.mkdir()
                phases = LauncherPhases(root)
                (package / "__init__.py").write_text("", encoding="utf-8")
                (root / ".env").write_text(
                    'TRIBLER_API_KEY=placeholder-synthetic\nPYTHON_ADAPTER_PORT="7109"\n',
                    encoding="utf-8")
                # A real Python child observes its environment before any app filtering.
                (package / "__main__.py").write_text(
                    phases.python_prelude()
                    + "import json, os, ssl, tempfile\nfrom pathlib import Path\n"
                    "_diag_mark(11)\n"
                    f"names = {list(FORBIDDEN)!r}\n"
                    "_diag_mark(12)\n"
                    "runtime = bool(ssl.create_default_context()) and Path(tempfile.gettempdir()).is_dir()\n"
                    "_diag_mark(13)\n"
                    "print(json.dumps({'present': {n: n in os.environ for n in names}, "
                    "'port': os.getenv('PYTHON_ADAPTER_PORT'), "
                    "'limit': os.getenv('PYTHON_ADAPTER_MAX_TOTAL_RESULTS'), "
                    "'runtime': runtime}))\n_diag_mark(14)\n",
                    encoding="utf-8")
                wrapper = root / "probe.ps1"
                wrapper.write_text(
                    phases.shell("wrapper_enter")
                    + "$before = [Environment]::GetEnvironmentVariables()\n"
                    + phases.shell("environment_before") + phases.shell("adapter_call") +
                    "& (Join-Path $PSScriptRoot 'python-adapter-host/start-local.ps1')\n"
                    + phases.shell("adapter_returned") +
                    "$after = [Environment]::GetEnvironmentVariables()\n"
                    + phases.shell("environment_after") +
                    "$same = $before.Count -eq $after.Count\n"
                    "foreach ($key in $before.Keys) { if ($before[$key] -cne $after[$key]) { $same = $false } }\n"
                    "Write-Output ('PARENT_UNCHANGED=' + $same)\n"
                    + phases.shell("parent_output_buffered"),
                    encoding="utf-8")
                env = synthetic_environment()
                env["tRiBlEr_ApI_KeY"] = env.pop("TRIBLER_API_KEY")
                with phases.on_failure(), tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                    with owned_launcher(root, env, stdout, stderr, script="probe.ps1", shell=shell,
                                        phases=phases, preparation=ENVIRONMENT_PREPARATION) as launcher:
                        budget = POWERSHELL_51_TIMEOUT if shell == "powershell" else POWERSHELL_7_TIMEOUT
                        wait_launcher(launcher, phases, budget)
                    stdout.seek(0)
                    lines = stdout.read().decode("utf-8").splitlines()
                    phases.mark("output_read")
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
