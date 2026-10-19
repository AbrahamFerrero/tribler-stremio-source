import unittest
import os
import asyncio
from unittest.mock import patch

from tests.stress_harness import run_stress
from tests.test_kodi_worker import manager, media
from tests.host_failure_probe import probe
from adapter_host.kodi.process_manager import KodiWorkerError
from adapter_host.models import MediaItem
from adapter_host.registry import ResolverRegistry


class StressLifecycleTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(os.name == "nt", "Windows PID ownership regression")
    async def test_worker_exit_before_assignment_does_not_look_up_stale_pid(self):
        create_process = asyncio.create_subprocess_exec

        async def exit_before_return(*args, **kwargs):
            process = await create_process(*args, **kwargs)
            process.kill()
            await process.wait()
            return process

        worker = manager()
        with patch("asyncio.create_subprocess_exec", exit_before_return), patch(
                "adapter_host.kodi.process_manager.WindowsWorkerJob.assign") as assign:
            with self.assertRaisesRegex(KodiWorkerError, "^worker_process_error$"):
                await worker.resolve(media())
            assign.assert_not_called()
        self.assertEqual(worker.active_count, 0)
        self.assertEqual(len(worker.completed_pids), 1)

    async def test_harness_failure_drains_other_lanes_before_returning(self):
        original_resolve = ResolverRegistry.resolve_all
        original_create = asyncio.create_subprocess_exec
        started = asyncio.Event()
        previous_tasks = asyncio.all_tasks()

        async def observe_create(*args, **kwargs):
            process = await original_create(*args, **kwargs)
            started.set()
            return process

        async def fail_one_lane(registry, item):
            if item.id == "fixture:ok":
                await asyncio.wait_for(started.wait(), 2)
                raise RuntimeError("Synthetic harness failure")
            return await original_resolve(registry, MediaItem("fixture:block", "movie", "Synthetic"))

        try:
            with patch.object(ResolverRegistry, "resolve_all", fail_one_lane), patch(
                    "asyncio.create_subprocess_exec", observe_create):
                with self.assertRaisesRegex(RuntimeError, "Synthetic harness failure"):
                    await run_stress(10)
                unfinished_lanes = [task for task in asyncio.all_tasks() - previous_tasks
                                    if "run_stress.<locals>.lane" in task.get_coro().__qualname__]
                self.assertEqual(unfinished_lanes, [], "failed harness left a request lane running")
        finally:
            unfinished = asyncio.all_tasks() - previous_tasks
            for task in unfinished:
                task.cancel()
            await asyncio.gather(*unfinished, return_exceptions=True)

    @unittest.skipUnless(os.name == "nt", "Windows kernel ownership regression")
    async def test_job_assignment_failure_refuses_worker_execution(self):
        worker = manager()
        with patch("adapter_host.kodi.process_manager.WindowsWorkerJob.assign", side_effect=OSError("private detail")):
            with self.assertRaisesRegex(KodiWorkerError, "^worker_ownership_error$"):
                await worker.resolve(media())
        self.assertEqual(worker.active_count, 0)
        self.assertEqual(len(worker.completed_pids), 1)

    @unittest.skipUnless(os.name == "nt", "Windows kernel ownership regression")
    def test_host_death_stops_assigned_worker(self):
        result = probe()
        self.assertFalse(result["workerSurvivedHostDeath"])

    async def test_completed_pid_diagnostics_remain_bounded(self):
        worker = manager()
        # Model an already warm manager without spawning hundreds of processes.
        worker.completed_pids.extend(range(100))
        await worker.resolve(media())
        self.assertEqual(worker.active_count, 0)
        self.assertLessEqual(len(worker.completed_pids), 100)

    async def test_repeated_worker_failure_cancellation_and_recovery(self):
        result = await run_stress(10)
        self.assertEqual(result["cycles"], 10)
        self.assertGreater(result["peakWorkers"], 1)
        self.assertLessEqual(result["peakWorkers"], 4)
        self.assertEqual(result["activeAtEnd"], 0)
        self.assertEqual(result["temporaryEntriesAtEnd"], 0)
