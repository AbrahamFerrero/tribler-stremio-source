from __future__ import annotations

import os
from pathlib import Path
import sys
from typing import Any
def install_filesystem_guard(
    addon_path: Path,
    profile_path: Path,
    settings_file: Path | None,
) -> None:
    """Best-effort Python audit guard; this is not an OS security boundary."""
    read_roots = tuple({
        addon_path.resolve(strict=True),
        profile_path.resolve(strict=True),
        Path(sys.base_prefix).resolve(strict=True),
        Path(__file__).resolve().parents[2],
    })
    exact_reads = {settings_file.resolve(strict=True)} if settings_file is not None else set()
    write_roots = (profile_path.resolve(strict=True),)

    def allowed(path_value: Any, roots: tuple[Path, ...], exact: set[Path] | None = None) -> bool:
        if isinstance(path_value, int):
            return True
        try:
            path = Path(os.fsdecode(path_value)).resolve(strict=False)
        except (TypeError, ValueError, OSError):
            return False
        return (exact is not None and path in exact) or any(path == root or root in path.parents for root in roots)

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.spawn"}:
            raise PermissionError("child processes are disabled in the Kodi worker")
        if event == "open" and args:
            mode = args[1] if len(args) > 1 else "r"
            flags = args[2] if len(args) > 2 else 0
            writing = (isinstance(mode, str) and any(char in mode for char in "wax+")) or (
                isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            )
            roots = write_roots if writing else read_roots
            if not allowed(args[0], roots, None if writing else exact_reads):
                raise PermissionError("filesystem access outside the Kodi worker sandbox")
        if event in {"os.remove", "os.rmdir", "os.mkdir", "os.chdir"} and args:
            if not allowed(args[0], write_roots):
                raise PermissionError("filesystem mutation outside the Kodi worker sandbox")
        if event in {"os.rename", "os.replace"} and len(args) >= 2:
            if not allowed(args[0], write_roots) or not allowed(args[1], write_roots):
                raise PermissionError("filesystem mutation outside the Kodi worker sandbox")

    sys.addaudithook(audit)
