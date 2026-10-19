from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError, replace
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from adapter_host.app import default_registry
from adapter_host.config import AdapterSettings, KodiResolverProfile
from adapter_host.kodi.adapter_config import (
    MAX_ADAPTER_CONFIG_BYTES, WORKER_PROFILE_CONFIG_ENV, decode_adapter_config, encode_adapter_config,
)
from adapter_host.kodi.process_manager import KodiWorkerConfig, _minimal_environment
from adapter_host.kodi.protocol import MAX_INPUT_BYTES, encode_message, error_response
from adapter_host.kodi_installed_resolver import KodiInstalledResolver
from adapter_host.models import MediaItem

HOST_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).parent / "fixtures" / "profile_config_source.py"
POISON = {
    "PYTHON_ADAPTER_KODI_SOURCE_MODULE": "wrong_module",
    "PYTHON_ADAPTER_KODI_SOURCE_ID": "wrong_source",
    "PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING": "wrong_setting",
    "PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE": "wrong_mode",
    WORKER_PROFILE_CONFIG_ENV: '{"parent":"wrong-profile"}',
    "PYTHON_ADAPTER_KODI_RESOLVERS_FILE": "private-parent-path",
}


class KodiProfileIsolationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.a, self.b = (self.make_profile(label) for label in ("a", "b"))

    def make_profile(self, label: str) -> KodiResolverProfile:
        addon = self.root / label / "addon"
        (addon / "lib").mkdir(parents=True)
        (addon / "lib" / f"module_{label}.py").write_bytes(FIXTURE.read_bytes())
        settings = self.root / label / "fixture-settings.json"
        settings.write_text(json.dumps({f"setting_{label}": "true"}), encoding="utf-8")
        return KodiResolverProfile(
            id=f"profile_{label}", name=f"Profile {label}", enabled=True,
            addon_path=addon, addon_id=f"script.module.{label}",
            module="adapter_host.kodi.adapters.p2p_metadata", callable="resolve",
            settings_file=settings, profile_path=self.root / label / "profile",
            worker_timeout_seconds=5,
            adapter_config={"sourceModule": f"module_{label}", "sourceId": f"source_{label}",
                            "sourceEnabledSetting": f"setting_{label}",
                            "sourceResponseMode": "none" if label == "a" else "capture-streams"},
        )

    def item(self, title="Fixture") -> MediaItem:
        return MediaItem(id="tt1234567", kind="movie", title=title)

    def assert_results(self, results, profiles) -> None:
        self.assertEqual([result["providerId"] for result in results], [profile.id for profile in profiles])
        for result, profile in zip(results, profiles):
            self.assertEqual(result["metadata"]["provider"], profile.adapter_config["sourceId"])
            self.assertEqual(result["metadata"]["source"], profile.adapter_config["sourceModule"])
            self.assertEqual(result["infoHash"], profile.id[-1] * 40)
            if profile.adapter_config["sourceResponseMode"] == "capture-streams":
                self.assertEqual(result["fileIndex"], 7)
                self.assertEqual(result["filename"], "b.mkv")
            else:
                self.assertNotIn("fileIndex", result)

    async def test_sequential_a_then_b_and_b_then_a(self) -> None:
        for profiles in ((self.a, self.b), (self.b, self.a)):
            with self.subTest(order=[profile.id for profile in profiles]):
                resolvers = [KodiInstalledResolver.from_profile(profile) for profile in profiles]
                results = []
                for resolver in resolvers:
                    results.extend(await resolver.resolve(self.item()))
                    self.assertEqual(resolver.manager.active_count, 0)
                    self.assertEqual(len(resolver.manager.completed_pids), 1)
                self.assert_results(results, profiles)

    async def test_concurrent_workers_observe_only_their_own_configuration(self) -> None:
        registry = default_registry(AdapterSettings(kodi_profiles=(self.a, self.b)))
        task = asyncio.create_task(registry.resolve(self.item("concurrent")))
        try:
            deadline = asyncio.get_running_loop().time() + 3
            while not all((profile.profile_path / "ready").exists() for profile in (self.a, self.b)):
                if task.done() or asyncio.get_running_loop().time() >= deadline:
                    self.fail("Both real workers must reach the fixture barrier")
                await asyncio.sleep(0.01)
            for profile in (self.a, self.b):
                self.assertEqual(registry._resolvers[profile.id].manager.active_count, 1)
                (profile.profile_path / "release").write_text("release")
            self.assert_results(await task, (self.a, self.b))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        for profile in (self.a, self.b):
            self.assertEqual(registry._resolvers[profile.id].manager.active_count, 0)

    async def test_failure_and_timeout_preserve_other_profile_results(self) -> None:
        invalid = replace(self.b, adapter_config={**self.b.adapter_config, "sourceResponseMode": "invalid"})
        for profile, title in ((invalid, "Fixture"), (self.b, "fail_b"),
                               (replace(self.b, worker_timeout_seconds=0.3), "block_b")):
            with self.subTest(title=title):
                registry = default_registry(AdapterSettings(kodi_profiles=(profile, self.a)))
                results = await registry.resolve(self.item(title))
                self.assert_results(results, (self.a,))
                states = {state["id"]: state for state in registry.list_resolvers()}
                self.assertEqual(states[self.a.id]["status"], "ok")
                self.assertEqual(states[self.b.id]["status"], "resolver_error")
                self.assertEqual(states[self.b.id]["lastError"], "resolver_error")
                for resolver in (registry._resolvers[self.a.id], registry._resolvers[self.b.id]):
                    self.assertEqual(resolver.manager.active_count, 0)
                    self.assertEqual(len(resolver.manager.completed_pids), 1)

    async def test_parent_environment_poisoning_cannot_override_either_profile(self) -> None:
        registry = default_registry(AdapterSettings(kodi_profiles=(self.a, self.b)))
        with patch.dict(os.environ, POISON):
            before = dict(os.environ)
            self.assert_results(await registry.resolve(self.item()), (self.a, self.b))
            self.assertTrue(dict(os.environ) == before, "Worker launch mutated the parent environment")

    async def test_secret_sentinels_and_legacy_names_are_absent_from_real_worker(self) -> None:
        names = ("TRIBLER_API_KEY", "TRIBLER_URL", "SOME_API_TOKEN", "COOKIE_SECRET",
                 "PROVIDER_API_KEY", "AUTHORIZATION", "PROVIDER_CREDENTIALS", "PROVIDER_PASSWORD")
        profile = replace(self.a, module="module_a", callable="inspect_environment")
        resolver = KodiInstalledResolver.from_profile(profile, maximum_results=7)
        with patch.dict(os.environ, {**POISON, **dict.fromkeys(names, "SHOULD_NOT_BE_VISIBLE")}):
            result, = await resolver.resolve(self.item())
        self.assertFalse(any(result["metadata"]["visible"].values()))
        self.assertTrue(result["metadata"]["configMatches"])
        self.assertTrue(result["metadata"]["limitMatches"])

    async def _inspect_worker_environment(self):
        profile = replace(self.a, module="module_a", callable="inspect_environment")
        resolver = KodiInstalledResolver.from_profile(profile, maximum_results=7)
        result, = await resolver.resolve(self.item())
        metadata = result["metadata"]
        for name in ("configMatches", "limitMatches", "encodingMatches", "utf8Matches"):
            self.assertTrue(metadata[name], name)
        self.assertEqual(resolver.manager.active_count, 0)
        return metadata

    async def test_parent_privacy_canaries_are_absent_from_real_worker(self) -> None:
        groups = {
            "arbitrary": ("KODI_PRIVACY_CANARY_1",),
            "identity": ("USERNAME", "USER", "USERPROFILE", "HOME", "COMPUTERNAME", "HOSTNAME",
                         "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "USERDOMAIN"),
            "proxy": ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"),
            "certificate": ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"),
            "runtime_excluded": ("WINDIR", "PATH", "TEMP", "TMP"),
        }
        for category, names in groups.items():
            for capitalization in (str.upper, str.lower, str.title):
                canaries = dict.fromkeys(map(capitalization, names), "parent-only-canary")
                with patch.dict(os.environ, {**POISON, **canaries}):
                    before = dict(os.environ)
                    metadata = await self._inspect_worker_environment()
                    self.assertTrue(dict(os.environ) == before, "Worker launch mutated the parent environment")
                for name in canaries:
                    with self.subTest(category=category, name=name):
                        self.assertFalse(metadata["visible"][name], "Parent canary is visible")

    async def test_arbitrary_parent_noise_does_not_change_worker_environment(self) -> None:
        baseline = await self._inspect_worker_environment()
        canaries = {f"UNRELATED_CANARY_{index:03d}": f"noise-{index}" for index in range(20)}
        with patch.dict(os.environ, canaries):
            observed = await self._inspect_worker_environment()
        for name in canaries:
            with self.subTest(name=name):
                self.assertFalse(observed["visible"][name], "Parent noise is visible")
        self.assertTrue(observed == baseline, "Parent noise changed the observable worker environment")

    async def test_legacy_parsed_once_then_executes_through_profile_transport(self) -> None:
        with patch.dict(os.environ, {
            "PYTHON_ADAPTER_KODI_RESOLVER_ENABLED": "true",
            "PYTHON_ADAPTER_KODI_ADDON_PATH": str(self.a.addon_path),
            "PYTHON_ADAPTER_KODI_MODULE": self.a.module,
            "PYTHON_ADAPTER_KODI_SETTINGS_FILE": str(self.a.settings_file),
            "PYTHON_ADAPTER_KODI_SOURCE_MODULE": "module_a",
            "PYTHON_ADAPTER_KODI_SOURCE_ID": "source_a",
            "PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING": "setting_a",
            "PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE": "none",
        }, clear=True):
            settings = AdapterSettings.from_environment()
        with patch.dict(os.environ, POISON):
            registry = default_registry(settings)
            result, = await registry.resolve(self.item())
        self.assertEqual(result["providerId"], "kodi_installed")
        self.assertEqual(result["metadata"]["provider"], "source_a")
        self.assertEqual(result["metadata"]["source"], "module_a")
        manager = registry._resolvers["kodi_installed"].manager
        self.assertEqual(manager.config.adapter_config, settings.kodi_profiles[0].adapter_config)
        self.assertEqual(len(manager.completed_pids), 1)

    def test_missing_malformed_and_invalid_config_fail_in_real_worker_with_sanitized_errors(self) -> None:
        config = dict(self.a.adapter_config)
        invalid_objects = [[], {}, {**config, "sourceModule": "bad/name"}, {**config, "sourceId": "bad/id"},
                           {**config, "sourceEnabledSetting": "bad/setting"},
                           {**config, "sourceResponseMode": "unsupported"}, {**config, "sourceId": 3},
                           {**config, "unexpected": "private-value"}]
        invalid_objects.extend({key: value for key, value in config.items() if key != missing}
                               for missing in ("sourceModule", "sourceId", "sourceEnabledSetting"))
        raws = [None, '{"private-value":', "[" * 2000, " " * (MAX_ADAPTER_CONFIG_BYTES + 1),
                '{"sourceId":"one","sourceId":"two"}', '{"value":NaN}']
        raws.extend(json.dumps(value) for value in invalid_objects)
        manager = KodiInstalledResolver.from_profile(self.a).manager
        self.a.profile_path.mkdir()
        request = encode_message({"requestId": "a" * 32, "media": {
            "id": "tt1234567", "kind": "movie", "title": "Fixture",
        }}, MAX_INPUT_BYTES)
        for index, raw in enumerate(raws):
            with self.subTest(case=index):
                environment = _minimal_environment()
                # Deliberately bypass only the parent encoder to exercise malformed
                # input at the real worker boundary; no fake process or production hook.
                environment.update({
                    "PYTHON_ADAPTER_KODI_SOURCE_MODULE": "module_a",
                    "PYTHON_ADAPTER_KODI_SOURCE_ID": "source_a",
                    "PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING": "setting_a",
                    "PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE": "none",
                })
                if raw is not None:
                    environment[WORKER_PROFILE_CONFIG_ENV] = raw
                process = subprocess.run(manager._arguments(self.a.profile_path), input=request,
                                         capture_output=True, timeout=3, cwd=HOST_ROOT, env=environment)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(json.loads(process.stdout), error_response("module_error"))
                self.assertEqual(process.stderr, b"")

    async def test_request_metadata_cannot_override_profile_configuration(self) -> None:
        item = MediaItem.from_json({"id": "tt1234567", "kind": "movie", "title": "Fixture",
                                   "metadata": {"adapterConfig": dict(self.b.adapter_config),
                                                WORKER_PROFILE_CONFIG_ENV: "poison"}})
        result = await KodiInstalledResolver.from_profile(self.a).resolve(item)
        self.assert_results(result, (self.a,))

    def test_worker_config_owns_deeply_immutable_data_and_transport_is_bounded(self) -> None:
        original = {"nested": {"items": [1, True, None]}, "label": "fixture"}
        first = KodiWorkerConfig(addon_path=self.a.addon_path, module_name="module_a", adapter_config=original)
        second = replace(first)
        original["nested"]["items"].append("changed")
        self.assertEqual(first.adapter_config["nested"]["items"], (1, True, None))
        self.assertIsNot(first.adapter_config, second.adapter_config)
        self.assertIsNot(first.adapter_config["nested"], second.adapter_config["nested"])
        with self.assertRaises(TypeError):
            first.adapter_config["nested"]["items"][0] = 2
        with self.assertRaises(FrozenInstanceError):
            first.adapter_config = {}
        encoded = encode_adapter_config(first.adapter_config)
        self.assertEqual(encoded, '{"label":"fixture","nested":{"items":[1,true,null]}}')
        self.assertEqual(encode_adapter_config(dict(reversed(list(first.adapter_config.items())))), encoded)
        self.assertEqual(decode_adapter_config(encoded), first.adapter_config)
        for value in ({"large": "x" * MAX_ADAPTER_CONFIG_BYTES}, {"items": [1] * 128},
                      {"a": {"b": {"c": {"d": {}}}}}, {"value": float("nan")}):
            with self.subTest(kind=next(iter(value))):
                with self.assertRaises(ValueError):
                    replace(first, adapter_config=value)
                with self.assertRaises(ValueError):
                    encode_adapter_config(value)

    def test_profile_and_worker_config_reject_credential_fields(self) -> None:
        for name in ("TRIBLER_API_KEY", "TRIBLER_URL", "apiKey", "token", "cookies", "authorization",
                     "credentials", "password"):
            with self.subTest(field=name):
                value = {"nested": {name: "sentinel"}}
                with self.assertRaisesRegex(ValueError, "credential fields"):
                    replace(self.a, adapter_config=value)
                with self.assertRaisesRegex(ValueError, "credential fields"):
                    KodiWorkerConfig(addon_path=self.a.addon_path, module_name="module_a", adapter_config=value)


if __name__ == "__main__":
    unittest.main()
