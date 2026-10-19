from __future__ import annotations

from contextlib import redirect_stderr
import http.client
import io
import logging
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch

from adapter_host.app import LOGGER, create_server
from adapter_host.config import AdapterSettings
from adapter_host.registry import ResolverRegistry


SECRET = "SYNTHETIC_PRIVATE_MARKER"


class HttpLoggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.records: list[logging.LogRecord] = []
        records = self.records

        class Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        self.old_logging = LOGGER.handlers[:], LOGGER.level, LOGGER.propagate
        LOGGER.handlers, LOGGER.propagate = [Capture()], False
        LOGGER.setLevel(logging.INFO)
        self.stderr = io.StringIO()
        self.redirect = redirect_stderr(self.stderr)
        self.redirect.__enter__()
        self.server = create_server(0, registry=ResolverRegistry(), settings=AdapterSettings())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.redirect.__exit__(None, None, None)
        LOGGER.handlers, level, LOGGER.propagate = self.old_logging
        LOGGER.setLevel(level)

    def request(self, method: str, path: str) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            connection.request(method, path, headers={"Authorization": SECRET})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def raw_request(self, line: bytes, allow_reset: bool = False) -> bytes:
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2) as connection:
            connection.sendall(line + b"\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            chunks = []
            try:
                while chunk := connection.recv(4096):
                    chunks.append(chunk)
            except ConnectionError:
                if not allow_reset:
                    raise
            return b"".join(chunks)

    def assert_private(self, output: bytes = b"") -> None:
        # Inspect every field, including args/exc_info, then simulate an exporter
        # that serializes all LogRecord attributes rather than the default format.
        rendered = repr([record.__dict__ for record in self.records])
        for record in self.records:
            rendered += logging.Formatter("%(message)s %(event)s %(stage)s").format(record)
            self.assertEqual(record.pathname, "adapter_host.http")
            self.assertIsNone(record.exc_info)
            self.assertIsNone(record.stack_info)
            self.assertNotIn("request", record.__dict__)
        combined = rendered + self.stderr.getvalue() + output.decode("utf-8", errors="replace")
        for forbidden in (SECRET, "Traceback (most recent call last)"):
            self.assertNotIn(forbidden, combined)
        root = str(Path(__file__).resolve().parents[1])
        self.assertNotIn(root, combined)
        self.assertNotIn(root.replace("\\", "\\\\"), combined)
        self.assertEqual(self.stderr.getvalue(), "")

    def test_query_and_extended_record_export_are_safe(self) -> None:
        for path, endpoint, status in (("/health", "/health", 200), ("/resolvers", "/resolvers", 200),
                                       ("/resolve", "/resolve", 404), ("/" + SECRET, "OTHER", 404)):
            self.assertEqual(self.request("GET", path + "?token=" + SECRET)[0], status)
            record = self.records[-1]
            self.assertEqual((record.method, record.endpoint, record.status), ("GET", endpoint, status))
            self.assertEqual((record.event, record.stage), ("http_response", "response"))
        self.assert_private()

    def test_unknown_method_and_parser_errors_are_safe(self) -> None:
        self.assertEqual(self.request("METHOD_" + SECRET, "/" + SECRET)[0], 501)
        self.assertEqual((self.records[-1].method, self.records[-1].endpoint), ("UNKNOWN", "OTHER"))
        self.raw_request(("GET /health?token=" + SECRET + " HTTP/" + SECRET).encode())
        self.assertTrue(any(record.levelno == logging.WARNING for record in self.records))
        self.assert_private()

    def test_malformed_absolute_targets_return_controlled_error_and_recover(self) -> None:
        for method in ("GET", "POST", "OPTIONS"):
            response = self.raw_request((method + " http://[?token=" + SECRET + " HTTP/1.1").encode())
            self.assertIn(b" 400 ", response)
            self.assertIn(b'{"error":"invalid request target"}', response)
            self.assert_private(response)
        self.assertEqual(self.request("GET", "/health")[0], 200)
        self.assert_private()

    def test_unexpected_lifecycle_failures_are_safe_and_connections_close(self) -> None:
        # Real server lifecycle with failures at boundaries outside do_POST.
        handler = self.server.RequestHandlerClass
        arbitrary_error = type(SECRET, (Exception,), {})
        for operation, error, category in (
            ("read", OSError(SECRET), "OSError"),
            ("write", RuntimeError(SECRET), "RuntimeError"),
            ("finish", arbitrary_error(SECRET), "UnexpectedError"),
        ):
            with self.subTest(operation=operation):
                done = threading.Event()
                original = self.server.handle_error
                original_setup, original_finish = handler.setup, handler.finish

                class FailingStream:
                    def __init__(self, stream: object, failing_method: str) -> None:
                        self.stream, self.failing_method = stream, failing_method

                    def __getattr__(self, name: str) -> object:
                        if name == self.failing_method:
                            def fail(*args: object) -> None:
                                raise error
                            return fail
                        return getattr(self.stream, name)

                def setup(instance: object) -> None:
                    original_setup(instance)
                    if operation == "read":
                        instance.rfile = FailingStream(instance.rfile, "readline")
                    elif operation == "write":
                        instance.wfile = FailingStream(instance.wfile, "write")

                def finish(instance: object) -> None:
                    original_finish(instance)
                    if operation == "finish":
                        raise error

                def observed(*args: object) -> None:
                    try:
                        original(*args)
                    finally:
                        done.set()

                with patch.object(handler, "setup", setup), patch.object(handler, "finish", finish), patch.object(self.server, "handle_error", observed):
                    response = self.raw_request(b"GET /health HTTP/1.1", allow_reset=True)
                    self.assertTrue(done.wait(2))
                record = next(record for record in reversed(self.records) if record.event == "http_connection_failure")
                self.assertEqual((record.levelno, record.stage, record.error_type),
                                 (logging.ERROR, "request_lifecycle", category))
                if operation != "finish":
                    self.assertNotIn(b" 200 ", response)
                self.assertEqual(self.request("GET", "/health")[0], 200)
                self.assert_private(response)

    def test_inherited_log_callbacks_ignore_free_text(self) -> None:
        handler = object.__new__(self.server.RequestHandlerClass)
        handler.command, handler.path = SECRET, "/" + SECRET
        handler.log_message("%s", SECRET)
        handler.log_error("%s", SECRET)
        handler.log_request(SECRET, SECRET)
        self.assertTrue(all(record.method == "UNKNOWN" and record.endpoint == "OTHER" for record in self.records))
        self.assertNotIn("status", self.records[-1].__dict__)
        self.assert_private()

    def test_unexpected_resolve_error_returns_generic_500(self) -> None:
        error = type(SECRET, (Exception,), {})(SECRET)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            with patch.object(self.server.RequestHandlerClass, "_resolve_until_disconnect", side_effect=error):
                connection.request("POST", "/resolve?token=" + SECRET,
                                   body=b'{"id":"synthetic","type":"movie","title":"Synthetic fixture"}',
                                   headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 500)
                self.assertEqual(response.read(), b'{"error":"internal server error"}')
            failure = next(record for record in self.records if record.event == "http_request_failure")
            self.assertEqual((failure.stage, failure.error_type), ("resolve", "UnexpectedError"))
            self.assert_private()
        finally:
            connection.close()
