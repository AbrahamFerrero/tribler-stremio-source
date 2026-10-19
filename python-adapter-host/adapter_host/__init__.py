"""Local-only Python resolver adapter for Tribler Stremio Bridge."""

from .models import MediaItem, StreamSource
from .normalization import normalize
from .resolver import Resolver
from .registry import ResolverRegistry
from .kodi_installed_resolver import KodiInstalledResolver

__all__ = [
    "KodiInstalledResolver", "MediaItem", "Resolver", "ResolverRegistry", "StreamSource", "normalize"
]
