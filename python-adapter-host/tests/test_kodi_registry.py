from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from adapter_host.app import default_registry
from adapter_host.config import AdapterSettings, KodiResolverProfile
from adapter_host.example_resolver import ExampleResolver
from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerProcessManager
from adapter_host.kodi_installed_resolver import KodiInstalledResolver
from adapter_host.models import MediaItem


class KodiRegistryConstructionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.profile_a = self.make_profile("profile_a", "Profile A", 4)
        self.profile_b = self.make_profile("profile_b", "Profile B", 5)

    def make_profile(self, identifier: str, name: str, timeout: float) -> KodiResolverProfile:
        addon = self.root / identifier / "addon"
        (addon / "lib").mkdir(parents=True)
        settings = self.root / identifier / "fixture-settings.json"
        settings.write_text(json.dumps({"fixture.marker": identifier}), encoding="utf-8")
        module = "fixture_" + identifier
        operation = "resolve_" + identifier
        # Minimal project-authored fixture: no network or adapterConfig access.
        (addon / "lib" / (module + ".py")).write_text(
            "import xbmcaddon\n\n"
            f"def {operation}(media):\n"
            "    addon = xbmcaddon.Addon()\n"
            "    return [{\n"
            "        'type': 'https',\n"
            f"        'url': 'https://example.invalid/{identifier}.mp4',\n"
            "        'metadata': {\n"
            f"            'module': '{module}',\n"
            "            'setting': addon.getSetting('fixture.marker'),\n"
            "            'addon': addon.getAddonInfo('id'),\n"
            "        },\n"
            "    }]\n",
            encoding="utf-8",
        )
        return KodiResolverProfile(
            id=identifier, name=name, enabled=True, addon_path=addon,
            addon_id="script.module." + identifier, module=module, callable=operation,
            worker_timeout_seconds=timeout, settings_file=settings,
            profile_path=self.root / identifier / "profile",
        )

    async def test_unconfigured_registry_keeps_disabled_placeholder_and_example_behavior(self) -> None:
        registry = default_registry(AdapterSettings())
        states = registry.list_resolvers()
        self.assertEqual([(state["id"], state["enabled"]) for state in states],
                         [("example_authorized", True), ("kodi_installed", False)])
        self.assertEqual(states[1]["status"], "disabled")
        self.assertIsNone(registry._resolvers["kodi_installed"].manager)
        item = MediaItem(id="python-adapter:test", kind="movie", title="Fixture")
        self.assertEqual(await registry.resolve(item), await ExampleResolver().resolve(item))
        self.assertEqual(registry.enabled_count(), 1)

    def test_one_profile_has_its_own_identity_without_an_extra_placeholder(self) -> None:
        registry = default_registry(AdapterSettings(kodi_profiles=(self.profile_a,)))
        self.assertEqual([(state["id"], state["name"], state["enabled"]) for state in registry.list_resolvers()],
                         [(ExampleResolver.id, ExampleResolver.name, True), ("profile_a", "Profile A", True)])
        self.assertIsInstance(registry._resolvers["profile_a"], KodiInstalledResolver)
        self.assertEqual(KodiInstalledResolver().id, "kodi_installed")
        self.assertEqual(KodiInstalledResolver().name, "Installed Kodi resolver")

    def test_two_profiles_follow_configuration_order_including_file_input(self) -> None:
        path = self.root / "resolvers.json"
        for profiles in ((self.profile_a, self.profile_b), (self.profile_b, self.profile_a)):
            with self.subTest(order=[profile.id for profile in profiles]):
                path.write_text(json.dumps({"version": 1, "profiles": [{
                    "id": profile.id, "name": profile.name, "enabled": profile.enabled,
                    "addonPath": str(profile.addon_path), "addonId": profile.addon_id,
                    "module": profile.module, "callable": profile.callable,
                    "workerTimeoutSeconds": profile.worker_timeout_seconds, "adapterConfig": {},
                } for profile in profiles]}), encoding="utf-8")
                with patch.dict(os.environ, {"PYTHON_ADAPTER_KODI_RESOLVERS_FILE": str(path)}, clear=True):
                    settings = AdapterSettings.from_environment()
                registry = default_registry(settings)
                self.assertEqual([(state["id"], state["name"]) for state in registry.list_resolvers()],
                                 [(ExampleResolver.id, ExampleResolver.name)] +
                                 [(profile.id, profile.name) for profile in profiles])
                self.assertEqual(registry.enabled_count(), 3)

    def test_each_resolver_owns_its_profile_worker_manager_and_configuration(self) -> None:
        settings = AdapterSettings(kodi_profiles=(self.profile_a, self.profile_b), max_results_per_resolver=7)
        with patch.dict(os.environ, {"PYTHON_ADAPTER_KODI_MODULE": "must_not_be_read"}), patch.object(
            AdapterSettings, "from_environment", side_effect=AssertionError("unexpected config reread")
        ):
            registry = default_registry(settings)
        first, second = (registry._resolvers[profile.id] for profile in settings.kodi_profiles)
        self.assertIsNot(first, second)
        self.assertIsNot(first.manager, second.manager)
        self.assertIsNot(first.manager.config, second.manager.config)
        self.assertIsNot(first.manager.completed_pids, second.manager.completed_pids)
        for profile, resolver in zip(settings.kodi_profiles, (first, second)):
            with self.subTest(profile=profile.id):
                self.assertEqual((resolver.id, resolver.name), (profile.id, profile.name))
                self.assertIsInstance(resolver.manager, KodiWorkerProcessManager)
                self.assertEqual(resolver.manager.config, KodiWorkerConfig(
                    addon_path=profile.addon_path, module_name=profile.module, callable_name=profile.callable,
                    addon_id=profile.addon_id, settings_file=profile.settings_file,
                    profile_path=profile.profile_path, timeout_seconds=profile.worker_timeout_seconds,
                    maximum_results=7,
                ))
                self.assertEqual(resolver.manager.active_count, 0)
                self.assertEqual(resolver.manager.completed_pids, [])
                self.assertFalse(profile.profile_path.exists())
                self.assertNotIn(profile.module, sys.modules)
                with self.assertRaises(FrozenInstanceError):
                    resolver.manager.config.module_name = "changed"

    async def test_disabled_profile_is_visible_but_never_executed(self) -> None:
        disabled = replace(self.profile_b, enabled=False)
        registry = default_registry(AdapterSettings(kodi_profiles=(self.profile_a, disabled)))
        first, second = registry._resolvers["profile_a"], registry._resolvers["profile_b"]
        self.assertIsNot(first.manager, second.manager)
        self.assertEqual([(state["id"], state["enabled"]) for state in registry.list_resolvers()],
                         [(ExampleResolver.id, True), ("profile_a", True), ("profile_b", False)])
        with patch.object(first.manager, "resolve", new_callable=AsyncMock, return_value=[]) as active, patch.object(
            second.manager, "resolve", new_callable=AsyncMock, side_effect=AssertionError("disabled worker ran")
        ) as inactive:
            await registry.resolve(MediaItem(id="fixture:profiles", kind="movie", title="Fixture"))
        active.assert_awaited_once()
        inactive.assert_not_called()
        self.assertEqual(registry.list_resolvers()[2]["status"], "disabled")
        self.assertFalse(disabled.profile_path.exists())
        self.assertNotIn(disabled.module, sys.modules)

    def test_legacy_environment_preserves_identity_and_enablement(self) -> None:
        for enabled in (True, False):
            with self.subTest(enabled=enabled), patch.dict(os.environ, {
                "PYTHON_ADAPTER_KODI_RESOLVER_ENABLED": str(enabled),
                "PYTHON_ADAPTER_KODI_ADDON_PATH": str(self.profile_a.addon_path),
                "PYTHON_ADAPTER_KODI_MODULE": self.profile_a.module,
                "PYTHON_ADAPTER_KODI_CALLABLE": self.profile_a.callable,
            }, clear=True):
                registry = default_registry()
                self.assertEqual([(state["id"], state["name"], state["enabled"])
                                  for state in registry.list_resolvers()],
                                 [(ExampleResolver.id, ExampleResolver.name, True),
                                  ("kodi_installed", "Installed Kodi resolver", enabled)])
                self.assertEqual(registry._resolvers["kodi_installed"].manager.config.module_name,
                                 self.profile_a.module)

    def test_file_profile_with_legacy_id_registers_once_and_is_enabled(self) -> None:
        profile = replace(self.profile_a, id="kodi_installed", name="Configured file profile")
        settings = AdapterSettings(kodi_profiles=(profile,), kodi_resolvers_file=self.root / "resolvers.json")
        self.assertIsNone(settings.legacy_kodi_profile)
        states = default_registry(settings).list_resolvers()
        self.assertEqual([state["id"] for state in states], [ExampleResolver.id, "kodi_installed"])
        self.assertEqual((states[1]["name"], states[1]["enabled"]), ("Configured file profile", True))

    def test_existing_duplicate_registration_protection_is_preserved(self) -> None:
        registry = default_registry(AdapterSettings(kodi_profiles=(self.profile_a,)))
        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register(KodiInstalledResolver.from_profile(self.profile_a))
        self.assertEqual(len(registry.list_resolvers()), 2)
        collision = replace(self.profile_a, id=ExampleResolver.id)
        with self.assertRaisesRegex(ValueError, "already registered"):
            default_registry(AdapterSettings(kodi_profiles=(collision,)))

    def test_construction_keeps_existing_addon_path_validation_for_disabled_profiles(self) -> None:
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                invalid = replace(self.profile_a, enabled=enabled, addon_path=self.root)
                with self.assertRaisesRegex(ValueError, "must contain lib"):
                    default_registry(AdapterSettings(kodi_profiles=(invalid,)))

    async def test_two_profiles_execute_their_own_modules_in_real_workers(self) -> None:
        profiles = (self.profile_b, self.profile_a)
        registry = default_registry(AdapterSettings(kodi_profiles=profiles))
        results = await registry.resolve(MediaItem(id="fixture:profiles", kind="movie", title="Fixture"))
        self.assertEqual([(result["providerId"], result["url"], result["metadata"]) for result in results], [
            (profile.id, f"https://example.invalid/{profile.id}.mp4",
             {"module": profile.module, "setting": profile.id, "addon": profile.addon_id})
            for profile in profiles
        ])
        managers = [registry._resolvers[profile.id].manager for profile in profiles]
        for manager in managers:
            self.assertEqual(manager.active_count, 0)
            self.assertEqual(len(manager.completed_pids), 1)
        self.assertNotEqual(managers[0].completed_pids[0], managers[1].completed_pids[0])
        self.assertEqual([state["status"] for state in registry.list_resolvers()[1:]], ["ok", "ok"])
        for profile in profiles:
            self.assertNotIn(profile.module, sys.modules)


if __name__ == "__main__":
    unittest.main()
