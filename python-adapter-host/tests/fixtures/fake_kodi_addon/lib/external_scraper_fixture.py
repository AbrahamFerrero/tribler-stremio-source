# These replacement titles and localized labels are invented fixture identities.
# IMDb-shaped numbers are local test data, not a reserved external namespace.
"""Project-authored external-scraper contract fixture; no third-party code or networking."""
import json
from pathlib import Path
import xbmcaddon
import xbmcvfs


class Client:
    def request(self, payload, **kwargs):
        return json.dumps(payload)


client = Client()


def record(name):
    profile = Path(xbmcaddon.Addon().getAddonInfo("profile"))
    with (profile / "calls.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps(name) + "\n")


def providers(tag, specified_folders=None, ret_all=False):
    assert specified_folders == ["torrents"] and ret_all is False
    settings = xbmcaddon.Addon()
    mode = settings.getSetting("fixture.mode")
    record("factory:" + tag)
    if mode == "invalid_package":
        return [("valid", lambda: None), ("invalid", None)]
    if mode == "noniterable_package":
        return 3
    if mode == "many_providers":
        return (("provider_" + str(i), lambda: None) for i in range(101))
    if mode == "empty":
        return []

    def result(letter, **kwargs):
        return {"hash": letter * 40, "name": "Example.S02E03.1080p", **kwargs}

    class Semantic:
        def sources(self, data, hostDict):
            # Authored operations, based on both real packages' title/info helpers.
            # Mirror swallowed failures so a green worker alone cannot pass this test.
            try:
                year = data["year"]
                title = data["title"].replace("&", "and").replace(year, "")
                for alias in data["aliases"]:
                    alias.replace(year, "")
                assert data["imdb"].startswith("tt") and hostDict == {}
                if "tvshowtitle" in data:
                    data["tvshowtitle"].replace("&", "and").replace(year, "")
                    assert data["tvshowtitle"] == ""  # unavailable, never guessed
                    # This fixture requires a truthy season for the TV query contract.
                    assert data["season"]
                    marker = "S%02dE%02d" % (int(data["season"]), int(data["episode"]))
                    name = "Example." + marker + ".1080p"
                else:
                    years = [str(int(year) - 1), year, str(int(year) + 1)]
                    name = "Big.Buck.Bunny.2008.1080p"
                    assert any(value in name for value in years)
                    assert title.replace(" ", ".") == name.split(year)[0].rstrip(".")
                name.lower().replace(year, "")
            except (TypeError, AssertionError) as error:
                record({"semantic_error": type(error).__name__})
                return []
            record("semantic_pass")
            return [result(tag, name=name)]

    class SeriesTitle:
        def sources(self, data, hostDict):
            record({"query": data})
            name = "Neral.Beacon.S01E01.1080p"
            marker = "S%02dE%02d" % (int(data["season"]), int(data["episode"]))
            # Independent synthetic release identity, not derived from the input title.
            release_series = name.split(marker)[0].replace(".", " ").strip().lower()
            if data["tvshowtitle"].lower() != release_series:
                record("series_title_mismatch")
                return []
            record("series_title_match")
            return [result(tag, name=name)]

    class Broken:
        def sources(self, data, hostDict):
            record("broken")
            data["title"] = "contaminated"
            data["aliases"].append("contaminated")
            raise RuntimeError("private exception must not escape")

    class Invalid:
        def sources(self, data, hostDict):
            record("invalid")
            return 17

    class Movie:
        hasMovies, hasEpisodes, pack_capable = True, False, False

        def sources(self, data, hostDict):
            record("movie")
            assert data == {"imdb": "tt1254207", "title": "Big Buck Bunny", "year": "2008", "aliases": []}
            assert hostDict == {}
            if mode == "many":
                return (result(format(i, "040x"), hash=format(i, "040x")) for i in range(1, 201))
            return [result(tag, size=1.5, seeders="7", quality="1080p"),
                    {"url": "magnet:?xt=urn:btih:" + "b" * 40, "name": "Second release"},
                    {"hash": "invalid"}, {"url": "magnet:?xt=invalid"}, None,
                    {"url": "https://example.invalid/page", "direct": False},
                    {"url": "https://example.invalid/video.mp4", "direct": True,
                     "name": "video.mp4", "headers": {"Authorization": "discard-me"}}]

    class Episode:
        hasMovies, hasEpisodes, pack_capable = False, True, True

        def sources(self, data, hostDict):
            record("episode")
            assert data == {"imdb": "tt1254207", "title": "", "tvshowtitle": "", "year": "",
                            "aliases": [], "season": "2", "episode": "3"}
            assert hostDict == {}
            return [result(tag), result("b", name="Season pack", package="season"),
                    result("c", package="season"), result("d", package="season", fileIdx=4),
                    result("e", name="Example.S02E04"), result("f", name="opaque release")]

    class Duplicate:
        def sources(self, data, hostDict):
            record("duplicate")
            return [result(tag), result("c", name="Third release")]

    class StreamingFailure:
        def sources(self, data, hostDict):
            yield result(tag)
            raise RuntimeError("private iterator failure")

    class InvalidStream:
        def sources(self, data, hostDict):
            for _ in range(100):
                yield None
            record("scan_exceeded")
            raise RuntimeError("scan went beyond bound")

    class Vfs:
        def sources(self, data, hostDict):
            root = Path(settings.getAddonInfo("profile"))
            (root / "directory").mkdir(exist_ok=True)
            (root / "file.txt").write_text("fixture", encoding="utf-8")
            directories, files = xbmcvfs.listdir(str(root))
            assert directories == ["directory"] and "file.txt" in files
            denied = False
            try:
                xbmcvfs.listdir(str(root.parent))
            except PermissionError:
                denied = True
            assert denied
            return [result(tag)]

    class Capture:
        def sources(self, data, hostDict):
            streams = [{"infoHash": tag.upper() * 40, "fileIdx": 4,
                        "behaviorHints": {"filename": "selected.mkv"}}]
            if mode == "capture_ambiguous":
                streams.append({"infoHash": tag * 40, "fileIdx": 8})
            if mode == "capture_filename":
                streams[0].pop("fileIdx")
                streams[0]["behaviorHints"]["filename"] = "Example.S02E03.mkv"
            client.request({"streams": streams})
            record("capture_returned")
            if mode == "capture_failure":
                raise RuntimeError("private capture failure")
            if mode in ("capture_isolation", "capture_failure"):
                return []
            return [result(tag, name="opaque release")]

    class Unobserved:
        def sources(self, data, hostDict):
            record("unobserved")
            return [result(tag, name="opaque release")]

    class Explicit:
        def sources(self, data, hostDict):
            return [result("d", name="opaque release", fileIndex=9)]

    if mode.startswith("capture"):
        entries = [("capture", Capture)]
        if mode in ("capture_isolation", "capture_failure"):
            entries += [("unobserved", Unobserved), ("explicit", Explicit)]
        return entries
    if mode == "series_title":
        return [("series_title", SeriesTitle)]
    if mode == "semantic":
        return [("semantic", Semantic)]
    if mode == "vfs":
        return [("vfs", Vfs)]
    if mode == "all_failed":
        return [("broken", Broken), ("invalid", Invalid)]
    if mode == "iterator_failure":
        return [("streaming", StreamingFailure), ("invalid_stream", InvalidStream)]
    if mode == "many":
        return [("movie", Movie), ("duplicate", Duplicate)]
    return [("broken", Broken), ("invalid", Invalid), ("movie", Movie),
            ("episode", Episode), ("duplicate", Duplicate)]
