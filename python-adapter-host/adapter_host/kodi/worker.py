from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import importlib
import json
from pathlib import Path
import re
import sys
from typing import Any

from .compat import install
from .protocol import (
    MAX_INPUT_BYTES,
    MAX_OUTPUT_BYTES,
    ProtocolError,
    decode_request,
    encode_message,
    error_response,
    success_response,
)
from .sandbox import install_filesystem_guard
from .python_roots import AddonPythonRoots


class _StderrProxy:
    _url = re.compile(r"(?:https?|magnet):\S+", re.IGNORECASE)
    _secret = re.compile(r"(?i)(token|cookie|authorization|password|api[_-]?key)\s*[:=]\s*\S+")

    def write(self, value: str) -> int:
        cleaned = self._url.sub("<url>", str(value))
        cleaned = self._secret.sub(r"\1=<redacted>", cleaned)
        return sys.stderr.write(cleaned[:2_000])

    def flush(self) -> None:
        sys.stderr.flush()


def main() -> int:
    try:
        arguments = _arguments()
        addon_path = Path(arguments.addon_path).resolve(strict=True)
        profile_path = Path(arguments.profile_path).resolve(strict=False)
        python_roots = AddonPythonRoots.discover(addon_path)
        profile_path.mkdir(parents=True, exist_ok=True)
        profile_path = profile_path.resolve(strict=True)
        settings_path = Path(arguments.settings_file).resolve(strict=True) if arguments.settings_file else None
        settings = _load_settings(settings_path)
        raw_request = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        request = decode_request(raw_request)
        install(arguments.addon_id, addon_path, profile_path, settings)
        install_filesystem_guard(addon_path, profile_path, settings_path)
        sys.path[:0] = [str(path) for path in python_roots.import_paths]
        with redirect_stdout(_StderrProxy()):
            module = importlib.import_module(arguments.module)
            operation = getattr(module, arguments.callable, None)
            if not callable(operation):
                raise ProtocolError("configured callable is unavailable")
            if arguments.evaluation_source is None:
                results = operation(request["media"])
                response = success_response(results, arguments.maximum_results)
            else:
                # Only these fixed, project-owned adapters expose local evaluation.
                from .adapters.source_pack import ADAPTER_MODULE, SourcePackAdapter
                from .adapters.external_scraper_package import ExternalScraperPackageAdapter
                adapters = {ADAPTER_MODULE: SourcePackAdapter,
                            "adapter_host.kodi.adapters.external_scraper_package": ExternalScraperPackageAdapter}
                if arguments.module not in adapters or arguments.callable != "resolve":
                    raise ProtocolError("evaluation adapter unavailable")
                adapter = adapters[arguments.module]()
                if arguments.evaluation_source == "*":
                    response = {"ok": True, "sourceIds": adapter.source_ids()}
                else:
                    results = adapter.resolve_source(request["media"], arguments.evaluation_source)
                    response = success_response(results, arguments.maximum_results)
        encoded = encode_message(response, MAX_OUTPUT_BYTES)
    except ProtocolError:
        encoded = encode_message(error_response("invalid_output"), MAX_OUTPUT_BYTES)
    except PermissionError:
        encoded = encode_message(error_response("sandbox_violation"), MAX_OUTPUT_BYTES)
    except Exception:
        encoded = encode_message(error_response("module_error"), MAX_OUTPUT_BYTES)
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    return 0


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--addon-path", required=True)
    parser.add_argument("--profile-path", required=True)
    parser.add_argument("--addon-id", required=True)
    parser.add_argument("--module", required=True)
    parser.add_argument("--callable", required=True)
    parser.add_argument("--settings-file")
    parser.add_argument("--maximum-results", type=int, required=True)
    parser.add_argument("--evaluation-source")
    return parser.parse_args()


def _load_settings(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    if path.stat().st_size > 16_384:
        raise ProtocolError("settings file exceeds limit")
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or len(value) > 256:
        raise ProtocolError("settings must be an object")
    result: dict[str, str] = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not isinstance(entry, str) or not key or len(key) > 256 or len(entry) > 8_192:
            raise ProtocolError("invalid setting")
        result[key] = entry
    return result


if __name__ == "__main__":
    raise SystemExit(main())
