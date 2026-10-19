# These replacement titles and localized labels are invented fixture identities.
# IMDb-shaped numbers are local test data, not a reserved external namespace.
from __future__ import annotations

import unittest

from adapter_host.models import MediaItem
from adapter_host.normalization import normalize


class ModelAndNormalizationTests(unittest.TestCase):
    def test_accepts_current_bridge_type_alias(self) -> None:
        item = MediaItem.from_json({"id": "tt-test", "type": "movie", "title": "Test", "externalIds": {"imdb": "tt-test"}})
        self.assertEqual(item.kind, "movie")
        self.assertEqual(item.external_ids, {"imdb": "tt-test"})

    def test_accepts_an_episode_without_a_fabricated_title_but_rejects_blank_movie_title(self) -> None:
        episode = MediaItem.from_json({
            "id": "tt9999999999:2:3", "type": "episode", "title": "",
            "season": 2, "episode": 3, "externalIds": {"imdb": "tt9999999999"},
        })
        self.assertEqual(episode.title, "")
        with self.assertRaises(ValueError):
            MediaItem.from_json({"id": "tt1254207", "type": "movie", "title": ""})

    def test_series_title_is_optional_bounded_text_and_never_inferred(self) -> None:
        media = {"id": "tt9900101:1:1", "type": "episode", "title": "First Signal", "season": 1, "episode": 1}
        self.assertIsNone(MediaItem.from_json(media).series_title)
        item = MediaItem.from_json({**media, "seriesTitle": "Neral Beacon"})
        self.assertEqual((item.title, item.series_title), ("First Signal", "Neral Beacon"))
        for invalid in (None, 123, {}, [], "", "   ", "x" * 301, "Bad\x00Title"):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                MediaItem.from_json({**media, "seriesTitle": invalid})

    def test_normalizes_all_supported_source_shapes_and_preserves_fields(self) -> None:
        hash_value = "a" * 40
        streams = normalize([
            {"infoHash": hash_value, "fileIndex": 4, "title": "Torrent", "filename": "film.mkv",
             "quality": "4K", "resolution": "2160p", "codec": "AV1", "language": "es",
             "sizeBytes": 123, "seeds": 7, "metadata": {"source": "test"}},
            {"url": "https://media.example/film.webm", "filename": "film.webm"},
            {"type": "http", "url": "http://media.example/film.mp4"},
        ], provider_id="unit")
        self.assertEqual([source["type"] for source in streams], ["magnet", "https", "http"])
        self.assertEqual(streams[0]["magnet"], f"magnet:?xt=urn:btih:{hash_value}")
        self.assertEqual(streams[0]["fileIndex"], 4)
        self.assertEqual(streams[0]["metadata"], {"source": "test"})

    def test_hls_and_existing_video_extensions_are_normalized(self) -> None:
        for extension in ("m3u8", "M3U8", "mp4", "mkv", "webm", "avi", "mov", "m4v", "ts", "m2ts"):
            for scheme in ("http", "https"):
                url = f"{scheme}://1.1.1.1/video/master.{extension}?fixture=1"
                with self.subTest(extension=extension, scheme=scheme):
                    self.assertEqual(normalize([{"url": url}]), [
                        {"providerId": "python", "type": scheme, "url": url},
                    ])

    def test_opaque_http_urls_are_unproven_candidates(self) -> None:
        for scheme in ("http", "https"):
            url = f"{scheme}://media.example/page?token=fixture"
            self.assertEqual(normalize([{"url": url}]), [
                {"providerId": "python", "type": scheme, "url": url},
            ])

    def test_dangerous_http_paths_cannot_be_promoted_by_filename(self) -> None:
        for suffix in ("exe", "msi", "bat", "cmd", "com", "scr", "ps1", "js", "vbs", "lnk", "jar"):
            for path in (f"payload.{suffix}", f"payload.{suffix.upper()}", f"payload%2E{suffix}",
                         "payload." + "".join(f"%{ord(char):02x}" for char in suffix)):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    normalize([{"url": "https://media.example/" + path + "?fixture=1", "filename": "safe.mp4"}])

    def test_rejects_invalid_or_dangerous_output(self) -> None:
        invalid = [
            {"type": "https", "url": "https:///page"},
            {"type": "https", "url": "http://media.example/page"},
            {"url": "https://@media.example/page"},
            {"url": "https://user:pass@media.example/page"},
            {"type": "https", "url": "https://user:pass@media.example/video.mp4"},
            {"type": "magnet", "magnet": "magnet:?dn=missing-hash"},
            {"type": "https", "url": "https://media.example/video.mp4", "filename": "payload.exe"},
        ]
        for source in invalid:
            with self.subTest(source=source), self.assertRaises(ValueError):
                normalize([source])


if __name__ == "__main__":
    unittest.main()
