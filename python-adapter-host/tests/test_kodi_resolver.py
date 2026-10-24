from __future__ import annotations

from pathlib import Path
import unittest

from tests.worker_integration import HEALTHY_WORKER_SECONDS

from adapter_host.kodi.process_manager import KodiWorkerConfig, KodiWorkerProcessManager
from adapter_host.kodi_installed_resolver import KodiInstalledResolver
from adapter_host.models import MediaItem


FIXTURE = Path(__file__).parent / "fixtures" / "fake_kodi_addon"


class KodiInstalledResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_normalizes_worker_results(self) -> None:
        manager = KodiWorkerProcessManager(KodiWorkerConfig(
            addon_path=FIXTURE,
            module_name="fake_kodi_module",
            addon_id="script.module.fake",
            settings_file=FIXTURE / "settings.example.json",
            timeout_seconds=HEALTHY_WORKER_SECONDS,
        ))
        resolver = KodiInstalledResolver(manager)
        results = await resolver.resolve(MediaItem(id="fixture:ok", kind="movie", title="Fixture"))
        self.assertEqual(len(results), 3)
        self.assertEqual({entry["providerId"] for entry in results}, {"kodi_installed"})
        self.assertEqual(results[2]["fileIndex"], 2)

    async def test_unconfigured_resolver_fails_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "not configured"):
            await KodiInstalledResolver().resolve(MediaItem(id="x", kind="movie", title="X"))


if __name__ == "__main__":
    unittest.main()
