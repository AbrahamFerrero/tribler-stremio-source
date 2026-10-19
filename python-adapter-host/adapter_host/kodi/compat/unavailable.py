"""Import-only stand-ins for unavailable Kodi UI/playback objects.

Construction grants no capabilities. Actions fail closed; no player or UI exists.
"""


def denied(*args: object, **kwargs: object) -> None:
    del args, kwargs
    raise PermissionError("Kodi UI and playback actions are disabled in the adapter worker")


class UnavailableObject:
    def __init__(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    play = denied
    stop = denied
    show = denied
    doModal = denied
