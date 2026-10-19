from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
import re
from typing import Any
from urllib.parse import urlsplit

MAX_INPUT_BYTES = 32_768
MAX_OUTPUT_BYTES = 256_000
MAX_STDERR_BYTES = 32_768
MAX_WORKER_RESULTS = 100
MAX_STRING_LENGTH = 8_192
_HASH = re.compile(r"^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")
_ALLOWED_RESULT_FIELDS = {
    "type", "url", "magnet", "infoHash", "fileIndex", "title", "filename", "quality",
    "resolution", "codec", "audio", "language", "sizeBytes", "seeds", "metadata",
}


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class WorkerResponse:
    results: list[dict[str, Any]]
    unsupported_count: int = 0


def encode_message(value: object, maximum: int) -> bytes:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise ProtocolError("message is not valid JSON") from error
    if len(encoded) > maximum:
        raise ProtocolError("message exceeds size limit")
    return encoded


def decode_request(raw: bytes) -> dict[str, Any]:
    value = _decode_object(raw, MAX_INPUT_BYTES)
    if set(value) != {"requestId", "media"}:
        raise ProtocolError("invalid worker request")
    request_id = value["requestId"]
    media = value["media"]
    if not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise ProtocolError("invalid request id")
    if not isinstance(media, dict):
        raise ProtocolError("invalid media object")
    allowed = {"id", "kind", "title", "year", "season", "episode", "externalIds", "classifications", "seriesTitle"}
    if set(media) - allowed or any(key in media for key in ("module", "class", "script", "path")):
        raise ProtocolError("invalid media fields")
    return {"requestId": request_id, "media": media}


def validate_module_results(value: object, maximum_results: int) -> WorkerResponse:
    if not isinstance(value, list) or len(value) > min(maximum_results, MAX_WORKER_RESULTS):
        raise ProtocolError("module result must be a bounded list")
    results: list[dict[str, Any]] = []
    unsupported = 0
    for entry in value:
        if not isinstance(entry, Mapping):
            raise ProtocolError("module result entry must be an object")
        if set(entry) - _ALLOWED_RESULT_FIELDS:
            raise ProtocolError("module result contains unsupported fields")
        candidate = _json_copy(dict(entry))
        result_type = candidate.get("type")
        if result_type is None:
            if candidate.get("magnet") or candidate.get("infoHash"):
                result_type = "magnet"
            elif isinstance(candidate.get("url"), str):
                result_type = urlsplit(candidate["url"]).scheme.lower()
            candidate["type"] = result_type
        if result_type not in {"http", "https", "magnet", "torrent"}:
            unsupported += 1
            continue
        _validate_candidate_shape(candidate)
        results.append(candidate)
    return WorkerResponse(results, unsupported)


def decode_response(raw: bytes, maximum_results: int) -> WorkerResponse:
    value = _decode_object(raw, MAX_OUTPUT_BYTES)
    if value.get("ok") is False:
        error = value.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
            raise ProtocolError("invalid worker error")
        raise ProtocolError(f"worker:{code}")
    if value.get("ok") is not True or set(value) - {"ok", "results", "unsupportedCount"}:
        raise ProtocolError("invalid worker response")
    response = validate_module_results(value.get("results"), maximum_results)
    unsupported = value.get("unsupportedCount", response.unsupported_count)
    if isinstance(unsupported, bool) or not isinstance(unsupported, int) or not 0 <= unsupported <= MAX_WORKER_RESULTS:
        raise ProtocolError("invalid unsupported result count")
    return WorkerResponse(response.results, unsupported)


def decode_evaluation_source_ids(raw: bytes) -> list[str]:
    """Validate the local-only enumeration response without printing source data."""
    value = _decode_object(raw, MAX_OUTPUT_BYTES)
    if value.get("ok") is False:
        error = value.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code):
            raise ProtocolError(f"worker:{code}")
        raise ProtocolError("invalid worker error")
    ids = value.get("sourceIds")
    if (set(value) != {"ok", "sourceIds"} or value["ok"] is not True
            or not isinstance(ids, list) or len(ids) > 128
            or any(not isinstance(source_id, str) or len(source_id) > 512
                   or not re.fullmatch(r"[A-Za-z0-9_.-]{1,512}", source_id)
                   for source_id in ids) or len(set(ids)) != len(ids)):
        raise ProtocolError("invalid evaluation source list")
    return ids


def success_response(results: object, maximum_results: int) -> dict[str, Any]:
    validated = validate_module_results(results, maximum_results)
    return {"ok": True, "results": validated.results, "unsupportedCount": validated.unsupported_count}


def error_response(code: str) -> dict[str, object]:
    if not re.fullmatch(r"[a-z_]{1,64}", code):
        code = "worker_error"
    return {"ok": False, "error": {"code": code}}


def _decode_object(raw: bytes, maximum: int) -> dict[str, Any]:
    if len(raw) > maximum:
        raise ProtocolError("message exceeds size limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise ProtocolError("invalid JSON message") from error
    if not isinstance(value, dict):
        raise ProtocolError("message must be an object")
    return value


def _validate_candidate_shape(candidate: dict[str, Any]) -> None:
    for key in ("type", "url", "magnet", "infoHash"):
        value = candidate.get(key)
        if value is not None and not isinstance(value, str):
            raise ProtocolError(f"invalid {key}")
    for key in ("title", "filename", "quality", "resolution", "codec", "audio", "language"):
        value = candidate.get(key)
        if value is not None and not isinstance(value, str):
            raise ProtocolError(f"invalid {key}")
    for key, value in candidate.items():
        if isinstance(value, str) and (not value or len(value) > MAX_STRING_LENGTH or any(ord(c) < 32 for c in value)):
            raise ProtocolError(f"invalid {key}")
    for key in ("fileIndex", "sizeBytes", "seeds"):
        value = candidate.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
            raise ProtocolError(f"invalid {key}")
    info_hash = candidate.get("infoHash")
    if info_hash is not None and (not isinstance(info_hash, str) or not _HASH.fullmatch(info_hash)):
        raise ProtocolError("invalid infoHash")
    metadata = candidate.get("metadata")
    if metadata is not None:
        if not isinstance(metadata, dict) or len(encode_message(metadata, 16_384)) > 16_384 or _depth(metadata) > 6:
            raise ProtocolError("invalid metadata")


def _json_copy(value: object) -> Any:
    return json.loads(encode_message(value, MAX_OUTPUT_BYTES))


def _depth(value: object, current: int = 0) -> int:
    if isinstance(value, dict):
        return max([current, *(_depth(item, current + 1) for item in value.values())])
    if isinstance(value, list):
        return max([current, *(_depth(item, current + 1) for item in value)])
    return current
