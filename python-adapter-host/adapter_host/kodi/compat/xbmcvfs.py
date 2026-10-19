from __future__ import annotations

import builtins
from pathlib import Path
import shutil

from . import runtime
# Filename sanitization is unsupported; this API fails closed.
from .unavailable import denied as makeLegalFilename


def translatePath(path: str) -> str:
    return str(runtime.translate(path))


def exists(path: str) -> bool:
    return runtime.translate(path).exists()


def listdir(path: str) -> tuple[list[str], list[str]]:
    directories, files = [], []
    for entry in sorted(runtime.translate(path).iterdir()):
        # Validate each target too, including symlinks leaving the authorized roots.
        resolved = runtime.translate(str(entry))
        (directories if resolved.is_dir() else files).append(entry.name)
    return directories, files


class File:
    def __init__(self, path: str, mode: str = "r") -> None:
        if mode not in {"r", "rb", "w", "wb", "a", "ab"}:
            raise ValueError("unsupported file mode")
        resolved = runtime.translate(path) if mode.startswith("r") else runtime.writable(path)
        if not mode.startswith("r"):
            resolved.parent.mkdir(parents=True, exist_ok=True)
        self._file = builtins.open(resolved, mode)

    def read(self, *args: object) -> object:
        return self._file.read(*args)

    def write(self, value: object) -> object:
        return self._file.write(value)  # type: ignore[arg-type]

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> "File":
        return self

    def __exit__(self, *args: object) -> None:
        del args
        self.close()


def mkdir(path: str) -> bool:
    runtime.writable(path).mkdir(exist_ok=True)
    return True


def mkdirs(path: str) -> bool:
    runtime.writable(path).mkdir(parents=True, exist_ok=True)
    return True


def delete(path: str) -> bool:
    target = runtime.writable(path)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return True


def rename(source: str, target: str) -> bool:
    source_path = runtime.writable(source)
    target_path = runtime.writable(target)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.replace(target_path)
    return True


def rmdir(path: str) -> bool:
    runtime.writable(path).rmdir()
    return True
