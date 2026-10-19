from __future__ import annotations

import json
import http.client
import asyncio
import socket
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from adapter_host.app import create_server
from adapter_host.config import AdapterSettings, KodiResolverProfile
from adapter_host.models import MediaItem, StreamSource
from adapter_host.registry import ResolverRegistry
from adapter_host.resolver import Resolver
from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerProcessManager
from adapter_host.kodi_installed_resolver import KodiInstalledResolver


FIXTURE = Path(__file__).parent / "fixtures" / "fake_kodi_addon"


class CancellableResolver(Resolver):
    id = "cancellable"
    name = "Cancellable resolver"
    timeout_seconds = 0.5

    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancelled = threading.Event()

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        self.started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class QueueSlowResolver(CancellableResolver):
    timeout_seconds = 0.06

    def __init__(self, resolver_id: str) -> None:
        super().__init__()
        self.id = resolver_id


class HttpApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = create_server(0)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path: str, payload: object | None = None) -> tuple[int, dict[str, object]]:
        data = None if payload is None else json.dumps(payload).encode()
        request = Request(f"http://127.0.0.1:{self.port}{path}", data=data,
                          headers={"Content-Type": "application/json"} if data else {})
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_health_and_resolvers(self) -> None:
        self.assertEqual(self.server.socket.getsockname()[0], "127.0.0.1")
        status, health = self.request("/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertEqual(health["activeResolvers"], 1)
        self.assertEqual(health["maxConcurrentResolvers"], 4)
        self.assertEqual(health["resolverTimeoutSeconds"], 6.0)
        self.assertEqual(health["requestTimeoutSeconds"], 8.0)
        status, body = self.request("/resolvers")
        self.assertEqual(status, 200)
        self.assertEqual(body["resolvers"][0]["id"], "example_authorized")  # type: ignore[index]
        self.assertEqual(body["resolvers"][1]["id"], "kodi_installed")  # type: ignore[index]
        self.assertEqual(body["resolvers"][1]["status"], "disabled")  # type: ignore[index]

    def test_http_contract_methods_and_headers(self) -> None:
        # INTEGRATION: the actual server and routing; default resolvers remain local.
        cases = [("GET", "/health", 200), ("GET", "/resolvers", 200),
                 ("GET", "/resolve", 404), ("POST", "/health", 404),
                 ("PUT", "/resolve", 405), ("PATCH", "/health", 405),
                 ("DELETE", "/resolvers", 405), ("HEAD", "/health", 501),
                 ("OPTIONS", "/resolve", 501)]
        for method, path, expected in cases:
            with self.subTest(method=method, path=path):
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                try:
                    connection.request(method, path)
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, expected)
                    if method == "HEAD":
                        self.assertEqual(body, b"")
                    if expected != 501:
                        self.assertEqual(response.getheader("Content-Type"), "application/json; charset=utf-8")
                        self.assertEqual(response.getheader("Content-Length"), str(len(body)))
                        self.assertEqual(response.getheader("Cache-Control"), "no-store")
                        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
                        self.assertIsInstance(json.loads(body), dict)
                finally:
                    connection.close()

    def test_http_contract_body_validation_and_limits(self) -> None:
        cases = [
            (b"{}", "text/plain", 415),
            (b'{"id":', "application/json", 400),
            (b"\xff", "application/json", 400),
            (b"[]", "application/json", 400),
            (b"x" * 32769, "application/json", 413),
            (json.dumps({"id": "fixture", "kind": "movie", "title": "Synthetic",
                         "module": "synthetic-private-module"}).encode(), "application/json", 400),
        ]
        for body, content_type, status in cases:
            with self.subTest(content_type=content_type, status=status, size=len(body)):
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                try:
                    connection.request("POST", "/resolve", body, {"Content-Type": content_type})
                    response = connection.getresponse()
                    payload = json.loads(response.read())
                    self.assertEqual(response.status, status)
                    self.assertEqual(set(payload), {"error"})
                    self.assertIsInstance(payload["error"], str)
                    self.assertNotIn("synthetic-private-module", payload["error"])
                    self.assertNotIn("Traceback", payload["error"])
                finally:
                    connection.close()

    def test_http_contract_chunked_limit_and_exact_length_boundary(self) -> None:
        valid = b'{"id":"synthetic","type":"movie","title":"Synthetic"}'
        for body, chunked, status in [(valid + b" " * (32768 - len(valid)), False, 200),
                                      (valid, True, 200), (b"x" * 32769, True, 413)]:
            with self.subTest(chunked=chunked, size=len(body)):
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                try:
                    connection.request("POST", "/resolve", iter([body]) if chunked else body,
                                       {"Content-Type": "application/json; charset=utf-8"},
                                       encode_chunked=chunked)
                    response = connection.getresponse()
                    payload = json.loads(response.read())
                    self.assertEqual(response.status, status)
                    if status == 200:
                        self.assertEqual(payload, {"streams": []})
                    else:
                        self.assertEqual(payload, {"error": "request too large"})
                finally:
                    connection.close()

    def test_http_contract_required_and_optional_media_fields(self) -> None:
        # An unknown synthetic identity produces no external discovery or network IO.
        base = {"id": "synthetic:contract", "kind": "movie", "title": "Synthetic"}
        self.assertEqual(self.request("/resolve", base), (200, {"streams": []}))
        optional = {**base, "year": 2026, "season": 1, "episode": 2,
                    "externalIds": {"synthetic": "fixture"}, "classifications": ["synthetic"],
                    "stremio": {"type": "movie"}, "metadata": {}, "seriesTitle": "Synthetic series"}
        self.assertEqual(self.request("/resolve", optional), (200, {"streams": []}))
        for field in ("id", "kind", "title"):
            missing = dict(base)
            del missing[field]
            with self.subTest(missing=field):
                self.assertEqual(self.request("/resolve", missing)[0], 400)

    def test_resolve_returns_https_and_magnet(self) -> None:
        status, body = self.request("/resolve", {"id": "python-adapter:test", "type": "movie", "title": "Big Buck Bunny"})
        self.assertEqual(status, 200)
        self.assertEqual({stream["type"] for stream in body["streams"]}, {"https", "magnet"})  # type: ignore[union-attr]

    def test_rejects_invalid_input_and_unknown_routes(self) -> None:
        self.assertEqual(self.request("/resolve", {"id": "x"})[0], 400)
        for field in ("module", "class", "script", "path"):
            for value in ("../../evil", "..\\..\\evil", "os.system", "subprocess", "module && command",
                          "C:\\absolute\\path", "\\\\server\\share", "module\x00value"):
                with self.subTest(field=field, value=value):
                    forbidden = {"id": "x", "type": "movie", "title": "X", field: value}
                    self.assertEqual(self.request("/resolve", forbidden)[0], 400)
        self.assertEqual(self.request("/not-an-endpoint")[0], 404)

    def test_rejects_request_controlled_worker_adapter_configuration(self) -> None:
        for field in ("adapterConfig", "adapter_config", "profiles", "PYTHON_ADAPTER_KODI_PROFILE_CONFIG",
                      "resolver", "resolverId", "profile", "module", "callable", "addonPath", "profilePath",
                      "settingsFile", "addon_path", "profile_path", "settings_file"):
            with self.subTest(field=field):
                status, body = self.request("/resolve", {
                    "id": "tt1234567", "kind": "movie", "title": "Fixture",
                    field: {"sourceModule": "request_controlled_module"},
                })
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "request contains unsupported fields"})

    def test_client_disconnect_cancels_resolver_task(self) -> None:
        resolver = CancellableResolver()
        registry = ResolverRegistry(default_timeout_seconds=0.5)
        registry.register(resolver)
        settings = AdapterSettings(resolver_timeout_seconds=0.5, request_timeout_seconds=0.8)
        server = create_server(0, registry, settings)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
        body = b'{"id":"cancel","type":"movie","title":"Cancel"}'
        client.sendall(
            b"POST /resolve HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n\r\n".encode()
            + body
        )
        self.assertTrue(resolver.started.wait(1))
        client.close()
        self.assertTrue(resolver.cancelled.wait(1), "resolver task was left running after disconnect")
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    def test_global_request_timeout_is_distinct_from_resolver_timeout(self) -> None:
        registry = ResolverRegistry(default_timeout_seconds=0.06, max_concurrent_resolvers=1)
        registry.register(QueueSlowResolver("queued-a"))
        registry.register(QueueSlowResolver("queued-b"))
        settings = AdapterSettings(
            resolver_timeout_seconds=0.06,
            request_timeout_seconds=0.1,
            max_concurrent_resolvers=1,
        )
        server = create_server(0, registry, settings)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        body = json.dumps({"id": "timeout", "type": "movie", "title": "Timeout"}).encode()
        request = Request(
            f"http://127.0.0.1:{server.server_address[1]}/resolve",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        started = time.monotonic()
        try:
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=1)
            self.assertEqual(caught.exception.code, 504)
            self.assertLess(time.monotonic() - started, 0.3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_client_disconnect_terminates_kodi_worker(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="fake_kodi_module",
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=5,
        ))
        registry = ResolverRegistry(default_timeout_seconds=2)
        registry.register(KodiInstalledResolver(manager))
        settings = AdapterSettings(resolver_timeout_seconds=2, request_timeout_seconds=3)
        server = create_server(0, registry, settings)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=1)
        body = b'{"id":"fixture:ignore-cancellation","type":"movie","title":"Cancel worker"}'
        client.sendall(
            b"POST /resolve HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n\r\n".encode()
            + body
        )
        deadline = time.monotonic() + 2
        while manager.active_count == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(manager.active_count, 1)
        client.close()
        deadline = time.monotonic() + 2
        while manager.active_count != 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(manager.active_count, 0, "Kodi worker survived the HTTP disconnect")
        self.assertEqual(len(manager.completed_pids), 1)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    def test_configured_broken_kodi_resolver_is_explicitly_unavailable(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="missing_fixture_module",
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
        ))
        registry = ResolverRegistry(default_timeout_seconds=2)
        registry.register(KodiInstalledResolver(manager))
        settings = AdapterSettings(resolver_timeout_seconds=2, request_timeout_seconds=3, kodi_profiles=(
            KodiResolverProfile(
                id="kodi_installed", name="Broken configured profile", enabled=True,
                addon_path=FIXTURE, addon_id="script.module.fake", module="missing_fixture_module",
                callable="resolve", worker_timeout_seconds=1,
            ),
        ))
        server = create_server(0, registry, settings)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                f"http://127.0.0.1:{server.server_address[1]}/resolve",
                data=b'{"id":"broken","type":"movie","title":"Broken"}',
                headers={"Content-Type": "application/json"},
            )
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=2)
            self.assertEqual(caught.exception.code, 503)
            self.assertEqual(json.load(caught.exception)["error"], "configured resolvers unavailable")
            status, body = self._request_server(server, "/resolvers")
            self.assertEqual(status, 200)
            self.assertEqual(body["resolvers"][0]["status"], "resolver_error")  # type: ignore[index]
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    @staticmethod
    def _request_server(server: object, path: str, payload: object | None = None) -> tuple[int, dict[str, object]]:
        port = getattr(server, "server_address")[1]
        data = None if payload is None else json.dumps(payload).encode()
        request = Request(f"http://127.0.0.1:{port}{path}", data=data,
                          headers={"Content-Type": "application/json"} if data else {})
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)


if __name__ == "__main__":
    unittest.main()
