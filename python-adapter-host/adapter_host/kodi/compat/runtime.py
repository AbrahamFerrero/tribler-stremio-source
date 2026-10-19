from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading


@dataclass(slots=True)
class RuntimeState:
    addon_id: str
    addon_path: Path
    profile_path: Path
    settings: dict[str, str]


_state: RuntimeState | None = None
_properties: dict[int, dict[str, str]] = {}
_lock = threading.RLock()


def configure(addon_id: str, addon_path: Path, profile_path: Path, settings: dict[str, str]) -> None:
    global _state
    addon_root = addon_path.resolve(strict=True)
    profile_root = profile_path.resolve(strict=False)
    profile_root.mkdir(parents=True, exist_ok=True)
    _state = RuntimeState(addon_id, addon_root, profile_root.resolve(strict=True), dict(settings))
    with _lock:
        _properties.clear()


def state() -> RuntimeState:
    if _state is None:
        raise RuntimeError("Kodi compatibility runtime is not configured")
    return _state


def properties(window_id: int) -> dict[str, str]:
    with _lock:
        return _properties.setdefault(window_id, {})


def ensure_within(path: Path, roots: tuple[Path, ...]) -> Path:
    resolved = path.resolve(strict=False)
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise PermissionError("path is outside the Kodi compatibility sandbox")
    return resolved


def translate(path: str) -> Path:
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ValueError("invalid path")
    current = state()
    normalized = path.replace("\\", "/")
    profile_prefix = f"special://profile/addon_data/{current.addon_id}"
    if normalized == "special://profile":
        return current.profile_path
    if normalized.startswith(profile_prefix):
        suffix = normalized[len(profile_prefix):].lstrip("/")
        return ensure_within(current.profile_path / suffix, (current.profile_path,))
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = current.addon_path / candidate
    return ensure_within(candidate, (current.addon_path, current.profile_path))


def writable(path: str) -> Path:
    current = state()
    resolved = translate(path)
    return ensure_within(resolved, (current.profile_path,))
