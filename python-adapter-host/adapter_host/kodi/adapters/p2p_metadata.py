from __future__ import annotations

from collections.abc import Iterable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
import importlib
import json
import math
import os
import re
from typing import Any, Iterator
from urllib.parse import urlsplit

from ..adapter_config import WORKER_PROFILE_CONFIG_ENV, decode_adapter_config
from ...normalization import decorative_metadata_text

_HASH = re.compile(r"^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")
_IMDB_ID = re.compile(r"^tt\d{7,10}$", re.IGNORECASE)
_RESOLUTION = re.compile(r"(?<!\d)(2160p|1080p|720p|480p)(?!\d)", re.IGNORECASE)
_EPISODE_MARKER = re.compile(r"(?:^|[^a-z0-9])(?:s0?(?P<season>\d{1,3})[ ._-]*e0?(?P<episode>\d{1,3})|(?P<season_x>\d{1,3})x0?(?P<episode_x>\d{1,3}))(?:$|[^a-z0-9])", re.IGNORECASE)
_VIDEO_EXTENSIONS = (".mkv", ".mp4", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts")
_DEFAULT_MAX_RESULTS = 20
_MAX_FILE_INDEX = 2**53 - 1
_MODULE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
_SOURCE_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_SETTING_NAME = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_RESPONSE_MODES = {"none", "capture-streams"}


@dataclass(slots=True)
class _ProviderResponseObservation:
    transport_failed: bool = False
    invalid_payload: bool = False
    raw_streams: list[Mapping[str, Any]] = field(default_factory=list)


def resolve(media: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Adapt one locally configured P2P metadata source in the disposable Kodi worker.

    The source module, identifier, setting and compatibility mode are startup configuration.
    Request payloads cannot select imports, callables or source settings.
    """
    source = _local_source_configuration()
    query = _build_query(media)
    if query is None:
        return []

    output: list[dict[str, Any]] = []
    maximum_results = _worker_result_limit()
    import xbmcaddon  # type: ignore[import-not-found]  # Supplied by KodiCompat in the worker.

    settings = xbmcaddon.Addon()
    if settings.getSetting(source.enabled_setting).strip().lower() != "true":
        return []
    try:
        provider_module = importlib.import_module(source.module_name)
        factory = getattr(provider_module, "source", None)
        if not callable(factory):
            raise TypeError("configured source factory is unavailable")
        instance = factory()
        operation = getattr(instance, "sources", None)
        if not callable(operation):
            raise TypeError("configured source operation is unavailable")
        with _source_response_compatibility(source.response_mode, provider_module) as observation:
            raw_results = operation(dict(query), {})
        if observation.transport_failed:
            raise RuntimeError("configured source request failed")
        if observation.invalid_payload:
            raise RuntimeError("configured source returned invalid response")
    except Exception as error:
        raise RuntimeError("configured source failed") from error
    if not isinstance(raw_results, Iterable) or isinstance(raw_results, (str, bytes, Mapping)):
        raise ValueError("configured source returned invalid data")
    if source.response_mode == "capture-streams" and isinstance(raw_results, list):
        _restore_file_selection_metadata(raw_results, observation.raw_streams)
    for raw in raw_results:
        candidate = _final_candidate(raw, source.source_id, media)
        if candidate is not None:
            output.append(candidate)
            if len(output) >= maximum_results:
                return output
    return output


@dataclass(frozen=True, slots=True)
class _LocalSourceConfiguration:
    module_name: str
    source_id: str
    enabled_setting: str
    response_mode: str


def _local_source_configuration() -> _LocalSourceConfiguration:
    data = decode_adapter_config(os.environ.get(WORKER_PROFILE_CONFIG_ENV))
    required = {"sourceModule", "sourceId", "sourceEnabledSetting"}
    if not required <= data.keys() or data.keys() - required - {"sourceResponseMode"}:
        raise ValueError("local source configuration fields are invalid")
    if any(not isinstance(value, str) for value in data.values()):
        raise ValueError("local source configuration values must be strings")
    module_name = data["sourceModule"].strip()
    source_id = data["sourceId"].strip()
    enabled_setting = data["sourceEnabledSetting"].strip()
    response_mode = data.get("sourceResponseMode", "none").strip().lower()
    if not _MODULE_NAME.fullmatch(module_name):
        raise ValueError("local source module is invalid")
    if not _SOURCE_ID.fullmatch(source_id):
        raise ValueError("local source id is invalid")
    if not _SETTING_NAME.fullmatch(enabled_setting):
        raise ValueError("local source enabled setting is invalid")
    if response_mode not in _RESPONSE_MODES:
        raise ValueError("local source response mode is invalid")
    return _LocalSourceConfiguration(module_name, source_id, enabled_setting, response_mode)


def _worker_result_limit() -> int:
    raw = os.environ.get("PYTHON_ADAPTER_WORKER_MAX_RESULTS", "")
    try:
        parsed = int(raw)
    except ValueError:
        return _DEFAULT_MAX_RESULTS
    return parsed if 1 <= parsed <= 100 else _DEFAULT_MAX_RESULTS


@contextmanager
def _source_response_compatibility(response_mode: str, provider_module: Any) -> Iterator[_ProviderResponseObservation]:
    """Capture response metadata only for the configured local compatibility mode."""
    if response_mode != "capture-streams":
        yield _ProviderResponseObservation()
        return
    client = getattr(provider_module, "client", None)
    original_request = getattr(client, "request", None)
    if not callable(original_request):
        yield _ProviderResponseObservation()
        return
    observation = _ProviderResponseObservation()

    def compatible_request(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("headers") is None:
            kwargs["headers"] = {
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            }
        try:
            response = original_request(*args, **kwargs)
        except Exception:
            observation.transport_failed = True
            raise
        if response is None:
            observation.invalid_payload = True
        else:
            observation.raw_streams = _raw_streams(response)
        return response

    client.request = compatible_request
    try:
        yield observation
    finally:
        client.request = original_request


def _raw_streams(response: object) -> list[Mapping[str, Any]]:
    """Capture only structurally valid stream objects from the current source response."""
    payload = response[0] if isinstance(response, tuple) and response else response
    if isinstance(payload, bytes):
        try:
            payload = payload.decode("utf-8")
        except UnicodeDecodeError:
            return []
    if not isinstance(payload, str):
        return []
    try:
        decoded = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    streams = decoded.get("streams") if isinstance(decoded, Mapping) else None
    return [stream for stream in streams if isinstance(stream, Mapping)] if isinstance(streams, list) else []


def _restore_file_selection_metadata(results: list[object], remote_streams: Iterable[Mapping[str, Any]]) -> int:
    """Restore file selection only for a unique, normalized BTIH correspondence.

    Some locally installed compatibility sources retain a BTIH as ``hash`` but omit ``fileIdx``
    and ``behaviorHints.filename``. Multiple remote entries for one BTIH are intentionally
    ambiguous: no result is enriched in that case.
    """
    remote_by_hash: dict[str, list[Mapping[str, Any]]] = {}
    for stream in remote_streams:
        info_hash = _normalized_info_hash(stream.get("infoHash"))
        if info_hash is not None:
            remote_by_hash.setdefault(info_hash, []).append(stream)

    restored = 0
    for result in results:
        if not isinstance(result, dict):
            continue
        info_hash = _normalized_info_hash(result.get("hash"))
        candidates = remote_by_hash.get(info_hash, []) if info_hash is not None else []
        if len(candidates) != 1:
            continue
        remote = candidates[0]
        changed = False
        file_index = _source_file_index(remote.get("fileIdx"))
        if file_index is not None:
            result["fileIndex"] = file_index
            changed = True
        filename = _source_filename(remote.get("behaviorHints"))
        if filename is not None:
            result["filename"] = filename
            changed = True
        restored += int(changed)
    return restored


def _normalized_info_hash(value: object) -> str | None:
    return value.lower() if isinstance(value, str) and _HASH.fullmatch(value) else None


def _source_file_index(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_FILE_INDEX else None


def _source_filename(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    filename = value.get("filename")
    if not isinstance(filename, str):
        return None
    cleaned = filename.strip()
    if not cleaned or len(cleaned) > 1_024 or any(ord(char) < 32 for char in cleaned):
        return None
    return cleaned


def _imdb(media: Mapping[str, Any]) -> str | None:
    external_ids = media.get("externalIds", {})
    if not isinstance(external_ids, Mapping):
        external_ids = {}
    imdb = external_ids.get("imdb", "")
    if not isinstance(imdb, str) or not _IMDB_ID.fullmatch(imdb):
        media_id = media.get("id")
        imdb = media_id if isinstance(media_id, str) and _IMDB_ID.fullmatch(media_id) else ""
    return imdb.lower() if isinstance(imdb, str) and _IMDB_ID.fullmatch(imdb) else None


def _episode_number(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100_000 else None


def _build_query(media: Mapping[str, Any]) -> dict[str, Any] | None:
    """Build the fixed Kodi-compatible request shape for the local source profile.

    Episode selection uses IMDb, season and episode. Empty title fields deliberately express
    unavailable metadata; they are never substituted with IMDb values or fabricated episode text.
    """
    imdb = _imdb(media)
    if imdb is None:
        return None
    kind = media.get("kind")
    if kind == "episode":
        season = _episode_number(media.get("season"))
        episode = _episode_number(media.get("episode"))
        if season is None or episode is None:
            return None
        year = media.get("year")
        return {
            "title": "",
            "tvshowtitle": "",
            "year": year if isinstance(year, int) and not isinstance(year, bool) else 0,
            "aliases": [],
            "imdb": imdb,
            "season": season,
            "episode": episode,
        }
    if kind != "movie":
        return None
    title = media.get("title")
    year = media.get("year")
    normalized_title = title.strip() if isinstance(title, str) and title.strip() else imdb
    normalized_year = year if isinstance(year, int) and not isinstance(year, bool) else 0
    return {
        "title": normalized_title,
        "year": normalized_year,
        "aliases": [],
        "imdb": imdb.lower(),
    }


def _final_candidate(raw: object, provider_name: str, media: Mapping[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    url = raw.get("url")
    info_hash = raw.get("hash")
    candidate: dict[str, Any]
    if isinstance(url, str) and url.lower().startswith("magnet:"):
        candidate = {"type": "magnet", "magnet": url}
    elif isinstance(info_hash, str) and _HASH.fullmatch(info_hash):
        candidate = {"type": "magnet", "infoHash": info_hash.lower()}
    elif isinstance(url, str) and raw.get("direct") is True and _is_direct_video(url, raw.get("name")):
        scheme = urlsplit(url).scheme.lower()
        if scheme not in {"http", "https"}:
            return None
        candidate = {"type": scheme, "url": url}
        name = raw.get("name")
        if isinstance(name, str) and name.lower().endswith(_VIDEO_EXTENSIONS):
            candidate["filename"] = name
    else:
        # Hoster tokens, debrid candidates and non-video URLs need another resolver stage.
        return None

    file_index = _nonnegative_integer(raw.get("fileIndex"))
    if file_index is None:
        file_index = _nonnegative_integer(raw.get("fileIdx"))
    if media.get("kind") == "episode" and not _episode_selection_is_unambiguous(raw, media, file_index):
        # An episode request must never fall through to Tribler's historical "main video" choice
        # for a season pack. The installed provider has no per-file list, so a precise release
        # marker (or an explicit index) is the minimum available evidence.
        return None
    if file_index is not None:
        candidate["fileIndex"] = file_index

    _copy_text(candidate, "title", raw.get("name"), 300)
    _copy_text(candidate, "filename", raw.get("filename"), 1_024)
    _copy_text(candidate, "quality", raw.get("quality"), 64)
    language = decorative_metadata_text(raw.get("language"), 64)
    if language:
        candidate["language"] = language
    quality = candidate.get("quality")
    if isinstance(quality, str):
        match = _RESOLUTION.search(quality)
        if match:
            candidate["resolution"] = match.group(1).lower()
    seeds = _nonnegative_integer(raw.get("seeders"))
    if seeds is not None:
        candidate["seeds"] = seeds
    size_bytes = _gib_to_bytes(raw.get("size"))
    if size_bytes is not None:
        candidate["sizeBytes"] = size_bytes
    candidate["metadata"] = {
        "module": "p2p_metadata_adapter",
        "provider": provider_name[:64],
        "source": str(raw.get("source", ""))[:64],
        "direct": raw.get("direct") is True,
        "debridOnly": raw.get("debridonly") is True,
    }
    return candidate


def _episode_selection_is_unambiguous(raw: Mapping[str, Any], media: Mapping[str, Any], file_index: int | None) -> bool:
    if file_index is not None:
        return True
    season = _episode_number(media.get("season"))
    episode = _episode_number(media.get("episode"))
    if season is None or episode is None:
        return False
    for value in (raw.get("filename"), raw.get("name")):
        if not isinstance(value, str):
            continue
        for match in _EPISODE_MARKER.finditer(value):
            parsed_season = int(match.group("season") or match.group("season_x"))
            parsed_episode = int(match.group("episode") or match.group("episode_x"))
            if (parsed_season, parsed_episode) == (season, episode):
                return True
    return False


def _is_direct_video(url: str, name: object) -> bool:
    path = urlsplit(url).path.lower()
    return path.endswith(_VIDEO_EXTENSIONS) or (
        isinstance(name, str) and name.lower().endswith(_VIDEO_EXTENSIONS)
    )


def _copy_text(target: dict[str, Any], key: str, value: object, maximum: int) -> None:
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned and len(cleaned) <= maximum and not any(ord(char) < 32 for char in cleaned):
            target[key] = cleaned


def _nonnegative_integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed < 0 or not parsed.is_integer():
        return None
    return int(parsed)


def _gib_to_bytes(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        gib = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(gib) or gib <= 0:
        return None
    return round(gib * 1024**3)
