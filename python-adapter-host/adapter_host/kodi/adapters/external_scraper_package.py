from __future__ import annotations

from collections.abc import Iterable, Mapping
from copy import deepcopy
import importlib
from itertools import islice
import os
import sys
from typing import Any

from ..adapter_config import WORKER_PROFILE_CONFIG_ENV, decode_adapter_config
from ..protocol import MAX_WORKER_RESULTS
from ...normalization import deduplication_key, normalize_one
from .p2p_metadata import (
    _MODULE_NAME, _SOURCE_ID, _episode_number, _final_candidate, _imdb,
    _source_file_index, _worker_result_limit, _RESPONSE_MODES,
    _source_response_compatibility, _restore_file_selection_metadata,
)


class ExternalScraperPackageAdapter:
    """Fixed external-scraper contract, selected only by startup-local profile data."""

    def __init__(self) -> None:
        config = decode_adapter_config(os.environ.get(WORKER_PROFILE_CONFIG_ENV))
        required = {"packageModule", "folders"}
        if not required <= config.keys() or config.keys() - required - {"responseMode"}:
            raise ValueError("external scraper adapter configuration invalid")
        package = config["packageModule"]
        if (not isinstance(package, str) or not _MODULE_NAME.fullmatch(package)
                or package.split(".")[-1] in {"default", "service"}):
            raise ValueError("external scraper package configuration invalid")
        # Only the inspected torrent contract is supported; never pass folder paths through.
        if config["folders"] != ("torrents",):
            raise ValueError("external scraper folders configuration invalid")
        self.package_module = package
        response_mode = config.get("responseMode", "none")
        if not isinstance(response_mode, str) or response_mode not in _RESPONSE_MODES:
            raise ValueError("external scraper response mode configuration invalid")
        self.response_mode = response_mode

    def source_ids(self) -> list[str]:
        return [name for name, _ in self._providers()]

    def resolve_source(self, media: Mapping[str, Any], source_id: str) -> list[dict[str, Any]]:
        """Run a configured package member without package-wide dedupe or cap."""
        query = _media_query(media)
        if query is None:
            return []
        providers = dict(self._providers())
        if source_id not in providers:
            raise ValueError("evaluation source is unavailable")
        source_class = providers[source_id]
        capability = "hasEpisodes" if media.get("kind") == "episode" else "hasMovies"
        if getattr(source_class, capability, None) is False:
            return []
        output: list[dict[str, Any]] = []
        try:
            instance = source_class()
            if getattr(instance, capability, None) is False:
                return []
            provider_module = sys.modules.get(getattr(source_class, "__module__", None))
            with _source_response_compatibility(self.response_mode, provider_module) as observation:
                raw_results = instance.sources(deepcopy(query), {})
            if observation.transport_failed or observation.invalid_payload or not _iterable(raw_results):
                raise ValueError("evaluation source output invalid")
            if self.response_mode == "capture-streams" and isinstance(raw_results, list):
                _restore_file_selection_metadata(raw_results, observation.raw_streams)
            for raw in islice(raw_results, MAX_WORKER_RESULTS):
                candidate = _candidate(raw, source_id, media)
                if candidate is not None:
                    output.append(candidate)
        except Exception:
            # Match production's per-provider failure isolation and partial output.
            pass
        return output

    def _providers(self) -> list[tuple[str, Any]]:
        package = importlib.import_module(self.package_module)
        factory = getattr(package, "sources", None)
        if not callable(factory):
            raise ValueError("external scraper package contract invalid")
        providers = factory(specified_folders=["torrents"])
        if not _iterable(providers):
            raise ValueError("external scraper package contract invalid")
        providers = list(islice(providers, MAX_WORKER_RESULTS + 1))
        if len(providers) > MAX_WORKER_RESULTS:
            raise ValueError("external scraper package enumeration exceeds limit")
        names: set[str] = set()
        for entry in providers:
            if (not isinstance(entry, (list, tuple)) or len(entry) != 2
                    or not isinstance(entry[0], str) or not _SOURCE_ID.fullmatch(entry[0])
                    or entry[0] in names or not callable(entry[1])):
                raise ValueError("external scraper package contract invalid")
            names.add(entry[0])
        return providers

    def resolve(self, media: Mapping[str, Any]) -> list[dict[str, Any]]:
        query = _media_query(media)
        if query is None:
            return []
        package = importlib.import_module(self.package_module)
        factory = getattr(package, "sources", None)
        if not callable(factory):
            raise ValueError("external scraper package contract invalid")
        providers = factory(specified_folders=["torrents"])
        if not _iterable(providers):
            raise ValueError("external scraper package contract invalid")
        # Reuse the worker hard bound for enumeration and per-provider input scanning.
        providers = list(islice(providers, MAX_WORKER_RESULTS + 1))
        if len(providers) > MAX_WORKER_RESULTS:
            raise ValueError("external scraper package enumeration exceeds limit")
        names: set[str] = set()
        for entry in providers:
            if (not isinstance(entry, (list, tuple)) or len(entry) != 2
                    or not isinstance(entry[0], str) or not _SOURCE_ID.fullmatch(entry[0])
                    or entry[0] in names or not callable(entry[1])):
                raise ValueError("external scraper package contract invalid")
            names.add(entry[0])

        output: list[dict[str, Any]] = []
        seen: set[str] = set()
        attempted = completed = 0
        maximum = _worker_result_limit()
        capability = "hasEpisodes" if media.get("kind") == "episode" else "hasMovies"
        # Preserve the package's enumeration order, independently of provider latency.
        for name, source_class in providers:
            if getattr(source_class, capability, None) is False:
                continue
            attempted += 1
            try:
                instance = source_class()
                if getattr(instance, capability, None) is False:
                    completed += 1
                    continue
                # Observe only the already loaded provider module; never import from media data.
                provider_module = sys.modules.get(getattr(source_class, "__module__", None))
                with _source_response_compatibility(self.response_mode, provider_module) as observation:
                    raw_results = instance.sources(deepcopy(query), {})
                if observation.transport_failed or observation.invalid_payload:
                    raise ValueError("external scraper provider response invalid")
                if not _iterable(raw_results):
                    raise ValueError("external scraper provider output invalid")
                # Match the legacy list contract and its unique-hash rule exactly.
                if self.response_mode == "capture-streams" and isinstance(raw_results, list):
                    _restore_file_selection_metadata(raw_results, observation.raw_streams)
                for raw in islice(raw_results, MAX_WORKER_RESULTS):
                    candidate = _candidate(raw, name, media)
                    if candidate is None:
                        continue
                    key = deduplication_key(candidate)
                    if key in seen:
                        continue
                    seen.add(key)
                    output.append(candidate)
                    if len(output) >= maximum:
                        return output
                completed += 1
            except Exception:
                # Third-party exceptions and paths never become public diagnostics.
                print("external_scraper_provider_failed", file=sys.stderr)
        if attempted and not completed and not output:
            raise RuntimeError("external scraper providers failed")
        return output


def _iterable(value: Any) -> bool:
    return isinstance(value, Iterable) and not isinstance(value, (str, bytes, Mapping))


def _media_query(media: Mapping[str, Any]) -> dict[str, Any] | None:
    imdb = _imdb(media)
    title, year = media.get("title"), media.get("year")
    if imdb is None or not isinstance(title, str):
        return None
    known_year = type(year) is int and 1 <= year <= 9999
    if media.get("kind") == "movie":
        # Matching helpers require text; providers also parse int(year). Never invent a year.
        if not title.strip() or not known_year:
            return None
        return {"imdb": imdb, "title": title, "aliases": [], "year": str(year)}
    if media.get("kind") != "episode":
        return None
    season, episode = _episode_number(media.get("season")), _episode_number(media.get("episode"))
    if season is None or episode is None:
        return None
    # An unavailable series title stays empty; never substitute the episode title.
    series_title = media.get("seriesTitle", "")
    if not isinstance(series_title, str):
        return None
    return {"imdb": imdb, "title": title, "tvshowtitle": series_title, "aliases": [],
            "year": str(year) if known_year else "",
            # Decimal text also keeps season zero truthy in episodic provider routing.
            "season": str(season), "episode": str(episode)}


def _candidate(raw: object, name: str, media: Mapping[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    if media.get("kind") == "episode" and raw.get("package"):
        if (_source_file_index(raw.get("fileIndex")) is None
                and _source_file_index(raw.get("fileIdx")) is None):
            return None
    try:
        candidate = _final_candidate(raw, name, media)
        if candidate is None:
            return None
        candidate["metadata"]["module"] = "external_scraper_package_adapter"
        normalized = dict(normalize_one(candidate, "external_scraper_package"))
        normalized.pop("providerId")
        return normalized
    except (ValueError, TypeError, OverflowError):
        return None


def resolve(media: Mapping[str, Any]) -> list[dict[str, Any]]:
    return ExternalScraperPackageAdapter().resolve(media)
