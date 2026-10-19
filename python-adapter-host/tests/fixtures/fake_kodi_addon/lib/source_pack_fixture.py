"""Project-authored SourcePack contracts; no Internet or third-party code."""
import json
import os
from pathlib import Path
import threading
import time
import xbmcaddon

URL = "https://1.1.1.1/source-pack.mp4"
_lock = threading.Lock()
_active = 0
_peak = 0


class Legacy:
    def __init__(self):
        self.arguments = {}
        if xbmcaddon.Addon().getSetting("fixture.mode") == "no_resolver":
            self.resolve = None

    def record(self, name, values):
        if name in {"movie", "tvshow"}:
            aliases = values["aliases"]
            if xbmcaddon.Addon().getSetting("fixture.mode") == "json_aliases":
                aliases = json.loads(aliases)
            title = values["localtitle" if name == "movie" else "localtvshowtitle"]
            assert isinstance(aliases, list) and {"title": title} in aliases
            # Providers may mutate their argument; another instance must remain isolated.
            aliases.append({"title": "fixture-private-mutation"})
        self.arguments[name] = {k: v for k, v in values.items() if k != "self"}
        return "opaque-query"

    def movie(self, imdb, title, localtitle, aliases, year):
        return self.record("movie", locals())

    def tvshow(self, imdb, tvdb, tvshowtitle, localtvshowtitle, aliases, year):
        return self.record("tvshow", locals())

    def episode(self, url, imdb, tvdb, title, premiered, season, episode):
        return self.record("episode", locals())

    def sources(self, url, hostDict, hostprDict):
        self.record("sources", locals())
        return self.results()

    def results(self):
        global _active, _peak
        assert "TRIBLER_API_KEY" not in os.environ and "TRIBLER_URL" not in os.environ
        addon = xbmcaddon.Addon()
        mode = addon.getSetting("fixture.mode")
        profile = Path(addon.getAddonInfo("profile"))
        if mode.startswith("resolve_count_"):
            self.resolve_calls = 0
            (profile / "resolve-count.json").write_text(json.dumps({"calls": 0}))
            candidates = {
                "final_mp4": {"url": URL, "direct": True},
                "final_hls": {"url": "https://1.1.1.1/master.m3u8", "direct": True},
                "final_query": {"url": URL + "?case=fixture", "direct": True},
                "invalid_metadata": {"url": URL, "direct": True, "quality": 123},
                "token": {"url": "opaque-video-token", "direct": True},
                "wrapper": {"url": "https://1.1.1.1/direct-wrapper", "direct": True, "filename": "fake.mp4"},
                "none": {"url": "opaque-empty-token", "direct": True},
                "empty": {"url": "opaque-blank-token", "direct": True},
                "same": {"url": "https://1.1.1.1/still-embed", "direct": True, "filename": "fake.mp4"},
                "intermediate": {"url": "opaque-intermediate-token", "direct": True},
                "credential": {"url": "https://1.1.1.1/credential", "direct": True},
                "resolved_magnet": {"url": "https://1.1.1.1/p2p", "direct": True},
                "debrid": {"url": "opaque-video-token", "direct": True, "debridonly": True},
                "local": {"url": "opaque-video-token", "direct": True, "local": True},
                "torrent": {"url": "opaque-video-token", "direct": True, "type": "torrent"},
                "magnet": {"url": "opaque-video-token", "direct": True, "type": "magnet"},
                "info_hash": {"url": "opaque-video-token", "direct": True, "infoHash": "d" * 40},
                "magnet_field": {"url": "opaque-video-token", "direct": True, "magnet": "fixture"},
                "torrent_url": {"url": "https://1.1.1.1/file.torrent", "direct": True},
                "magnet_url": {"url": "magnet:?xt=urn:btih:" + "d" * 40, "direct": True},
                "file_url": {"url": "file:///media.mp4", "direct": True},
                "indirect_http": {"url": "https://1.1.1.1/resolve", "direct": False},
                "indirect_final": {"url": URL, "direct": False},
                "indirect_token": {"url": "opaque-video-token", "direct": False},
                "indirect_same": {"url": "https://1.1.1.1/still-embed", "direct": False, "filename": "fake.mp4"},
                "indirect_intermediate": {"url": "opaque-intermediate-token", "direct": False},
                "encoded_torrent": {"url": "https://1.1.1.1/file%2Etorrent", "direct": True},
            }
            return [candidates[mode.removeprefix("resolve_count_")]]
        if mode == "no_resolver":
            return [
                {"url": "https://1.1.1.1/opaque|Cookie=private", "direct": True, "filename": "fake.mp4"},
                {"url": URL, "direct": True},
                {"url": "https://1.1.1.1/embed", "direct": False, "filename": "fake.mp4"},
                {"url": URL, "direct": False},
            ]
        if mode == "block":
            (profile / "started").write_text("1")
            while True:
                time.sleep(1)
        with _lock:
            _active += 1
            _peak = max(_peak, _active)
        time.sleep(0.08)
        with _lock:
            _active -= 1
            (profile / (type(self).__name__ + ".json")).write_text(json.dumps({"arguments": self.arguments, "peak": _peak}))
        if mode == "error":
            raise RuntimeError("Authorization=private /secret")
        if mode == "sandbox":
            (profile.parent / "outside").write_text("forbidden")
        if mode == "many":
            def generate():
                for index in range(100):
                    yield {"url": URL + "?i=" + str(index), "direct": True}
                raise AssertionError("scan bound exceeded")
            return generate()
        if mode == "lazy_failure":
            def generate():
                yield {"url": URL, "direct": True}
                raise RuntimeError("private lazy failure")
            return generate()
        if mode == "direct_resolve":
            return [
                {"url": "opaque-video-token", "direct": True},
                {"url": "https://1.1.1.1/direct-wrapper", "direct": True, "filename": "fake.mp4"},
                {"url": "opaque-empty-token", "direct": True},
                {"url": "opaque-invalid-token", "direct": True},
                {"url": "https://1.1.1.1/credential", "direct": True},
                {"url": "https://1.1.1.1/p2p", "direct": True},
                {"url": "https://1.1.1.1/still-embed", "direct": True, "filename": "fake.mp4"},
            ]
        return [
            {"url": URL + "|Cookie=private&Authorization=private&Referer=private&Origin=private", "direct": True,
             "quality": "1080p", "language": "en", "headers": {"Cookie": "private"}, "metadata": {"secret": "private"},
             "source": "hoster", "info": "private context"},
            {"url": URL, "direct": True},
            {"url": "https://1.1.1.1/embed", "direct": False, "filename": "fake.mp4"},
            {"url": "https://1.1.1.1/resolve", "direct": False, "quality": "720p"},
            {"url": "https://1.1.1.1/still-embed", "direct": False, "filename": "fake.mp4"},
            {"url": "https://1.1.1.1/credential", "direct": False},
            {"url": "https://1.1.1.1/p2p", "direct": False},
            {"url": URL, "direct": True, "debridonly": True},
            {"url": URL, "direct": True, "local": True},
            {"url": "magnet:?xt=urn:btih:" + "d"*40, "direct": True},
            {"url": "https://1.1.1.1/file.torrent", "direct": True, "filename": "fake.mp4"},
            {"url": "https://1.1.1.1/file.torrent", "type": "torrent", "direct": True},
            {"url": "file:///media.mp4", "direct": True},
            {"url": "https://user:private@1.1.1.1/video.mp4", "direct": True},
            {"url": "https://1.1.1.1/api/embed", "direct": True, "filename": "fake.mp4"},
            None,
        ]

    def resolve(self, url):
        addon = xbmcaddon.Addon()
        if addon.getSetting("fixture.mode").startswith("resolve_count_"):
            self.resolve_calls += 1
            profile = Path(addon.getAddonInfo("profile"))
            (profile / "resolve-count.json").write_text(json.dumps({"calls": self.resolve_calls}))
        if url == "opaque-blank-token":
            return ""
        if url == "opaque-intermediate-token":
            return "https://1.1.1.1/embed"
        if url == "opaque-empty-token":
            return None
        if url == "opaque-invalid-token":
            return "not-a-final-url"
        if url == "opaque-video-token":
            return "https://1.1.1.1/token-resolved.mp4"
        if url == "https://1.1.1.1/direct-wrapper":
            return "https://1.1.1.1/wrapper-resolved.m3u8"
        if url.endswith("/resolve"):
            return "https://1.1.1.1/resolved.m3u8|Origin=private"
        if url.endswith("/credential"):
            return "https://user:private@1.1.1.1/video.mp4"
        if url.endswith("/p2p"):
            return "magnet:?xt=urn:btih:" + "d"*40
        return url


class Aware(Legacy):
    def movie(self, imdb, tmdb, title, localtitle, aliases, year):
        return self.record("movie", locals())

    def tvshow(self, imdb, tmdb, tvdb, tvshowtitle, localtvshowtitle, aliases, year):
        return self.record("tvshow", locals())

    def episode(self, url, imdb, tmdb, tvdb, title, premiered, season, episode):
        return self.record("episode", locals())

    def sources(self, url, hostDict):
        self.record("sources", locals())
        return self.results()


class Unsupported(Legacy):
    def movie(self, imdb, title, arbitrary):
        raise AssertionError("unsupported signature must never be invoked")
