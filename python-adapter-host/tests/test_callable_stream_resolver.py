from __future__ import annotations

import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import tempfile
import shutil
import unittest
from unittest.mock import patch

from adapter_host.config import AdapterSettings
from adapter_host.kodi.adapters.callable_stream_resolver import ADAPTER_MODULE
from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerError, KodiWorkerProcessManager
from adapter_host.kodi_profiles import KodiResolverProfile
import test_http_api
import test_http_availability
import test_kodi_worker

FIXTURE = test_http_api.FIXTURE
MOVIE = {"id": "tt1254207", "kind": "movie", "title": "Big Buck Bunny", "year": 2008}
CONFIG = {"targetModule": "callable_stream_fixture", "targetCallable": "get_stream_data", "resultMode": "tuple"}
URL = "https://1.1.1.1/fixture-video.mp4"


def profile(**kwargs):
    return KodiResolverProfile(id="callable_fixture", name="Callable fixture", enabled=True,
                               addon_path=FIXTURE, addon_id="script.module.fake", module=ADAPTER_MODULE,
                               callable="resolve", worker_timeout_seconds=2, adapter_config=CONFIG, **kwargs)


class CallableWorkerTests(unittest.IsolatedAsyncioTestCase):
    observe_real_processes = test_kodi_worker.KodiWorkerTests.observe_real_processes

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workers = []

    def manager(self, mode="", result_mode="tuple", maximum=20, timeout=2, config=None, addon_path=FIXTURE):
        directory = self.root / str(len(self.workers))
        directory.mkdir()
        settings = directory / "settings.json"
        settings.write_text(json.dumps({"fixture.mode": mode}), encoding="utf-8")
        worker = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=addon_path, module_name=ADAPTER_MODULE, settings_file=settings,
            profile_path=directory / "profile", timeout_seconds=timeout, maximum_results=maximum,
            adapter_config=config if config is not None else {**CONFIG, "resultMode": result_mode}))
        self.workers.append(worker)
        return worker

    def arguments(self, worker):
        return json.loads((worker.config.profile_path / "arguments.json").read_text())

    async def asyncTearDown(self):
        for worker in self.workers:
            self.assertEqual(worker.active_count, 0)

    async def test_movie_tuple_mapping_sanitization_order_and_dedupe(self):
        worker = self.manager()
        with patch.dict(os.environ, {"TRIBLER_API_KEY": "hidden", "TRIBLER_URL": "hidden"}):
            result = await worker.resolve(MOVIE)
        self.assertEqual([r["type"] for r in result], ["https", "magnet"])
        self.assertEqual(result[0], {"type": "https", "url": URL, "filename": "BigBuckBunny.mp4",
                                     "title": "Big Buck Bunny", "quality": "1080p"})
        self.assertEqual(result[1]["fileIndex"], 0)
        self.assertEqual(result, await worker.resolve(MOVIE))
        self.assertEqual(self.arguments(worker), dict(imdb_id="tt1254207", content_type="movie", season=None,
                         episode=None, override_title="Big Buck Bunny", override_year=2008, tmdb_id=None,
                         progress_callback=None, target_providers=None, _optional_flag=False))
        serialized = json.dumps(result)
        for secret in ("headers", "metadata", "Cookie", "Authorization", "X-Api-Key", "do-not-expose"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(len(set(worker.completed_pids)), 2)

    async def test_hls_discards_kodi_instructions_and_preserves_validation(self):
        result = await self.manager("hls").resolve(MOVIE)
        self.assertEqual(result, [
            {"type": "https", "url": "https://1.1.1.1/video/plain.m3u8", "quality": "720p"},
            {"type": "https", "url": "https://1.1.1.1/video/kodi.m3u8", "quality": "720p"},
            {"type": "https", "url": "https://1.1.1.1/video/sensitive.m3u8"},
            {"type": "https", "url": "https://example.invalid/api/play"},
            {"type": "https", "url": URL},
            {"type": "https", "url": "https://1.1.1.1/video/normal.mkv"},
        ])

    async def test_episode_and_optional_identity_are_not_invented(self):
        worker = self.manager()
        episode = {**MOVIE, "kind": "episode", "title": "Episode title", "season": 0, "episode": 2,
                   "seriesTitle": "Authorized fixture series", "externalIds": {"imdb": "tt1254207", "tmdb": "10378"}}
        await worker.resolve(episode)
        args = self.arguments(worker)
        self.assertEqual((args["content_type"], args["season"], args["episode"], args["tmdb_id"]), ("tv", 0, 2, "10378"))
        self.assertEqual(args["override_title"], "Authorized fixture series")
        await worker.resolve({k: v for k, v in episode.items() if k not in {"seriesTitle", "year"}})
        self.assertIsNone(self.arguments(worker)["override_title"])
        self.assertIsNone(self.arguments(worker)["override_year"])
        await worker.resolve({**MOVIE, "id": "local:bbb", "externalIds": {"tmdb": "10378"}})
        self.assertIsNone(self.arguments(worker)["imdb_id"])
        self.assertEqual(self.arguments(worker)["tmdb_id"], "10378")
        await worker.resolve({**MOVIE, "externalIds": {"tmdb": "not-a-number"}})
        self.assertIsNone(self.arguments(worker)["tmdb_id"])
        for changes in ({"kind": "series"}, {"kind": "episode", "season": 1},
                        {"kind": "episode", "season": True, "episode": 2}):
            skipped = self.manager()
            self.assertEqual(await skipped.resolve({**MOVIE, **changes}), [])
            self.assertFalse((skipped.config.profile_path / "arguments.json").exists())

    async def test_explicit_direct_list_and_iterable_contracts(self):
        expected = await self.manager().resolve(MOVIE)
        for mode in ("list", "iterable"):
            self.assertEqual(await self.manager(mode, "streams").resolve(MOVIE), expected)
        self.assertEqual(await self.manager("empty").resolve(MOVIE), [])
        self.assertEqual(await self.manager("canceled").resolve(MOVIE), [])

    async def test_tuple3_and_bounded_signature_projection(self):
        self.assertEqual(await self.manager("tuple3").resolve(MOVIE), await self.manager().resolve(MOVIE))
        for operation in ("short_stream_data", "known_required", "arbitrary_kwargs"):
            worker = self.manager(config={**CONFIG, "targetCallable": operation})
            self.assertEqual(await worker.resolve(MOVIE), [{"type": "https", "url": URL}])
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await self.manager(config={**CONFIG, "targetCallable": "unknown_required"}).resolve(MOVIE)

    async def test_failure_and_lazy_failure_are_sanitized(self):
        for mode, contract in (("exception", "tuple"), ("bad_tuple", "tuple"), ("bad_status", "tuple"),
                               ("invalid", "streams"), ("iterator_failure", "streams"), ("list", "tuple"),
                               ("bad_canceled_collection", "tuple")):
            with self.subTest(mode=mode), self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
                await self.manager(mode, contract).resolve(MOVIE)
        with self.assertRaisesRegex(KodiWorkerError, "^sandbox_violation$"):
            await self.manager("sandbox").resolve(MOVIE)

    async def test_scan_and_output_bounds_stop_lazy_iteration(self):
        result = await self.manager("many", "streams", maximum=3).resolve(MOVIE)
        self.assertEqual([r["url"] for r in result], [URL + "?fixture=" + str(i) for i in range(3)])
        self.assertEqual(await self.manager("invalid_scan", "streams").resolve(MOVIE), [])
        self.assertEqual(len(await self.manager("many", "streams", maximum=100).resolve(MOVIE)), 100)

    async def test_timeout_and_cancellation_reap_real_workers(self):
        processes = self.observe_real_processes()
        worker = self.manager("block", timeout=0.4)
        with self.assertRaisesRegex(KodiWorkerError, "^worker_timeout$"):
            await worker.resolve(MOVIE)
        self.assertTrue((worker.config.profile_path / "arguments.json").exists())
        blocking = self.manager("block", timeout=5)
        task = asyncio.create_task(blocking.resolve(MOVIE))
        deadline = asyncio.get_running_loop().time() + 2
        while not (blocking.config.profile_path / "arguments.json").exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertTrue((blocking.config.profile_path / "arguments.json").exists())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(len(processes), 2)
        self.assertTrue(all(process.returncode is not None for process in processes))
        self.assertEqual([len(w.completed_pids) for w in (worker, blocking)], [1, 1])

    async def test_only_callable_in_configured_addon_is_loaded(self):
        for module, operation in (("json", "loads"), ("missing_local_module", "resolve"),
                                  ("callable_stream_fixture", "missing"), ("callable_stream_fixture", "URL")):
            with self.subTest(module=module, operation=operation), self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
                await self.manager(config={**CONFIG, "targetModule": module, "targetCallable": operation}).resolve(MOVIE)

    def resources_addon(self):
        addon = self.root / "resources-addon"
        library = addon / "resources" / "lib"
        library.mkdir(parents=True)
        # Reuse the deterministic fixture, changing only its installed layout.
        shutil.copyfile(FIXTURE / "lib" / "callable_stream_fixture.py", library / "scraper.py")
        return addon

    async def test_resources_layout_namespace_and_regular_packages(self):
        expected = await self.manager().resolve(MOVIE)
        addon = self.resources_addon()
        for regular in (False, True):
            if regular:
                for directory in (addon / "resources", addon / "resources/lib"):
                    (directory / "__init__.py").write_text("", encoding="utf-8")
            for module in ("resources.lib.scraper", "scraper"):
                with self.subTest(regular=regular, module=module):
                    worker = self.manager(addon_path=addon, config={**CONFIG, "targetModule": module})
                    self.assertEqual(await worker.resolve(MOVIE), expected)
                    self.assertEqual(self.arguments(worker)["override_title"], "Big Buck Bunny")
        shutil.copytree(FIXTURE / "lib", addon / "lib")
        self.assertEqual(await self.manager(addon_path=addon).resolve(MOVIE), expected)

    async def test_outside_roots_and_external_search_paths_are_rejected_before_import(self):
        addon = self.resources_addon()
        trap = 'raise PermissionError("must not execute unauthorized module")'
        (addon / "outside.py").write_text(trap, encoding="utf-8")
        (addon / "resources/outside.py").write_text(trap, encoding="utf-8")
        outside = self.root / "external"
        outside.mkdir()
        (outside / "external_target.py").write_text(trap, encoding="utf-8")
        bad_package = addon / "unapproved"
        bad_package.mkdir()
        (bad_package / "__init__.py").write_text(trap, encoding="utf-8")
        (bad_package / "target.py").write_text(trap, encoding="utf-8")
        local_worker = self.manager(addon_path=addon, config={**CONFIG, "targetModule": "resources.lib.scraper"})
        expected = await local_worker.resolve(MOVIE)
        with patch.dict(os.environ, {"PYTHONPATH": str(outside)}):
            for module in ("outside", "resources.outside", "external_target", "unapproved.target", "json", "pip"):
                with self.subTest(module=module), self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
                    await self.manager(addon_path=addon, config={**CONFIG, "targetModule": module}).resolve(MOVIE)
            # Ambient PYTHONPATH must not let an external regular package shadow
            # the authorized local namespace package or execute its initializer.
            (outside / "resources").mkdir()
            (outside / "resources/__init__.py").write_text(trap, encoding="utf-8")
            self.assertEqual(await local_worker.resolve(MOVIE), expected)

    async def test_symlink_escape_from_module_and_standard_root(self):
        addon = self.resources_addon()
        outside = self.root / "outside.py"
        outside.write_text('raise PermissionError("must not import")', encoding="utf-8")
        link = addon / "resources/lib/escape.py"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest(f"symlinks unavailable: {type(error).__name__}")
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await self.manager(addon_path=addon, config={**CONFIG, "targetModule": "resources.lib.escape"}).resolve(MOVIE)
        internal = addon / "outside.py"
        internal.write_text(outside.read_text(), encoding="utf-8")
        link.unlink()
        link.symlink_to(internal)
        with self.assertRaisesRegex(KodiWorkerError, "^module_error$"):
            await self.manager(addon_path=addon, config={**CONFIG, "targetModule": "resources.lib.escape"}).resolve(MOVIE)
        other = self.root / "linked-addon"
        other.mkdir()
        (other / "lib").symlink_to(addon / "resources/lib", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Python root"):
            self.manager(addon_path=other)

    def test_configuration_rejected_at_startup_and_frozen(self):
        invalid = [{}, {**CONFIG, "extra": "data"}, {**CONFIG, "headers": {}},
                   *({**CONFIG, "targetModule": value} for value in ("../outside", "service", "a.default", "a;exit", [], "x" * 257)),
                   *({**CONFIG, "targetCallable": value} for value in ("a.b", "__import__", "x()", 1)),
                   *({**CONFIG, "resultMode": value} for value in ("auto", None, []))]
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValueError):
                replace(profile(), adapter_config=config)
        config = dict(CONFIG)
        configured = replace(profile(), adapter_config=config)
        config["targetModule"] = "changed"
        self.assertEqual(configured.adapter_config["targetModule"], CONFIG["targetModule"])
        with self.assertRaises(TypeError):
            configured.adapter_config["targetModule"] = "changed"
        with self.assertRaises(ValueError):
            replace(profile(), callable="other")


class CallableHttpTests(unittest.TestCase):
    host = test_http_availability.HttpAvailabilityTests.host

    def test_http_fields_metadata_ids_and_headers_cannot_select_code_or_arguments(self):
        with tempfile.TemporaryDirectory() as temporary:
            configured = profile(profile_path=Path(temporary) / "profile")
            settings = AdapterSettings(kodi_profiles=(configured,), resolver_timeout_seconds=3, request_timeout_seconds=4)
            with self.host(settings) as (server, registry):
                request = lambda payload: test_http_api.HttpApiTests._request_server(server, "/resolve", payload)
                baseline = request(MOVIE)
                self.assertEqual(baseline[0], 200)
                self.assertEqual(len([r for r in baseline[1]["streams"] if r["providerId"] == configured.id]), 2)
                poison = {"targetModule": "os", "targetCallable": "system", "module": "os", "callable": "system",
                          "script": "bad.py", "class": "Bad", "path": "../outside", "provider": "bad",
                          "target_providers": ["bad"], "adapterConfig": {"targetModule": "os"}, "resultMode": "streams"}
                for key, value in poison.items():
                    with self.subTest(key=key):
                        self.assertEqual(request({**MOVIE, key: value})[0], 400)
                self.assertEqual(request({**MOVIE, "metadata": poison, "stremio": poison}), baseline)
                self.assertEqual(request({**MOVIE, "externalIds": {k: str(v) for k, v in poison.items()}}), baseline)
                from urllib.request import Request, urlopen
                raw = Request(f"http://127.0.0.1:{server.server_address[1]}/resolve", data=json.dumps(MOVIE).encode(),
                              headers={"Content-Type": "application/json", "Cookie": "do-not-expose",
                                       "Authorization": "do-not-expose", "X-Api-Key": "do-not-expose"})
                with urlopen(raw, timeout=2) as response:
                    self.assertEqual(json.load(response), baseline[1])
                arguments = json.loads((configured.profile_path / "arguments.json").read_text())
                self.assertIsNone(arguments["target_providers"])
                self.assertEqual(arguments["override_title"], MOVIE["title"])
                self.assertTrue(registry._resolvers[configured.id].manager.completed_pids)
