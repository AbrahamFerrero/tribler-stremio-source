from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import importlib
import inspect
from itertools import islice
import os
import re
from typing import Any

from ..adapter_config import WORKER_PROFILE_CONFIG_ENV, decode_adapter_config
from ..protocol import MAX_WORKER_RESULTS
from ..python_roots import AddonPythonRoots
from ...normalization import deduplication_key, normalize_one
from .p2p_metadata import _MODULE_NAME, _episode_number, _imdb, _worker_result_limit

ADAPTER_MODULE = "adapter_host.kodi.adapters.callable_stream_resolver"
_STREAM_FIELDS = frozenset({
    "type", "url", "magnet", "infoHash", "fileIndex", "title", "filename", "quality",
    "resolution", "codec", "audio", "language", "sizeBytes", "seeds",
})

_ARGUMENT_NAMES = frozenset({
    "imdb_id", "content_type", "season", "episode", "progress_callback", "target_providers",
    "override_title", "override_year", "tmdb_id",
})


@dataclass(frozen=True, slots=True)
class CallableConfiguration:
    module: str
    callable: str
    result_mode: str


def validate_configuration(config: Mapping[str, Any]) -> CallableConfiguration:
    """Validate startup data without importing any configured addon code."""
    if set(config) != {"targetModule", "targetCallable", "resultMode"}:
        raise ValueError("callable adapter configuration fields are invalid")
    module, operation, mode = (config[key] for key in ("targetModule", "targetCallable", "resultMode"))
    if (not isinstance(module, str) or len(module) > 256 or not _MODULE_NAME.fullmatch(module)
            or any(part in {"default", "service"} or part.startswith("_") for part in module.split("."))):
        raise ValueError("callable adapter target module is invalid")
    if not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,127}", operation):
        raise ValueError("callable adapter target callable is invalid")
    if not isinstance(mode, str) or mode not in {"streams", "tuple"}:
        raise ValueError("callable adapter result mode is invalid")
    return CallableConfiguration(module, operation, mode)


class CallableStreamResolverAdapter:
    """One trusted local callable with a bounded discovery keyword vocabulary."""

    def __init__(self) -> None:
        self.config = validate_configuration(decode_adapter_config(os.environ.get(WORKER_PROFILE_CONFIG_ENV)))

    def resolve(self, media: Mapping[str, Any]) -> list[dict[str, Any]]:
        arguments = _arguments(media)
        if arguments is None:
            return []
        try:
            operation = _local_callable(self.config)
            raw = operation(**_declared_arguments(operation, arguments))
            if self.config.result_mode == "tuple":
                if not isinstance(raw, tuple) or len(raw) not in (3, 4):
                    raise ValueError("invalid callable tuple")
                # Diagnostics and cancellation status never become stream metadata.
                if type(raw[-1]) is not bool:
                    raise ValueError("invalid callable status")
                if not isinstance(raw[0], Iterable) or isinstance(raw[0], (str, bytes, Mapping)):
                    raise ValueError("invalid callable streams")
                if raw[-1]:
                    return []
                raw = raw[0]
            if not isinstance(raw, Iterable) or isinstance(raw, (str, bytes, Mapping)):
                raise ValueError("invalid callable streams")
            output: list[dict[str, Any]] = []
            seen: set[str] = set()
            maximum = _worker_result_limit()
            for entry in islice(raw, MAX_WORKER_RESULTS):
                candidate = _candidate(entry)
                if candidate is None:
                    continue
                key = deduplication_key(candidate)
                if key not in seen:
                    seen.add(key)
                    output.append(candidate)
                    if len(output) >= maximum:
                        break
            return output
        except PermissionError:
            raise
        except Exception:
            # Includes import, invocation, and lazy iterator failures; discard partial output.
            raise RuntimeError("callable adapter failed") from None


def _local_callable(config: CallableConfiguration) -> Any:
    from ..compat import runtime

    roots = AddonPythonRoots.discover(runtime.state().addon_path)
    roots.validate_module(config.module)
    module = importlib.import_module(config.module)
    roots.validate_module(config.module)
    operation = getattr(module, config.callable, None)
    if not callable(operation):
        raise ValueError("configured callable is unavailable")
    return operation


def _declared_arguments(operation: Any, values: Mapping[str, Any]) -> dict[str, Any]:
    parameters = inspect.signature(operation).parameters
    if len(parameters) > 32:
        raise ValueError("callable signature exceeds limit")
    arguments = {}
    for name, parameter in parameters.items():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        if name in _ARGUMENT_NAMES and parameter.kind != parameter.POSITIONAL_ONLY:
            arguments[name] = values.get(name)
        elif parameter.default is parameter.empty:
            raise ValueError("unsupported required callable parameter")
    return arguments


def _arguments(media: Mapping[str, Any]) -> dict[str, Any] | None:
    kind = media.get("kind")
    if kind not in {"movie", "episode"}:
        return None
    arguments: dict[str, Any] = {"imdb_id": _imdb(media), "content_type": "movie" if kind == "movie" else "tv"}
    if kind == "episode":
        season, episode = _episode_number(media.get("season")), _episode_number(media.get("episode"))
        if season is None or episode is None:
            return None
        arguments.update(season=season, episode=episode)
    title = media.get("title") if kind == "movie" else media.get("seriesTitle")
    if isinstance(title, str) and title.strip() and len(title) <= 300 and not any(ord(c) < 32 for c in title):
        arguments["override_title"] = title.strip()
    year = media.get("year")
    if type(year) is int and 1 <= year <= 9999:
        arguments["override_year"] = year
    ids = media.get("externalIds")
    tmdb = ids.get("tmdb") if isinstance(ids, Mapping) else None
    if isinstance(tmdb, str) and re.fullmatch(r"[1-9][0-9]{0,15}", tmdb):
        arguments["tmdb_id"] = tmdb
    return arguments


def _candidate(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    # Only final stream data. Legacy P2P candidate conversion requires a different
    # contract (direct/name/hash, GiB sizes and pack matching), so is not applicable.
    candidate = {key: raw[key] for key in _STREAM_FIELDS if key in raw}
    if isinstance(candidate.get("magnet"), str) and "|" in candidate["magnet"]:
        return None
    # Discard Kodi header instructions without interpreting or retaining them.
    # The base URL still passes through the normal stream validation below.
    if isinstance(candidate.get("url"), str):
        candidate["url"] = candidate["url"].split("|", 1)[0]
    try:
        result = dict(normalize_one(candidate, "callable_stream_resolver"))
        result.pop("providerId")
        return result
    except (ValueError, TypeError, OverflowError):
        return None


def resolve(media: Mapping[str, Any]) -> list[dict[str, Any]]:
    return CallableStreamResolverAdapter().resolve(media)
