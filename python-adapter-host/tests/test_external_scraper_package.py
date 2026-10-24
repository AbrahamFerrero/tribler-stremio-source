# These replacement titles and localized labels are invented fixture identities.
# IMDb-shaped numbers are local test data, not a reserved external namespace.
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest

from tests.worker_integration import HEALTHY_WORKER_SECONDS, RESOLVER_SECONDS, REQUEST_SECONDS

from adapter_host.config import AdapterSettings
from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerError, KodiWorkerProcessManager
from adapter_host.kodi_profiles import KodiResolverProfile
import test_http_api
import test_http_availability

FIXTURE = test_http_api.FIXTURE
MODULE = "adapter_host.kodi.adapters.external_scraper_package"
MOVIE = {"id": "tt1254207", "kind": "movie", "title": "Big Buck Bunny", "year": 2008}
EPISODE = {"id": "tt1254207", "kind": "episode", "title": "", "season": 2, "episode": 3}


class ExternalScraperWorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workers = []

    def manager(self, package="scraper_package_a", mode="", maximum=20, config=None):
        directory = self.root / str(len(self.workers))
        directory.mkdir()
        settings = directory / "settings.json"
        settings.write_text(json.dumps({"fixture.mode": mode}), encoding="utf-8")
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE, module_name=MODULE, addon_id="script.module.fake",
            settings_file=settings, profile_path=directory / "profile", timeout_seconds=HEALTHY_WORKER_SECONDS,
            maximum_results=maximum,
            adapter_config=config if config is not None else {"packageModule": package, "folders": ["torrents"]},
        ))
        self.workers.append(manager)
        return manager

    def calls(self, manager):
        return [json.loads(line) for line in (manager.config.profile_path / "calls.jsonl").read_text().splitlines()]

    async def asyncTearDown(self):
        for worker in self.workers:
            self.assertEqual(worker.active_count, 0)

    async def test_unique_capture_rescues_markerless_episode(self):
        config = {"packageModule": "scraper_package_a", "folders": ["torrents"],
                  "responseMode": "capture-streams"}
        worker = self.manager(mode="capture", config=config)
        result = await worker.resolve(EPISODE)
        self.assertEqual(len(result), 1, "episode candidate rejected because file selection was not recovered")
        self.assertEqual((result[0]["infoHash"], result[0]["fileIndex"], result[0]["filename"]),
                         ("a" * 40, 4, "selected.mkv"))
        self.assertEqual(self.calls(worker), ["factory:a", "capture_returned"])
        for response_mode in (None, "none"):
            disabled = {k: v for k, v in config.items() if k != "responseMode"}
            if response_mode is not None:
                disabled["responseMode"] = response_mode
            self.assertEqual(await self.manager(mode="capture", config=disabled).resolve(EPISODE), [])

    async def test_capture_ambiguity_filename_and_provider_isolation(self):
        config = {"packageModule": "scraper_package_a", "folders": ["torrents"],
                  "responseMode": "capture-streams"}
        self.assertEqual(await self.manager(mode="capture_ambiguous", config=config).resolve(EPISODE), [])
        result = await self.manager(mode="capture_filename", config=config).resolve(EPISODE)
        self.assertEqual([r["infoHash"] for r in result], ["a" * 40])
        self.assertNotIn("fileIndex", result[0])
        for mode in ("capture_isolation", "capture_failure"):
            worker = self.manager(mode=mode, config=config)
            result = await worker.resolve(EPISODE)
            self.assertEqual([(r["infoHash"], r["fileIndex"]) for r in result], [("d" * 40, 9)])
            self.assertIn("unobserved", self.calls(worker))
        self.assertEqual(await self.manager(config=config).resolve(MOVIE), await self.manager().resolve(MOVIE))
        # A provider without the compatible request path retains explicit selection and pack checks.
        self.assertEqual(await self.manager(config=config).resolve(EPISODE), await self.manager().resolve(EPISODE))

    async def test_real_package_matching_semantics_survive_normalization(self):
        for media in (MOVIE, {**EPISODE, "year": 2008}, EPISODE,
                      {**EPISODE, "season": 0}):
            with self.subTest(media=media):
                worker = self.manager(mode="semantic")
                result = await worker.resolve(media)
                self.assertEqual(self.calls(worker), ["factory:a", "semantic_pass"])
                self.assertEqual([r["infoHash"] for r in result], ["a" * 40])

    async def test_normalization_dedupe_and_deterministic_order(self):
        worker = self.manager()
        first = await worker.resolve(MOVIE)
        second = await worker.resolve(MOVIE)
        self.assertEqual(first, second)
        self.assertEqual([r.get("infoHash") for r in first], ["a" * 40, "b" * 40, None, "c" * 40])
        self.assertEqual([r["metadata"]["provider"] for r in first], ["movie", "movie", "movie", "duplicate"])
        self.assertEqual(first[0]["sizeBytes"], 1610612736)
        self.assertEqual(first[0]["seeds"], 7)
        self.assertEqual(first[0]["resolution"], "1080p")
        self.assertEqual(first[0]["metadata"]["module"], "external_scraper_package_adapter")
        self.assertNotIn("headers", first[2])
        self.assertNotIn("Authorization", json.dumps(first))
        self.assertEqual(len(set(worker.completed_pids)), 2)

    async def test_capabilities_exclude_incompatible_providers(self):
        for media, expected in ((MOVIE, "movie"), (EPISODE, "episode")):
            with self.subTest(kind=media["kind"]):
                worker = self.manager()
                result = await worker.resolve(media)
                self.assertTrue(result)
                self.assertEqual(self.calls(worker), ["factory:a", "broken", "invalid", expected, "duplicate"])

    async def test_healthy_provider_survives_exception_and_invalid_output(self):
        worker = self.manager()
        results = await worker.resolve(MOVIE)
        self.assertEqual(self.calls(worker)[:3], ["factory:a", "broken", "invalid"])
        self.assertEqual([r.get("infoHash") for r in results], ["a" * 40, "b" * 40, None, "c" * 40])

    async def test_episode_packs_fail_closed_and_explicit_file_index_survives(self):
        result = await self.manager().resolve(EPISODE)
        self.assertEqual([r["infoHash"] for r in result], ["a" * 40, "d" * 40])
        self.assertNotIn("fileIndex", result[0])
        self.assertEqual(result[1]["fileIndex"], 4)

    async def test_result_limit_applies_before_worker_ipc_and_stops_iteration(self):
        worker = self.manager(mode="many", maximum=3)
        result = await worker.resolve(MOVIE)
        self.assertEqual([r["infoHash"] for r in result], [format(i, "040x") for i in (1, 2, 3)])
        self.assertEqual(self.calls(worker), ["factory:a", "movie"])

    async def test_iterator_failure_preserves_results_and_invalid_scan_is_bounded(self):
        worker = self.manager(mode="iterator_failure")
        result = await worker.resolve(MOVIE)
        self.assertEqual([r["infoHash"] for r in result], ["a" * 40])
        self.assertEqual(self.calls(worker), ["factory:a"])

    async def test_structural_package_failures_and_all_failed_providers_are_sanitized(self):
        for mode in ("invalid_package", "noniterable_package", "many_providers", "all_failed"):
            with self.subTest(mode=mode), self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
                await self.manager(mode=mode).resolve(MOVIE)
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await self.manager(package="external_scraper_fixture").resolve(MOVIE)
        self.assertEqual(await self.manager(mode="empty").resolve(MOVIE), [])

    async def test_invalid_adapter_configuration_is_rejected_before_package_import(self):
        configurations = [
            {}, {"packageModule": "scraper_package_a", "folders": ["../torrents"]},
            {"packageModule": "../scraper_package_a", "folders": ["torrents"]},
            {"packageModule": "service", "folders": ["torrents"]},
            {"packageModule": "scraper_package_a", "folders": ["torrents"], "callable": "sources"},
            {"packageModule": "scraper_package_a", "folders": "torrents"},
        ]
        configurations += [{"packageModule": "scraper_package_a", "folders": ["torrents"],
                            "responseMode": value} for value in (None, True, 1, [], {}, "unknown")]
        for config in configurations:
            with self.subTest(config=config):
                worker = self.manager(config=config)
                with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
                    await worker.resolve(MOVIE)
                self.assertFalse((worker.config.profile_path / "calls.jsonl").exists())

    async def test_unavailable_metadata_is_not_fabricated(self):
        for changes in ({"year": None}, {"title": ""}, {"id": "unknown"}, {"kind": "series"}):
            worker = self.manager()
            self.assertEqual(await worker.resolve({**MOVIE, **changes}), [])
            self.assertFalse((worker.config.profile_path / "calls.jsonl").exists())
        self.assertEqual(await self.manager().resolve({**EPISODE, "season": None}), [])

    async def test_two_profile_packages_remain_isolated_in_both_orders_and_concurrently(self):
        a, b = self.manager(), self.manager("scraper_package_b")
        for order in ((a, b), (b, a)):
            results = await asyncio.gather(*(worker.resolve(MOVIE) for worker in order))
            self.assertEqual([r[0]["infoHash"] for r in results],
                             ["a" * 40 if worker is a else "d" * 40 for worker in order])
        self.assertEqual((await b.resolve(MOVIE))[0]["infoHash"], "d" * 40)
        self.assertEqual((await a.resolve(MOVIE))[0]["infoHash"], "a" * 40)
        self.assertEqual(self.calls(a).count("factory:a"), 3)
        self.assertEqual(self.calls(b).count("factory:d"), 3)

    async def test_guarded_listdir_runs_in_real_worker(self):
        results = await self.manager(mode="vfs").resolve(MOVIE)
        self.assertEqual([r["infoHash"] for r in results], ["a" * 40])


class ExternalScraperHttpTests(unittest.TestCase):
    host = test_http_availability.HttpAvailabilityTests.host

    def settings(self, maximum=20):
        profiles = tuple(KodiResolverProfile(
            id="profile_" + letter, name="Profile " + letter, enabled=True,
            addon_path=FIXTURE, addon_id="script.module.fake", module=MODULE,
            callable="resolve", worker_timeout_seconds=HEALTHY_WORKER_SECONDS,
            adapter_config={"packageModule": "scraper_package_" + letter, "folders": ["torrents"]},
        ) for letter in ("a", "b"))
        return AdapterSettings(kodi_profiles=profiles, resolver_timeout_seconds=RESOLVER_SECONDS,
                               request_timeout_seconds=REQUEST_SECONDS, max_total_results=maximum)

    def request(self, server, media):
        return test_http_api.HttpApiTests._request_server(server, "/resolve", media)

    def test_two_profiles_use_same_adapter_through_http_and_registry_dedupe(self):
        with self.host(self.settings()) as (server, registry):
            status, body = self.request(server, MOVIE)
            self.assertEqual(status, 200, body)
            self.assertEqual([r.get("infoHash") for r in body["streams"]],
                             [None, "a" * 40, "d" * 40,
                              "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", "b" * 40, None, "c" * 40])
            self.assertEqual([r["providerId"] for r in body["streams"]], ["example_authorized", "profile_a", "profile_b", "example_authorized"] + ["profile_a"] * 3)
            self.assertTrue(all(registry._resolvers["profile_" + key].manager.completed_pids for key in ("a", "b")))
        with self.host(self.settings(maximum=4)) as (server, _):
            self.assertEqual([r["infoHash"] for r in self.request(server, MOVIE)[1]["streams"][2:]],
                             ["d" * 40, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"])

    def test_authoritative_series_title_crosses_http_validation_and_worker_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings_file = root / "settings.json"
            settings_file.write_text(json.dumps({"fixture.mode": "series_title"}))
            settings = self.settings()
            profile = replace(settings.kodi_profiles[0], settings_file=settings_file, profile_path=root / "profile")
            settings = replace(settings, kodi_profiles=(profile,))
            media = {"id": "tt9900101:1:1", "type": "episode", "title": "First Signal",
                     "seriesTitle": "Neral Beacon", "season": 1, "episode": 1,
                     "externalIds": {"imdb": "tt9900101"}}
            with self.host(settings) as (server, _):
                status, body = self.request(server, media)
                self.assertEqual(status, 200, body)
                self.assertEqual([r["infoHash"] for r in body["streams"]], ["a" * 40])
                calls = profile.profile_path / "calls.jsonl"
                entries = [json.loads(line) for line in calls.read_text().splitlines()]
                self.assertEqual(entries, ["factory:a", {"query": {
                    "imdb": "tt9900101", "title": "First Signal", "tvshowtitle": "Neral Beacon",
                    "year": "", "aliases": [], "season": "1", "episode": "1",
                }}, "series_title_match"])
                for title in (None, "First Signal"):
                    control = {**media}
                    if title is None:
                        del control["seriesTitle"]
                    else:
                        control["seriesTitle"] = title
                    self.assertEqual(self.request(server, control), (200, {"streams": []}))
                    self.assertEqual(json.loads(calls.read_text().splitlines()[-1]), "series_title_mismatch")

    def test_request_cannot_change_capture_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sf = root / "settings.json"
            sf.write_text(json.dumps({"fixture.mode": "capture"}))
            for mode, expected in (("none", 0), ("capture-streams", 1)):
                settings = self.settings()
                profile = replace(settings.kodi_profiles[0], settings_file=sf,
                                  profile_path=root / mode,
                                  adapter_config={"packageModule": "scraper_package_a",
                                                  "folders": ["torrents"], "responseMode": mode})
                with self.host(replace(settings, kodi_profiles=(profile,))) as (server, _):
                    baseline = self.request(server, EPISODE)
                    self.assertEqual(baseline[0], 200)
                    self.assertEqual(len(baseline[1]["streams"]), expected)
                    other = "capture-streams" if mode == "none" else "none"
                    for key in ("responseMode", "sourceResponseMode", "adapterConfig"):
                        self.assertEqual(self.request(server, {**EPISODE, key: other})[0], 400)
                    poison = {"responseMode": other, "sourceResponseMode": other,
                              "adapterConfig": {"responseMode": other}}
                    self.assertEqual(self.request(server, {**EPISODE, "metadata": poison}), baseline)
                    self.assertEqual(self.request(server, {**EPISODE, "externalIds": {"responseMode": other}}), baseline)

    def test_request_cannot_select_package_via_fields_or_metadata(self):
        with self.host(self.settings()) as (server, _):
            baseline = self.request(server, MOVIE)
            self.assertEqual(baseline[0], 200)
            for key, value in (("packageModule", "scraper_package_b"), ("folders", ["other"]),
                               ("adapterConfig", {"packageModule": "scraper_package_b"})):
                with self.subTest(key=key):
                    self.assertEqual(self.request(server, {**MOVIE, key: value})[0], 400)
            malicious = {"packageModule": "scraper_package_b", "folders": ["other"],
                         "adapterConfig": {"packageModule": "scraper_package_b"}}
            self.assertEqual(self.request(server, {**MOVIE, "metadata": malicious}), baseline)
            self.assertEqual(self.request(server, {**MOVIE, "externalIds": {"packageModule": "scraper_package_b"}}), baseline)
