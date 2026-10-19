from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from adapter_host.config import (
    AdapterSettings,
    DEFAULT_MAX_CONCURRENT_RESOLVERS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_RESOLVER_TIMEOUT_SECONDS,
)


class AdapterSettingsTests(unittest.TestCase):
    def test_default_timeout_hierarchy_and_concurrency(self) -> None:
        self.assertLess(DEFAULT_RESOLVER_TIMEOUT_SECONDS, DEFAULT_REQUEST_TIMEOUT_SECONDS)
        self.assertEqual((DEFAULT_RESOLVER_TIMEOUT_SECONDS, DEFAULT_REQUEST_TIMEOUT_SECONDS), (6.0, 8.0))
        self.assertEqual(DEFAULT_MAX_CONCURRENT_RESOLVERS, 4)

    def test_environment_overrides_are_validated(self) -> None:
        with patch.dict(os.environ, {
            "PYTHON_ADAPTER_RESOLVER_TIMEOUT_SECONDS": "3",
            "PYTHON_ADAPTER_REQUEST_TIMEOUT_SECONDS": "5",
            "PYTHON_ADAPTER_MAX_CONCURRENT_RESOLVERS": "2",
        }, clear=True):
            settings = AdapterSettings.from_environment()
        self.assertEqual(settings.resolver_timeout_seconds, 3)
        self.assertEqual(settings.request_timeout_seconds, 5)
        self.assertEqual(settings.max_concurrent_resolvers, 2)

    def test_rejects_inverted_timeout_hierarchy(self) -> None:
        with self.assertRaisesRegex(ValueError, "request timeout must exceed resolver timeout"):
            AdapterSettings(resolver_timeout_seconds=8, request_timeout_seconds=8)

    def test_kodi_resolver_is_disabled_and_unconfigured_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            settings = AdapterSettings.from_environment()
        self.assertFalse(settings.kodi_resolver_enabled)
        self.assertIsNone(settings.kodi_addon_path)
        self.assertIsNone(settings.kodi_module)

    def test_enabled_kodi_resolver_requires_static_local_configuration(self) -> None:
        with patch.dict(os.environ, {"PYTHON_ADAPTER_KODI_RESOLVER_ENABLED": "true"}, clear=True):
            with self.assertRaisesRegex(ValueError, "requires addon path and module"):
                AdapterSettings.from_environment()


if __name__ == "__main__":
    unittest.main()
