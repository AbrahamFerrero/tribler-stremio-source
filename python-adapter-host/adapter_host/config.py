from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

from .kodi.process_manager import KodiWorkerConfig
from .kodi_profiles import KodiResolverProfile, load_kodi_profiles, validate_kodi_profiles

DEFAULT_RESOLVER_TIMEOUT_SECONDS = 6.0
DEFAULT_REQUEST_TIMEOUT_SECONDS = 8.0
DEFAULT_MAX_CONCURRENT_RESOLVERS = 4
DEFAULT_MAX_RESULTS_PER_RESOLVER = 20
DEFAULT_MAX_TOTAL_RESULTS = 100
DEFAULT_KODI_WORKER_TIMEOUT_SECONDS = 5.0


def require_isolated_host_environment() -> None:
    """Refuse service startup; cannot undo the interpreter's initial inheritance."""
    if any(name.upper() in {"TRIBLER_API_KEY", "TRIBLER_URL"} for name in os.environ):
        raise ValueError("host startup refused: forbidden Tribler environment")


@dataclass(frozen=True, slots=True)
class AdapterSettings:
    resolver_timeout_seconds: float = DEFAULT_RESOLVER_TIMEOUT_SECONDS
    request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT_SECONDS
    max_concurrent_resolvers: int = DEFAULT_MAX_CONCURRENT_RESOLVERS
    max_results_per_resolver: int = DEFAULT_MAX_RESULTS_PER_RESOLVER
    max_total_results: int = DEFAULT_MAX_TOTAL_RESULTS
    kodi_profiles: tuple[KodiResolverProfile, ...] = ()
    kodi_resolvers_file: Path | None = None

    def __post_init__(self) -> None:
        if self.resolver_timeout_seconds <= 0:
            raise ValueError("resolver timeout must be positive")
        if self.request_timeout_seconds <= self.resolver_timeout_seconds:
            raise ValueError("adapter request timeout must exceed resolver timeout")
        if not 1 <= self.max_concurrent_resolvers <= 32:
            raise ValueError("max concurrent resolvers must be between 1 and 32")
        if not 1 <= self.max_results_per_resolver <= 100:
            raise ValueError("max results per resolver must be between 1 and 100")
        if not 1 <= self.max_total_results <= 100:
            raise ValueError("max total results must be between 1 and 100")
        profiles = validate_kodi_profiles(self.kodi_profiles)
        for profile in profiles:
            if profile.enabled and profile.worker_timeout_seconds >= self.resolver_timeout_seconds:
                raise ValueError("Kodi worker timeout must be positive and below resolver timeout")
        object.__setattr__(self, "kodi_profiles", profiles)

    @property
    def legacy_kodi_profile(self) -> KodiResolverProfile | None:
        # Compatibility view for the v1.2.1 single-profile settings accessors.
        if self.kodi_resolvers_file is None and len(self.kodi_profiles) == 1:
            profile = self.kodi_profiles[0]
            if profile.id == "kodi_installed":
                return profile
        return None

    @property
    def kodi_resolver_enabled(self) -> bool:
        profile = self.legacy_kodi_profile
        return profile is not None and profile.enabled

    @property
    def kodi_addon_path(self) -> Path | None:
        profile = self.legacy_kodi_profile
        return None if profile is None else profile.addon_path

    @property
    def kodi_module(self) -> str | None:
        profile = self.legacy_kodi_profile
        return None if profile is None else profile.module

    @property
    def kodi_callable(self) -> str:
        profile = self.legacy_kodi_profile
        return "resolve" if profile is None else profile.callable

    @property
    def kodi_addon_id(self) -> str:
        profile = self.legacy_kodi_profile
        return "script.module.local" if profile is None else profile.addon_id

    @property
    def kodi_settings_file(self) -> Path | None:
        profile = self.legacy_kodi_profile
        return None if profile is None else profile.settings_file

    @property
    def kodi_profile_path(self) -> Path | None:
        profile = self.legacy_kodi_profile
        return None if profile is None else profile.profile_path

    @property
    def kodi_worker_timeout_seconds(self) -> float:
        profile = self.legacy_kodi_profile
        return DEFAULT_KODI_WORKER_TIMEOUT_SECONDS if profile is None else profile.worker_timeout_seconds

    @classmethod
    def from_environment(cls) -> "AdapterSettings":
        config_file = _optional_path("PYTHON_ADAPTER_KODI_RESOLVERS_FILE")
        if config_file is not None:
            if any(name.startswith("PYTHON_ADAPTER_KODI_")
                   and name != "PYTHON_ADAPTER_KODI_RESOLVERS_FILE" for name in os.environ):
                raise ValueError("Kodi resolvers file cannot be combined with legacy PYTHON_ADAPTER_KODI_* variables")
            profiles = load_kodi_profiles(config_file)
        else:
            profiles = _legacy_kodi_profiles()
        return cls(
            resolver_timeout_seconds=_positive_float(
                "PYTHON_ADAPTER_RESOLVER_TIMEOUT_SECONDS", DEFAULT_RESOLVER_TIMEOUT_SECONDS
            ),
            request_timeout_seconds=_positive_float(
                "PYTHON_ADAPTER_REQUEST_TIMEOUT_SECONDS", DEFAULT_REQUEST_TIMEOUT_SECONDS
            ),
            max_concurrent_resolvers=_positive_integer(
                "PYTHON_ADAPTER_MAX_CONCURRENT_RESOLVERS", DEFAULT_MAX_CONCURRENT_RESOLVERS
            ),
            max_results_per_resolver=_positive_integer(
                "PYTHON_ADAPTER_MAX_RESULTS_PER_RESOLVER", DEFAULT_MAX_RESULTS_PER_RESOLVER
            ),
            max_total_results=_positive_integer(
                "PYTHON_ADAPTER_MAX_TOTAL_RESULTS", DEFAULT_MAX_TOTAL_RESULTS
            ),
            kodi_profiles=profiles,
            kodi_resolvers_file=config_file,
        )


def _legacy_kodi_profiles() -> tuple[KodiResolverProfile, ...]:
    enabled = _boolean("PYTHON_ADAPTER_KODI_RESOLVER_ENABLED", False)
    addon = _optional_path("PYTHON_ADAPTER_KODI_ADDON_PATH")
    module = _optional_text("PYTHON_ADAPTER_KODI_MODULE")
    callable_name = os.getenv("PYTHON_ADAPTER_KODI_CALLABLE", "resolve").strip()
    addon_id = os.getenv("PYTHON_ADAPTER_KODI_ADDON_ID", "script.module.local").strip()
    timeout = _positive_float("PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS", DEFAULT_KODI_WORKER_TIMEOUT_SECONDS)
    KodiWorkerConfig(
        addon_path=addon or Path("."), module_name=module or "unconfigured",
        callable_name=callable_name, addon_id=addon_id, timeout_seconds=timeout,
    ).validate_structure()
    if addon is None or module is None:
        if enabled:
            raise ValueError("enabled Kodi resolver requires addon path and module")
        return ()
    # Capture legacy P2P values once; workers receive only the profile data block.
    adapter_config = {}
    for suffix, key in (("MODULE", "sourceModule"), ("ID", "sourceId"),
                        ("ENABLED_SETTING", "sourceEnabledSetting"), ("RESPONSE_MODE", "sourceResponseMode")):
        value = os.getenv(f"PYTHON_ADAPTER_KODI_SOURCE_{suffix}")
        if value is not None:
            adapter_config[key] = value.strip().lower() if suffix == "RESPONSE_MODE" else value.strip()
    return (KodiResolverProfile(
        id="kodi_installed", name="Installed Kodi resolver", enabled=enabled,
        addon_path=addon, addon_id=addon_id, module=module, callable=callable_name,
        settings_file=_optional_path("PYTHON_ADAPTER_KODI_SETTINGS_FILE"),
        profile_path=_optional_path("PYTHON_ADAPTER_KODI_PROFILE_PATH"),
        worker_timeout_seconds=timeout, adapter_config=adapter_config,
    ),)


def _positive_float(name: str, fallback: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return fallback
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a positive number") from error
    if not 0 < value <= 300:
        raise ValueError(f"{name} must be between 0 and 300")
    return value


def _positive_integer(name: str, fallback: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return fallback
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _boolean(name: str, fallback: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return fallback
    value = raw.strip().lower()
    if value in {"true", "1", "yes", "on"}:
        return True
    if value in {"false", "0", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def _optional_text(name: str) -> str | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip()


def _optional_path(name: str) -> Path | None:
    value = _optional_text(name)
    return None if value is None else Path(value).expanduser().resolve(strict=False)
