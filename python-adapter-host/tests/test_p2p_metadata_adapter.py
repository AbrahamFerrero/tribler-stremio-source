from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import unittest

from adapter_host.kodi.adapters.p2p_metadata import (
    _build_query,
    _source_response_compatibility,
    _restore_file_selection_metadata,
)
from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerProcessManager
from adapter_host.kodi_installed_resolver import KodiInstalledResolver
from adapter_host.models import MediaItem


FIXTURE = Path(__file__).parent / "fixtures" / "fake_kodi_addon"


class P2pMetadataAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.adapter_config = {
            "sourceModule": "example_p2p.sources.torrents.metadata_source",
            "sourceId": "example_p2p",
            "sourceEnabledSetting": "provider.example_p2p",
            "sourceResponseMode": "capture-streams",
        }

    def test_restores_example_p2p_file_selection_metadata_by_unique_infohash(self) -> None:
        info_hash = "a" * 40
        source_results = [{"hash": info_hash, "name": "opaque release"}]
        restored = _restore_file_selection_metadata(source_results, [{
            "infoHash": info_hash,
            "fileIdx": 7,
            "behaviorHints": {"filename": "Show.S02E03.mkv"},
        }])

        self.assertEqual(restored, 1)
        self.assertEqual(source_results[0]["fileIndex"], 7)
        self.assertEqual(source_results[0]["filename"], "Show.S02E03.mkv")

    def test_compatibility_scope_captures_raw_metadata_and_restores_it_after_sources(self) -> None:
        info_hash = "9" * 40

        def original(**_kwargs):
            return '{"streams":[{"infoHash":"' + info_hash + '","fileIdx":4,' \
                '"behaviorHints":{"filename":"Show.S02E03.mkv"}}]}'

        client = SimpleNamespace(request=original)
        provider_module = SimpleNamespace(client=client)
        source_results = [{"hash": info_hash}]
        with _source_response_compatibility("capture-streams", provider_module) as observation:
            client.request()
            self.assertEqual(_restore_file_selection_metadata(source_results, observation.raw_streams), 1)

        self.assertEqual(source_results[0]["fileIndex"], 4)
        self.assertEqual(source_results[0]["filename"], "Show.S02E03.mkv")
        self.assertIs(client.request, original)

    def test_does_not_enrich_when_hash_is_missing_or_ambiguous(self) -> None:
        info_hash = "b" * 40
        different = [{"hash": "c" * 40}]
        ambiguous = [{"hash": info_hash}]
        remote = [
            {"infoHash": info_hash, "fileIdx": 1, "behaviorHints": {"filename": "one.mkv"}},
            {"infoHash": info_hash, "fileIdx": 2, "behaviorHints": {"filename": "two.mkv"}},
        ]

        self.assertEqual(_restore_file_selection_metadata(different, remote), 0)
        self.assertNotIn("fileIndex", different[0])
        self.assertEqual(_restore_file_selection_metadata(ambiguous, remote), 0)
        self.assertNotIn("fileIndex", ambiguous[0])

    def test_invalid_example_p2p_file_index_or_filename_fails_closed_per_field(self) -> None:
        info_hash = "d" * 40
        cases = [
            ({"infoHash": info_hash, "fileIdx": True, "behaviorHints": {"filename": "valid.mkv"}}, "fileIndex"),
            ({"infoHash": info_hash, "fileIdx": -1, "behaviorHints": {"filename": "valid.mkv"}}, "fileIndex"),
            ({"infoHash": info_hash, "fileIdx": 3, "behaviorHints": {"filename": "bad\x00name.mkv"}}, "filename"),
            ({"infoHash": info_hash, "fileIdx": 3, "behaviorHints": {"filename": "x" * 1_025}}, "filename"),
        ]
        for remote, forbidden in cases:
            with self.subTest(remote=remote["fileIdx"], forbidden=forbidden):
                source_results = [{"hash": info_hash}]
                _restore_file_selection_metadata(source_results, [remote])
                self.assertNotIn(forbidden, source_results[0])

    def test_movie_without_example_p2p_file_metadata_is_unchanged(self) -> None:
        info_hash = "e" * 40
        source_results = [{"hash": info_hash, "name": "existing movie"}]

        self.assertEqual(_restore_file_selection_metadata(source_results, [{"infoHash": info_hash}]), 0)
        self.assertEqual(source_results, [{"hash": info_hash, "name": "existing movie"}])

    def test_example_p2p_http_headers_are_fixed_and_client_is_restored(self) -> None:
        seen_headers = []

        def original(**kwargs):
            seen_headers.append(kwargs["headers"])
            return '{"streams":[]}'

        client = SimpleNamespace(request=original)
        provider_module = SimpleNamespace(client=client)

        with _source_response_compatibility("capture-streams", provider_module):
            self.assertEqual(client.request(), '{"streams":[]}')

        self.assertEqual(seen_headers[0]["Accept"], "application/json")
        self.assertIs(client.request, original)

    async def test_movie_query_and_final_result_classification_run_in_worker(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
        ))
        resolver = KodiInstalledResolver(manager)

        results = await resolver.resolve(MediaItem(
            id="fixture:bbb",
            kind="movie",
            title="Big Buck Bunny",
            year=2008,
            external_ids={"imdb": "tt1254207"},
        ))

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["infoHash"], "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c")
        self.assertEqual(results[0]["seeds"], 7)
        self.assertEqual(results[0]["sizeBytes"], 268_435_456)
        self.assertEqual(results[0]["metadata"]["provider"], "example_p2p")
        self.assertEqual(results[1]["type"], "https")
        self.assertEqual(results[1]["filename"], "bbb-test.mp4")
        self.assertEqual(manager.active_count, 0)
        self.assertEqual(len(manager.completed_pids), 1)

    async def test_stremio_imdb_id_works_without_enriched_title_or_year(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
        ))

        results = await KodiInstalledResolver(manager).resolve(MediaItem(
            id="tt1254207",
            kind="movie",
            title="tt1254207",
        ))

        self.assertEqual(len(results), 2)
        self.assertTrue(all(result["metadata"]["provider"] == "example_p2p" for result in results))
        self.assertEqual(manager.active_count, 0)

    async def test_many_provider_results_are_capped_before_worker_validation(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
            maximum_results=7,
        ))

        results = await KodiInstalledResolver(manager).resolve(MediaItem(
            id="tt0000025",
            kind="movie",
            title="Many Results",
            year=2026,
        ))

        self.assertEqual(len(results), 7)
        self.assertEqual(manager.active_count, 0)
        self.assertEqual(len(manager.completed_pids), 1)

    async def test_provider_must_be_enabled_in_local_settings(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            timeout_seconds=1,
        ))
        resolver = KodiInstalledResolver(manager)

        results = await resolver.resolve(MediaItem(
            id="fixture:bbb",
            kind="movie",
            title="Big Buck Bunny",
            year=2008,
            external_ids={"imdb": "tt1254207"},
        ))

        self.assertEqual(results, [])
        self.assertEqual(manager.active_count, 0)
        self.assertEqual(len(manager.completed_pids), 1)

    async def test_episode_query_rejects_ambiguous_captured_file_selection(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
        ))
        results = await KodiInstalledResolver(manager).resolve(MediaItem(
            id="tt9999999999:2:3",
            kind="episode",
            title="",
            external_ids={"imdb": "tt9999999999"},
            season=2,
            episode=3,
        ))
        self.assertEqual(results, [])
        self.assertEqual(manager.active_count, 0)

    async def test_episode_file_index_is_preserved_when_provider_supplies_one(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
        ))
        results = await KodiInstalledResolver(manager).resolve(MediaItem(
            id="tt9999999999:2:4", kind="episode", title="",
            external_ids={"imdb": "tt9999999999"}, season=2, episode=4,
        ))
        self.assertEqual(results[0]["fileIndex"], 8)

    async def test_ambiguous_season_pack_is_not_exposed_for_episode_playback(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="adapter_host.kodi.adapters.p2p_metadata",
            adapter_config=self.adapter_config,
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=1,
        ))
        results = await KodiInstalledResolver(manager).resolve(MediaItem(
            id="tt9999999999:2:2", kind="episode", title="",
            external_ids={"imdb": "tt9999999999"}, season=2, episode=2,
        ))
        self.assertEqual(results, [])

    def test_episode_without_imdb_or_coordinates_fails_closed(self) -> None:
        self.assertIsNone(_build_query({
            "id": "tt9999999999:2:3", "kind": "episode", "title": "",
            "externalIds": {}, "season": 2,
        }))


if __name__ == "__main__":
    unittest.main()
