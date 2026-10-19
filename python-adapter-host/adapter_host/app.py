from __future__ import annotations

import asyncio
import json
import logging
import select
import socket
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from .example_resolver import ExampleResolver
from .config import AdapterSettings, require_isolated_host_environment
from .models import MediaItem
from .registry import ResolutionResult, ResolverRegistry
from .kodi_installed_resolver import KodiInstalledResolver

MAX_REQUEST_BYTES = 32_768
LOGGER = logging.getLogger("adapter_host.http")


class _PrivateHttpLogMetadataFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # A full LogRecord export must not expose local source paths.
        record.pathname = "adapter_host.http"
        return True


LOGGER.addFilter(_PrivateHttpLogMetadataFilter())
HTTP_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"})
HTTP_ENDPOINTS = frozenset({"/health", "/resolvers", "/resolve"})


def _error_category(error: BaseException | None) -> str:
    # Exact types only: exception names and messages can be supplied by dependencies.
    return {
        BrokenPipeError: "BrokenPipeError", ConnectionResetError: "ConnectionResetError",
        ConnectionAbortedError: "ConnectionAbortedError", TimeoutError: "TimeoutError",
        OSError: "OSError", ValueError: "ValueError", RuntimeError: "RuntimeError",
        TypeError: "TypeError", AttributeError: "AttributeError",
    }.get(type(error), "UnexpectedError")


class AdapterHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        # Keep socketserver's shutdown/close lifecycle, but never its raw traceback.
        LOGGER.error("HTTP connection failure", extra={
            "event": "http_connection_failure", "stage": "request_lifecycle",
            "error_type": _error_category(sys.exc_info()[1]),
        })


class RequestTooLarge(ValueError):
    pass


class ClientDisconnected(Exception):
    pass


class AdapterRequestTimeout(Exception):
    pass


class RequiredResolverUnavailable(Exception):
    pass


def default_registry(settings: AdapterSettings | None = None) -> ResolverRegistry:
    active_settings = settings or AdapterSettings.from_environment()
    registry = ResolverRegistry(
        default_timeout_seconds=active_settings.resolver_timeout_seconds,
        maximum_results=active_settings.max_total_results,
        maximum_results_per_resolver=active_settings.max_results_per_resolver,
        max_concurrent_resolvers=active_settings.max_concurrent_resolvers,
    )
    registry.register(ExampleResolver())
    if not active_settings.kodi_profiles:
        registry.register(KodiInstalledResolver(), enabled=False)
    for profile in active_settings.kodi_profiles:
        registry.register(
            KodiInstalledResolver.from_profile(
                profile, maximum_results=active_settings.max_results_per_resolver,
            ),
            enabled=profile.enabled,
        )
    return registry


def create_server(port: int, registry: ResolverRegistry | None = None,
                  settings: AdapterSettings | None = None) -> ThreadingHTTPServer:
    require_isolated_host_environment()
    if isinstance(port, bool) or not 0 <= port <= 65_535:
        raise ValueError("port must be between 0 and 65535")
    active_settings = settings or AdapterSettings.from_environment()
    active_registry = registry or default_registry(active_settings)
    active_registry.validate_timeout_hierarchy(active_settings.request_timeout_seconds)

    class Handler(AdapterRequestHandler):
        resolver_registry = active_registry
        adapter_settings = active_settings

    # The address is intentionally constant and cannot be overridden by a request.
    return AdapterHTTPServer(("127.0.0.1", port), Handler)


class AdapterRequestHandler(BaseHTTPRequestHandler):
    resolver_registry: ResolverRegistry
    adapter_settings: AdapterSettings
    server_version = "TriblerStremioPythonAdapter/0.1"
    sys_version = ""

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        try:
            urlsplit(self.path)
        except ValueError:
            self.close_connection = True
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid request target"})
            return False
        return True

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(HTTPStatus.OK, {
                "ok": True,
                "service": "tribler-stremio-python-adapter",
                "activeResolvers": self.resolver_registry.enabled_count(),
                "maxConcurrentResolvers": self.resolver_registry.max_concurrent_resolvers,
                "resolverTimeoutSeconds": self.resolver_registry.default_timeout_seconds,
                "requestTimeoutSeconds": self.adapter_settings.request_timeout_seconds,
            })
        elif path == "/resolvers":
            self._json(HTTPStatus.OK, {"resolvers": self.resolver_registry.list_resolvers()})
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/resolve":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "content type must be application/json"})
                return
            body = self._read_limited_body()
            item = MediaItem.from_json(json.loads(body.decode("utf-8")))
            resolution = asyncio.run(self._resolve_until_disconnect(item))
            if self._configured_resolver_failed(resolution):
                raise RequiredResolverUnavailable
            self._json(HTTPStatus.OK, {"streams": resolution.streams})
        except ClientDisconnected:
            LOGGER.info("Client disconnected; resolver work cancelled")
        except AdapterRequestTimeout:
            self._json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "request timeout"})
        except RequiredResolverUnavailable:
            # The configured local resolver is the requested capability. Do not
            # quietly substitute unrelated resolver output for a broken setup.
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "configured resolvers unavailable"})
        except RequestTooLarge:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request too large"})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)[:200]})
        except Exception as error:
            LOGGER.error("Unhandled adapter request failure", extra={
                "event": "http_request_failure", "stage": "resolve",
                "error_type": _error_category(error),
            })
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal server error"})

    async def _resolve_until_disconnect(self, item: MediaItem) -> ResolutionResult:
        resolve_task = asyncio.create_task(self.resolver_registry.resolve_with_outcomes(item))
        disconnect_task = asyncio.create_task(self._wait_for_disconnect())
        try:
            done, _ = await asyncio.wait(
                {resolve_task, disconnect_task},
                timeout=self.adapter_settings.request_timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if resolve_task in done:
                return await resolve_task
            resolve_task.cancel()
            await asyncio.gather(resolve_task, return_exceptions=True)
            if disconnect_task in done:
                raise ClientDisconnected
            raise AdapterRequestTimeout
        finally:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)

    async def _wait_for_disconnect(self) -> None:
        while True:
            await asyncio.sleep(0.05)
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                if readable and self.connection.recv(1, socket.MSG_PEEK) == b"":
                    return
            except (ConnectionError, OSError, ValueError):
                return

    def _configured_resolver_failed(self, resolution: ResolutionResult) -> bool:
        configured_ids = {profile.id for profile in self.adapter_settings.kodi_profiles if profile.enabled}
        participating = [outcome for outcome in resolution.outcomes if outcome.id in configured_ids]
        return bool(participating) and not any(outcome.operational for outcome in participating)

    def do_PUT(self) -> None:
        self._method_not_allowed()

    do_DELETE = do_PUT
    do_PATCH = do_PUT

    def _method_not_allowed(self) -> None:
        self._json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})

    def _read_limited_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length")
        transfer_encoding = self.headers.get("Transfer-Encoding", "").lower()
        if raw_length is not None:
            length = int(raw_length)
            if length < 0 or length > MAX_REQUEST_BYTES:
                raise RequestTooLarge
            return self.rfile.read(length)
        if transfer_encoding != "chunked":
            raise ValueError("content length or chunked encoding required")
        result = bytearray()
        while True:
            line = self.rfile.readline(128)
            if not line.endswith(b"\r\n") or len(line) >= 128:
                raise ValueError("invalid chunked request")
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError as error:
                raise ValueError("invalid chunked request") from error
            if size < 0 or len(result) + size > MAX_REQUEST_BYTES:
                raise RequestTooLarge
            if size == 0:
                # Accept trailers syntactically but never expose or use them.
                trailer_bytes = 0
                while True:
                    trailer = self.rfile.readline(1024)
                    trailer_bytes += len(trailer)
                    if trailer == b"\r\n":
                        return bytes(result)
                    if not trailer.endswith(b"\r\n") or len(trailer) >= 1024 or trailer_bytes > 8192:
                        raise ValueError("invalid chunked request")
            chunk = self.rfile.read(size)
            if len(chunk) != size or self.rfile.read(2) != b"\r\n":
                raise ValueError("invalid chunked request")
            result.extend(chunk)

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status.value)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.info("Client disconnected before response was written")

    def log_message(self, format_string: str, *args: object) -> None:
        # Inherited callbacks can contain targets, parser input and exception text.
        # Never format or retain their arguments, even in LogRecord extras.
        self._log_http(logging.INFO, "http_message", "http")

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        status = int(code) if isinstance(code, (int, HTTPStatus)) and not isinstance(code, bool) else None
        self._log_http(logging.INFO, "http_response", "response", status)

    def log_error(self, format_string: str, *args: object) -> None:
        self._log_http(logging.WARNING, "http_error", "protocol")

    def _log_http(self, level: int, event: str, stage: str, status: int | None = None) -> None:
        method = getattr(self, "command", None)
        try:
            path = urlsplit(getattr(self, "path", "")).path
        except ValueError:
            path = ""
        metadata = {
            "event": event, "stage": stage,
            "method": method if method in HTTP_METHODS else "UNKNOWN",
            "endpoint": path if path in HTTP_ENDPOINTS else "OTHER",
        }
        if status is not None and 100 <= status <= 599:
            metadata["status"] = status
        LOGGER.log(level, "HTTP request", extra=metadata)
