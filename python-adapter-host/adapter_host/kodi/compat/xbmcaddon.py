from __future__ import annotations

from . import runtime


class Addon:
    def __init__(self, id: str | None = None) -> None:
        current = runtime.state()
        if id is not None and id != current.addon_id:
            raise ValueError("unknown addon id")
        self._state = current

    def getSetting(self, id: str) -> str:
        return self._state.settings.get(_key(id), "")

    def setSetting(self, id: str, value: str) -> bool:
        if not isinstance(value, str) or len(value) > 8_192:
            raise ValueError("invalid setting value")
        self._state.settings[_key(id)] = value
        return True

    def getAddonInfo(self, key: str) -> str:
        values = {
            "id": self._state.addon_id,
            "name": self._state.addon_id,
            "version": "0.0.0-adapter",
            "path": str(self._state.addon_path),
            "profile": str(self._state.profile_path),
            "icon": "",
            "enabled": "true",
        }
        if key not in values:
            return ""
        return values[key]

    def getLocalizedString(self, id: int) -> str:
        if isinstance(id, bool) or not isinstance(id, int):
            raise ValueError("invalid localization id")
        return str(id)

    def openSettings(self) -> None:
        raise PermissionError("Kodi settings UI is disabled in the adapter worker")


def _key(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(char) < 32 for char in value):
        raise ValueError("invalid setting id")
    return value
