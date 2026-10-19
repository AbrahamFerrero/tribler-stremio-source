from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from itertools import islice
import logging
import time
from dataclasses import asdict, dataclass

from .models import MediaItem, StreamSource
from .normalization import deduplication_key, normalize
from .resolver import Resolver, validate_resolver_id

LOGGER = logging.getLogger("adapter_host.registry")


@dataclass(slots=True)
class ResolverState:
    id: str
    name: str
    enabled: bool
    status: str = "never-run"
    latencyMs: int | None = None
    resultCount: int | None = None
    lastError: str | None = None

    def public(self) -> dict[str, object]:
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass(frozen=True, slots=True)
class ResolverOutcome:
    id: str
    status: str
    operational: bool


@dataclass(frozen=True, slots=True)
class ResolutionResult:
    streams: list[StreamSource]
    outcomes: tuple[ResolverOutcome, ...]


def is_known_zero_seed_torrent(source: StreamSource) -> bool:
    """The existing Python hygiene exclusion, shared with local evaluation."""
    return source["type"] in {"magnet", "torrent"} and source.get("seeds") == 0


class ResolverRegistry:
    def __init__(self, default_timeout_seconds: float = 6.0, maximum_results: int = 100,
                 maximum_results_per_resolver: int = 20, max_concurrent_resolvers: int = 4) -> None:
        if (default_timeout_seconds <= 0 or not 1 <= maximum_results <= 100
                or not 1 <= maximum_results_per_resolver <= 100
                or not 1 <= max_concurrent_resolvers <= 32):
            raise ValueError("invalid registry limits")
        self.default_timeout_seconds = default_timeout_seconds
        self.maximum_results = maximum_results
        self.maximum_results_per_resolver = maximum_results_per_resolver
        self.max_concurrent_resolvers = max_concurrent_resolvers
        self._resolvers: dict[str, Resolver] = {}
        self._states: dict[str, ResolverState] = {}

    def register(self, resolver: Resolver, *, enabled: bool = True) -> None:
        if resolver.id in self._resolvers:
            raise ValueError(f"resolver already registered: {resolver.id}")
        validate_resolver_id(resolver.id)
        self._resolvers[resolver.id] = resolver
        self._states[resolver.id] = ResolverState(
            resolver.id,
            resolver.name[:128],
            enabled,
            status="never-run" if enabled else "disabled",
        )

    def set_enabled(self, resolver_id: str, enabled: bool) -> None:
        if resolver_id not in self._states:
            raise KeyError(resolver_id)
        state = self._states[resolver_id]
        state.enabled = enabled
        if not enabled:
            state.status = "disabled"
            state.lastError = None
        elif state.status == "disabled":
            state.status = "never-run"

    def list_resolvers(self) -> list[dict[str, object]]:
        return [state.public() for state in self._states.values()]

    def enabled_count(self) -> int:
        return sum(state.enabled for state in self._states.values())

    def validate_timeout_hierarchy(self, request_timeout_seconds: float) -> None:
        for resolver_id, resolver in self._resolvers.items():
            if not self._states[resolver_id].enabled:
                continue
            timeout = resolver.timeout_seconds or self.default_timeout_seconds
            if timeout >= request_timeout_seconds:
                raise ValueError("every resolver timeout must be below the adapter request timeout")

    async def resolve_all(self, item: MediaItem) -> list[StreamSource]:
        return (await self.resolve_with_outcomes(item)).streams

    async def resolve_with_outcomes(self, item: MediaItem) -> ResolutionResult:
        """Resolve once using invocation-local outcomes; public state is diagnostics only."""
        resolvers = [resolver for resolver_id, resolver in self._resolvers.items()
                     if self._states[resolver_id].enabled]
        groups: list[list[StreamSource]] = [[] for _ in resolvers]
        outcomes: list[ResolverOutcome | None] = [None for _ in resolvers]
        queue: asyncio.Queue[tuple[int, Resolver]] = asyncio.Queue()
        for entry in enumerate(resolvers):
            queue.put_nowait(entry)

        async def worker() -> None:
            while True:
                try:
                    index, resolver = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    groups[index], outcomes[index] = await self._run(resolver, item)
                finally:
                    queue.task_done()

        workers = [asyncio.create_task(worker())
                   for _ in range(min(len(resolvers), self.max_concurrent_resolvers))]
        if workers:
            await asyncio.gather(*workers)
        completed = tuple(outcome for outcome in outcomes if outcome is not None)
        # Consider every bounded resolver result before applying the global cap.
        # This lets later resolvers improve seed evidence for an earlier torrent.
        unique: dict[str, StreamSource] = {}
        for position in range(max((len(group) for group in groups), default=0)):
            for group in groups:
                if position >= len(group):
                    continue
                source = group[position]
                if is_known_zero_seed_torrent(source):
                    continue
                # Filenames are only hints; an explicit file index selects a distinct file.
                key = (f"bt:{source['infoHash']}:{source.get('fileIndex', '')}"
                       if source["type"] in {"magnet", "torrent"} and source.get("infoHash")
                       else deduplication_key(source))
                previous = unique.get(key)
                if previous is None or (source["type"] in {"magnet", "torrent"}
                                        and (source.get("seeds") or 0) > (previous.get("seeds") or 0)):
                    unique[key] = source
        return ResolutionResult(list(unique.values())[:self.maximum_results], completed)

    async def _run(self, resolver: Resolver, item: MediaItem) -> tuple[list[StreamSource], ResolverOutcome]:
        state = self._states[resolver.id]
        started = time.monotonic()
        timeout = resolver.timeout_seconds or self.default_timeout_seconds
        try:
            raw = await asyncio.wait_for(resolver.resolve_candidates(item), timeout=timeout)
        except asyncio.TimeoutError:
            state.status = "timeout"
            state.resultCount = 0
            state.lastError = "timeout"
            state.latencyMs = round((time.monotonic() - started) * 1000)
            LOGGER.warning("Resolver timed out", extra={"resolver_id": resolver.id})
            return [], ResolverOutcome(resolver.id, "timeout", False)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # Failure isolation is intentional at the plugin boundary.
            state.status = "resolver_error"
            state.resultCount = 0
            state.lastError = "resolver_error"
            state.latencyMs = round((time.monotonic() - started) * 1000)
            LOGGER.warning("Resolver failed", extra={"resolver_id": resolver.id, "error_type": type(error).__name__})
            return [], ResolverOutcome(resolver.id, "resolver_error", False)
        try:
            if isinstance(raw, (str, bytes, Mapping)) or not isinstance(raw, Iterable):
                raise ValueError("resolver output must be an iterable")
            limited = list(islice(iter(raw), self.maximum_results_per_resolver + 1))
            exceeded = len(limited) > self.maximum_results_per_resolver
            normalized: list[StreamSource] = []
            invalid = False
            for candidate in limited[:self.maximum_results_per_resolver]:
                try:
                    normalized.extend(normalize([candidate], provider_id=resolver.id))
                except Exception:
                    invalid = True
            status = "invalid_result" if invalid or exceeded else "ok"
            state.status = status
            state.resultCount = len(normalized)
            state.lastError = "invalid_result" if invalid or exceeded else None
            # A valid empty response is operational, as are valid survivors of
            # filtering/truncation. Diagnostic degradation is independent.
            operational = bool(normalized) or not (invalid or exceeded)
            return normalized, ResolverOutcome(resolver.id, status, operational)
        except Exception as error:
            state.status = "invalid_result"
            state.resultCount = 0
            state.lastError = "invalid_result"
            LOGGER.warning("Resolver returned invalid results", extra={
                "resolver_id": resolver.id, "error_type": type(error).__name__
            })
            return [], ResolverOutcome(resolver.id, "invalid_result", False)
        finally:
            state.latencyMs = round((time.monotonic() - started) * 1000)

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        return await self.resolve_all(item)
