from __future__ import annotations

import asyncio
import json
import subprocess
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerError, KodiWorkerProcessManager, _minimal_environment
from adapter_host.kodi.protocol import MAX_INPUT_BYTES, ProtocolError


FIXTURE = Path(__file__).parent / "fixtures" / "fake_kodi_addon"
SETTINGS = FIXTURE / "settings.example.json"


def media(identifier: str = "fixture:ok") -> dict[str, object]:
    return {
        "id": identifier, "kind": "movie", "title": "Fixture", "year": 2024,
        "season": None, "episode": None, "externalIds": {}, "classifications": [],
    }


def manager(timeout: float = 1.0) -> KodiWorkerProcessManager:
    return KodiWorkerProcessManager(KodiWorkerConfig(
        addon_path=FIXTURE,
        module_name="fake_kodi_module",
        addon_id="script.module.fake",
        settings_file=SETTINGS,
        timeout_seconds=timeout,
    ))


class KodiWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancellation_waits_for_worker_cleanup(self) -> None:
        from adapter_host.kodi.windows_job import WindowsWorkerJob

        processes = self.observe_real_processes()
        worker = manager(5)
        entered = asyncio.Event()
        release = asyncio.Event()
        stop = worker._stop
        arguments = worker._arguments
        profiles = []
        jobs = []

        def observe_arguments(profile, *args):
            profiles.append(profile)
            return arguments(profile, *args)

        def observe_job():
            job = WindowsWorkerJob()
            jobs.append(job)
            return job

        async def delayed_stop(process):
            entered.set()
            await release.wait()
            await stop(process)

        with patch.object(worker, "_stop", delayed_stop), patch.object(
                worker, "_arguments", observe_arguments), patch(
                "adapter_host.kodi.process_manager.WindowsWorkerJob", observe_job):
            task = asyncio.create_task(worker.resolve(media("fixture:block")))
            try:
                deadline = asyncio.get_running_loop().time() + 2
                while not worker.active_count and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.005)
                self.assertEqual(worker.active_count, 1)
                task.cancel()
                await asyncio.wait_for(entered.wait(), 2)
                task.cancel()  # Cancellation races with cleanup already in progress.
                await asyncio.sleep(0)
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(worker.active_count, 0)
                self.assertTrue(all(process.returncode is not None for process in processes))
                self.assertEqual(len(worker.completed_pids), 1)
                self.assertTrue(all(not profile.exists() for profile in profiles))
                self.assertTrue(all(job._handle is None for job in jobs))
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                # A failing regression must not leak its Windows kernel handle.
                for job in jobs:
                    job.close()

    def observe_real_processes(self):
        processes = []
        create_process = asyncio.create_subprocess_exec

        async def observe(*args, **kwargs):
            process = await create_process(*args, **kwargs)
            processes.append(process)
            return process

        async def cleanup():
            # Keep a failed cleanup assertion from leaving a real worker behind.
            for process in processes:
                if process.returncode is None:
                    process.kill()
                await process.wait()

        self.enterContext(patch("asyncio.create_subprocess_exec", observe))
        self.addAsyncCleanup(cleanup)
        return processes

    def test_minimal_environment_has_only_explicit_platform_runtime_variables(self) -> None:
        owned = {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        for platform, parent, expected in (
            ("nt", {"SYSTEMROOT": "runtime-root", "WINDIR": "excluded", "PATH": "excluded"},
             {**owned, "SYSTEMROOT": "runtime-root"}),
            ("nt", {"UNRELATED_CANARY": "excluded"}, owned),
            ("posix", {"SYSTEMROOT": "excluded", "HOME": "excluded", "PATH": "excluded"}, owned),
        ):
            with self.subTest(platform=platform, systemroot_present="SYSTEMROOT" in parent):
                with patch.dict(os.environ, parent, clear=True), patch("adapter_host.kodi.process_manager.os.name", platform):
                    self.assertEqual(_minimal_environment(), expected)

    async def test_worker_imports_fixture_and_returns_all_supported_types(self) -> None:
        worker = manager()
        with patch.dict(os.environ, {"TRIBLER_API_KEY": "secret", "TRIBLER_URL": "http://secret"}):
            results = await worker.resolve(media())
        self.assertEqual(len(results), 3)
        self.assertEqual({entry["type"] for entry in results}, {"https", "magnet"})
        self.assertEqual(results[2]["fileIndex"], 2)
        metadata = results[0]["metadata"]
        self.assertTrue(metadata["setting"])
        self.assertTrue(metadata["pathConfined"])
        self.assertFalse(metadata["triblerApiKeyVisible"])
        self.assertFalse(metadata["triblerUrlVisible"])
        self.assertEqual(worker.active_count, 0)
        self.assertEqual(len(worker.completed_pids), 1)

    async def test_module_exception_and_invalid_output_are_sanitized(self) -> None:
        for identifier, code in (("fixture:exception", "module_error"), ("fixture:invalid", "invalid_output")):
            with self.subTest(identifier=identifier):
                with self.assertRaisesRegex(KodiWorkerError, code):
                    await manager().resolve(media(identifier))

    async def test_corrupt_and_excessive_stdout_are_rejected(self) -> None:
        with self.assertRaisesRegex(KodiWorkerError, "worker_protocol_error"):
            await manager().resolve(media("fixture:corrupt-stdout"))
        with self.assertRaisesRegex(KodiWorkerError, "worker_output_too_large"):
            await manager().resolve(media("fixture:large-output"))

    async def test_oversized_input_is_rejected_by_parent_and_real_worker(self) -> None:
        worker = manager()
        with self.assertRaisesRegex(ProtocolError, "^message exceeds size limit$"):
            await worker.resolve(media("x" * MAX_INPUT_BYTES))
        self.assertEqual(worker.completed_pids, [])
        # A valid JSON request padded past the byte bound must not be accepted
        # just because the complete object appears before the read boundary.
        request = json.dumps({"requestId": "a" * 32, "media": media()}).encode()
        request += b" " * (MAX_INPUT_BYTES + 1 - len(request))
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.run(
                worker._arguments(Path(directory)), input=request, capture_output=True,
                timeout=3, cwd=Path(__file__).resolve().parents[1], env=_minimal_environment(),
            )
        self.assertEqual(process.returncode, 0)
        self.assertEqual(json.loads(process.stdout), {"ok": False, "error": {"code": "invalid_output"}})
        self.assertEqual(process.stderr, b"")

    async def test_excessive_stderr_is_rejected(self) -> None:
        with self.assertRaisesRegex(KodiWorkerError, "^worker_stderr_too_large$"):
            await manager().resolve(media("fixture:large-stderr"))

    async def test_child_process_and_shell_execution_are_denied(self) -> None:
        for identifier in ("fixture:child-process", "fixture:shell"):
            with self.subTest(identifier=identifier):
                with self.assertRaisesRegex(KodiWorkerError, "^sandbox_violation$"):
                    await manager().resolve(media(identifier))

    async def test_hard_timeout_terminates_worker_without_zombie(self) -> None:
        processes = self.observe_real_processes()
        worker = manager(0.15)
        with self.assertRaisesRegex(KodiWorkerError, "worker_timeout"):
            await worker.resolve(media("fixture:block"))
        self.assertEqual(worker.active_count, 0)
        self.assertEqual(len(worker.completed_pids), 1)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode, "worker process still running after cleanup")

    async def test_cancellation_terminates_non_cooperative_worker(self) -> None:
        processes = self.observe_real_processes()
        worker = manager(5)
        task = asyncio.create_task(worker.resolve(media("fixture:ignore-cancellation")))
        deadline = asyncio.get_running_loop().time() + 2
        while worker.active_count == 0 and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(worker.active_count, 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(worker.active_count, 0)
        self.assertEqual(len(worker.completed_pids), 1)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode, "worker process still running after cleanup")

    async def test_traversal_is_rejected_by_fixture_runtime(self) -> None:
        with self.assertRaisesRegex(KodiWorkerError, "sandbox_violation"):
            await manager().resolve(media("fixture:traversal"))

    async def test_forbids_entrypoint_modules_in_local_configuration(self) -> None:
        for module_name in ("service", "default"):
            with self.assertRaises(ValueError):
                KodiWorkerConfig(addon_path=FIXTURE, module_name=module_name).validated()


if __name__ == "__main__":
    unittest.main()
