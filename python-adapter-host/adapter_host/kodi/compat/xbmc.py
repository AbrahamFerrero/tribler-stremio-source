from __future__ import annotations

import re
import sys
import threading
import time

from .xbmcvfs import translatePath
from .unavailable import UnavailableObject

LOGDEBUG = 0
LOGINFO = 1
LOGWARNING = 2
LOGERROR = 3
LOGFATAL = 4
LOGNONE = 5

_abort = threading.Event()
_URL = re.compile(r"(?:https?|magnet):\S+", re.IGNORECASE)
_SECRET = re.compile(r"(?i)(token|cookie|authorization|password|api[_-]?key)\s*[:=]\s*\S+")


def log(message: object, level: int = LOGDEBUG) -> None:
    text = str(message).replace("\r", " ").replace("\n", " ")[:2_000]
    text = _URL.sub("<url>", text)
    text = _SECRET.sub(r"\1=<redacted>", text)
    sys.stderr.write(f"kodi[{int(level)}] {text}\n")


def sleep(milliseconds: int) -> None:
    if isinstance(milliseconds, bool) or not isinstance(milliseconds, int) or milliseconds < 0:
        raise ValueError("invalid sleep duration")
    _abort.wait(min(milliseconds, 60_000) / 1000)


class Monitor:
    def abortRequested(self) -> bool:
        return _abort.is_set()

    def waitForAbort(self, timeout: float | None = None) -> bool:
        return _abort.wait(timeout)


def getInfoLabel(label: str) -> str:
    return "20.0" if label == "System.BuildVersion" else ""


def getCondVisibility(condition: str) -> bool:
    del condition
    return False


def executebuiltin(command: str) -> None:
    del command
    raise PermissionError("Kodi builtins are disabled in the adapter worker")


def executeJSONRPC(payload: str) -> str:
    del payload
    raise PermissionError("Kodi JSON-RPC is disabled in the adapter worker")


# Legacy source libraries bind these names during import. All active actions
# remain unavailable; path translation reuses exactly the existing guard.

LOGNOTICE = LOGINFO
ENGLISH_NAME = 2
PLAYLIST_VIDEO = 1
Player = UnavailableObject
PlayList = UnavailableObject
Keyboard = UnavailableObject


def getLocalizedString(identifier: int) -> str:
    return str(identifier)


def getSkinDir() -> str:
    return ""


def getLanguage(*args: object, **kwargs: object) -> str:
    del args, kwargs
    return ""
