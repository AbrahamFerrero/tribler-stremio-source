from __future__ import annotations

from .models import MediaItem, StreamSource
from .resolver import Resolver


class ExampleResolver(Resolver):
    """Deterministic, network-free example using the openly licensed Big Buck Bunny."""

    id = "example_authorized"
    name = "Authorized example resolver"
    timeout_seconds = 2.0

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        if item.id != "python-adapter:test" and "big buck bunny" not in item.title.lower():
            return []
        raw_results = [
            {
                "type": "https",
                "url": "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4",
                "title": "Big Buck Bunny — HTTPS 320p",
                "filename": "BigBuckBunny_320x180.mp4",
                "quality": "SD",
                "resolution": "320x180",
                "codec": "H.264",
                "language": "zxx",
                "metadata": {"license": "Creative Commons Attribution 3.0", "example": True},
            },
            {
                "type": "magnet",
                "magnet": "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny",
                "title": "Big Buck Bunny — BitTorrent",
                "quality": "multi-quality",
                "metadata": {"license": "Creative Commons Attribution 3.0", "example": True},
            },
        ]
        return self.normalize(raw_results)
