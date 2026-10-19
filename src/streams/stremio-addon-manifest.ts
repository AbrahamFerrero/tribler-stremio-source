export interface StreamResourceCapabilities {
  types: string[];
  idPrefixes?: string[];
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

function arrayOfStrings(value: unknown, field: string, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((entry) =>
    typeof entry !== "string" || !entry || entry.length > 200 || hasControlCharacters(entry)
  )) {
    throw new Error(`Stremio addon manifest ${field} are invalid`);
  }
  return [...new Set(value as string[])];
}

function optionalPrefixes(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) =>
    typeof entry !== "string" || entry.length > 200 || hasControlCharacters(entry)
  )) {
    throw new Error(`Stremio addon manifest ${field} are invalid`);
  }
  return [...new Set(value as string[])];
}

export function parseStreamResourceCapabilities(payload: unknown): StreamResourceCapabilities {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Stremio addon manifest schema is invalid");
  }
  const manifest = payload as Record<string, unknown>;
  if (typeof manifest.id !== "string" || !manifest.id || typeof manifest.name !== "string" || !manifest.name ||
    typeof manifest.description !== "string" || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Stremio addon manifest schema is invalid");
  }
  const manifestTypes = arrayOfStrings(manifest.types, "types");
  const manifestPrefixes = optionalPrefixes(manifest.idPrefixes, [], "idPrefixes");
  if (!Array.isArray(manifest.resources) || manifest.resources.length > 100) {
    throw new Error("Stremio addon manifest resources are invalid");
  }
  for (const raw of manifest.resources) {
    if (raw === "stream") {
      return {
        types: manifestTypes,
        ...(manifestPrefixes.length > 0 ? { idPrefixes: manifestPrefixes } : {})
      };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const resource = raw as Record<string, unknown>;
    if (resource.name !== "stream") continue;
    const types = resource.types === undefined
      ? manifestTypes
      : arrayOfStrings(resource.types, "stream resource types");
    const prefixes = optionalPrefixes(resource.idPrefixes, manifestPrefixes, "stream resource idPrefixes");
    return { types, ...(prefixes.length > 0 ? { idPrefixes: prefixes } : {}) };
  }
  throw new Error("Stremio addon manifest does not declare the stream resource");
}
