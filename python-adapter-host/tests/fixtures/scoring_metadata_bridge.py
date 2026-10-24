"""Synthetic stdin/stdout integration boundary, not a Python HTTP host or Kodi worker."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter_host.kodi.adapters.callable_stream_resolver import _candidate
from adapter_host.models import MediaItem
from adapter_host.registry import ResolverRegistry
from adapter_host.resolver import Resolver


class SyntheticResolver(Resolver):
    id = "synthetic"
    name = "Synthetic metadata"

    def __init__(self, candidates, callable_route):
        self.candidates = candidates
        self.callable_route = callable_route

    async def resolve(self, item):
        if self.callable_route:
            return [value for raw in self.candidates if (value := _candidate(raw)) is not None]
        return self.candidates


async def main():
    request = json.load(sys.stdin)
    results = []
    for candidates in request["cases"]:
        registry = ResolverRegistry()
        registry.register(SyntheticResolver(candidates, request["callable"]))
        result = await registry.resolve_with_outcomes(MediaItem("synthetic", "movie", "Synthetic"))
        results.append({"streams": result.streams,
                        "statuses": [outcome.status for outcome in result.outcomes]})
    print(json.dumps(results))


if __name__ == "__main__":
    asyncio.run(main())
