from __future__ import annotations

import unittest

from adapter_host.kodi.adapters.callable_stream_resolver import _candidate
from adapter_host.kodi.adapters.p2p_metadata import _final_candidate
from adapter_host.normalization import normalize_one


class StructuredMetadataTests(unittest.TestCase):
    def test_omits_unsafe_original_fields_without_losing_the_candidate(self):
        invalid = ["en\n", "en\t", "\ten", "e\x00n", "en\x7f", "en\u0085", "en\u200b",
                   "\u00a0en", "en\u202e", "<b>en</b>", "en" + " " * 501,
                   "", " ", 7, {}, []]
        for field in ("language", "audio"):
            for value in invalid:
                with self.subTest(field=field, value=value):
                    raw = {"type": "magnet", "infoHash": "a" * 40, field: value}
                    for result in (normalize_one(raw, "fixture"), _candidate(raw)):
                        self.assertIsNotNone(result)
                        self.assertNotIn(field, result)
                        self.assertEqual(result["infoHash"], "a" * 40)

    def test_safe_whole_text_is_preserved_without_a_language_vocabulary(self):
        for value in (" en ", "ES / ENG", "Dual   audio", "Multi", "English subs",
                      "en opaque", "en/eng", "https://opaque.invalid/en"):
            with self.subTest(value=value):
                raw = {"type": "magnet", "infoHash": "a" * 40, "language": value, "audio": value}
                for result in (normalize_one(raw, "fixture"), _candidate(raw)):
                    self.assertEqual(result["language"], value.strip(" "))
                    self.assertEqual(result["audio"], value.strip(" "))

    def test_oversized_decorative_fields_are_omitted_not_truncated_or_source_rejected(self):
        raw = {"type": "magnet", "infoHash": "a" * 40,
               "language": "en" + " " * 62 + "opaque", "audio": "en" + " " * 126 + "opaque"}
        for result in (normalize_one(raw, "fixture"), _candidate(raw)):
            self.assertIsNotNone(result)
            self.assertNotIn("language", result)
            self.assertNotIn("audio", result)

    def test_p2p_conversion_does_not_repair_language_before_common_normalization(self):
        for value, expected in (("en\n", None), ("\u00a0en", None), (" en ", "en"),
                                ("en opaque", "en opaque")):
            with self.subTest(value=value):
                candidate = _final_candidate({"hash": "a" * 40, "language": value},
                                             "synthetic", {"kind": "movie"})
                self.assertIsNotNone(candidate)
                self.assertEqual(candidate.get("language"), expected)

    def test_seed_contract_and_other_text_fields_are_unchanged(self):
        for seeds in (0, 1, 31, 2**53 - 1):
            result = normalize_one({"infoHash": "a" * 40, "seeds": seeds,
                                    "title": " Synthetic ", "audio": "en\n"}, "fixture")
            self.assertEqual(result["seeds"], seeds)
            self.assertEqual(result["title"], "Synthetic")
        with self.assertRaises(ValueError):
            normalize_one({"infoHash": "a" * 40, "seeds": 0.5}, "fixture")
