from __future__ import annotations

import json


class _MetadataClient:
    def request(self, *_args, **_kwargs):
        shared_hash = "e" * 40
        return json.dumps({"streams": [
            {"infoHash": shared_hash, "fileIdx": 2, "behaviorHints": {"filename": "part-one.mkv"}},
            {"infoHash": shared_hash, "fileIdx": 5, "behaviorHints": {"filename": "part-two.mkv"}},
        ]})


client = _MetadataClient()

# IMDb-shaped fixture ID; it is not associated with a real series.
SYNTHETIC_SERIES_ID = "tt9999999999"


class source:
    def sources(self, data, host_dict):
        if data == {
            "title": "", "tvshowtitle": "", "year": 0, "aliases": [],
            "imdb": SYNTHETIC_SERIES_ID, "season": 2, "episode": 3,
        }:
            assert host_dict == {}
            # Compatibility mode captures this response.  The same BTIH has two
            # conflicting file selections, so the adapter must not enrich the
            # normalized source with either one.
            client.request()
            return [{
                "provider": "example_p2p", "source": "torrent", "seeders": "12",
                "hash": "e" * 40, "name": "Example Series Collection",
                "quality": "1080p", "language": "en",
                "url": "magnet:?xt=urn:btih:" + "e" * 40,
                "direct": False, "size": 1.5,
            }]
        if data == {
            "title": "", "tvshowtitle": "", "year": 0, "aliases": [],
            "imdb": SYNTHETIC_SERIES_ID, "season": 2, "episode": 4,
        }:
            assert host_dict == {}
            return [{
                "provider": "example_p2p", "source": "torrent", "seeders": "13",
                "hash": "f" * 40, "name": "Example Series S02E04",
                "fileIdx": 8, "quality": "1080p",
                "url": "magnet:?xt=urn:btih:" + "f" * 40,
                "direct": False,
            }]
        if data == {
            "title": "", "tvshowtitle": "", "year": 0, "aliases": [],
            "imdb": SYNTHETIC_SERIES_ID, "season": 2, "episode": 2,
        }:
            assert host_dict == {}
            return [{
                "provider": "example_p2p", "source": "torrent", "seeders": "14",
                "hash": "a" * 40, "name": "Example Series Season 2 Collection",
                "quality": "1080p", "url": "magnet:?xt=urn:btih:" + "a" * 40,
                "direct": False,
            }]
        if data == {
            "title": "Many Results", "year": 2026, "aliases": [], "imdb": "tt0000025",
        }:
            assert host_dict == {}
            return [
                {
                    "provider": "example_p2p",
                    "source": "torrent",
                    "hash": f"{index:040x}",
                    "name": f"Many Results source {index}",
                    "quality": "1080p",
                    "url": f"magnet:?xt=urn:btih:{index:040x}",
                    "direct": False,
                }
                for index in range(1, 26)
            ]
        assert data in ({
            "title": "Big Buck Bunny", "year": 2008, "aliases": [], "imdb": "tt1254207",
        }, {
            "title": "tt1254207", "year": 0, "aliases": [], "imdb": "tt1254207",
        })
        assert host_dict == {}
        return [
            {
                "provider": "example_p2p",
                "source": "torrent",
                "seeders": "7",
                "hash": "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
                "name": "Big Buck Bunny licensed demo",
                "quality": "1080p",
                "language": "en",
                "url": "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
                "direct": False,
                "size": 0.25,
            },
            {
                "provider": "example_p2p",
                "source": "direct",
                "name": "bbb-test.mp4",
                "quality": "720p",
                "url": "https://example.invalid/bbb-test.mp4",
                "direct": True,
            },
            {
                "provider": "example_p2p",
                "source": "other",
                "url": "https://example.invalid/non-video-resource",
                "direct": False,
            },
        ]
