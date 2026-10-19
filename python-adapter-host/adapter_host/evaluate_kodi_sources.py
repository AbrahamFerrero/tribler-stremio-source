"""Fixed local D2b child protocol; never exposed by the HTTP adapter."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from collections import Counter
from typing import Any

from .config import AdapterSettings
from .kodi_installed_resolver import KodiInstalledResolver
from .models import MediaItem
from .normalization import deduplication_key
from .registry import is_known_zero_seed_torrent

_ADAPTERS = {"adapter_host.kodi.adapters.source_pack",
             "adapter_host.kodi.adapters.external_scraper_package"}
_CALLABLE_ADAPTER = "adapter_host.kodi.adapters.callable_stream_resolver"
# Profile-level evaluation unit for non-decomposable callable resolvers;
# this diagnostic ID is not an upstream source and is never sent to the worker.
_PROFILE_SOURCE_ID = "profile"
_MAX_INPUT = 32_768
_MAX_OUTPUT = 8_000_000
_MAX_SOURCES = 512


def structural(rows: list[dict[str, Any]]) -> None:
    """Count owners with Python's existing candidate identity, never exporting keys."""
    identities = [{deduplication_key(candidate) for candidate in row["candidates"]}
                  for row in rows]
    owners = Counter(key for source_keys in identities for key in source_keys)
    for row, source_keys in zip(rows, identities):
        candidates = row["candidates"]
        torrents = [candidate for candidate in candidates if candidate["type"] in {"magnet", "torrent"}]
        row["counts"] = {
            "returned": len(candidates),
            "direct": sum(candidate["type"] in {"http", "https"} for candidate in candidates),
            "torrent": len(torrents),
            "positiveSeeds": sum(candidate.get("seeds", 0) > 0 for candidate in torrents),
            "unknownSeeds": sum("seeds" not in candidate for candidate in torrents),
            "zeroSeeds": sum(candidate.get("seeds") == 0 for candidate in torrents),
            "zeroSeedWouldDrop": sum(is_known_zero_seed_torrent(candidate) for candidate in candidates),
            "distinct": len(source_keys),
            "exclusive": sum(owners[key] == 1 for key in source_keys),
            "shared": sum(owners[key] > 1 for key in source_keys),
        }


async def evaluate(media: dict[str, Any]) -> dict[str, Any]:
    MediaItem.from_json(media)
    settings = AdapterSettings.from_environment()
    rows: list[dict[str, Any]] = []
    managers = []
    try:
        for profile in settings.kodi_profiles:
            if not profile.enabled or (profile.module not in _ADAPTERS
                                       and profile.module != _CALLABLE_ADAPTER):
                continue
            callable_profile = profile.module == _CALLABLE_ADAPTER
            if callable_profile:
                source_ids = [_PROFILE_SOURCE_ID]
            else:
                manager = KodiInstalledResolver.from_profile(
                    profile, maximum_results=settings.max_results_per_resolver).manager
                managers.append(manager)
                source_ids = await manager.evaluation_source_ids()
            if len(rows) + len(source_ids) > _MAX_SOURCES:
                raise ValueError("too many evaluation sources")
            for source_id in source_ids:
                started = time.perf_counter()
                try:
                    if callable_profile:
                        manager = KodiInstalledResolver.from_profile(
                            profile, maximum_results=settings.max_results_per_resolver).manager
                        managers.append(manager)
                    candidates = (await manager.resolve(media) if callable_profile
                                  else await manager.evaluate_source(media, source_id))
                    status = "ok"
                except Exception:
                    # One broken evaluation unit must not erase other observations.
                    candidates, status = [], "error"
                elapsed_ms = min(600_000.0, max(0.0, round((time.perf_counter() - started) * 1000, 3)))
                rows.append({"profileId": profile.id, "sourceId": source_id,
                             "status": status, "elapsedMs": elapsed_ms, "candidates": candidates})
    finally:
        if any(manager.active_count for manager in managers):
            raise RuntimeError("evaluation worker remains active")
    structural(rows)
    return {"ok": True, "sources": rows}


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(_MAX_INPUT + 1)
        if len(raw) > _MAX_INPUT:
            raise ValueError("input too large")
        media = json.loads(raw.decode("utf-8"))
        if not isinstance(media, dict):
            raise ValueError("invalid media")
        response = asyncio.run(evaluate(media))
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > _MAX_OUTPUT:
            raise ValueError("output too large")
    except Exception:
        # Never forward third-party exceptions, paths, settings, or candidate data.
        encoded = b'{"ok":false,"error":"evaluation_failed"}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
