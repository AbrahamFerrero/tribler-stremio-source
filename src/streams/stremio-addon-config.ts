import { readFileSync } from "node:fs";
import type { ContentTypePolicy, PolicyContentType } from "./content-type-policy";

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface StremioAddonConfig {
  id: string;
  name: string;
  manifestUrl: string;
  enabled: boolean;
  contentTypes: ContentTypePolicy;
}

function configuredContentTypes(value: unknown, index: number): ContentTypePolicy {
  if (value === undefined) return Object.freeze({ movie: true, series: true, anime: true });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`addons[${index}].contentTypes must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const keys: PolicyContentType[] = ["movie", "series", "anime"];
  for (const key of Object.keys(entry)) {
    if (!keys.includes(key as PolicyContentType)) {
      throw new Error(`addons[${index}].contentTypes contains an unknown key`);
    }
  }
  for (const key of keys) {
    if (Object.hasOwn(entry, key) && typeof entry[key] !== "boolean") {
      throw new Error(`addons[${index}].contentTypes.${key} must be a boolean`);
    }
  }
  return Object.freeze({ movie: entry.movie !== false, series: entry.series !== false, anime: entry.anime !== false });
}

function configuredManifestUrl(value: unknown, index: number): string {
  if (typeof value !== "string") throw new Error(`addons[${index}].manifestUrl must be an absolute HTTP URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`addons[${index}].manifestUrl must be an absolute HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`addons[${index}].manifestUrl must use HTTP or HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`addons[${index}].manifestUrl must not contain credentials, query parameters or a fragment`);
  }
  if (!url.pathname.endsWith("/manifest.json")) {
    throw new Error(`addons[${index}].manifestUrl must end with /manifest.json`);
  }
  return url.toString();
}

export function loadStremioAddonConfigs(path: string): StremioAddonConfig[] {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read Stremio addon config: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(payload) || payload.length > 32) {
    throw new Error("Stremio addon config must be an array with at most 32 entries");
  }
  const configs = payload.map((raw, index): StremioAddonConfig => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`addons[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !PROVIDER_ID.test(entry.id)) {
      throw new Error(`addons[${index}].id must match ${PROVIDER_ID.source}`);
    }
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 200) {
      throw new Error(`addons[${index}].name must be a non-empty string of at most 200 characters`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new Error(`addons[${index}].enabled must be a boolean`);
    }
    return {
      id: entry.id,
      name: entry.name.trim(),
      manifestUrl: configuredManifestUrl(entry.manifestUrl, index),
      enabled: entry.enabled !== false,
      contentTypes: configuredContentTypes(entry.contentTypes, index)
    };
  });
  const ids = configs.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Stremio addon config contains duplicate ids");
  return configs;
}
