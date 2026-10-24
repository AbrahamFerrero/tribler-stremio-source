from __future__ import annotations

import os
import time

import xbmc
import xbmcaddon
import xbmcgui
import xbmcvfs


def resolve(media):
    mode = media["id"]
    if mode == "fixture:ready-block":
        with xbmcvfs.File("special://profile/addon_data/script.module.fake/ready", "w") as ready:
            ready.write("ready")
        while True:
            time.sleep(1)
    if mode == "fixture:exception":
        raise RuntimeError("fixture secret traceback must not escape")
    if mode in {"fixture:block", "fixture:ignore-cancellation"}:
        while True:
            time.sleep(1)
    if mode == "fixture:invalid":
        return [{"type": "https", "url": 42}]
    if mode == "fixture:corrupt-stdout":
        os.write(1, b"corrupt")
        return []
    if mode == "fixture:large-output":
        os.write(1, b"x" * 300_000)
        return []
    if mode == "fixture:large-stderr":
        os.write(2, b"x" * 40_000)
        return []
    if mode == "fixture:child-process":
        import subprocess
        import sys
        subprocess.run([sys.executable, "-c", "pass"], check=True)
        return []
    if mode == "fixture:shell":
        os.system("exit 0")
        return []
    if mode == "fixture:unsupported":
        return [{"type": "ftp", "url": "ftp://example.invalid/file"}]
    if mode == "fixture:traversal":
        xbmcvfs.translatePath("../outside")
        return []
    if mode == "fixture:described":
        return [
            {"type": "https", "url": "https://1.1.1.1/fixture-video.mp4",
             "title": "Synthetic private description", "filename": "synthetic-private.mp4",
             "language": "hu", "audio": "Dual audio", "resolution": "1080p"},
            {"type": "magnet", "magnet": "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc",
             "title": "Audio: Japanese | English subtitles", "filename": "synthetic-private.mkv",
             "resolution": "1080p"},
        ]

    addon = xbmcaddon.Addon("script.module.fake")
    setting_ok = addon.getSetting("fixture.enabled") == "true"
    direct_cases = {
        "fixture:direct-movie": {
            "id": "fixture:direct-movie", "kind": "movie", "title": "fixture:direct-movie",
            "year": None, "season": None, "episode": None, "externalIds": {},
            "classifications": [],
        },
        "tt7654321:4:5": {
            "id": "tt7654321:4:5", "kind": "episode", "title": "",
            "year": None, "season": 4, "episode": 5,
            "externalIds": {"imdb": "tt7654321"}, "classifications": [],
        },
    }
    if mode in direct_cases:
        assert media == direct_cases[mode]
        return [{
            "type": "https",
            # Public literal keeps source validation deterministic; A02/A03 do not fetch it.
            "url": "https://1.1.1.1/fixture-video.mp4",
            "filename": "movie-direct.mp4" if mode == "fixture:direct-movie"
            else "episode-identity-tt7654321-s04e05.mp4",
            "quality": "1080p",
        }]
    if mode == "tt7654322":
        assert media == {
            "id": "tt7654322", "kind": "movie", "title": "tt7654322",
            "year": None, "season": None, "episode": None,
            "externalIds": {"imdb": "tt7654322"},
            "classifications": [],
        }
        return [
            {
                "type": "https", "url": "https://1.1.1.1/ac4-best-2160p.mp4",
                "title": "AC4 Python 2160p", "filename": "ac4-best-2160p.mp4",
                "quality": "2160p", "codec": "HEVC", "language": "en",
                "sizeBytes": 5 * 1024 ** 3,
            },
            {
                "type": "https", "url": "https://1.1.1.1/ac4-duplicate-1080p.mp4",
                "title": "AC4 Python duplicate 480p", "filename": "ac4-duplicate-1080p.mp4",
                "quality": "480p", "sizeBytes": 512 * 1024 ** 2,
            },
        ]
    profile = addon.getAddonInfo("profile")
    translated = xbmcvfs.translatePath("special://profile/addon_data/script.module.fake/fixture.txt")
    window = xbmcgui.Window(10000)
    window.setProperty("fixture", "ready")
    xbmc.log("fake module invoked", xbmc.LOGINFO)
    return [
        {
            "type": "https",
            "url": "https://example.invalid/fixture.mp4",
            "filename": "fixture.mp4",
            "quality": "1080p",
            "metadata": {
                "fixture": True,
                "setting": setting_ok,
                "pathConfined": translated.startswith(profile),
                "window": window.getProperty("fixture"),
                "triblerApiKeyVisible": os.getenv("TRIBLER_API_KEY") is not None,
                "triblerUrlVisible": os.getenv("TRIBLER_URL") is not None,
            },
        },
        {
            "type": "magnet",
            "magnet": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "title": "Fixture magnet",
        },
        {
            "infoHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "fileIndex": 2,
            "filename": "fixture-selected.mkv",
        },
    ]
