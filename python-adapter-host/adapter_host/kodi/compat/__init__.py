from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType

from . import runtime, xbmc, xbmcaddon, xbmcgui, xbmcplugin, xbmcvfs


def install(addon_id: str, addon_path: Path, profile_path: Path, settings: dict[str, str]) -> None:
    runtime.configure(addon_id, addon_path, profile_path, settings)
    modules: dict[str, ModuleType] = {
        "xbmc": xbmc,
        "xbmcaddon": xbmcaddon,
        "xbmcgui": xbmcgui,
        "xbmcplugin": xbmcplugin,
        "xbmcvfs": xbmcvfs,
    }
    for name, module in modules.items():
        sys.modules[name] = module


__all__ = ["install"]
