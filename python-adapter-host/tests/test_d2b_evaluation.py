"""D2b structural counts use the existing Python stream identity."""
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tests.worker_integration import HEALTHY_WORKER_SECONDS, RESOLVER_SECONDS, REQUEST_SECONDS

from adapter_host.config import AdapterSettings
from adapter_host.evaluate_kodi_sources import evaluate, structural
from adapter_host.kodi_profiles import KodiResolverProfile
from adapter_host.kodi.process_manager import KodiWorkerProcessManager
from adapter_host.normalization import deduplication_key, normalize_one
import test_http_api
import test_callable_stream_resolver


class StructuralEvaluationTests(unittest.TestCase):
    def test_shared_owners_distinct_and_seed_categories(self):
        shared = normalize_one({"type": "magnet", "infoHash": "a" * 40, "seeds": 0}, "fixture")
        another = normalize_one({"type": "magnet", "infoHash": "b" * 40, "seeds": 5}, "fixture")
        unknown = normalize_one({"type": "magnet", "infoHash": "c" * 40}, "fixture")
        direct = normalize_one({"type": "https", "url": "https://example.org/video.mp4?token=PRIVATE"}, "fixture")
        rows = [{"candidates": [shared, another, unknown, direct, direct]},
                {"candidates": [dict(shared)]}, {"candidates": []}]
        self.assertEqual(deduplication_key(rows[0]["candidates"][0]),
                         deduplication_key(rows[1]["candidates"][0]))
        structural(rows)
        self.assertEqual(rows[0]["counts"], dict(returned=5, direct=2, torrent=3,
                         positiveSeeds=1, unknownSeeds=1, zeroSeeds=1, zeroSeedWouldDrop=1,
                         distinct=4, exclusive=3, shared=1))
        self.assertEqual(rows[1]["counts"]["shared"], 1)
        self.assertEqual(rows[2]["counts"]["returned"], 0)
        self.assertNotIn("PRIVATE", json.dumps([row["counts"] for row in rows]))


class WorkerEvaluationTests(unittest.IsolatedAsyncioTestCase):
    async def test_callable_profile_units_use_normal_workers_and_keep_stable_empty_error_rows(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profiles = []
            for mode in ("", "empty", "exception"):
                directory = root / (mode or "direct")
                directory.mkdir()
                settings_file = directory / "settings.json"
                settings_file.write_text(json.dumps({"fixture.mode": mode}), encoding="utf-8")
                profiles.append(replace(test_callable_stream_resolver.profile(
                    settings_file=settings_file, profile_path=directory / "profile"),
                    id=mode or "direct"))
            profiles.append(replace(profiles[0], id="unavailable", addon_path=root / "missing"))
            settings = AdapterSettings(kodi_profiles=tuple(profiles), resolver_timeout_seconds=RESOLVER_SECONDS,
                                       request_timeout_seconds=REQUEST_SECONDS)
            managers = []
            original_resolve = KodiWorkerProcessManager.resolve

            async def observed_resolve(manager, media):
                managers.append(manager)
                return await original_resolve(manager, media)

            with patch("adapter_host.evaluate_kodi_sources.AdapterSettings.from_environment", return_value=settings), \
                    patch.object(KodiWorkerProcessManager, "resolve", observed_resolve), \
                    patch.object(KodiWorkerProcessManager, "evaluation_source_ids", side_effect=AssertionError("not decomposable")), \
                    patch.object(KodiWorkerProcessManager, "evaluate_source", side_effect=AssertionError("not decomposable")):
                first = await evaluate(test_callable_stream_resolver.MOVIE)
                second = await evaluate({**test_callable_stream_resolver.MOVIE, "kind": "episode",
                                         "season": 1, "episode": 1})
            for result in (first, second):
                rows = result["sources"]
                self.assertEqual([(row["profileId"], row["sourceId"], row["status"]) for row in rows],
                                 [("direct", "profile", "ok"), ("empty", "profile", "ok"),
                                  ("exception", "profile", "error"), ("unavailable", "profile", "error")])
                self.assertEqual(rows[0]["counts"]["direct"], 1)
                self.assertEqual(rows[0]["candidates"][0]["type"], "https")
                self.assertEqual([row["candidates"] for row in rows[1:]], [[], [], []])
                self.assertEqual([row["counts"]["returned"] for row in rows[1:]], [0, 0, 0])
                self.assertTrue(all(0 <= row["elapsedMs"] <= 600_000 for row in rows))
                safe_rows = [{key: value for key, value in row.items() if key != "candidates"} for row in rows]
                for forbidden in ("do-not-expose", "/secret", "Authorization", str(root), "https://"):
                    self.assertNotIn(forbidden, json.dumps(safe_rows))
            self.assertEqual(len(managers), 6)
            self.assertTrue(all(manager.active_count == 0 and len(manager.completed_pids) == 1
                                for manager in managers))

    async def test_fixed_child_logic_uses_d2a_and_represents_zero_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings_file = root / "settings.json"
            settings_file.write_text(json.dumps({"fixture.mode": ""}), encoding="utf-8")
            profile = KodiResolverProfile(
                id="pack", name="Pack", enabled=True, addon_path=test_http_api.FIXTURE,
                addon_id="script.module.fake", module="adapter_host.kodi.adapters.source_pack",
                callable="resolve", settings_file=settings_file, profile_path=root / "profile",
                worker_timeout_seconds=HEALTHY_WORKER_SECONDS,
                adapter_config={"sourcePackage": "fixture_sources", "sourceFolders": ["en"]})
            settings = AdapterSettings(kodi_profiles=(profile,), resolver_timeout_seconds=RESOLVER_SECONDS,
                                       request_timeout_seconds=REQUEST_SECONDS)
            media = {"id": "tt1254207", "kind": "movie", "title": "Big Buck Bunny", "year": 2008,
                     "externalIds": {"imdb": "tt1254207"}}
            with patch("adapter_host.evaluate_kodi_sources.AdapterSettings.from_environment", return_value=settings):
                result = await evaluate(media)
            rows = result["sources"]
            self.assertEqual(len(rows), 4)
            self.assertTrue(all(isinstance(row["elapsedMs"], (int, float))
                                and 0 <= row["elapsedMs"] <= 600_000 for row in rows))
            active = [row for row in rows if row["counts"]["returned"] > 0]
            self.assertEqual(len(active), 2)
            self.assertEqual([row["counts"]["shared"] for row in active], [3, 3])
            self.assertEqual([row["counts"]["direct"] for row in active], [4, 4])
            self.assertTrue(any(row["status"] == "ok" and row["counts"]["returned"] == 0 for row in rows))
            self.assertTrue(any(row["status"] == "error" and row["counts"]["returned"] == 0 for row in rows))
            self.assertEqual(len([row for row in rows if row["profileId"] == "pack"]), len(rows))

    async def test_external_package_keeps_inner_source_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile = KodiResolverProfile(
                id="external", name="External", enabled=True, addon_path=test_http_api.FIXTURE,
                addon_id="script.module.fake", module="adapter_host.kodi.adapters.external_scraper_package",
                callable="resolve", profile_path=root / "profile", worker_timeout_seconds=HEALTHY_WORKER_SECONDS,
                adapter_config={"packageModule": "scraper_package_a", "folders": ["torrents"]})
            settings = AdapterSettings(kodi_profiles=(profile,), resolver_timeout_seconds=RESOLVER_SECONDS,
                                       request_timeout_seconds=REQUEST_SECONDS)
            managers = []
            original_evaluate = KodiWorkerProcessManager.evaluate_source

            async def observed_evaluate(manager, media, source_id):
                managers.append(manager)
                return await original_evaluate(manager, media, source_id)

            with patch("adapter_host.evaluate_kodi_sources.AdapterSettings.from_environment", return_value=settings), \
                    patch.object(KodiWorkerProcessManager, "resolve", side_effect=AssertionError("must decompose")), \
                    patch.object(KodiWorkerProcessManager, "evaluate_source", observed_evaluate):
                result = await evaluate(test_callable_stream_resolver.MOVIE)
            rows = result["sources"]
            self.assertGreater(len(rows), 1)
            self.assertTrue(all(row["profileId"] == "external" and row["sourceId"] != "profile" for row in rows))
            self.assertEqual(len(managers), len(rows))
            self.assertTrue(any(row["counts"]["returned"] > 0 for row in rows))
            self.assertTrue(all(manager.active_count == 0 for manager in managers))
