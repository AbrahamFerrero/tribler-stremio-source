from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict


class StreamSource(TypedDict, total=False):
    providerId: str
    type: str
    url: str
    magnet: str
    infoHash: str
    fileIndex: int
    title: str
    filename: str
    quality: str
    resolution: str
    codec: str
    audio: str
    language: str
    sizeBytes: int
    seeds: int
    metadata: dict[str, Any]


@dataclass(frozen=True, slots=True)
class MediaItem:
    id: str
    kind: str
    title: str
    year: int | None = None
    season: int | None = None
    episode: int | None = None
    external_ids: dict[str, str] = field(default_factory=dict)
    classifications: tuple[str, ...] = ()
    stremio: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    series_title: str | None = None

    @classmethod
    def from_json(cls, value: object) -> "MediaItem":
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        allowed = {"id", "kind", "type", "title", "year", "season", "episode", "externalIds",
                   "classifications", "stremio", "metadata", "seriesTitle"}
        if set(value) - allowed:
            raise ValueError("request contains unsupported fields")
        identifier = _required_text(value.get("id"), "id", 1024)
        # The current Node provider serializes internal `kind` as `type`.
        kind = _required_text(value.get("kind", value.get("type")), "kind/type", 16)
        if kind not in {"movie", "series", "episode"}:
            raise ValueError("kind/type must be movie, series, or episode")
        title = _episode_aware_title(value.get("title"), kind)
        external = value.get("externalIds", {})
        if not isinstance(external, dict) or len(external) > 20:
            raise ValueError("externalIds must be an object with at most 20 entries")
        external_ids: dict[str, str] = {}
        for key, raw in external.items():
            external_ids[_required_text(key, "externalIds key", 64)] = _required_text(raw, "externalIds value", 256)
        classifications_raw = value.get("classifications", [])
        if not isinstance(classifications_raw, list) or len(classifications_raw) > 20:
            raise ValueError("classifications must be an array with at most 20 entries")
        classifications = tuple(_required_text(entry, "classification", 64) for entry in classifications_raw)
        stremio = _validated_object(value.get("stremio", {}), "stremio", 4096, 3)
        metadata = _validated_object(value.get("metadata", {}), "metadata", 16_384, 6)
        return cls(
            id=identifier,
            kind=kind,
            title=title,
            series_title=(_required_text(value["seriesTitle"], "seriesTitle", 300)
                          if "seriesTitle" in value else None),
            year=_optional_integer(value.get("year"), "year", 0, 9999),
            season=_optional_integer(value.get("season"), "season", 0, 100_000),
            episode=_optional_integer(value.get("episode"), "episode", 0, 100_000),
            external_ids=external_ids,
            classifications=classifications,
            stremio=stremio,
            metadata=metadata,
        )


def _required_text(value: object, field_name: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    result = value.strip()
    if not result or len(result) > maximum or any(ord(char) < 32 for char in result):
        raise ValueError(f"{field_name} is invalid")
    return result


def _episode_aware_title(value: object, kind: str) -> str:
    if not isinstance(value, str):
        raise ValueError("title must be a string")
    result = value.strip()
    if len(result) > 300 or any(ord(char) < 32 for char in result):
        raise ValueError("title is invalid")
    if not result and kind != "episode":
        raise ValueError("title is invalid")
    return result


def _optional_integer(value: object, field_name: str, minimum: int, maximum: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{field_name} is invalid")
    return value


def _validated_object(value: object, field_name: str, maximum_bytes: int, maximum_depth: int) -> dict[str, Any]:
    import json

    if not isinstance(value, dict):
        raise ValueError(f"{field_name} must be an object")
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError(f"{field_name} must contain JSON values") from error
    if len(encoded.encode("utf-8")) > maximum_bytes or _depth(value) > maximum_depth:
        raise ValueError(f"{field_name} exceeds safety limits")
    return json.loads(encoded)


def _depth(value: object, current: int = 0) -> int:
    if isinstance(value, dict):
        return max([current, *(_depth(entry, current + 1) for entry in value.values())])
    if isinstance(value, list):
        return max([current, *(_depth(entry, current + 1) for entry in value)])
    return current
