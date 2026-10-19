from __future__ import annotations

import unittest

from adapter_host.kodi.protocol import ProtocolError, decode_request, decode_response, encode_message


class KodiProtocolTests(unittest.TestCase):
    def test_request_rejects_execution_fields(self) -> None:
        value = {"requestId": "a" * 32, "media": {"id": "x", "module": "os"}}
        with self.assertRaises(ProtocolError):
            decode_request(encode_message(value, 32_768))
        for field in ("module", "class", "script", "path"):
            value = {"requestId": "a" * 32, "media": {"id": "x", field: "value"}}
            with self.assertRaises(ProtocolError):
                decode_request(encode_message(value, 32_768))

    def test_response_accepts_supported_shapes_and_marks_unsupported(self) -> None:
        value = {
            "ok": True,
            "results": [
                {"type": "https", "url": "https://example.invalid/video.mp4"},
                {"infoHash": "a" * 40, "fileIndex": 1, "filename": "video.mkv"},
            ],
            "unsupportedCount": 1,
        }
        response = decode_response(encode_message(value, 256_000), 20)
        self.assertEqual(len(response.results), 2)
        self.assertEqual(response.unsupported_count, 1)

    def test_response_rejects_invalid_result(self) -> None:
        value = {"ok": True, "results": [{"type": "https", "url": 42}], "unsupportedCount": 0}
        with self.assertRaises(ProtocolError):
            decode_response(encode_message(value, 256_000), 20)


if __name__ == "__main__":
    unittest.main()
