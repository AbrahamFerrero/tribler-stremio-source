from __future__ import annotations

from . import runtime
from .unavailable import UnavailableObject


class Window:
    def __init__(self, window_id: int) -> None:
        if isinstance(window_id, bool) or not isinstance(window_id, int):
            raise ValueError("invalid window id")
        self._values = runtime.properties(window_id)

    def getProperty(self, key: str) -> str:
        return self._values.get(_key(key), "")

    def setProperty(self, key: str, value: str) -> None:
        if not isinstance(value, str) or len(value) > 16_384:
            raise ValueError("invalid window property")
        self._values[_key(key)] = value

    def clearProperty(self, key: str) -> None:
        self._values.pop(_key(key), None)


class Dialog:
    def notification(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def ok(self, *args: object, **kwargs: object) -> bool:
        del args, kwargs
        return False

    def yesno(self, *args: object, **kwargs: object) -> bool:
        del args, kwargs
        return False

    def select(self, *args: object, **kwargs: object) -> int:
        del args, kwargs
        return -1

    def multiselect(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class DialogProgress:
    def create(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def update(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def close(self) -> None:
        return None

    def iscanceled(self) -> bool:
        return False


def _key(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(char) < 32 for char in value):
        raise ValueError("invalid property key")
    return value


ListItem = UnavailableObject
WindowDialog = UnavailableObject
ControlButton = UnavailableObject
ControlImage = UnavailableObject
DialogProgressBG = DialogProgress
NOTIFICATION_INFO = "info"
NOTIFICATION_WARNING = "warning"
NOTIFICATION_ERROR = "error"


def getCurrentWindowDialogId() -> int:
    return 0


def getCurrentWindowId() -> int:
    return 0
