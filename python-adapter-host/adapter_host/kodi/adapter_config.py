from __future__ import annotations

from collections.abc import Mapping
import json
import math
import re
from types import MappingProxyType
from typing import Any

MAX_ADAPTER_CONFIG_BYTES = 4_096
MAX_ADAPTER_CONFIG_DEPTH = 4
MAX_ADAPTER_CONFIG_ITEMS = 128
WORKER_PROFILE_CONFIG_ENV = "PYTHON_ADAPTER_KODI_PROFILE_CONFIG"
_SECRET_NAME = re.compile(r"(?i)(secret|password|credential|cookie|authorization|api[_-]?key|token)")


def is_secret_name(name: str) -> bool:
    return bool(_SECRET_NAME.search(name)) or name.upper() in {"TRIBLER_API_KEY", "TRIBLER_URL"}


def _bounded_json_data(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("Kodi adapterConfig must be an object")
    remaining = MAX_ADAPTER_CONFIG_ITEMS

    def copy_json(item: Any, depth: int) -> Any:
        nonlocal remaining
        remaining -= 1
        if remaining < 0:
            raise ValueError("Kodi adapterConfig has too many items")
        if isinstance(item, Mapping) or isinstance(item, (list, tuple)):
            if depth > MAX_ADAPTER_CONFIG_DEPTH:
                raise ValueError("Kodi adapterConfig is too deeply nested")
            if isinstance(item, Mapping):
                result = {}
                for key, child in item.items():
                    if not isinstance(key, str):
                        raise ValueError("Kodi adapterConfig keys must be strings")
                    if is_secret_name(key):
                        raise ValueError("Kodi adapterConfig must not contain credential fields")
                    remaining -= 1
                    result[key] = copy_json(child, depth + 1)
                return result
            return [copy_json(child, depth + 1) for child in item]
        if item is None or type(item) in (bool, int, str):
            return item
        if type(item) is float and math.isfinite(item):
            return item
        raise ValueError("Kodi adapterConfig must contain only JSON data")

    data = copy_json(value, 1)
    try:
        encoded = json.dumps(data, separators=(",", ":"), sort_keys=True, allow_nan=False)
    except ValueError:
        raise ValueError("Kodi adapterConfig must contain only bounded JSON data") from None
    if len(encoded.encode("utf-8")) > MAX_ADAPTER_CONFIG_BYTES:
        raise ValueError("Kodi adapterConfig is too large")

    return data


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Kodi configuration contains duplicate object keys")
        result[key] = value
    return result


def reject_json_constant(value: str) -> Any:
    raise ValueError("Kodi configuration must contain finite JSON numbers")


def freeze_adapter_config(value: Mapping[str, Any]) -> Mapping[str, Any]:
    data = _bounded_json_data(value)

    def freeze(item: Any) -> Any:
        if isinstance(item, dict):
            return MappingProxyType({key: freeze(child) for key, child in item.items()})
        if isinstance(item, list):
            return tuple(freeze(child) for child in item)
        return item

    return freeze(data)


def encode_adapter_config(value: Mapping[str, Any]) -> str:
    """Serialize bounded startup data deterministically, never truncating it."""
    data = _bounded_json_data(value)
    return json.dumps(data, separators=(",", ":"), sort_keys=True, allow_nan=False)


def decode_adapter_config(raw: str | None) -> Mapping[str, Any]:
    """Read the worker's data block; missing or invalid data fails closed."""
    if raw is None:
        raise ValueError("Kodi worker profile configuration is missing")
    try:
        if len(raw.encode("utf-8")) > MAX_ADAPTER_CONFIG_BYTES:
            raise ValueError("Kodi worker profile configuration is too large")
        data = json.loads(raw, object_pairs_hook=unique_json_object, parse_constant=reject_json_constant)
        return freeze_adapter_config(data)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("Kodi worker profile configuration is invalid") from None
