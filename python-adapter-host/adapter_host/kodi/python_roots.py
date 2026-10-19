from __future__ import annotations

from dataclasses import dataclass
import importlib.machinery
from pathlib import Path
import sys


@dataclass(frozen=True, slots=True)
class AddonPythonRoots:
    addon: Path
    roots: tuple[Path, ...]

    @classmethod
    def discover(cls, addon_path: Path) -> "AddonPythonRoots":
        addon = addon_path.resolve(strict=True)
        roots = []
        for relative in ("lib", "resources/lib"):
            candidate = addon / relative
            resolved = candidate.resolve(strict=False)
            # Standard roots cannot redirect, even to another addon directory.
            # Descendant links are checked during module resolution.
            if resolved != candidate:
                raise ValueError("Kodi Python root must not redirect outside its standard location")
            if candidate.is_dir():
                roots.append(resolved)
        if not addon.is_dir() or not roots:
            raise ValueError("Kodi addon path must contain lib or resources/lib")
        return cls(addon, tuple(roots))

    @property
    def import_paths(self) -> tuple[Path, ...]:
        # The addon supplies the resources.lib prefix, but is not a target root.
        parents = (self.addon,) if self.addon / "resources/lib" in self.roots else ()
        return self.roots + parents

    def validate_module(self, name: str) -> tuple[Path, ...]:
        """Resolve the package chain without executing package initializers."""
        # Match actual import precedence, including external regular packages
        # that can shadow local namespace packages; reject their physical origin.
        search = list(sys.path)
        parts = name.split(".")
        for index in range(len(parts)):
            prefix = ".".join(parts[:index + 1])
            # Resolve each component against explicit parent locations. A leaf
            # name also lets PathFinder inspect namespace packages before their
            # parents exist in sys.modules; these specs are never executed.
            spec = importlib.machinery.PathFinder.find_spec(parts[index], search)
            if spec is None:
                raise ValueError("callable target must be installed in an addon Python root")
            final = index == len(parts) - 1
            locations = tuple(Path(path).resolve(strict=True) for path in (spec.submodule_search_locations or ()))
            origin = Path(spec.origin).resolve(strict=True) if spec.origin else None
            if final:
                if origin is None or not any(origin.is_relative_to(root) for root in self.roots):
                    raise ValueError("callable target is outside addon Python roots")
            else:
                # Package ancestors (resources/__init__.py) are allowed only
                # along the chain to a fixed authorized root.
                if not locations or any(not self._package_allowed(path) for path in locations):
                    raise ValueError("callable package is outside addon Python roots")
                if origin is not None and (origin.name != "__init__.py" or origin.parent not in locations):
                    raise ValueError("callable package origin is invalid")
            cached = sys.modules.get(prefix)
            if cached is not None:
                cached_file = getattr(cached, "__file__", None)
                cached_origin = Path(cached_file).resolve(strict=True) if cached_file else None
                cached_paths = tuple(Path(path).resolve(strict=True) for path in getattr(cached, "__path__", ()))
                if cached_origin != origin or cached_paths != locations:
                    raise ValueError("callable module conflicts with an already loaded module")
            search = [str(path) for path in locations]
        return locations

    def _package_allowed(self, path: Path) -> bool:
        return path.is_relative_to(self.addon) and any(
            path.is_relative_to(root) or root.is_relative_to(path) for root in self.roots
        )
