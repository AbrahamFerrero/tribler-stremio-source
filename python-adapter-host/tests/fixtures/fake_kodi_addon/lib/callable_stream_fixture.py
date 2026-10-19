"""Deterministic Big Buck Bunny callable; no networking or third-party providers."""
import json
import os
from pathlib import Path
import time

import xbmcaddon
import xbmcplugin

# Existing public-literal fixture URL: returned as data, never fetched by these tests.
URL = "https://1.1.1.1/fixture-video.mp4"
HASH = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"


def get_stream_data(imdb_id, content_type, season=None, episode=None,
                    progress_callback=None, target_providers=None, override_title=None,
                    override_year=None, tmdb_id=None, _optional_flag=False):
    # Directory UI calls stay inert in a discovery worker.
    assert xbmcplugin.addDirectoryItems(-1, [], totalItems=0) is True
    assert xbmcplugin.setContent(-1, "movies") is None
    assert xbmcplugin.endOfDirectory(-1, succeeded=True, updateListing=False, cacheToDisc=False) is None
    addon = xbmcaddon.Addon()
    arguments = dict(imdb_id=imdb_id, content_type=content_type, season=season, episode=episode,
                     override_title=override_title, override_year=override_year, tmdb_id=tmdb_id,
                     progress_callback=progress_callback, target_providers=target_providers, _optional_flag=_optional_flag)
    assert "TRIBLER_API_KEY" not in os.environ and "TRIBLER_URL" not in os.environ
    profile = Path(addon.getAddonInfo("profile"))
    (profile / "arguments.json").write_text(json.dumps(arguments), encoding="utf-8")
    mode = addon.getSetting("fixture.mode")
    if mode == "exception":
        raise RuntimeError("private path /secret Authorization=do-not-expose")
    if mode == "block":
        while True:
            time.sleep(1)
    if mode == "sandbox":
        (profile.parent / "outside.txt").write_text("forbidden")
    streams = [
        {"url": URL, "filename": "BigBuckBunny.mp4", "title": "Big Buck Bunny", "quality": "1080p",
         "headers": {"Cookie": "do-not-expose", "Authorization": "do-not-expose",
                     "Proxy-Authorization": "do-not-expose", "X-Api-Key": "do-not-expose"},
         "metadata": {"secret": "do-not-expose"}, "behaviorHints": {"proxyHeaders": {"request": {"Cookie": "secret"}}}},
        None, "malformed", {"url": 123}, {"url": "plugin://not-a-stream"},
        {"url": "https://user:secret@example.invalid/video.mp4"},
        {"url": URL + "|Authorization=do-not-expose"},
        {"url": URL, "quality": ["invalid"]}, {"url": URL, "sizeBytes": True},
        {"url": URL, "title": "duplicate"},
        {"infoHash": HASH, "title": "Big Buck Bunny", "fileIndex": 0},
    ]
    if mode == "hls":
        streams = [
            {"url": "https://1.1.1.1/video/plain.m3u8", "quality": "720p"},
            {"url": "https://1.1.1.1/video/kodi.m3u8|User-Agent=fixture&Referer=https%3A%2F%2Fexample.invalid",
             "quality": "720p"},
            {"url": "https://1.1.1.1/video/sensitive.m3u8|Cookie=fixture&Authorization=fixture|ignored",
             "headers": {"Origin": "fixture"}, "metadata": {"headers": "fixture"}},
            {"magnet": "magnet:?xt=urn:btih:" + HASH + "&dn=fixture|foo=bar"},
            {"url": "https://example.invalid/api/play|Cookie=fixture"},
            {"url": "https://example.invalid/api/play"},
            {"url": "https://user:fixture@1.1.1.1/video/master.m3u8|ignored"},
            {"url": "file:///video/master.m3u8|ignored"},
            {"url": "|https://1.1.1.1/video/master.m3u8"},
            {"url": URL},
            {"url": "https://1.1.1.1/video/normal.mkv"},
        ]
    if mode in {"many", "invalid_scan", "iterator_failure"}:
        def generate():
            for i in range(100):
                yield None if mode == "invalid_scan" else {"url": URL + "?fixture=" + str(i)}
                if mode == "iterator_failure":
                    raise RuntimeError("private iterator secret")
            raise RuntimeError("adapter read past its scan bound")
        return generate()
    if mode == "empty":
        streams = []
    if mode == "invalid":
        return {"streams": streams}
    if mode == "tuple3":
        return (streams, [], False)
    if mode == "bad_tuple":
        return (streams,)
    if mode == "bad_canceled_collection":
        return (None, [], True)
    if mode == "bad_status":
        return (streams, [], [], "false")
    if mode == "list":
        return streams
    if mode == "iterable":
        return iter(streams)
    return (streams, ["do-not-expose"], ["do-not-expose"], mode == "canceled")


def short_stream_data(imdb_id, content_type, season=None, episode=None, progress_callback=None, target_providers=None):
    return ([{"url": URL}], ["private diagnostic"], False)


def unknown_required(imdb_id, content_type, arbitrary):
    raise AssertionError("unsupported required argument must not be invoked")


def known_required(imdb_id, content_type, progress_callback, target_providers, tmdb_id):
    assert progress_callback is None and target_providers is None and tmdb_id is None
    return ([{"url": URL}], [], False)


def arbitrary_kwargs(imdb_id, content_type, **kwargs):
    assert kwargs == {}
    return ([{"url": URL}], [], False)
