from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping
import re
from typing import Any

from .models import MediaItem, StreamSource
from .normalization import normalize


def validate_resolver_id(identifier: str) -> None:
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", identifier):
        raise ValueError("resolver id is invalid")


class Resolver(ABC):
    """Small contract implemented by every Python/Kodi-specific adapter."""

    id: str
    name: str
    timeout_seconds: float | None = None

    @abstractmethod
    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        raise NotImplementedError

    async def resolve_candidates(self, item: MediaItem) -> Iterable[Mapping[str, Any]]:
        """Candidate boundary for the registry's bounded, per-result normalization."""
        return await self.resolve(item)

    def normalize(self, raw_results: Iterable[Mapping[str, Any]]) -> list[StreamSource]:
        return normalize(raw_results, provider_id=self.id)
