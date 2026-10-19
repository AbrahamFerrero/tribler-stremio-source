from __future__ import annotations

import importlib
from contextlib import ExitStack
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

from adapter_host.kodi.compat import install


FIXTURE = Path(__file__).parent / "fixtures" / "fake_kodi_addon"


class KodiCompatibilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        install("script.module.fake", FIXTURE, Path(self.temporary.name), {"fixture.enabled": "true"})
        self.xbmc = importlib.import_module("xbmc")
        self.xbmcaddon = importlib.import_module("xbmcaddon")
        self.xbmcgui = importlib.import_module("xbmcgui")
        self.xbmcvfs = importlib.import_module("xbmcvfs")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_xbmc_logging_monitor_and_denied_execution(self) -> None:
        self.assertFalse(self.xbmc.Monitor().abortRequested())
        self.assertEqual(self.xbmc.getInfoLabel("System.BuildVersion"), "20.0")
        self.xbmc.log("safe test")
        with self.assertRaises(PermissionError):
            self.xbmc.executebuiltin("anything")
        with self.assertRaises(PermissionError):
            self.xbmc.executeJSONRPC("{}")

    def test_xbmcaddon_settings_are_local(self) -> None:
        addon = self.xbmcaddon.Addon("script.module.fake")
        self.assertEqual(addon.getSetting("fixture.enabled"), "true")
        self.assertEqual(addon.getSetting("missing"), "")
        self.assertEqual(Path(addon.getAddonInfo("path")), FIXTURE.resolve())
        with self.assertRaises(PermissionError):
            addon.openSettings()

    def test_xbmcgui_is_deterministic_and_headless(self) -> None:
        window = self.xbmcgui.Window(10000)
        window.setProperty("key", "value")
        self.assertEqual(window.getProperty("key"), "value")
        self.assertFalse(self.xbmcgui.Dialog().yesno("question"))
        self.assertEqual(self.xbmcgui.Dialog().select("heading", []), -1)

    def test_xbmcplugin_directory_calls_are_inert(self) -> None:
        plugin = importlib.import_module("xbmcplugin")
        for name in ("addDirectoryItems", "setContent", "endOfDirectory"):
            self.assertTrue(callable(getattr(plugin, name)))
        for operation in (plugin.setResolvedUrl, plugin.setProperty, self.xbmc.Player().play,
                          self.xbmc.PlayList(1).play, self.xbmcgui.WindowDialog().show,
                          self.xbmcvfs.makeLegalFilename):
            with self.assertRaises(PermissionError):
                operation("untrusted")

        class UntouchedItems:
            def __iter__(self):
                raise AssertionError("directory items must not be consumed")

        # Network, filesystem and command boundaries must not be reached. The
        # payload deliberately includes a URL and an opaque ListItem stand-in.
        items = [("https://example.invalid/video.mp4", object(), False)]
        with ExitStack() as stack:
            boundaries = [stack.enter_context(patch(name, side_effect=AssertionError(name))) for name in (
                "socket.socket", "socket.getaddrinfo", "builtins.open", "io.open",
                "os.open", "os.mkdir", "os.remove", "os.rename", "os.system", "subprocess.Popen",
            )]
            self.assertIs(plugin.addDirectoryItems(1, items), True)
            self.assertIs(plugin.addDirectoryItems(handle=-1, items=items, totalItems=1), True)
            self.assertIs(plugin.addDirectoryItems(1, UntouchedItems(), 100), True)
            self.assertIsNone(plugin.setContent(1, "movies"))
            self.assertIsNone(plugin.setContent(handle=-1, content="episodes"))
            self.assertIsNone(plugin.endOfDirectory(1))
            self.assertIsNone(plugin.endOfDirectory(1, False, True, False))
            self.assertIsNone(plugin.endOfDirectory(handle=-1, succeeded=True, updateListing=False, cacheToDisc=True))
            for boundary in boundaries:
                boundary.assert_not_called()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0][0], "https://example.invalid/video.mp4")
        self.assertEqual(list(Path(self.temporary.name).iterdir()), [])

    def test_xbmcvfs_confines_paths_and_writes(self) -> None:
        path = self.xbmcvfs.translatePath("special://profile/addon_data/script.module.fake/test.txt")
        with self.xbmcvfs.File(path, "w") as handle:
            handle.write("ok")
        self.assertTrue(self.xbmcvfs.exists(path))
        with self.assertRaises(PermissionError):
            self.xbmcvfs.translatePath("../escape.txt")
        with self.assertRaises(PermissionError):
            self.xbmcvfs.File(str(FIXTURE / "write.txt"), "w")


if __name__ == "__main__":
    unittest.main()
