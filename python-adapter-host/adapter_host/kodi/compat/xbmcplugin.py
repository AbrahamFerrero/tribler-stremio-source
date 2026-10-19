"""Inert directory UI compatibility for headless stream-discovery workers.

Arguments are ignored, never consumed or converted into filesystem, network,
plugin or playback actions. Playback entrypoints always deny execution.
"""
from __future__ import annotations


from .unavailable import denied

def addDirectoryItems(handle: int, items: object, totalItems: int = 0) -> bool:
    """Acknowledge a directory batch without inspecting or retaining its items."""
    return True


def setContent(handle: int, content: str) -> None:
    """Ignore directory presentation metadata."""
    return None


def endOfDirectory(handle: int, succeeded: bool = True, updateListing: bool = False,
                   cacheToDisc: bool = True) -> None:
    """Finish no UI operation and write no directory cache."""
    return None


# Libraries may bind these entrypoints; the worker cannot perform the actions.
setResolvedUrl = denied
setProperty = denied


def addDirectoryItem(handle: int, url: str, listitem: object, isFolder: bool = False,
                     totalItems: int = 0) -> bool:
    del handle, url, listitem, isFolder, totalItems
    return True
