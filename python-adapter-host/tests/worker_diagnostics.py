"""Bounded, failure-only test observations; never serialize worker input/output."""
from __future__ import annotations

import asyncio
from collections import deque
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
import json
import os
import sys
import time
from unittest.mock import patch

from adapter_host.kodi.process_manager import KodiWorkerError

MAX_EVENTS = 64
MAX_PROCESSES = 64
MAX_NUMBER = 1_000_000
WORKER_CODES = frozenset({
    "worker_timeout", "worker_process_error", "worker_ownership_error",
    "worker_pipe_error", "worker_protocol_error", "worker_output_too_large",
    "worker_stderr_too_large", "invalid_output", "sandbox_violation", "module_error",
})
EVENTS = frozenset({
    "operation_start", "operation_end", "operation_error", "process_created",
    "cleanup_start", "cleanup_end", "resolver_outcome", "request_start",
    "request_cancel", "process_kill", "request_end",
})
STATUSES = frozenset({"ok", "timeout", "resolver_error", "invalid_result"})
NUMBERS = frozenset({"request", "operation", "resolver", "process", "duration_ms"})


def number(value):
    return min(MAX_NUMBER, max(0, value)) if type(value) is int else 0


def error_code(error):
    # Do not invoke __str__/__repr__ on arbitrary plugin exceptions or arguments.
    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    if (type(error) is KodiWorkerError and len(error.args) == 1
            and type(error.args[0]) is str and error.args[0] in WORKER_CODES):
        return error.args[0]
    return "other"


class KernelHandle:
    """Duplicate asyncio's existing handle; never reopen a PID, even a live one.

    Private CPython transport details may be absent/closed. Report unavailable
    rather than guessing. A SYNCHRONIZE-only duplicate cannot keep a worker alive.
    """
    def __init__(self, process):
        self.handle = None
        self.kernel = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
                                          ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
                                          wintypes.BOOL, wintypes.DWORD]
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        try:
            popen = process._transport.get_extra_info("subprocess")
            source = int(popen._handle)
        except (AttributeError, TypeError, ValueError):
            return
        duplicate = wintypes.HANDLE()
        current = kernel.GetCurrentProcess()
        if kernel.DuplicateHandle(current, source, current, ctypes.byref(duplicate),
                                  0x100000, False, 0):  # SYNCHRONIZE, non-inheritable
            self.kernel, self.handle = kernel, duplicate

    def state(self):
        if self.handle is None:
            return "unavailable"
        result = self.kernel.WaitForSingleObject(self.handle, 0)
        return {0: "exited", 258: "live"}.get(result, "unavailable")

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class WorkerDiagnostics:
    def __init__(self, managers=(), *, expected_module_errors=()):
        self.managers = tuple(managers)
        self.expected_module_errors = tuple(expected_module_errors)
        self.events = deque(maxlen=MAX_EVENTS)
        self.processes = deque(maxlen=MAX_PROCESSES)
        self.started = time.monotonic()
        self.created = 0
        self.completed = 0
        self.operations = 0
        self.request = ContextVar("diagnostic_request", default=0)
        self.operation = ContextVar("diagnostic_operation", default=0)
        self.peak = 0
        self.peak_states = []
        self.peak_events = []

    def record(self, event, *, code=None, status=None, operational=None, expected=None, **values):
        if event not in EVENTS:
            return
        entry = {"event": event, "ms": number(round((time.monotonic() - self.started) * 1000)),
                 "request": number(self.request.get()), "operation": number(self.operation.get())}
        entry.update({key: number(value) for key, value in values.items() if key in NUMBERS})
        if code is not None:
            entry["code"] = code if type(code) is str and code in WORKER_CODES | {"cancelled"} else "other"
        if status is not None:
            entry["status"] = status if type(status) is str and status in STATUSES else "other"
        if type(operational) is bool:
            entry["operational"] = operational
        if type(expected) is bool:
            entry["expected_fixture_error"] = expected
        self.events.append(entry)

    def process_created(self, process):
        self.created += 1
        if len(self.processes) == MAX_PROCESSES:
            self.processes.popleft()[2].close()
        self.processes.append((self.created, process, KernelHandle(process)))
        self.record("process_created", process=self.created)

    def states(self):
        return [{"process": number(ordinal), "asyncio_pending": child.returncode is None,
                 "kernel": handle.state()} for ordinal, child, handle in self.processes]

    def process_ordinal(self, process):
        return next((ordinal for ordinal, child, _handle in self.processes if child is process), 0)

    def observe_peak(self, peak):
        if peak > self.peak:
            self.peak = peak
            self.peak_states = self.states()
            self.peak_events = list(self.events)

    def release_processes(self):
        # Release before quiescent handle-count samples in the stress harness.
        while self.processes:
            self.processes.popleft()[2].close()

    def emit(self, kind, *, peak=0, limit=0):
        payload = {"kind": kind if kind in {"http", "concurrency"} else "other",
                   "created": number(self.created), "completed": number(self.completed),
                   "peak": number(peak), "limit": number(limit),
                   "peak_states": self.peak_states, "peak_events": self.peak_events,
                   "states": self.states(),
                   "events": list(self.events)}
        print("PYTHON_WORKER_DIAGNOSTIC " + json.dumps(payload, separators=(",", ":")), file=sys.stderr)

    @contextmanager
    def observe(self, registry=None, *, subprocesses=True):
        with ExitStack() as stack:
            for ordinal, manager in enumerate(self.managers, 1):
                execute, stop = manager._execute, manager._stop

                async def observed_execute(*args, _execute=execute, _ordinal=ordinal,
                                           _expected=manager in self.expected_module_errors, **kwargs):
                    self.operations += 1
                    token = self.operation.set(self.operations)
                    started = time.monotonic()
                    self.record("operation_start", resolver=_ordinal)
                    try:
                        result = await _execute(*args, **kwargs)
                    except BaseException as error:
                        code = error_code(error)
                        self.record("operation_error", resolver=_ordinal, code=code,
                                    expected=_expected and code == "module_error",
                                    duration_ms=round((time.monotonic() - started) * 1000))
                        raise
                    else:
                        self.record("operation_end", resolver=_ordinal,
                                    duration_ms=round((time.monotonic() - started) * 1000))
                        return result
                    finally:
                        self.operation.reset(token)

                async def observed_stop(process, _stop=stop):
                    ordinal = self.process_ordinal(process)
                    self.record("cleanup_start", process=ordinal)
                    result = await _stop(process)
                    self.completed += 1
                    self.record("cleanup_end", process=ordinal)
                    return result

                stack.enter_context(patch.object(manager, "_execute", observed_execute))
                stack.enter_context(patch.object(manager, "_stop", observed_stop))
            if subprocesses:
                create = asyncio.create_subprocess_exec

                async def observed_create(*args, **kwargs):
                    process = await create(*args, **kwargs)
                    self.process_created(process)
                    return process

                stack.enter_context(patch("asyncio.create_subprocess_exec", observed_create))
            if registry is not None:
                resolve = registry.resolve_with_outcomes
                resolver_ordinals = {key: index for index, key in enumerate(registry._resolvers, 1)}

                async def observed_resolve(*args, **kwargs):
                    result = await resolve(*args, **kwargs)
                    for outcome in result.outcomes:
                        self.record("resolver_outcome", resolver=resolver_ordinals.get(outcome.id, 0),
                                    status=outcome.status, operational=outcome.operational)
                    return result

                stack.enter_context(patch.object(registry, "resolve_with_outcomes", observed_resolve))
            yield self

    @contextmanager
    def on_failure(self, kind, *, registry=None):
        try:
            with self.observe(registry):
                yield self
        except BaseException:
            self.emit(kind)
            raise
        finally:
            self.close()

    def close(self):
        self.release_processes()
        self.events.clear()
        self.peak_states.clear()
        self.peak_events.clear()
