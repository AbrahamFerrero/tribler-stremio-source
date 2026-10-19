from __future__ import annotations

from collections.abc import Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import importlib
import inspect
from itertools import islice
import json
import os
import re
import sys
from typing import Any
from urllib.parse import unquote, urlsplit

from ..adapter_config import WORKER_PROFILE_CONFIG_ENV, decode_adapter_config
from ..python_roots import AddonPythonRoots
from ..protocol import MAX_WORKER_RESULTS
from ...normalization import deduplication_key, has_supported_http_video_path, normalize_one
from .callable_stream_resolver import _STREAM_FIELDS
from .p2p_metadata import _MODULE_NAME, _episode_number, _imdb, _worker_result_limit

ADAPTER_MODULE = "adapter_host.kodi.adapters.source_pack"
_MOVIE = ("imdb", "title", "localtitle", "aliases", "year")
_TVSHOW = ("imdb", "tvdb", "tvshowtitle", "localtvshowtitle", "aliases", "year")
_EPISODE = ("url", "imdb", "tvdb", "title", "premiered", "season", "episode")


@dataclass(frozen=True, slots=True)
class SourcePackConfiguration:
    package: str
    folders: tuple[str, ...]
    source_ids: tuple[str, ...] | None
    modules: int
    workers: int
    aliases_format: str


def validate_configuration(config: Mapping[str, Any]) -> SourcePackConfiguration:
    required = {"sourcePackage", "sourceFolders"}
    if not required <= config.keys() or config.keys() - required - {"sourceIds", "maxProviderModules", "maxProviderWorkers", "aliasesFormat"}:
        raise ValueError("source pack configuration fields are invalid")
    package = config["sourcePackage"]
    if (not isinstance(package, str) or len(package) > 256 or not _MODULE_NAME.fullmatch(package)
            or any(part in {"default", "service"} or part.startswith("_") for part in package.split("."))):
        raise ValueError("source pack package is invalid")
    folders = config["sourceFolders"]
    if (not isinstance(folders, (list, tuple)) or not 1 <= len(folders) <= 8
            or any(not isinstance(folder, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", folder)
                   or folder in {"default", "service"} for folder in folders)
            or len(set(folders)) != len(folders)):
        raise ValueError("source pack folders are invalid")
    modules, workers = config.get("maxProviderModules", 64), config.get("maxProviderWorkers", 8)
    if type(modules) is not int or not 1 <= modules <= 128 or type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError("source pack limits are invalid")
    source_ids = config.get("sourceIds")
    if "sourceIds" in config:
        if (not isinstance(source_ids, (list, tuple)) or not 1 <= len(source_ids) <= modules
                or any(not isinstance(name, str) or len(name) > 512
                       or not any(name.startswith(package + "." + folder + ".")
                                  and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_]{0,127}",
                                                   name[len(package) + len(folder) + 2:])
                                  for folder in folders)
                       for name in source_ids)
                or len(set(source_ids)) != len(source_ids)):
            raise ValueError("source pack source IDs are invalid")
        source_ids = tuple(source_ids)
    aliases_format = config.get("aliasesFormat", "list")
    if not isinstance(aliases_format, str) or aliases_format not in {"list", "json"}:
        raise ValueError("source pack aliases format is invalid")
    return SourcePackConfiguration(package, tuple(sorted(folders)), source_ids, modules, workers, aliases_format)


class SourcePackAdapter:
    """Local source-class packs with fixed identity and discovery contracts."""

    def __init__(self) -> None:
        self.config = validate_configuration(decode_adapter_config(os.environ.get(WORKER_PROFILE_CONFIG_ENV)))

    def source_ids(self) -> list[str]:
        """Discover bounded, configured local modules for developer evaluation."""
        from ..compat import runtime
        roots = AddonPythonRoots.discover(runtime.state().addon_path)
        return _selected(roots, self.config)

    def resolve_source(self, media: Mapping[str, Any], source_id: str) -> list[dict[str, Any]]:
        """Run one discovered source before cross-source dedupe and result caps."""
        values = _identity(media)
        if values is None:
            return []
        if self.config.aliases_format == "json":
            values["aliases"] = json.dumps(values["aliases"], ensure_ascii=False)
        from ..compat import runtime
        roots = AddonPythonRoots.discover(runtime.state().addon_path)
        if source_id not in _selected(roots, self.config):
            raise ValueError("evaluation source is unavailable")
        roots.validate_module(source_id)
        module = importlib.import_module(source_id)
        roots.validate_module(source_id)
        factory = getattr(module, "source", None)
        if not isinstance(factory, type):
            raise ValueError("evaluation source is unavailable")
        candidates, _ = _run((source_id, factory), values, media["kind"])
        return candidates

    def resolve(self, media: Mapping[str, Any]) -> list[dict[str, Any]]:
        values = _identity(media)
        if values is None:
            return []
        if self.config.aliases_format == "json":
            values["aliases"] = json.dumps(values["aliases"], ensure_ascii=False)
        from ..compat import runtime
        roots = AddonPythonRoots.discover(runtime.state().addon_path)
        names = _selected(roots, self.config)
        providers = []
        skipped = 0
        # Import and origin checks are serialized: addon package initializers are
        # not raced, and all code selection comes from this bounded local list.
        for name in names:
            try:
                roots.validate_module(name)
                module = importlib.import_module(name)
                roots.validate_module(name)
                factory = getattr(module, "source", None)
                if not isinstance(factory, type):
                    raise ValueError("source class missing")
                providers.append((name, factory))
            except PermissionError:
                raise
            except Exception:
                skipped += 1
        output, seen = [], set()
        totals = dict(raw=0, direct=0, resolved=0, intermediate=0, excluded=0, invalid=0,
                      providersOk=0, providersError=0)
        maximum = _worker_result_limit()
        # map retains configured module order, regardless of network latency.
        with ThreadPoolExecutor(max_workers=self.config.workers) as pool:
            for candidates, diagnostics in pool.map(lambda entry: _run(entry, values, media["kind"]), providers):
                for key in ("raw", "direct", "resolved", "intermediate", "excluded", "invalid"):
                    totals[key] += diagnostics[key]
                totals["providersOk" if diagnostics["status"] == "ok" else "providersError"] += 1
                for candidate in candidates:
                    key = deduplication_key(candidate)
                    if key not in seen and len(output) < maximum:
                        seen.add(key)
                        output.append(candidate)
        print("source_pack_summary " + json.dumps({"enumerated": len(names), "imported": len(providers),
              "import_failed": skipped, "returned": len(output), **totals}), file=sys.stderr)
        return output


def _discover(roots: AddonPythonRoots, config: SourcePackConfiguration) -> list[str]:
    roots.validate_module(config.package)
    names = set()
    for folder in config.folders:
        prefix = config.package + "." + folder
        locations = roots.validate_module(prefix)
        if not locations:
            raise ValueError("source folder must be a local package")
        for directory in locations:
            for path in directory.iterdir():
                # Flat Python source modules only, no UI/entrypoint files, no
                # recursive loaders and no provider selection through HTTP.
                if (path.suffix == ".py" and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_]{0,127}", path.stem)
                        and path.stem not in {"default", "service", "main", "addon", "client"}):
                    name = prefix + "." + path.stem
                    try:
                        roots.validate_module(name)
                    except (ValueError, OSError):
                        continue
                    names.add(name)
    return sorted(names)[:config.modules]


def _selected(roots: AddonPythonRoots, config: SourcePackConfiguration) -> list[str]:
    discovered = _discover(roots, config)
    if config.source_ids is None:
        return discovered
    selected = set(config.source_ids)
    if not selected.issubset(discovered):
        raise ValueError("configured source is unavailable")
    return [name for name in discovered if name in selected]


def _parameters(operation: Any, contracts: tuple[tuple[str, ...], ...]) -> tuple[str, ...]:
    if not callable(operation):
        raise ValueError("source method missing")
    params = inspect.signature(operation).parameters
    if tuple(params) not in contracts or any(p.kind != p.POSITIONAL_OR_KEYWORD for p in params.values()):
        raise ValueError("unsupported source signature")
    return tuple(params)


def _aware(names: tuple[str, ...]) -> tuple[str, ...]:
    return (names[0], "tmdb", *names[1:]) if names[0] == "imdb" else ("url", "imdb", "tmdb", *names[2:])


def _identity(media: Mapping[str, Any]) -> dict[str, Any] | None:
    kind = media.get("kind")
    if kind not in {"movie", "episode"}:
        return None
    title = media.get("title") if kind == "movie" else media.get("seriesTitle")
    if not isinstance(title, str) or not title.strip() or len(title) > 300 or any(ord(c) < 32 for c in title):
        return None
    year = media.get("year")
    ids = media.get("externalIds")
    def decimal(name: str) -> str:
        value = ids.get(name) if isinstance(ids, Mapping) else None
        return value if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,15}", value) else ""
    values = dict(imdb=_imdb(media) or "", tmdb=decimal("tmdb"), tvdb=decimal("tvdb"),
                  title=media.get("title", ""), localtitle=title.strip(), aliases=[{"title": title.strip()}],
                  year=str(year) if type(year) is int and 1 <= year <= 9999 else "",
                  tvshowtitle=title.strip(), localtvshowtitle=title.strip(), premiered="",
                  hostDict=[], hostprDict=[])
    if kind == "episode":
        season, episode = _episode_number(media.get("season")), _episode_number(media.get("episode"))
        if season is None or episode is None:
            return None
        values.update(season=str(season), episode=str(episode))
    return values


def _run(entry: tuple[str, type], identity: Mapping[str, Any], kind: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    _, factory = entry
    diagnostics = dict(status="ok", raw=0, direct=0, resolved=0, intermediate=0, excluded=0, invalid=0)
    output = []
    try:
        instance = factory()
        contracts = {"movie": (_MOVIE, _aware(_MOVIE)), "tvshow": (_TVSHOW, _aware(_TVSHOW)),
                     "episode": (_EPISODE, _aware(_EPISODE)),
                     "sources": (("url", "hostDict"), ("url", "hostDict", "hostprDict"))}
        methods = ("movie", "sources") if kind == "movie" else ("tvshow", "episode", "sources")
        params = {method: _parameters(getattr(instance, method, None), contracts[method]) for method in methods}
        resolver = getattr(instance, "resolve", None)
        if resolver is not None:
            _parameters(resolver, (("url",),))
        # Preserve the configured representation and isolate mutable alias entries.
        aliases = identity["aliases"]
        if isinstance(aliases, list):
            aliases = [dict(alias) for alias in aliases]
        values = {**identity, "aliases": aliases, "hostDict": [], "hostprDict": []}
        for method in methods:
            raw = getattr(instance, method)(**{key: values[key] for key in params[method]})
            values["url"] = raw
        if not isinstance(raw, Iterable) or isinstance(raw, (str, bytes, Mapping)):
            raise ValueError("invalid sources collection")
        for candidate in islice(raw, MAX_WORKER_RESULTS):
            diagnostics["raw"] += 1
            if not isinstance(candidate, Mapping):
                diagnostics["invalid"] += 1
                continue
            url = candidate.get("url")
            if (candidate.get("debridonly") is True or candidate.get("local") is True
                    or candidate.get("type") in {"magnet", "torrent"} or candidate.get("magnet") or candidate.get("infoHash")):
                diagnostics["excluded"] += 1
                continue
            if not isinstance(url, str):
                diagnostics["excluded"] += 1
                continue
            # Opaque provider tokens may resolve to video; explicit P2P/local
            # URLs remain outside this adapter's discovery contract.
            if _excluded_url(url) or (resolver is None and not _http_url(url)):
                diagnostics["excluded"] += 1
                continue
            direct = candidate.get("direct") is True
            # Decide from the URL alone: invalid metadata must never trigger
            # a resolver call for an already-final direct stream.
            if resolver is not None and (not direct or not _final_http_video_url(url)):
                url = resolver(url)
            elif not direct:
                url = None
            normalized = _candidate(candidate, url) if direct or _final_http_video_url(url) else None
            if normalized is None:
                diagnostics["invalid" if direct else "intermediate"] += 1
                continue
            diagnostics["direct" if direct else "resolved"] += 1
            output.append(normalized)
    except PermissionError:
        raise
    except Exception:
        # Discard partial output, including failures in lazy collections.
        output = []
        diagnostics["status"] = "provider_error"
    return output, diagnostics


def _excluded_url(url: str) -> bool:
    try:
        parsed = urlsplit(url.split("|", 1)[0])
        return parsed.scheme.lower() in {"magnet", "file"} or unquote(parsed.path).lower().endswith(".torrent")
    except ValueError:
        return False


def _http_url(url: str) -> bool:
    try:
        parsed = urlsplit(url.split("|", 1)[0])
        return parsed.scheme.lower() in {"http", "https"} and not unquote(parsed.path).lower().endswith(".torrent")
    except ValueError:
        return False


def _final_http_video_url(url: object) -> bool:
    return isinstance(url, str) and has_supported_http_video_path(url.split("|", 1)[0])


def _candidate(raw: Mapping[str, Any], url: object) -> dict[str, Any] | None:
    if not isinstance(url, str) or not _http_url(url):
        return None
    # Opaque direct candidates leave without filename hints or provider headers;
    # Node must establish media evidence before admitting them.
    fields = {key: raw[key] for key in _STREAM_FIELDS - {"type", "url", "magnet", "infoHash", "fileIndex", "filename"}
              if key in raw}
    fields["url"] = url.split("|", 1)[0]
    try:
        result = dict(normalize_one(fields, "source_pack"))
        result.pop("providerId")
        return result
    except (ValueError, TypeError, OverflowError):
        return None


def resolve(media: Mapping[str, Any]) -> list[dict[str, Any]]:
    return SourcePackAdapter().resolve(media)
