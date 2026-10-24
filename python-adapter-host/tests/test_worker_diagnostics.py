import asyncio
from contextlib import redirect_stderr
import io
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from adapter_host.kodi.process_manager import KodiWorkerError
from adapter_host.registry import ResolutionResult, ResolverOutcome
from tests.test_kodi_worker import manager, media
from tests.worker_diagnostics import (
    KernelHandle, MAX_EVENTS, MAX_NUMBER, MAX_PROCESSES, WORKER_CODES,
    WorkerDiagnostics, error_code,
)

CANARY = "PRIVATE_CANARY/token/path/provider/title/url"


class DiagnosticTests(unittest.TestCase):
    def test_closed_codes_and_bounded_failure_output(self):
        class PrivateError(Exception):
            def __str__(self):
                raise AssertionError("must not stringify")

        for code in WORKER_CODES:
            self.assertEqual(error_code(KodiWorkerError(code)), code)
        for error in (PrivateError(CANARY), KodiWorkerError(CANARY), RuntimeError("worker_timeout")):
            self.assertEqual(error_code(error), "other")
        self.assertEqual(error_code(asyncio.CancelledError()), "cancelled")
        diagnostics = WorkerDiagnostics()
        for _ in range(MAX_EVENTS + 5):
            diagnostics.record("operation_error", code=CANARY, status=CANARY,
                               request=MAX_NUMBER + 1, duration_ms=-1, private=CANARY)
        diagnostics.record(CANARY)
        self.assertEqual(len(diagnostics.events), MAX_EVENTS)
        output = io.StringIO()
        with redirect_stderr(output):
            diagnostics.emit("http")
        payload = json.loads(output.getvalue().split(" ", 1)[1])
        self.assertNotIn(CANARY, output.getvalue())
        self.assertEqual(payload["events"][-1]["request"], MAX_NUMBER)
        self.assertEqual(payload["events"][-1]["duration_ms"], 0)
        self.assertEqual(payload["events"][-1]["code"], "other")
        diagnostics.close()
        self.assertEqual(list(diagnostics.events), [])

    def test_handle_query_and_idempotent_close_without_pid_lookup(self):
        handle = KernelHandle.__new__(KernelHandle)
        handle.kernel, handle.handle = Mock(), 123
        for result, state in ((258, "live"), (0, "exited"), (0xFFFFFFFF, "unavailable")):
            handle.kernel.WaitForSingleObject.return_value = result
            self.assertEqual(handle.state(), state)
        handle.close()
        handle.close()
        handle.kernel.CloseHandle.assert_called_once_with(123)
        self.assertEqual(handle.state(), "unavailable")

    def test_process_buffers_release_handles_at_eviction_and_close(self):
        diagnostics = WorkerDiagnostics()
        handles = []

        def new_handle(_process):
            handle = Mock()
            handle.state.return_value = "unavailable"
            handles.append(handle)
            return handle

        with patch("tests.worker_diagnostics.KernelHandle", new_handle):
            for _ in range(MAX_PROCESSES + 1):
                diagnostics.process_created(SimpleNamespace(returncode=None))
        diagnostics.observe_peak(5)
        output = io.StringIO()
        with redirect_stderr(output):
            diagnostics.emit("concurrency", peak=5, limit=4)
        payload = json.loads(output.getvalue().split(" ", 1)[1])
        self.assertEqual((payload["peak"], payload["limit"]), (5, 4))
        self.assertEqual(len(payload["peak_states"]), MAX_PROCESSES)
        self.assertLessEqual(len(payload["peak_events"]), MAX_EVENTS)
        self.assertTrue(all(state["asyncio_pending"] for state in payload["peak_states"]))
        self.assertEqual(len(diagnostics.processes), MAX_PROCESSES)
        handles[0].close.assert_called_once()
        diagnostics.close()
        diagnostics.close()
        for handle in handles:
            handle.close.assert_called_once()


class AsyncDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_wrappers_preserve_identity_outcomes_and_expected_fixture_error(self):
        result = object()
        stop_result = object()
        failure = KodiWorkerError("module_error")
        cancellation = asyncio.CancelledError()
        raised = None

        async def execute():
            if raised is not None:
                raise raised
            return result

        async def stop(_process):
            return stop_result

        worker = SimpleNamespace(_execute=execute, _stop=stop)
        resolution = ResolutionResult([], (ResolverOutcome(CANARY, "ok", True),))

        async def resolve():
            return resolution

        registry = SimpleNamespace(_resolvers={CANARY: worker}, resolve_with_outcomes=resolve)
        diagnostics = WorkerDiagnostics([worker], expected_module_errors=[worker])
        output = io.StringIO()
        with redirect_stderr(output), diagnostics.observe(registry, subprocesses=False):
            self.assertIs(await worker._execute(), result)
            self.assertIs(await worker._stop(object()), stop_result)
            self.assertIs(await registry.resolve_with_outcomes(), resolution)
            for error in (failure, cancellation):
                raised = error
                with self.assertRaises(type(error)) as caught:
                    await worker._execute()
                self.assertIs(caught.exception, error)
        self.assertEqual(output.getvalue(), "")
        self.assertIs(worker._execute, execute)
        events = list(diagnostics.events)
        self.assertTrue(next(event for event in events if event.get("code") == "module_error")["expected_fixture_error"])
        self.assertFalse(next(event for event in events if event.get("code") == "cancelled")["expected_fixture_error"])
        self.assertTrue(next(event for event in events if event["event"] == "resolver_outcome")["operational"])
        self.assertNotIn(CANARY, json.dumps(events))
        diagnostics.close()

    async def test_real_worker_handles_closed_after_success_and_controlled_failure(self):
        worker = manager()
        diagnostics = WorkerDiagnostics([worker])
        output = io.StringIO()
        with redirect_stderr(output), diagnostics.on_failure("http"):
            result = await worker.resolve(media())
            handle = diagnostics.processes[0][2]
            self.assertEqual(handle.state(), "exited" if os.name == "nt" else "unavailable")
        self.assertTrue(result)
        self.assertEqual((diagnostics.created, diagnostics.completed), (1, 1))
        self.assertEqual(output.getvalue(), "")
        self.assertIsNone(handle.handle)

        diagnostics = WorkerDiagnostics([worker])
        failure = AssertionError(CANARY)
        output = io.StringIO()
        with redirect_stderr(output):
            with self.assertRaises(AssertionError) as caught:
                with diagnostics.on_failure("http"):
                    await worker.resolve(media())
                    retained = diagnostics.processes[0][2]
                    raise failure
        self.assertIs(caught.exception, failure)
        self.assertIsNone(retained.handle)
        self.assertEqual(list(diagnostics.events), [])
        self.assertNotIn(CANARY, output.getvalue())
        self.assertEqual(output.getvalue().count("PYTHON_WORKER_DIAGNOSTIC "), 1)

    async def test_failure_capture_closes_handles_and_restores_patch_on_cancellation(self):
        diagnostics = WorkerDiagnostics()
        create = asyncio.create_subprocess_exec
        failure = asyncio.CancelledError()
        handle = Mock()
        handle.state.return_value = "unavailable"
        output = io.StringIO()
        with redirect_stderr(output), patch("tests.worker_diagnostics.KernelHandle", return_value=handle):
            with self.assertRaises(asyncio.CancelledError) as caught:
                with diagnostics.on_failure("http"):
                    diagnostics.process_created(SimpleNamespace(returncode=None))
                    raise failure
        self.assertIs(caught.exception, failure)
        handle.close.assert_called_once()
        self.assertIs(asyncio.create_subprocess_exec, create)
        self.assertEqual(list(diagnostics.processes), [])
