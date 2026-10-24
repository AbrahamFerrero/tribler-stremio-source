from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, nullcontext
import os
import threading
import unittest
from unittest.mock import patch

from adapter_host.app import create_server, default_registry
from adapter_host.config import AdapterSettings, KodiResolverProfile
from adapter_host.models import MediaItem, StreamSource
from adapter_host.resolver import Resolver
import test_http_api
from tests.worker_diagnostics import WorkerDiagnostics
from adapter_host.kodi.process_manager import KodiWorkerError
from tests.worker_integration import (
    HEALTHY_WORKER_SECONDS, BLOCKED_WORKER_SECONDS, RESOLVER_SECONDS,
    REQUEST_SECONDS, CLIENT_SECONDS, delayed_worker_start,
)

FIXTURE = test_http_api.FIXTURE


class CompletionGate(Resolver):
    """Hold each HTTP request after its Kodi outcome has been recorded."""
    id = "completion_gate"
    name = "Fixture completion gate"

    def __init__(self):
        identifiers = ("fixture:success", "fixture:error")
        self.entered = {identifier: threading.Event() for identifier in identifiers}
        self.release = {identifier: threading.Event() for identifier in identifiers}

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        self.entered[item.id].set()
        while not self.release[item.id].is_set():
            await asyncio.sleep(0.005)
        return []


class HttpAvailabilityTests(unittest.TestCase):
    def profile(self, identifier="profile_a", operation="success", enabled=True, *, timeout=None):
        return KodiResolverProfile(
            id=identifier, name=identifier, enabled=enabled,
            addon_path=FIXTURE, addon_id="script.module." + identifier,
            module="availability_fixture", callable=operation,
            worker_timeout_seconds=(timeout if timeout is not None else
                                    BLOCKED_WORKER_SECONDS if operation == "timeout" else HEALTHY_WORKER_SECONDS),
        )

    def settings(self, *profiles, **kwargs):
        return AdapterSettings(kodi_profiles=profiles, resolver_timeout_seconds=RESOLVER_SECONDS,
                               request_timeout_seconds=REQUEST_SECONDS, **kwargs)

    @contextmanager
    def host(self, settings, registry=None, *, diagnostic=False):
        registry = registry or default_registry(settings)
        server = create_server(0, registry, settings)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        managers = [resolver.manager for resolver in registry._resolvers.values()
                    if getattr(resolver, "manager", None) is not None]
        observation = (WorkerDiagnostics(managers, expected_module_errors=[
            manager for manager in managers if manager.config.callable_name == "error"
        ]).on_failure("http", registry=registry) if diagnostic else nullcontext())
        with observation, ExitStack() as stack:
            self.worker_errors = {}
            self.worker_configs = {}
            for resolver in registry._resolvers.values():
                worker = getattr(resolver, "manager", None)
                if worker is None:
                    continue
                errors = self.worker_errors[resolver.id] = []
                self.worker_configs[resolver.id] = worker.config
                resolve = worker.resolve

                async def observed(item, resolve=resolve, errors=errors):
                    try:
                        return await resolve(item)
                    except KodiWorkerError as error:
                        errors.append(str(error))
                        raise

                stack.enter_context(patch.object(worker, "resolve", observed))
            try:
                yield server, registry
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                for manager in managers:
                    self.assertEqual(manager.active_count, 0)

    def resolve(self, server, identifier="fixture:availability"):
        return test_http_api.HttpApiTests._request_server(server, "/resolve", {
            "id": identifier, "type": "movie", "title": "Availability fixture",
        }, timeout=CLIENT_SECONDS)

    def test_controlled_initialization_reproduces_false_503_and_preserves_empty_success(self):
        for delay, budget, expected in ((0.65, 0.5, 503), (0.65, HEALTHY_WORKER_SECONDS, 200),
                                        (1.2, HEALTHY_WORKER_SECONDS, 200)):
            with self.subTest(delay=delay, budget=budget), delayed_worker_start(delay):
                with self.host(self.settings(self.profile(operation="empty", timeout=budget))) as (server, registry):
                    self.assertEqual(self.resolve(server), (expected, {"streams": []} if expected == 200 else
                                                           {"error": "configured resolvers unavailable"}))
                    state = registry.list_resolvers()[-1]
                    self.assertEqual(state["status"], "ok" if expected == 200 else "resolver_error")
                    self.assertEqual(self.worker_errors["profile_a"], [] if expected == 200 else ["worker_timeout"])

    def assert_success(self, response, providers):
        expected = []
        positions = {}
        for provider in providers:
            config = self.worker_configs[provider]
            position = positions.get(provider, 0)
            positions[provider] = position + 1
            resource = str(position) if config.callable_name == "many" else config.addon_id
            expected.append({"providerId": provider, "type": "https",
                             "url": f"https://example.invalid/{resource}.mp4"})
        self.assertEqual(response, (200, {"streams": expected}))

    def assert_unavailable(self, response):
        self.assertEqual(response, (503, {"error": "configured resolvers unavailable"}))

    def test_one_successful_profile(self):
        with self.host(self.settings(self.profile())) as (server, _):
            self.assert_success(self.resolve(server), ["profile_a"])

    def test_one_successful_empty_profile(self):
        with self.host(self.settings(self.profile(operation="empty"))) as (server, _):
            self.assertEqual(self.resolve(server), (200, {"streams": []}))

    def test_two_successful_profiles_combine_normalized_results(self):
        with self.host(self.settings(self.profile(), self.profile("profile_b"))) as (server, _):
            response = self.resolve(server)
            self.assert_success(response, ["profile_a", "profile_b"])
            self.assertEqual([source["url"] for source in response[1]["streams"]], [
                "https://example.invalid/script.module.profile_a.mp4",
                "https://example.invalid/script.module.profile_b.mp4",
            ])

    def test_success_survives_error_or_timeout(self):
        for failure in ("error", "worker_timeout", "resolver_timeout"):
            with self.subTest(failure=failure):
                operation = "error" if failure == "error" else "timeout"
                settings = self.settings(self.profile(), self.profile("profile_b", operation))
                registry = default_registry(settings)
                if failure == "resolver_timeout":
                    registry._resolvers["profile_b"].timeout_seconds = 0.2
                with self.host(settings, registry) as (server, _):
                    self.assert_success(self.resolve(server), ["profile_a"])
                    self.assertEqual(self.worker_errors["profile_b"], {
                        "error": ["module_error"], "worker_timeout": ["worker_timeout"], "resolver_timeout": [],
                    }[failure])
                    if failure == "resolver_timeout":
                        self.assertEqual(registry.list_resolvers()[-1]["status"], "timeout")

    def test_empty_survives_error_and_two_empty_profiles_are_operational(self):
        for operation in ("error", "empty"):
            with self.subTest(second=operation), self.host(self.settings(
                self.profile(operation="empty"), self.profile("profile_b", operation),
            ), diagnostic=True) as (server, _):
                self.assertEqual(self.resolve(server), (200, {"streams": []}))

    def test_all_enabled_profiles_fail(self):
        for operations in (("timeout", "error"), ("error", "error"), ("timeout", "timeout")):
            with self.subTest(failures=operations), self.host(self.settings(
                self.profile(operation=operations[0]), self.profile("profile_b", operations[1]),
            )) as (server, registry):
                self.assert_unavailable(self.resolve(server))
                self.assertEqual([self.worker_errors[name] for name in ("profile_a", "profile_b")],
                                 [["worker_timeout" if op == "timeout" else "module_error"] for op in operations])

    def test_example_success_does_not_conceal_configured_failure(self):
        with self.host(self.settings(
            self.profile(operation="timeout"), self.profile("profile_b", "error"),
        )) as (server, registry):
            self.assert_unavailable(self.resolve(server, "python-adapter:test"))
            example = registry.list_resolvers()[0]
            self.assertEqual(example["status"], "ok")
            self.assertGreater(example["resultCount"], 0)

    def test_no_enabled_profiles_remains_optional(self):
        for profiles in ((), (self.profile(operation="error", enabled=False),)):
            with self.subTest(configured=len(profiles)), self.host(self.settings(*profiles)) as (server, _):
                status, body = self.resolve(server, "python-adapter:test")
                self.assertEqual(status, 200)
                self.assertEqual({source["providerId"] for source in body["streams"]}, {"example_authorized"})
                self.assertEqual(self.resolve(server), (200, {"streams": []}))

    def test_disabled_failed_profile_does_not_participate(self):
        with self.host(self.settings(
            self.profile(operation="empty"), self.profile("profile_b", "error", enabled=False),
        )) as (server, registry):
            self.assertEqual(self.resolve(server), (200, {"streams": []}))
            disabled = registry._resolvers["profile_b"]
            self.assertEqual(disabled.manager.completed_pids, [])
            self.assertEqual(registry.list_resolvers()[-1]["status"], "disabled")

    def test_partial_invalid_candidates_keep_valid_result_and_degraded_diagnostics(self):
        with self.host(self.settings(self.profile(operation="mixed"))) as (server, registry):
            self.assert_success(self.resolve(server), ["profile_a"])
            state = registry.list_resolvers()[-1]
            self.assertEqual((state["status"], state["resultCount"]), ("invalid_result", 1))
            status, body = test_http_api.HttpApiTests._request_server(server, "/resolvers")
            self.assertEqual(status, 200)
            self.assertEqual(set(body["resolvers"][-1]), {
                "id", "name", "enabled", "status", "latencyMs", "resultCount", "lastError",
            })

    def test_registry_truncation_with_valid_survivors_remains_operational(self):
        settings = self.settings(self.profile(operation="many"))
        registry = default_registry(settings)
        # IPC allows 20 results; the registry independently bounds to two.
        registry.maximum_results_per_resolver = 2
        with self.host(settings, registry) as (server, _):
            self.assert_success(self.resolve(server), ["profile_a", "profile_a"])
            self.assertEqual(registry.list_resolvers()[-1]["status"], "invalid_result")

    def test_cross_profile_duplicates_are_deduplicated(self):
        # Both real workers produce the same three URLs. Check that each ran,
        # then require exactly one copy of each source in the public response.
        with self.host(self.settings(
            self.profile(operation="many"), self.profile("profile_b", "many"),
        ), diagnostic=True) as (server, registry):
            status, body = self.resolve(server)
            self.assertEqual(status, 200)
            self.assertEqual(body["streams"], [
                {"providerId": "profile_a", "type": "https", "url": f"https://example.invalid/{i}.mp4"}
                for i in range(3)
            ])
            for identifier in ("profile_a", "profile_b"):
                self.assertEqual(len(registry._resolvers[identifier].manager.completed_pids), 1)
            self.assertEqual([state["resultCount"] for state in registry.list_resolvers()[1:]], [3, 3])

    def test_global_bound_applies_to_combined_real_worker_results(self):
        with self.host(self.settings(
            self.profile(), self.profile("profile_b"), max_total_results=1,
        ), diagnostic=True) as (server, registry):
            self.assert_success(self.resolve(server), ["profile_a"])
            self.assertEqual([state["resultCount"] for state in registry.list_resolvers()[1:]], [1, 1])

    def test_fatal_invalid_output_and_ipc_limit_violation_fail_closed(self):
        for operation in ("malformed", "invalid_ipc", "many"):
            with self.subTest(operation=operation), self.host(self.settings(
                self.profile(operation=operation), max_results_per_resolver=2,
            )) as (server, _):
                self.assert_unavailable(self.resolve(server))

    def test_overlapping_requests_use_their_own_outcomes_in_both_completion_orders(self):
        for first, second in (("fixture:success", "fixture:error"), ("fixture:error", "fixture:success")):
            with self.subTest(first=first):
                settings = self.settings(self.profile(operation="by_request"), max_concurrent_resolvers=1)
                registry = default_registry(settings)
                gate = CompletionGate()
                registry.register(gate)
                with self.host(settings, registry) as (server, _), ThreadPoolExecutor(max_workers=2) as pool:
                    try:
                        first_response = pool.submit(self.resolve, server, first)
                        self.assertTrue(gate.entered[first].wait(RESOLVER_SECONDS))
                        second_response = pool.submit(self.resolve, server, second)
                        self.assertTrue(gate.entered[second].wait(RESOLVER_SECONDS))
                        # Both requests remain in flight. Shared diagnostics now
                        # describe only the second request's contradictory outcome.
                        state = next(state for state in registry.list_resolvers() if state["id"] == "profile_a")
                        self.assertEqual(state["status"], "ok" if second == "fixture:success" else "resolver_error")
                        gate.release[first].set()
                        response = first_response.result(timeout=2)
                        if first == "fixture:success":
                            self.assert_success(response, ["profile_a"])
                        else:
                            self.assert_unavailable(response)
                        gate.release[second].set()
                        response = second_response.result(timeout=2)
                        if second == "fixture:success":
                            self.assert_success(response, ["profile_a"])
                        else:
                            self.assert_unavailable(response)
                    finally:
                        for event in gate.release.values():
                            event.set()

    def test_legacy_environment_single_profile_uses_same_http_semantics(self):
        with patch.dict(os.environ, {
            "PYTHON_ADAPTER_KODI_RESOLVER_ENABLED": "true",
            "PYTHON_ADAPTER_KODI_ADDON_PATH": str(FIXTURE),
            "PYTHON_ADAPTER_KODI_MODULE": "availability_fixture",
            "PYTHON_ADAPTER_KODI_CALLABLE": "by_request",
            "PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS": str(HEALTHY_WORKER_SECONDS),
            "PYTHON_ADAPTER_RESOLVER_TIMEOUT_SECONDS": str(RESOLVER_SECONDS),
            "PYTHON_ADAPTER_REQUEST_TIMEOUT_SECONDS": str(REQUEST_SECONDS),
        }, clear=True):
            settings = AdapterSettings.from_environment()
        with self.host(settings) as (server, _):
            self.assert_success(self.resolve(server, "fixture:success"), ["kodi_installed"])
            self.assert_unavailable(self.resolve(server, "fixture:error"))


if __name__ == "__main__":
    unittest.main()
