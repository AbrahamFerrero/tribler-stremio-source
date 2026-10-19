"""Project-authored availability scenarios; no network access."""
import time

import xbmcaddon


def success(media):
    identifier = xbmcaddon.Addon().getAddonInfo("id")
    return [{"type": "https", "url": "https://example.invalid/" + identifier + ".mp4"}]


def empty(media):
    return []


def error(media):
    raise RuntimeError("private fixture detail must not escape")


def timeout(media):
    time.sleep(30)
    return []


def mixed(media):
    return success(media) + [{"type": "https", "url": "https://example.invalid/payload.exe"}]


def malformed(media):
    return [{"type": "https", "url": "https://example.invalid/payload.exe"}]


def invalid_ipc(media):
    return [{"type": "https", "url": 42}]


def many(media):
    return [{"type": "https", "url": "https://example.invalid/%s.mp4" % i} for i in range(3)]


def by_request(media):
    return success(media) if media["id"] == "fixture:success" else error(media)
