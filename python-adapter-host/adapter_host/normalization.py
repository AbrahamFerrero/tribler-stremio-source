from __future__ import annotations

import base64
import json
import math
import re
from collections.abc import Iterable, Mapping
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .models import StreamSource

_HEX_HASH = re.compile(r"^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")
_BASE32_HASH = re.compile(r"^[A-Z2-7]{32}$", re.IGNORECASE)
_VIDEO_EXTENSIONS = (".mkv", ".mp4", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".m3u8")
_DANGEROUS_EXTENSIONS = (".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".js", ".vbs", ".lnk", ".jar")
_TEXT_LIMITS = {"title": 300, "filename": 512, "quality": 64, "resolution": 64,
                "codec": 64, "audio": 128, "language": 64}


def normalize(raw_results: Iterable[Mapping[str, Any]], provider_id: str = "python") -> list[StreamSource]:
    if isinstance(raw_results, (str, bytes, Mapping)):
        raise ValueError("resolver output must be an iterable of stream objects")
    output: list[StreamSource] = []
    for raw in raw_results:
        output.append(normalize_one(raw, provider_id))
    return output


def normalize_one(raw: Mapping[str, Any], provider_id: str) -> StreamSource:
    if not isinstance(raw, Mapping):
        raise ValueError("stream must be an object")
    source_type = raw.get("type")
    url = _optional_text(raw.get("url"), "url", 4096)
    magnet = _optional_text(raw.get("magnet"), "magnet", 8192)
    explicit_hash = _optional_text(raw.get("infoHash"), "infoHash", 64)

    if not source_type:
        if magnet or explicit_hash:
            source_type = "magnet"
        elif url:
            source_type = urlsplit(url).scheme.lower()
    if source_type not in {"magnet", "torrent", "http", "https"}:
        raise ValueError("unsupported stream type")

    info_hash: str | None = _normalize_hash(explicit_hash) if explicit_hash else None
    if source_type == "magnet":
        if not magnet and info_hash:
            magnet = f"magnet:?xt=urn:btih:{info_hash}"
        if not magnet:
            raise ValueError("magnet source requires magnet or infoHash")
        magnet_hash = _hash_from_magnet(magnet)
        if info_hash and magnet_hash != info_hash:
            raise ValueError("magnet and infoHash do not match")
        info_hash = magnet_hash
    else:
        if not url:
            raise ValueError(f"{source_type} source requires url")
        parsed = urlsplit(url)
        if (parsed.scheme.lower() != source_type or not parsed.hostname
                or parsed.username is not None or parsed.password is not None):
            raise ValueError("stream URL is invalid")
        if source_type in {"http", "https"}:
            # Opaque URLs are unproven candidates; Node policy/probing decides
            # whether they contain media. Executable paths never reach that probe.
            if unquote(parsed.path).rstrip().lower().endswith(_DANGEROUS_EXTENSIONS):
                raise ValueError("dangerous HTTP URL path is not allowed")

    filename = _optional_text(raw.get("filename"), "filename", 512)
    if filename and filename.lower().endswith(_DANGEROUS_EXTENSIONS):
        raise ValueError("dangerous filename is not allowed")
    result: StreamSource = {"providerId": _clean_provider_id(provider_id), "type": str(source_type)}
    if url:
        result["url"] = url
    if magnet:
        result["magnet"] = magnet
    if info_hash:
        result["infoHash"] = info_hash
    if filename:
        result["filename"] = filename
    for field_name, maximum in _TEXT_LIMITS.items():
        if field_name == "filename":
            continue
        value = (decorative_metadata_text(raw.get(field_name), maximum)
                 if field_name in {"language", "audio"}
                 else _optional_text(raw.get(field_name), field_name, maximum))
        if value:
            result[field_name] = value  # type: ignore[literal-required]
    for field_name in ("sizeBytes", "seeds", "fileIndex"):
        value = _nonnegative_integer(raw.get(field_name), field_name)
        if value is not None:
            result[field_name] = value  # type: ignore[literal-required]
    if "metadata" in raw:
        result["metadata"] = _validate_metadata(raw["metadata"])
    return result


def deduplication_key(source: StreamSource) -> str:
    if source["type"] == "magnet":
        suffix = str(source.get("fileIndex", source.get("filename", ""))).lower()
        return f"bt:{source.get('infoHash', '')}:{suffix}"
    return f"url:{source.get('url', '')}"


def _hash_from_magnet(magnet: str) -> str:
    parsed = urlsplit(magnet)
    if parsed.scheme.lower() != "magnet":
        raise ValueError("invalid magnet URI")
    for xt in parse_qs(parsed.query).get("xt", []):
        if xt.lower().startswith("urn:btih:"):
            return _normalize_hash(xt[9:])
    raise ValueError("magnet URI has no valid BTIH")


def _normalize_hash(value: str) -> str:
    if _HEX_HASH.fullmatch(value):
        return value.lower()
    if _BASE32_HASH.fullmatch(value):
        return base64.b32decode(value.upper()).hex()
    raise ValueError("invalid infoHash")


def has_supported_http_video_path(url: str) -> bool:
    """Structural final-path hint only; neither filename hints nor media proof."""
    try:
        parsed = urlsplit(url)
        return (parsed.scheme.lower() in {"http", "https"} and bool(parsed.hostname)
                and parsed.username is None and parsed.password is None
                and parsed.path.lower().endswith(_VIDEO_EXTENSIONS))
    except ValueError:
        return False


def decorative_metadata_text(value: object, maximum: int) -> str | None:
    """Omit unsafe decoration, never repair a claim before Node sees it.

    Validate the original before trimming ASCII spaces. Preserve bounded safe
    opaque/subtitle text whole; Node alone recognizes languages and awards points.
    Other source fields deliberately retain their existing normalization.
    """
    if (not isinstance(value, str) or len(value) > 500
            or any((not " " <= char <= "~" and char != "\u00b7") or char in "<>" for char in value)):
        return None
    result = value.strip(" ")
    return result if result and len(result) <= maximum else None


def _optional_text(value: object, field_name: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    result = value.strip()
    if not result or len(result) > maximum or any(ord(char) < 32 for char in result):
        raise ValueError(f"{field_name} is invalid")
    return result


def _nonnegative_integer(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{field_name} must be a finite number")
    integer = int(value)
    if integer != value or integer < 0 or integer > 2**53 - 1:
        raise ValueError(f"{field_name} is invalid")
    return integer


def _validate_metadata(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("metadata must be an object")
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 16_384 or _json_depth(value) > 6:
        raise ValueError("metadata exceeds safety limits")
    return json.loads(encoded)


def _json_depth(value: object, depth: int = 0) -> int:
    if isinstance(value, dict):
        return max([depth, *(_json_depth(v, depth + 1) for v in value.values())])
    if isinstance(value, list):
        return max([depth, *(_json_depth(v, depth + 1) for v in value)])
    return depth


def _clean_provider_id(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", value):
        raise ValueError("resolver id is invalid")
    return value
