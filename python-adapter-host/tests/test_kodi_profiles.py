from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from adapter_host.config import AdapterSettings, KodiResolverProfile
from adapter_host.kodi.process_manager import KodiWorkerConfig
from adapter_host.kodi_installed_resolver import KodiInstalledResolver
from adapter_host.kodi_profiles import (
    MAX_ADAPTER_CONFIG_BYTES, MAX_ADAPTER_CONFIG_DEPTH, MAX_ADAPTER_CONFIG_ITEMS,
    MAX_CONFIG_BYTES, MAX_PROFILES,
)

FILE_ENV = "PYTHON_ADAPTER_KODI_RESOLVERS_FILE"


class KodiProfileConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.path = self.root / "resolvers.json"
        (self.root / "addon" / "lib").mkdir(parents=True)
        (self.root / "private-settings.json").write_text("{}", encoding="utf-8")
        self.entry = {
            "id": "profile_a", "name": "Profile A", "enabled": True,
            "addonPath": "addon", "addonId": "script.module.local",
            "module": "synthetic_module", "callable": "resolve",
            "workerTimeoutSeconds": 5, "adapterConfig": {},
        }
        environment = patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def load(self, entries=None, **root_overrides) -> AdapterSettings:
        root = {"version": 1, "profiles": [self.entry] if entries is None else entries}
        root.update(root_overrides)
        self.path.write_text(json.dumps(root), encoding="utf-8")
        with patch.dict(os.environ, {FILE_ENV: str(self.path)}):
            return AdapterSettings.from_environment()

    def test_one_profile_and_paths_relative_to_configuration_file(self) -> None:
        self.entry.update(settingsFile="private-settings.json", profilePath="profile")
        profile, = self.load().kodi_profiles
        self.assertIsInstance(profile, KodiResolverProfile)
        self.assertEqual((profile.id, profile.name, profile.enabled), ("profile_a", "Profile A", True))
        self.assertEqual(profile.addon_path, self.root / "addon")
        self.assertEqual(profile.settings_file, self.root / "private-settings.json")
        self.assertEqual(profile.profile_path, self.root / "profile")
        self.assertEqual((profile.module, profile.callable, profile.addon_id, profile.worker_timeout_seconds),
                         ("synthetic_module", "resolve", "script.module.local", 5))
        self.assertFalse((self.root / "profile").exists())

    def test_multiple_profiles_preserve_order_and_disabled_state(self) -> None:
        second = dict(self.entry, id="profile_b", name="Profile B", enabled=False)
        profiles = self.load([self.entry, second]).kodi_profiles
        self.assertEqual(tuple(profile.id for profile in profiles), ("profile_a", "profile_b"))
        self.assertFalse(profiles[1].enabled)
        self.assertIsNone(profiles[0].settings_file)
        self.assertIsNone(profiles[0].profile_path)
        self.assertEqual(self.load([]).kodi_profiles, ())

    def test_profiles_and_nested_adapter_data_are_immutable_and_detached(self) -> None:
        profile, = self.load().kodi_profiles
        original = {"nested": {"items": [1, True, None, "value", 1.25]}}
        profile = replace(profile, adapter_config=original)
        original["nested"]["items"].append("changed")
        self.assertEqual(profile.adapter_config["nested"]["items"], (1, True, None, "value", 1.25))
        with self.assertRaises(FrozenInstanceError):
            profile.enabled = False
        with self.assertRaises(TypeError):
            profile.adapter_config["new"] = 1
        with self.assertRaises(TypeError):
            profile.adapter_config["nested"]["new"] = 1
        with self.assertRaises(TypeError):
            profile.adapter_config["nested"]["items"][0] = 2
        source = [profile]
        settings = AdapterSettings(kodi_profiles=source)
        source.clear()
        self.assertEqual(settings.kodi_profiles, (profile,))
        with self.assertRaises(FrozenInstanceError):
            settings.kodi_profiles = ()

    def test_duplicate_profile_ids_are_rejected_even_when_disabled(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate resolver ids"):
            self.load([self.entry, dict(self.entry, enabled=False)])
        profile, = self.load().kodi_profiles
        with self.assertRaisesRegex(ValueError, "duplicate resolver ids"):
            AdapterSettings(kodi_profiles=(profile, profile))

    def test_invalid_profile_ids(self) -> None:
        for value in ("", "bad/id", "bad id", "x" * 65, 42, None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "resolver id"):
                self.load([dict(self.entry, id=value)])

    def test_invalid_names_and_enabled_flags(self) -> None:
        for field, values in (("name", ("", " ", "x" * 129, None, 1)),
                              ("enabled", ("true", 1, None))):
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    self.load([dict(self.entry, **{field: value})])

    def test_module_callable_and_addon_id_share_worker_validation(self) -> None:
        for field, worker_field, values in (
            ("module", "module_name", ("bad/name", "module()", "service", "pkg.default", "", 1)),
            ("callable", "callable_name", ("module.resolve", "resolve()", "", None)),
            ("addonId", "addon_id", ("bad/id", "", "x" * 129, None)),
        ):
            for value in values:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(ValueError):
                        self.load([dict(self.entry, **{field: value})])
                    arguments = {"addon_path": self.root / "addon", "module_name": "synthetic_module"}
                    arguments[worker_field] = value
                    with self.assertRaises(ValueError):
                        KodiWorkerConfig(**arguments).validated()

    def test_invalid_timeouts_and_hierarchy(self) -> None:
        for value in (0, -1, 301, True, "5", None, float("nan"), float("inf"), 6, 7):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.load([dict(self.entry, workerTimeoutSeconds=value)])
        with patch.dict(os.environ, {"PYTHON_ADAPTER_RESOLVER_TIMEOUT_SECONDS": "4"}):
            with self.assertRaisesRegex(ValueError, "below resolver timeout"):
                self.load()
        # Disabled profiles retain valid worker timeouts without an active resolver deadline.
        profile, = self.load([dict(self.entry, enabled=False, workerTimeoutSeconds=10)]).kodi_profiles
        self.assertEqual(profile.worker_timeout_seconds, 10)
        with self.assertRaises(ValueError):
            self.load([dict(self.entry, enabled=False, workerTimeoutSeconds=0)])

    def test_unsupported_version_including_boolean_and_float(self) -> None:
        for version in (0, 2, "1", True, 1.0, None):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "version"):
                self.load(version=version)

    def test_malformed_json_is_sanitized(self) -> None:
        for raw in (b'{"private-marker":', b"\xff", b"[" * 2000):
            with self.subTest(raw=raw[:20]):
                self.path.write_bytes(raw)
                with patch.dict(os.environ, {FILE_ENV: str(self.path)}):
                    with self.assertRaises(ValueError) as error:
                        AdapterSettings.from_environment()
                self.assertNotIn(str(self.path), str(error.exception))
                self.assertNotIn("private-marker", str(error.exception))
                self.assertIn("JSON", str(error.exception))

    def test_malformed_root_structure(self) -> None:
        for root in ([], None, 1, {}, {"version": 1}, {"profiles": []},
                     {"version": 1, "profiles": {}}, {"version": 1, "profiles": [], "extra": True}):
            with self.subTest(root=root):
                self.path.write_text(json.dumps(root), encoding="utf-8")
                with patch.dict(os.environ, {FILE_ENV: str(self.path)}), self.assertRaises(ValueError):
                    AdapterSettings.from_environment()

    def test_missing_required_or_unknown_profile_fields(self) -> None:
        for key in self.entry:
            entry = dict(self.entry)
            del entry[key]
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "required fields"):
                self.load([entry])
        for entry in (None, [], "profile", dict(self.entry, unexpected="value")):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.load([entry])

    def test_invalid_paths(self) -> None:
        for key in ("addonPath", "settingsFile", "profilePath"):
            for value in ("", " ", 5, [], "bad\x00path"):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                    self.load([dict(self.entry, **{key: value})])
        with self.assertRaises(ValueError):
            self.load([dict(self.entry, addonPath=None)])

    def test_missing_or_nonregular_configuration_file(self) -> None:
        for path, message in ((self.path, "missing or unreadable"), (self.root, "regular file")):
            with self.subTest(path=path), patch.dict(os.environ, {FILE_ENV: str(path)}):
                with self.assertRaisesRegex(ValueError, message) as error:
                    AdapterSettings.from_environment()
                self.assertNotIn(str(path), str(error.exception))

    def test_configuration_file_size_is_bounded(self) -> None:
        raw = json.dumps({"version": 1, "profiles": []}).encode()
        self.path.write_bytes(raw + b" " * (MAX_CONFIG_BYTES - len(raw)))
        with patch.dict(os.environ, {FILE_ENV: str(self.path)}):
            self.assertEqual(AdapterSettings.from_environment().kodi_profiles, ())
            with self.path.open("ab") as output:
                output.write(b" ")
            with self.assertRaisesRegex(ValueError, "too large"):
                AdapterSettings.from_environment()

    def test_profile_count_is_bounded(self) -> None:
        entries = [dict(self.entry, id=f"p{i}") for i in range(MAX_PROFILES)]
        self.assertEqual(len(self.load(entries).kodi_profiles), MAX_PROFILES)
        with self.assertRaises(ValueError):
            self.load(entries + [dict(self.entry, id="extra")])

    def test_adapter_config_requires_finite_json_object(self) -> None:
        for value in ([], "data", None, 1, {"value": float("nan")}, {"value": float("inf")}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.load([dict(self.entry, adapterConfig=value)])
        profile, = self.load().kodi_profiles
        for value in ({1: "bad-key"}, {"value": object()}, {"value": {1, 2}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                replace(profile, adapter_config=value)

    def test_adapter_config_depth_count_and_bytes_are_bounded(self) -> None:
        nested = {}
        for _ in range(MAX_ADAPTER_CONFIG_DEPTH - 1):
            nested = {"child": nested}
        self.load([dict(self.entry, adapterConfig=nested)])
        for value, message in (
            ({"child": nested}, "deeply nested"),
            ({"items": [0] * MAX_ADAPTER_CONFIG_ITEMS}, "too many items"),
            ({"text": "x" * MAX_ADAPTER_CONFIG_BYTES}, "too large"),
            ({"text": "\u00e9" * (MAX_ADAPTER_CONFIG_BYTES // 2)}, "too large"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.load([dict(self.entry, adapterConfig=value)])
        profile, = self.load().kodi_profiles
        cycle = {}
        cycle["cycle"] = cycle
        with self.assertRaisesRegex(ValueError, "deeply nested"):
            replace(profile, adapter_config=cycle)

    def test_duplicate_json_keys_are_rejected_without_echoing_values(self) -> None:
        for raw in ('{"version":1,"version":1,"profiles":[]}',
                    json.dumps({"version": 1, "profiles": [self.entry]}).replace(
                        '"adapterConfig": {}', '"adapterConfig": {"private-marker":1,"private-marker":2}')):
            self.path.write_text(raw, encoding="utf-8")
            with patch.dict(os.environ, {FILE_ENV: str(self.path)}):
                with self.assertRaisesRegex(ValueError, "duplicate object keys") as error:
                    AdapterSettings.from_environment()
            self.assertNotIn("private-marker", str(error.exception))

    def test_legacy_configuration_maps_to_the_same_model_and_worker_config(self) -> None:
        environment = {
            "PYTHON_ADAPTER_KODI_RESOLVER_ENABLED": "true",
            "PYTHON_ADAPTER_KODI_ADDON_PATH": str(self.root / "addon"),
            "PYTHON_ADAPTER_KODI_MODULE": "synthetic_module",
            "PYTHON_ADAPTER_KODI_ADDON_ID": "script.module.synthetic",
            "PYTHON_ADAPTER_KODI_CALLABLE": "lookup",
            "PYTHON_ADAPTER_KODI_SETTINGS_FILE": str(self.root / "private-settings.json"),
            "PYTHON_ADAPTER_KODI_PROFILE_PATH": str(self.root / "profile"),
            "PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS": "4",
            "PYTHON_ADAPTER_KODI_SOURCE_MODULE": "synthetic.source",
            "PYTHON_ADAPTER_KODI_SOURCE_ID": "synthetic",
            "PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING": "provider.synthetic",
            "PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE": " CAPTURE-STREAMS ",
        }
        with patch.dict(os.environ, environment):
            settings = AdapterSettings.from_environment()
        profile, = settings.kodi_profiles
        self.assertEqual((profile.id, profile.name, profile.enabled),
                         ("kodi_installed", "Installed Kodi resolver", True))
        self.assertEqual(profile.adapter_config, {
            "sourceModule": "synthetic.source", "sourceId": "synthetic",
            "sourceEnabledSetting": "provider.synthetic", "sourceResponseMode": "capture-streams",
        })
        self.assertEqual(profile, self.load([dict(
            self.entry, id=profile.id, name=profile.name, addonId=profile.addon_id,
            callable="lookup", workerTimeoutSeconds=4, settingsFile="private-settings.json",
            profilePath="profile", adapterConfig=dict(profile.adapter_config),
        )]).kodi_profiles[0])
        resolver = KodiInstalledResolver.from_settings(settings)
        self.assertEqual(resolver.id, "kodi_installed")
        self.assertEqual(resolver.manager.config, KodiWorkerConfig(
            addon_path=self.root / "addon", module_name="synthetic_module", callable_name="lookup",
            addon_id="script.module.synthetic", settings_file=self.root / "private-settings.json",
            profile_path=self.root / "profile", timeout_seconds=4, adapter_config=profile.adapter_config,
        ))

    def test_legacy_disabled_profile_and_unconfigured_state(self) -> None:
        self.assertEqual(AdapterSettings.from_environment().kodi_profiles, ())
        self.assertFalse(AdapterSettings.from_environment().kodi_resolver_enabled)
        with patch.dict(os.environ, {
            "PYTHON_ADAPTER_KODI_ADDON_PATH": str(self.root / "addon"),
            "PYTHON_ADAPTER_KODI_MODULE": "synthetic_module",
        }):
            profile, = AdapterSettings.from_environment().kodi_profiles
        self.assertFalse(profile.enabled)
        self.assertEqual((profile.callable, profile.addon_id, profile.worker_timeout_seconds),
                         ("resolve", "script.module.local", 5))

    def test_legacy_and_file_configuration_conflict_even_for_empty_or_disabled_values(self) -> None:
        for suffix, value in (("MODULE", "synthetic_module"), ("RESOLVER_ENABLED", "false"),
                              ("CALLABLE", ""), ("SOURCE_ID", "synthetic")):
            with self.subTest(suffix=suffix):
                with patch.dict(os.environ, {f"PYTHON_ADAPTER_KODI_{suffix}": value}):
                    with self.assertRaisesRegex(ValueError, "cannot be combined"):
                        self.load()

    def test_file_loading_does_not_import_addons_or_construct_workers(self) -> None:
        with patch("adapter_host.kodi_installed_resolver.KodiWorkerProcessManager") as manager, patch(
            "importlib.import_module"
        ) as importer:
            settings = self.load([dict(self.entry, id="kodi_installed")])
        importer.assert_not_called()
        manager.assert_not_called()
        self.assertEqual(settings.kodi_profiles[0].id, "kodi_installed")
        self.assertIsNone(settings.legacy_kodi_profile)
        self.assertFalse(settings.kodi_resolver_enabled)


if __name__ == "__main__":
    unittest.main()
