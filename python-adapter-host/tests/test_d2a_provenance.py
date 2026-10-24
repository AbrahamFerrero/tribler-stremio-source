"""D2a local worker provenance: synthetic fixtures only, no candidate output."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO

from tests.worker_integration import HEALTHY_WORKER_SECONDS

from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerError, KodiWorkerProcessManager
import test_http_api

FIXTURE = test_http_api.FIXTURE
MOVIE = {"id": "tt1254207", "kind": "movie", "title": "Big Buck Bunny", "year": 2008}


class InnerSourceProvenanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.managers = []

    async def asyncTearDown(self):
        self.assertTrue(all(manager.active_count == 0 for manager in self.managers))

    def manager(self, module, adapter_config, maximum=1, mode=""):
        directory = self.root / str(len(self.managers))
        directory.mkdir()
        settings = directory / "settings.json"
        settings.write_text(json.dumps({"fixture.mode": mode}), encoding="utf-8")
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE, module_name=module, settings_file=settings,
            profile_path=directory / "profile", timeout_seconds=HEALTHY_WORKER_SECONDS,
            maximum_results=maximum, adapter_config=adapter_config))
        self.managers.append(manager)
        return manager

    async def test_source_pack_preserves_both_owners_before_dedupe_and_cap(self):
        manager = self.manager("adapter_host.kodi.adapters.source_pack",
                               {"sourcePackage": "fixture_sources", "sourceFolders": ["en"]})
        ids = await manager.evaluation_source_ids()
        legacy, aware = "fixture_sources.en.01_legacy", "fixture_sources.en.02_aware"
        self.assertIn(legacy, ids)
        self.assertIn(aware, ids)
        first = await manager.evaluate_source(MOVIE, legacy)
        second = await manager.evaluate_source(MOVIE, aware)
        self.assertEqual(len(first), 4)  # Includes an unproven opaque direct candidate.
        self.assertEqual(len(second), 4)
        self.assertEqual(first, second)  # Same Direct URLs remain owned by both sources.
        self.assertTrue(all(item["type"] == "https" for item in first))
        self.assertEqual(len(await manager.resolve(MOVIE)), 1)  # Normal profile cap still applies.
        self.assertEqual(await manager.evaluate_source(MOVIE, "fixture_sources.en.03_unsupported"), [])
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await manager.evaluate_source(MOVIE, "fixture_sources.en.not_configured")

    async def test_external_package_keeps_torrent_and_direct_provenance(self):
        manager = self.manager("adapter_host.kodi.adapters.external_scraper_package",
                               {"packageModule": "scraper_package_a", "folders": ["torrents"]})
        ids = await manager.evaluation_source_ids()
        self.assertIn("movie", ids)
        self.assertIn("duplicate", ids)
        self.assertIn("broken", ids)
        movie = await manager.evaluate_source(MOVIE, "movie")
        duplicate = await manager.evaluate_source(MOVIE, "duplicate")
        self.assertEqual(len(movie), 3)  # Beyond the profile's one-result cap.
        self.assertEqual(len(duplicate), 2)
        self.assertEqual(sum(candidate["type"] == "https" for candidate in movie), 1)
        self.assertEqual(sum(candidate["type"] == "magnet" for candidate in movie), 2)
        self.assertEqual(movie[0]["infoHash"], duplicate[0]["infoHash"])
        self.assertTrue(any(candidate["type"] == "https" for candidate in movie))
        self.assertTrue(any(candidate["type"] == "magnet" for candidate in duplicate))
        self.assertEqual(await manager.resolve(MOVIE), movie[:1])
        self.assertEqual(await manager.evaluate_source(MOVIE, "episode"), [])
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await manager.evaluate_source(MOVIE, "absent")

    async def test_external_partial_failure_keeps_pre_failure_candidate(self):
        manager = self.manager("adapter_host.kodi.adapters.external_scraper_package",
                               {"packageModule": "scraper_package_a", "folders": ["torrents"]},
                               mode="iterator_failure")
        self.assertIn("streaming", await manager.evaluation_source_ids())
        candidates = await manager.evaluate_source(MOVIE, "streaming")
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates, await manager.resolve(MOVIE))

    async def test_evaluation_data_stays_in_memory_and_worker_logs_are_sanitized(self):
        manager = self.manager("adapter_host.kodi.adapters.external_scraper_package",
                               {"packageModule": "scraper_package_a", "folders": ["torrents"]})
        output, errors = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            candidates = await manager.evaluate_source(MOVIE, "movie")
        self.assertTrue(candidates)
        self.assertEqual((output.getvalue(), errors.getvalue()), ("", ""))
        self.assertEqual(list(self.root.rglob("*candidate*")), [])
