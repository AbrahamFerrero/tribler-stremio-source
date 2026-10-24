import unittest
import os
import asyncio
from contextlib import redirect_stderr
import io
import json
from unittest.mock import patch

from tests.stress_harness import run_stress
from tests.test_kodi_worker import manager, media
from tests.host_failure_probe import probe
from adapter_host.kodi.process_manager import KodiWorkerError
from adapter_host.models import MediaItem
from adapter_host.registry import ResolverRegistry
from tests.worker_integration import HEALTHY_WORKER_SECONDS, delayed_worker_start


def diagnostic_records(output):
    prefix = "PYTHON_WORKER_DIAGNOSTIC "
    return [line[len(prefix):] for line in output.getvalue().splitlines() if line.startswith(prefix)]


class StressLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancellation_during_real_pipe_connection_reaps_transport(self):
        from asyncio.base_subprocess import BaseSubprocessTransport

        original = BaseSubprocessTransport._connect_pipes
        connected, release = asyncio.Event(), asyncio.Event()
        transports = []
        pending_before = asyncio.all_tasks()

        async def hold_connection(transport, waiter):
            # CPython owns the live process until create_subprocess_exec returns.
            # Connect real pipes, but withhold its completion notification.
            transports.append(transport)
            ready = asyncio.get_running_loop().create_future()
            await original(transport, ready)
            await ready
            connected.set()
            await release.wait()
            if not waiter.done():
                waiter.set_result(None)

        worker = manager()
        with patch.object(BaseSubprocessTransport, "_connect_pipes", hold_connection):
            task = asyncio.create_task(worker.resolve(media("fixture:block")))
            try:
                await asyncio.wait_for(connected.wait(), 3)
                self.assertEqual(worker.active_count, 0)
                task.cancel()
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, 3)
                self.assertTrue(transports)
                self.assertTrue(all(transport.get_returncode() is not None for transport in transports))
                self.assertEqual(worker.completed_pids, [])  # No stale PID lookup by manager.
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                for transport in transports:
                    transport.close()
                    await transport._wait()
        await asyncio.sleep(0)
        self.assertEqual(asyncio.all_tasks() - pending_before, set())

    async def test_controlled_startup_reproduces_recovery_timeout_then_recovers(self):
        # Same real registry/process/IPC path, same latency, only the healthy
        # budget changes. The short budget still belongs to blocked controls.
        for budget in (1, HEALTHY_WORKER_SECONDS):
            output = io.StringIO()
            with self.subTest(budget=budget), delayed_worker_start(1.2), redirect_stderr(output):
                if budget == 1:
                    with self.assertRaisesRegex(AssertionError, "healthy recovery lost worker sources"):
                        await run_stress(6, healthy_timeout=budget)
                    records = diagnostic_records(output)
                    self.assertEqual(len(records), 1)
                    diagnostic = json.loads(records[0])
                    codes = [event["code"] for event in diagnostic["events"]
                             if event["event"] == "operation_error" and event["request"] == 1]
                    self.assertIn("worker_timeout", codes)
                    self.assertNotIn("module_error", codes)
                    self.assertEqual(diagnostic["created"], diagnostic["completed"])
                else:
                    result = await run_stress(6, healthy_timeout=budget)
                    self.assertEqual(result["cycles"], 6)
                    self.assertEqual(result["activeAtEnd"], 0)

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
            diagnostic_output = io.StringIO()
            with patch.object(ResolverRegistry, "resolve_all", fail_one_lane), patch(
                    "asyncio.create_subprocess_exec", observe_create), redirect_stderr(diagnostic_output):
                diagnostic_output.write("Synthetic stderr before diagnostic\n")
                with self.assertRaisesRegex(RuntimeError, "Synthetic harness failure"):
                    await run_stress(10)
                diagnostic_output.write("Synthetic stderr after diagnostic\n")
                unfinished_lanes = [task for task in asyncio.all_tasks() - previous_tasks
                                    if "run_stress.<locals>.lane" in task.get_coro().__qualname__]
                self.assertEqual(unfinished_lanes, [], "failed harness left a request lane running")
            records = diagnostic_records(diagnostic_output)
            self.assertEqual(len(records), 1, "expected exactly one worker diagnostic record")
            diagnostic = json.loads(records[0])
            self.assertEqual(diagnostic["kind"], "concurrency")
            self.assertEqual(diagnostic["limit"], 4)
            self.assertGreater(diagnostic["created"], 0)
            self.assertNotIn("Synthetic harness failure", diagnostic_output.getvalue())
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
