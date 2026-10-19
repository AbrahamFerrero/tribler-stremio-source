from __future__ import annotations

from typing import Any

from .config import AdapterSettings, DEFAULT_MAX_RESULTS_PER_RESOLVER
from .kodi_profiles import KodiResolverProfile
from .kodi.process_manager import KodiWorkerConfig, KodiWorkerProcessManager
from .models import MediaItem, StreamSource
from .resolver import Resolver


class KodiInstalledResolver(Resolver):
    def __init__(self, manager: KodiWorkerProcessManager | None = None, *,
                 resolver_id: str = "kodi_installed", name: str = "Installed Kodi resolver") -> None:
        self.id = resolver_id
        self.name = name
        self.manager = manager

    @classmethod
    def from_settings(cls, settings: AdapterSettings) -> "KodiInstalledResolver":
        """Compatibility constructor for the legacy single-profile settings view."""
        profile = settings.legacy_kodi_profile
        if profile is None:
            return cls()
        return cls.from_profile(profile, maximum_results=settings.max_results_per_resolver)

    @classmethod
    def from_profile(cls, profile: KodiResolverProfile, *,
                     maximum_results: int = DEFAULT_MAX_RESULTS_PER_RESOLVER) -> "KodiInstalledResolver":
        config = KodiWorkerConfig(
            addon_path=profile.addon_path,
            module_name=profile.module,
            callable_name=profile.callable,
            addon_id=profile.addon_id,
            settings_file=profile.settings_file,
            profile_path=profile.profile_path,
            timeout_seconds=profile.worker_timeout_seconds,
            maximum_results=maximum_results,
            adapter_config=profile.adapter_config,
        )
        return cls(KodiWorkerProcessManager(config), resolver_id=profile.id, name=profile.name)

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        return self.normalize(await self.resolve_candidates(item))

    async def resolve_candidates(self, item: MediaItem) -> list[dict[str, Any]]:
        if self.manager is None:
            raise RuntimeError("Kodi resolver is not configured")
        media = {
            "id": item.id,
            "kind": item.kind,
            "title": item.title,
            "year": item.year,
            "season": item.season,
            "episode": item.episode,
            "externalIds": dict(item.external_ids),
            "classifications": list(item.classifications),
        }
        if item.kind == "episode" and item.series_title is not None:
            media["seriesTitle"] = item.series_title
        return await self.manager.resolve(media)
