from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import stat
from typing import Any

from .kodi.adapter_config import (
    MAX_ADAPTER_CONFIG_BYTES, MAX_ADAPTER_CONFIG_DEPTH, MAX_ADAPTER_CONFIG_ITEMS,
    freeze_adapter_config, unique_json_object, reject_json_constant,
)
from .kodi.process_manager import KodiWorkerConfig
from .resolver import validate_resolver_id

MAX_CONFIG_BYTES = 65_536
MAX_PROFILES = 32


@dataclass(frozen=True, slots=True)
class KodiResolverProfile:
    """Startup-local data. Nested adapter data is copied and recursively frozen."""

    id: str
    name: str
    enabled: bool
    addon_path: Path
    addon_id: str
    module: str
    callable: str
    worker_timeout_seconds: float
    settings_file: Path | None = None
    profile_path: Path | None = None
    adapter_config: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        validate_resolver_id(self.id)
        if not isinstance(self.name, str) or not self.name.strip() or len(self.name) > 128:
            raise ValueError("Kodi profile name must be nonempty and at most 128 characters")
        if type(self.enabled) is not bool:
            raise ValueError("Kodi profile enabled must be a boolean")
        for label, value in (("addonPath", self.addon_path), ("settingsFile", self.settings_file),
                             ("profilePath", self.profile_path)):
            if value is None and label != "addonPath":
                continue
            if not isinstance(value, Path) or "\x00" in str(value):
                raise ValueError(f"Kodi profile {label} is invalid")
        KodiWorkerConfig(
            addon_path=self.addon_path, module_name=self.module, callable_name=self.callable,
            addon_id=self.addon_id, timeout_seconds=self.worker_timeout_seconds,
            adapter_config=self.adapter_config,
        ).validate_structure()
        object.__setattr__(self, "adapter_config", freeze_adapter_config(self.adapter_config))


def load_kodi_profiles(path: Path) -> tuple[KodiResolverProfile, ...]:
    try:
        if not stat.S_ISREG(path.stat().st_mode):
            raise ValueError("Kodi resolvers configuration must be a regular file")
        if path.stat().st_size > MAX_CONFIG_BYTES:
            raise ValueError("Kodi resolvers configuration file is too large")
        with path.open("rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError("Kodi resolvers configuration must be a regular file")
            raw = source.read(MAX_CONFIG_BYTES + 1)
    except OSError:
        raise ValueError("Kodi resolvers configuration file is missing or unreadable") from None
    if len(raw) > MAX_CONFIG_BYTES:
        raise ValueError("Kodi resolvers configuration file is too large")
    try:
        root = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_json_object,
                          parse_constant=reject_json_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ValueError("Kodi resolvers configuration is not valid UTF-8 JSON") from None
    if not isinstance(root, dict) or set(root) != {"version", "profiles"}:
        raise ValueError("Kodi resolvers configuration requires version and profiles only")
    if type(root["version"]) is not int or root["version"] != 1:
        raise ValueError("Kodi resolvers configuration version is unsupported")
    entries = root["profiles"]
    if not isinstance(entries, list) or len(entries) > MAX_PROFILES:
        raise ValueError("Kodi profiles must be an array of at most 32 profiles")
    profiles = []
    for index, entry in enumerate(entries):
        try:
            profiles.append(_profile_from_json(entry, path.parent))
        except ValueError as error:
            raise ValueError(f"Kodi profile at index {index}: {error}") from None
    return validate_kodi_profiles(profiles)


def validate_kodi_profiles(profiles: Any) -> tuple[KodiResolverProfile, ...]:
    if not isinstance(profiles, (list, tuple)) or len(profiles) > MAX_PROFILES:
        raise ValueError("Kodi profiles must contain at most 32 profiles")
    identifiers: set[str] = set()
    for profile in profiles:
        if not isinstance(profile, KodiResolverProfile):
            raise ValueError("Kodi profiles must contain KodiResolverProfile instances")
        if profile.id in identifiers:
            raise ValueError("Kodi profiles contain duplicate resolver ids")
        identifiers.add(profile.id)
    return tuple(profiles)


def _profile_from_json(entry: Any, base: Path) -> KodiResolverProfile:
    required = {"id", "name", "enabled", "addonPath", "addonId", "module", "callable",
                "workerTimeoutSeconds", "adapterConfig"}
    optional = {"settingsFile", "profilePath"}
    if not isinstance(entry, dict) or not required <= entry.keys() or entry.keys() - required - optional:
        raise ValueError("missing required fields or unknown profile fields")

    def path_value(key: str) -> Path | None:
        value = entry.get(key)
        if value is None and key in optional:
            return None
        if not isinstance(value, str) or not value.strip() or "\x00" in value:
            raise ValueError(f"{key} must be a nonempty local path")
        try:
            return (base / Path(value).expanduser()).resolve(strict=False)
        except (OSError, ValueError, RuntimeError):
            raise ValueError(f"{key} is invalid") from None

    return KodiResolverProfile(
        id=entry["id"], name=entry["name"], enabled=entry["enabled"],
        addon_path=path_value("addonPath"), addon_id=entry["addonId"], module=entry["module"],
        callable=entry["callable"], worker_timeout_seconds=entry["workerTimeoutSeconds"],
        settings_file=path_value("settingsFile"), profile_path=path_value("profilePath"),
        adapter_config=entry["adapterConfig"],
    )
