from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tests.worker_integration import HEALTHY_WORKER_SECONDS, RESOLVER_SECONDS, REQUEST_SECONDS

from adapter_host.kodi.adapters.source_pack import ADAPTER_MODULE
from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerError, KodiWorkerProcessManager
from adapter_host.kodi_profiles import KodiResolverProfile
import test_callable_stream_resolver
import test_http_api
import test_http_availability
import test_kodi_worker

FIXTURE = test_http_api.FIXTURE
MOVIE = test_callable_stream_resolver.MOVIE
CONFIG = {"sourcePackage": "fixture_sources", "sourceFolders": ["en"], "maxProviderModules": 64, "maxProviderWorkers": 2}
EXPECTED = [{"type": "https", "url": "https://1.1.1.1/source-pack.mp4", "quality": "1080p", "language": "en"},
            {"type": "https", "url": "https://1.1.1.1/resolved.m3u8", "quality": "720p"},
            {"type": "https", "url": "https://1.1.1.1/api/embed"}]


class SourcePackWorkerTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_callable_stream_resolver.CallableWorkerTests.setUp
    asyncTearDown = test_callable_stream_resolver.CallableWorkerTests.asyncTearDown
    observe_real_processes = test_kodi_worker.KodiWorkerTests.observe_real_processes
    def manager(self, mode="", maximum=20, timeout=HEALTHY_WORKER_SECONDS, config=None, addon_path=FIXTURE):
        directory = self.root / str(len(self.workers))
        directory.mkdir(exist_ok=True)
        settings = directory / "settings.json"
        settings.write_text(json.dumps({"fixture.mode": mode}), encoding="utf-8")
        worker = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=addon_path, module_name=ADAPTER_MODULE, settings_file=settings,
            profile_path=directory / "profile", timeout_seconds=timeout, maximum_results=maximum,
            adapter_config=config if config is not None else CONFIG))
        self.workers.append(worker)
        return worker


class SourcePackTests(SourcePackWorkerTests):
    async def test_provider_resolve_call_counts_and_final_validation(self):
        cases = (
            ("final_mp4", EXPECTED[0]["url"], 0),
            ("final_hls", "https://1.1.1.1/master.m3u8", 0),
            ("final_query", EXPECTED[0]["url"] + "?case=fixture", 0),
            ("invalid_metadata", None, 0),
            ("token", "https://1.1.1.1/token-resolved.mp4", 1),
            ("wrapper", "https://1.1.1.1/wrapper-resolved.m3u8", 1),
            ("none", None, 1), ("empty", None, 1), ("same", "https://1.1.1.1/still-embed", 1),
            ("intermediate", "https://1.1.1.1/embed", 1), ("credential", None, 1), ("resolved_magnet", None, 1),
            ("debrid", None, 0), ("local", None, 0), ("torrent", None, 0),
            ("magnet", None, 0), ("info_hash", None, 0), ("magnet_field", None, 0),
            ("torrent_url", None, 0), ("magnet_url", None, 0), ("file_url", None, 0),
            ("indirect_http", EXPECTED[1]["url"], 1),
            ("indirect_final", EXPECTED[0]["url"], 1),
            ("indirect_token", "https://1.1.1.1/token-resolved.mp4", 1),
            ("indirect_same", None, 1), ("indirect_intermediate", None, 1),
            ("encoded_torrent", None, 0),
        )
        for case, expected_url, expected_calls in cases:
            with self.subTest(case=case):
                worker = self.manager("resolve_count_" + case,
                                      config={**CONFIG, "sourceIds": ["fixture_sources.en.01_legacy"]})
                streams = await worker.resolve(MOVIE)
                self.assertEqual(streams, [] if expected_url is None else [{"type": "https", "url": expected_url}])
                counts = json.loads((worker.config.profile_path / "resolve-count.json").read_text())
                self.assertEqual(counts["calls"], expected_calls)

    async def test_direct_candidates_use_provider_resolve_before_final_validation(self):
        streams = await self.manager("direct_resolve").resolve(MOVIE)
        for filename in ("token-resolved.mp4", "wrapper-resolved.m3u8"):
            with self.subTest(filename=filename):
                self.assertIn({"type": "https", "url": "https://1.1.1.1/" + filename}, streams)
        self.assertIn({"type": "https", "url": "https://1.1.1.1/still-embed"}, streams)
        self.assertEqual(len(streams), 3)

    async def test_without_provider_resolver_only_direct_candidates_survive(self):
        worker = self.manager("no_resolver", config={**CONFIG, "sourceIds": ["fixture_sources.en.01_legacy"]})
        self.assertEqual(await worker.resolve(MOVIE), [
            {"type": "https", "url": "https://1.1.1.1/opaque"},
            {"type": "https", "url": EXPECTED[0]["url"]},
        ])

    async def test_real_worker_contracts_concurrency_sanitization_and_isolation(self):
        worker = self.manager()
        with patch.dict(os.environ, {"TRIBLER_API_KEY": "private", "TRIBLER_URL": "private"}):
            self.assertEqual(await worker.resolve({**MOVIE, "externalIds": {"tmdb": "10378"}}), EXPECTED)
        directory = worker.config.profile_path
        legacy, aware = [json.loads((directory / (name + ".json")).read_text()) for name in ("Legacy", "Aware")]
        self.assertEqual(legacy["peak"], 2)
        self.assertEqual(aware["peak"], 2)
        self.assertEqual(legacy["arguments"]["movie"], dict(imdb="tt1254207", title="Big Buck Bunny",
                         localtitle="Big Buck Bunny", aliases=[{"title": "Big Buck Bunny"}, {"title": "fixture-private-mutation"}], year="2008"))
        self.assertEqual(aware["arguments"]["movie"]["tmdb"], "10378")
        self.assertEqual(legacy["arguments"]["sources"], dict(url="opaque-query", hostDict=[], hostprDict=[]))
        self.assertEqual(aware["arguments"]["sources"], dict(url="opaque-query", hostDict=[]))
        self.assertEqual(await worker.resolve(MOVIE), EXPECTED)
        self.assertNotIn("private", json.dumps(EXPECTED))

    async def test_selected_sources_and_request_data_cannot_override(self):
        selected = self.manager(config={**CONFIG, "sourceIds": ["fixture_sources.en.01_legacy"]})
        self.assertEqual(await selected.resolve(MOVIE), EXPECTED)
        self.assertTrue((selected.config.profile_path / "Legacy.json").exists())
        self.assertFalse((selected.config.profile_path / "Aware.json").exists())
        self.assertEqual(selected.config.adapter_config["sourceIds"], ("fixture_sources.en.01_legacy",))

    async def test_selected_ids_order_and_local_evaluation(self):
        legacy = "fixture_sources.en.01_legacy"
        aware = "fixture_sources.en.02_aware"
        all_sources = self.manager()
        self.assertEqual(await all_sources.evaluation_source_ids(),
                         [legacy, aware, "fixture_sources.en.03_unsupported", "fixture_sources.en.04_failure"])
        selected = self.manager(config={**CONFIG, "sourceIds": [aware, legacy]})
        self.assertEqual(await selected.evaluation_source_ids(), [legacy, aware])
        self.assertEqual(await selected.resolve(MOVIE), EXPECTED)
        one = self.manager(config={**CONFIG, "sourceIds": [legacy]})
        self.assertEqual(await one.evaluation_source_ids(), [legacy])
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await one.evaluate_source(MOVIE, aware)

    async def test_unknown_selected_source_fails_closed(self):
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await self.manager(config={**CONFIG, "sourceIds": ["fixture_sources.en.Missing"]}).resolve(MOVIE)

    async def test_json_alias_contract_in_real_worker(self):
        worker = self.manager("json_aliases", config={**CONFIG, "aliasesFormat": "json"})
        self.assertEqual(await worker.resolve(MOVIE), EXPECTED)
        episode = {**MOVIE, "kind": "episode", "title": "Episode title", "seriesTitle": "Series title",
                   "season": 1, "episode": 2}
        self.assertEqual(await worker.resolve(episode), EXPECTED)
        for name in ("Legacy", "Aware"):
            args = json.loads((worker.config.profile_path / (name + ".json")).read_text())["arguments"]
            self.assertEqual(json.loads(args["tvshow"]["aliases"]), [{"title": "Series title"}])

    async def test_episode_identity_variants_and_missing_authoritative_title(self):
        worker = self.manager()
        episode = {**MOVIE, "kind": "episode", "title": "Episode title", "seriesTitle": "Authoritative series",
                   "season": 0, "episode": 2, "externalIds": {"imdb": "tt1254207", "tmdb": "10378", "tvdb": "42"}}
        self.assertEqual(await worker.resolve(episode), EXPECTED)
        for name in ("Legacy", "Aware"):
            args = json.loads((worker.config.profile_path / (name + ".json")).read_text())["arguments"]
            self.assertEqual(args["tvshow"]["tvshowtitle"], "Authoritative series")
            self.assertEqual(args["tvshow"]["localtvshowtitle"], "Authoritative series")
            self.assertEqual(args["tvshow"]["tvdb"], "42")
            self.assertEqual(args["episode"]["premiered"], "")
            self.assertEqual((args["episode"]["season"], args["episode"]["episode"]), ("0", "2"))
            self.assertEqual(args["episode"]["title"], "Episode title")
        missing = self.manager()
        self.assertEqual(await missing.resolve({k: v for k, v in episode.items() if k != "seriesTitle"}), [])
        self.assertFalse((missing.config.profile_path / "Legacy.json").exists())
        self.assertEqual(await missing.resolve({**episode, "season": True}), [])

    async def test_bounds_order_and_lazy_failure(self):
        self.assertEqual(await self.manager(maximum=1).resolve(MOVIE), EXPECTED[:1])
        single = self.manager(config={**CONFIG, "maxProviderModules": 1, "maxProviderWorkers": 1})
        self.assertEqual(await single.resolve(MOVIE), EXPECTED)
        self.assertFalse((single.config.profile_path / "Aware.json").exists())
        self.assertEqual(json.loads((single.config.profile_path / "Legacy.json").read_text())["peak"], 1)
        self.assertEqual(len(await self.manager("many", maximum=3).resolve(MOVIE)), 3)
        self.assertEqual(len(await self.manager("many", maximum=100).resolve(MOVIE)), 100)
        self.assertEqual(await self.manager("lazy_failure").resolve(MOVIE), [])
        self.assertEqual(await self.manager("error").resolve(MOVIE), [])
        with self.assertRaisesRegex(KodiWorkerError, "^sandbox_violation$"):
            await self.manager("sandbox").resolve(MOVIE)

    async def test_origin_checks_and_forbidden_entrypoints(self):
        for package in ("json", "missing", "adapter_host.kodi"):
            with self.subTest(package=package), self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
                await self.manager(config={**CONFIG, "sourcePackage": package}).resolve(MOVIE)
        # default.py is a PermissionError trap: the successful normal run proves it stays unloaded.
        self.assertEqual(await self.manager().resolve(MOVIE), EXPECTED)

    async def test_timeout_and_cancellation_reap_pool_worker(self):
        processes = self.observe_real_processes()
        blocked = self.manager("block", timeout=HEALTHY_WORKER_SECONDS)
        with self.assertRaisesRegex(KodiWorkerError, "^worker_timeout$"):
            await blocked.resolve(MOVIE)
        self.assertTrue((blocked.config.profile_path / "started").exists(),
                        "timeout occurred before the blocking provider initialized")
        worker = self.manager("block", timeout=5)
        task = asyncio.create_task(worker.resolve(MOVIE))
        deadline = asyncio.get_running_loop().time() + 2
        while not (worker.config.profile_path / "started").exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertTrue((worker.config.profile_path / "started").exists())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(len(processes), 2)
        self.assertTrue(all(process.returncode is not None for process in processes))

    def test_startup_configuration_is_strict_and_frozen(self):
        for changes in ({"sourcePackage": "resources.default.sources"},
                        {"sourceFolders": ["../en"]}, {"sourceFolders": ["default"]}, {"sourceFolders": []},
                        {"sourceFolders": ["en", "en"]}, {"sourceFolders": "en"},
                        {"maxProviderModules": 0}, {"maxProviderModules": 129}, {"maxProviderWorkers": 9},
                        {"maxProviderWorkers": True}, {"sourceIds": []},
                        {"sourceIds": ["fixture_sources.en.01_legacy", "fixture_sources.en.01_legacy"]},
                        {"sourceIds": [42]}, {"sourceIds": ["../Legacy"]},
                        {"sourceIds": "fixture_sources.en.01_legacy"}, {"aliasesFormat": "auto"}, {"aliasesFormat": []}, {"unknown": 1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.manager(config={**CONFIG, **changes})
        worker = self.manager()
        self.assertEqual(worker.config.adapter_config["sourceFolders"], ("en",))


class SourcePackHttpTests(unittest.TestCase):
    host = test_http_availability.HttpAvailabilityTests.host

    def test_http_metadata_and_external_ids_cannot_override_selected_source(self):
        profile = KodiResolverProfile(id="selected_pack", name="selected_pack", enabled=True, addon_path=FIXTURE,
                                      addon_id="script.module.fixture", module=ADAPTER_MODULE, callable="resolve",
                                      worker_timeout_seconds=HEALTHY_WORKER_SECONDS,
                                      adapter_config={**CONFIG, "sourceIds": ["fixture_sources.en.01_legacy"]})
        settings = test_http_availability.AdapterSettings(kodi_profiles=(profile,),
                                                         resolver_timeout_seconds=RESOLVER_SECONDS, request_timeout_seconds=REQUEST_SECONDS)
        with self.host(settings) as (server, registry):
            for media in ({**MOVIE, "metadata": {"sourceIds": ["fixture_sources.en.02_aware"]}},
                          {**MOVIE, "externalIds": {"sourceIds": "fixture_sources.en.02_aware"}}):
                status, payload = test_http_api.HttpApiTests._request_server(server, "/resolve", media)
                self.assertIn(status, (200, 400))
                if status == 200:
                    self.assertEqual([stream for stream in payload["streams"] if stream["providerId"] == "selected_pack"],
                                     [{**candidate, "providerId": "selected_pack"} for candidate in EXPECTED])
            manager = registry._resolvers["selected_pack"].manager
            self.assertEqual(manager.config.adapter_config["sourceIds"], ("fixture_sources.en.01_legacy",))

    def test_two_configured_source_packs_via_http_and_selector_rejection(self):
        profiles = tuple(KodiResolverProfile(id=name, name=name, enabled=True, addon_path=FIXTURE,
                         addon_id="script.module.fixture", module=ADAPTER_MODULE, callable="resolve",
                         worker_timeout_seconds=HEALTHY_WORKER_SECONDS, adapter_config=CONFIG) for name in ("pack_a", "pack_b"))
        settings = test_http_availability.AdapterSettings(kodi_profiles=profiles, resolver_timeout_seconds=RESOLVER_SECONDS, request_timeout_seconds=REQUEST_SECONDS)
        with self.host(settings) as (server, registry):
            response = test_http_api.HttpApiTests._request_server(server, "/resolve", MOVIE)
            self.assertEqual(response[0], 200)
            self.assertEqual([s for s in response[1]["streams"] if s["providerId"] in {"pack_a", "pack_b"}],
                             [{**candidate, "providerId": "pack_a"} for candidate in EXPECTED])
            for name in ("pack_a", "pack_b"):
                self.assertTrue(registry._resolvers[name].manager.completed_pids)
            for field in ("sourcePackage", "sourceFolders", "sourceIds", "module", "maxProviderWorkers", "aliasesFormat"):
                self.assertEqual(test_http_api.HttpApiTests._request_server(server, "/resolve", {**MOVIE, field: "evil"})[0], 400)
