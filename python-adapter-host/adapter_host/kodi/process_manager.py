from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
import uuid

from .adapter_config import WORKER_PROFILE_CONFIG_ENV, encode_adapter_config, freeze_adapter_config
from .python_roots import AddonPythonRoots
from .windows_job import WindowsWorkerJob
from .protocol import (
    MAX_INPUT_BYTES,
    MAX_OUTPUT_BYTES,
    MAX_STDERR_BYTES,
    ProtocolError,
    decode_response,
    decode_evaluation_source_ids,
    encode_message,
    MAX_WORKER_RESULTS,
)

_IMPORT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
_CALLABLE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_EVALUATION_SOURCE = re.compile(r"[A-Za-z0-9_.-]{1,512}")
_EVALUATION_ADAPTERS = {"adapter_host.kodi.adapters.source_pack",
                        "adapter_host.kodi.adapters.external_scraper_package"}


class KodiWorkerError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class KodiWorkerConfig:
    addon_path: Path
    module_name: str
    callable_name: str = "resolve"
    addon_id: str = "script.module.local"
    settings_file: Path | None = None
    profile_path: Path | None = None
    timeout_seconds: float = 5.0
    maximum_results: int = 20
    terminate_grace_seconds: float = 0.2
    adapter_config: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "adapter_config", freeze_adapter_config(self.adapter_config))

    def validate_structure(self) -> None:
        """Validate startup data without importing code or accessing addon files."""
        if (not isinstance(self.module_name, str) or not _IMPORT_NAME.fullmatch(self.module_name)
                or self.module_name.split(".")[-1] in {"default", "service"}):
            raise ValueError("Kodi module name is invalid or forbidden")
        if not isinstance(self.callable_name, str) or not _CALLABLE_NAME.fullmatch(self.callable_name):
            raise ValueError("Kodi callable name is invalid")
        if self.module_name == "adapter_host.kodi.adapters.callable_stream_resolver":
            from .adapters.callable_stream_resolver import validate_configuration
            if self.callable_name != "resolve":
                raise ValueError("callable adapter entrypoint must be resolve")
            validate_configuration(self.adapter_config)
        if self.module_name == "adapter_host.kodi.adapters.source_pack":
            from .adapters.source_pack import validate_configuration
            if self.callable_name != "resolve":
                raise ValueError("source pack entrypoint must be resolve")
            validate_configuration(self.adapter_config)
        if not isinstance(self.addon_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", self.addon_id):
            raise ValueError("Kodi addon id is invalid")
        if (type(self.timeout_seconds) not in (int, float) or not 0 < self.timeout_seconds <= 300
                or not 1 <= self.maximum_results <= 100):
            raise ValueError("Kodi worker limits are invalid")
        if not 0.01 <= self.terminate_grace_seconds <= 5:
            raise ValueError("Kodi worker termination grace is invalid")

    def validated(self) -> "KodiWorkerConfig":
        self.validate_structure()
        addon = AddonPythonRoots.discover(self.addon_path).addon
        settings = self.settings_file.resolve(strict=True) if self.settings_file is not None else None
        if settings is not None and (not settings.is_file() or settings.stat().st_size > 16_384):
            raise ValueError("Kodi settings file is invalid")
        profile = self.profile_path.resolve(strict=False) if self.profile_path is not None else None
        return KodiWorkerConfig(
            addon, self.module_name, self.callable_name, self.addon_id, settings, profile,
            self.timeout_seconds, self.maximum_results, self.terminate_grace_seconds, self.adapter_config,
        )


class KodiWorkerProcessManager:
    def __init__(self, config: KodiWorkerConfig) -> None:
        self.config = config.validated()
        self._active: dict[int, asyncio.subprocess.Process] = {}
        self.completed_pids: list[int] = []

    @property
    def active_count(self) -> int:
        return len(self._active)

    async def resolve(self, media: dict[str, Any]) -> list[dict[str, Any]]:
        return await self._execute(media)

    async def evaluation_source_ids(self) -> list[str]:
        """Local developer API; never called from the HTTP request path."""
        if self.config.module_name not in _EVALUATION_ADAPTERS:
            raise ValueError("evaluation adapter unavailable")
        return await self._execute({}, evaluation_source="*")

    async def evaluate_source(self, media: dict[str, Any], source_id: str) -> list[dict[str, Any]]:
        if self.config.module_name not in _EVALUATION_ADAPTERS or not isinstance(source_id, str) or len(source_id) > 512 or not _EVALUATION_SOURCE.fullmatch(source_id):
            raise ValueError("evaluation source is invalid")
        return await self._execute(media, evaluation_source=source_id)

    async def _execute(self, media: dict[str, Any], evaluation_source: str | None = None) -> Any:
        request = {"requestId": uuid.uuid4().hex, "media": media}
        encoded = encode_message(request, MAX_INPUT_BYTES)
        profile_config = encode_adapter_config(self.config.adapter_config)
        temporary: tempfile.TemporaryDirectory[str] | None = None
        if self.config.profile_path is None:
            temporary = tempfile.TemporaryDirectory(prefix="tribler-kodi-worker-")
            profile_path = Path(temporary.name)
        else:
            profile_path = self.config.profile_path
            profile_path.mkdir(parents=True, exist_ok=True)
        arguments = self._arguments(profile_path, evaluation_source)
        environment = _minimal_environment()
        environment["PYTHON_ADAPTER_WORKER_MAX_RESULTS"] = str(self.config.maximum_results)
        environment[WORKER_PROFILE_CONFIG_ENV] = profile_config
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        process: asyncio.subprocess.Process | None = None
        tasks: list[asyncio.Task[Any]] = []
        gathered: asyncio.Future[Any] | None = None
        job: WindowsWorkerJob | None = None
        try:
            if os.name == "nt":
                try:
                    job = WindowsWorkerJob()
                except OSError as error:
                    raise KodiWorkerError("worker_ownership_error") from error
            process = await asyncio.create_subprocess_exec(
                *arguments,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=Path(__file__).resolve().parents[2],
                env=environment,
                creationflags=creationflags,
            )
            # A fully closed asyncio transport may have released the original
            # process handle. Never reopen an already-exited worker by stale PID.
            if process.returncode is not None:
                raise KodiWorkerError("worker_process_error")
            if job is not None:
                try:
                    job.assign(process.pid)
                except OSError as error:
                    raise KodiWorkerError("worker_ownership_error") from error
            if process.stdin is None or process.stdout is None or process.stderr is None:
                raise KodiWorkerError("worker_pipe_error")
            self._active[process.pid] = process
            process.stdin.write(encoded)
            await process.stdin.drain()
            process.stdin.close()
            tasks = [
                asyncio.create_task(process.wait()),
                asyncio.create_task(_read_bounded(process.stdout, MAX_OUTPUT_BYTES)),
                asyncio.create_task(_read_bounded(process.stderr, MAX_STDERR_BYTES)),
            ]
            gathered = asyncio.gather(*tasks)
            try:
                return_code, stdout, _stderr = await asyncio.wait_for(
                    gathered, timeout=self.config.timeout_seconds
                )
            except asyncio.TimeoutError as error:
                raise KodiWorkerError("worker_timeout") from error
            except _StreamLimitError as error:
                raise KodiWorkerError(error.code) from error
            if return_code != 0:
                raise KodiWorkerError("worker_process_error")
            try:
                if evaluation_source == "*":
                    response = decode_evaluation_source_ids(stdout)
                else:
                    response = decode_response(stdout, MAX_WORKER_RESULTS if evaluation_source else self.config.maximum_results)
            except ProtocolError as error:
                code = str(error)[7:] if str(error).startswith("worker:") else "worker_protocol_error"
                raise KodiWorkerError(code) from error
            return response if evaluation_source == "*" else response.results
        except asyncio.CancelledError:
            raise
        finally:
            async def cleanup() -> None:
                try:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                    if gathered is not None:
                        await asyncio.gather(gathered, return_exceptions=True)
                    if process is not None:
                        await self._stop(process)
                        self._active.pop(process.pid, None)
                        self.completed_pids.append(process.pid)
                        # Recent diagnostics only; never retain every past PID.
                        del self.completed_pids[:-100]
                finally:
                    if job is not None:
                        job.close()
                    if temporary is not None:
                        temporary.cleanup()

            # A second cancellation must not interrupt terminate/kill/wait or
            # skip closing the kernel job. Keep owning cleanup until it finishes.
            cleanup_task = asyncio.create_task(cleanup())
            cancelled_during_cleanup = False
            while not cleanup_task.done():
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError:
                    cancelled_during_cleanup = True
            cleanup_task.result()
            if cancelled_during_cleanup:
                raise asyncio.CancelledError

    def _arguments(self, profile_path: Path, evaluation_source: str | None = None) -> list[str]:
        config = self.config
        result = [
            sys.executable, "-B", "-m", "adapter_host.kodi.worker",
            "--addon-path", str(config.addon_path),
            "--profile-path", str(profile_path.resolve(strict=False)),
            "--addon-id", config.addon_id,
            "--module", config.module_name,
            "--callable", config.callable_name,
            "--maximum-results", str(MAX_WORKER_RESULTS if evaluation_source else config.maximum_results),
        ]
        if evaluation_source is not None:
            result.extend(["--evaluation-source", evaluation_source])
        if config.settings_file is not None:
            result.extend(["--settings-file", str(config.settings_file)])
        return result

    async def _stop(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            await process.wait()
            return
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=self.config.terminate_grace_seconds)
            return
        except asyncio.TimeoutError:
            pass
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


class _StreamLimitError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def _read_bounded(stream: asyncio.StreamReader, maximum: int) -> bytes:
    data = bytearray()
    while True:
        chunk = await stream.read(min(65_536, maximum - len(data) + 1))
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > maximum:
            code = "worker_output_too_large" if maximum == MAX_OUTPUT_BYTES else "worker_stderr_too_large"
            raise _StreamLimitError(code)


def _minimal_environment() -> dict[str, str]:
    environment: dict[str, str] = {}
    # Windows Python needs SYSTEMROOT for Winsock/DNS; no other ambient OS
    # configuration is inherited. POSIX workers start with no OS variables.
    if os.name == "nt":
        system_root = os.environ.get("SYSTEMROOT")
        if system_root is not None:
            environment["SYSTEMROOT"] = system_root
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    return environment
