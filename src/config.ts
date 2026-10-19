import { isIP } from "node:net";
import { authorityStatus, validateAdminToken } from "./local-request-policy";
import { resolve } from "node:path";
import type { AppConfig } from "./types";
import { loadStreamRankingPolicy } from "./streams/ranking-policy";
import { parseSourceHeaderRules } from "./network/http-privacy";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function bufferMiB(name: string, fallback: number): number {
  const mib = positiveInteger(name, fallback);
  if (mib > 512) throw new Error(`${name} must be at most 512 MiB`);
  return mib * 1024 * 1024;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function commaList(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback).split(",").map((value) => value.trim()).filter(Boolean);
}

function catalogProvider(): AppConfig["catalogProvider"] {
  const value = process.env.CATALOG_PROVIDER ?? "internet-archive";
  if (value === "internet-archive" || value === "configured") return value;
  throw new Error("CATALOG_PROVIDER must be internet-archive or configured");
}

function torrentSafetyMode(): AppConfig["torrentSafetyMode"] {
  const value = process.env.TORRENT_SAFETY_MODE ?? "balanced";
  if (value === "balanced" || value === "fast") return value;
  throw new Error("TORRENT_SAFETY_MODE must be balanced or fast");
}

function downloadRetentionMode(): AppConfig["downloadRetentionMode"] {
  const value = process.env.DOWNLOAD_RETENTION_MODE ?? "smart";
  if (value === "smart" || value === "ephemeral" || value === "keep_all") return value;
  throw new Error("DOWNLOAD_RETENTION_MODE must be smart, ephemeral or keep_all");
}

function httpPrivacy(): AppConfig["httpPrivacy"] {
  const mode = process.env.HTTP_PRIVACY_MODE ?? "strict";
  if (mode !== "strict") throw new Error("HTTP_PRIVACY_MODE must be strict");
  const rawUserAgentMode = process.env.HTTP_PRIVACY_USER_AGENT ?? "minimal";
  if (rawUserAgentMode !== "minimal" && rawUserAgentMode !== "default" && rawUserAgentMode !== "custom") {
    throw new Error("HTTP_PRIVACY_USER_AGENT must be minimal, default or custom");
  }
  const customUserAgent = process.env.HTTP_PRIVACY_CUSTOM_USER_AGENT?.trim();
  if (rawUserAgentMode === "custom" && (
    !customUserAgent || customUserAgent.length > 256 || /[\r\n]/.test(customUserAgent)
  )) {
    throw new Error("HTTP_PRIVACY_CUSTOM_USER_AGENT is required and must be at most 256 characters");
  }
  if (booleanValue("HTTP_PRIVACY_SEND_REFERER", false)) {
    throw new Error("HTTP_PRIVACY_SEND_REFERER is not supported in strict mode");
  }
  if (booleanValue("HTTP_PRIVACY_ACCEPT_COOKIES", false)) {
    throw new Error("HTTP_PRIVACY_ACCEPT_COOKIES is not supported in strict mode");
  }
  const dnsMode = process.env.DNS_MODE ?? "system";
  if (dnsMode !== "system") throw new Error("DNS_MODE must be system");
  if (process.env.DNS_DOH_ENDPOINT?.trim()) {
    throw new Error("DNS_DOH_ENDPOINT cannot be used until DNS_MODE=doh is implemented");
  }
  return {
    mode,
    transport: "direct",
    dnsMode,
    sendReferer: false,
    acceptCookies: false,
    userAgentMode: rawUserAgentMode,
    ...(customUserAgent ? { customUserAgent } : {}),
    maxRedirects: 3,
    ...(process.env.HTTP_SOURCE_HEADER_RULES !== undefined ? { sourceHeaderRules: (() => {
      try { return parseSourceHeaderRules(JSON.parse(process.env.HTTP_SOURCE_HEADER_RULES)); }
      catch { throw new Error("Invalid HTTP_SOURCE_HEADER_RULES"); }
    })() } : {})
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}

function localUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHostname(url.hostname)) {
    throw new Error(`${name} must use http(s) and a loopback host (localhost, 127.0.0.0/8 or ::1)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or a fragment; use TRIBLER_API_KEY instead`);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(): AppConfig {
  const triblerRaw = process.env.TRIBLER_URL;
  if (!triblerRaw) {
    throw new Error("TRIBLER_URL is required (for example http://127.0.0.1:52194)");
  }
  const port = positiveInteger("BRIDGE_PORT", 7000);
  if (port > 65_535) throw new Error("BRIDGE_PORT must be at most 65535");
  const catalogPageSize = positiveInteger("CATALOG_PAGE_SIZE", 50);
  if (catalogPageSize > 100) throw new Error("CATALOG_PAGE_SIZE must be at most 100");
  const publicBaseUrl = localUrl(
    "PUBLIC_BASE_URL",
    process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`
  );
  const rawPublic = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
  const publicMatch = /^http:\/\/([^/]+)\/?$/.exec(rawPublic);
  if (!publicMatch || authorityStatus(publicMatch[1]!, port) !== 200) {
    throw new Error("PUBLIC_BASE_URL must use HTTP, localhost or 127.0.0.1, the BRIDGE_PORT and a root path");
  }
  const bridgeAdminToken = process.env.BRIDGE_ADMIN_TOKEN;
  validateAdminToken(bridgeAdminToken);
  const selectedCatalogProvider = catalogProvider();
  const startupBytes = bufferMiB("TRIBLER_STREAM_STARTUP_BUFFER_MIB", 8);
  const seekBytes = bufferMiB("TRIBLER_STREAM_SEEK_BUFFER_MIB", 4);
  const maxBytes = bufferMiB("TRIBLER_STREAM_MAX_BUFFER_MIB", 64);
  if (startupBytes > maxBytes) throw new Error("TRIBLER_STREAM_STARTUP_BUFFER_MIB must not exceed TRIBLER_STREAM_MAX_BUFFER_MIB");
  if (seekBytes > maxBytes) throw new Error("TRIBLER_STREAM_SEEK_BUFFER_MIB must not exceed TRIBLER_STREAM_MAX_BUFFER_MIB");

  return {
    host: "127.0.0.1",
    port,
    publicBaseUrl,
    ...(bridgeAdminToken !== undefined ? { bridgeAdminToken } : {}),
    triblerUrl: localUrl("TRIBLER_URL", triblerRaw),
    triblerApiKey: process.env.TRIBLER_API_KEY ?? "",
    triblerAutoDiscover: booleanValue("TRIBLER_AUTO_DISCOVER", false),
    torrentSafetyMode: torrentSafetyMode(),
    archiveHttpStreams: booleanValue("ARCHIVE_HTTP_STREAMS", true),
    catalogProvider: selectedCatalogProvider,
    ...(selectedCatalogProvider !== "configured" || process.env.CATALOG_SOURCES_FILE
      ? { catalogSourcesFile: resolve(process.cwd(), process.env.CATALOG_SOURCES_FILE ?? "config/catalog-sources.local.json") }
      : {}),
    catalogQuery: process.env.CATALOG_QUERY
      ?? 'mediatype:movies AND format:"Archive BitTorrent" AND (collection:feature_films OR collection:animationandcartoons)',
    catalogPageSize,
    catalogCacheTtlMs: positiveInteger("CATALOG_CACHE_TTL_MS", 5 * 60 * 1_000),
    catalogRequestTimeoutMs: positiveInteger("CATALOG_REQUEST_TIMEOUT_MS", 15_000),
    directHttpTimeoutMs: positiveInteger("DIRECT_HTTP_TIMEOUT_MS", 8_000),
    directHttpProbe: {
      enabled: booleanValue("DIRECT_HTTP_PROBE_ENABLED", false),
      timeoutMs: positiveInteger("DIRECT_HTTP_PROBE_TIMEOUT_MS", 4_000),
      maxCandidates: positiveInteger("DIRECT_HTTP_PROBE_MAX_CANDIDATES", 8),
      maxConcurrent: positiveInteger("DIRECT_HTTP_PROBE_MAX_CONCURRENT", 3)
    },
    streamRankingPolicy: loadStreamRankingPolicy(process.env.STREAM_RANKING_CONFIG_FILE?.trim() || undefined),
    httpPrivacy: httpPrivacy(),
    httpStreamTokenTtlMs: positiveInteger("HTTP_STREAM_TOKEN_TTL_SECONDS", 3_600) * 1_000,
    httpStreamTokenMaxEntries: positiveInteger("HTTP_STREAM_TOKEN_MAX_ENTRIES", 1_000),
    streamProviders: commaList("STREAM_PROVIDERS", "catalog,manual"),
    streamProviderTimeoutMs: positiveInteger("STREAM_PROVIDER_TIMEOUT_MS", 5_000),
    streamProviderMaxConcurrent: positiveInteger("STREAM_PROVIDER_MAX_CONCURRENT", 8),
    externalStreamProviderEnabled: booleanValue("STREAM_PROVIDER_EXTERNAL_ENABLED", false),
    ...(process.env.STREAM_PROVIDER_EXTERNAL_URL
      ? { externalStreamProviderUrl: process.env.STREAM_PROVIDER_EXTERNAL_URL }
      : {}),
    externalStreamProviderTimeoutMs: positiveInteger("STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS", 10_000),
    ...(process.env.STREAM_PROVIDER_STREMIO_ADDONS_FILE
      ? { stremioAddonProvidersFile: resolve(process.cwd(), process.env.STREAM_PROVIDER_STREMIO_ADDONS_FILE) }
      : {}),
    ...(process.env.STREMIO_MOVIE_METADATA_BASE_URL?.trim()
      ? { stremioMovieMetadataBaseUrl: process.env.STREMIO_MOVIE_METADATA_BASE_URL.trim() }
      : {}),
    stremioAddonManifestTtlMs: positiveInteger("STREMIO_ADDON_MANIFEST_TTL_MS", 15 * 60 * 1_000),
    stremioAddonRequestTimeoutMs: positiveInteger("STREMIO_ADDON_REQUEST_TIMEOUT_MS", 5_000),
    ...(process.env.STREAM_PROVIDER_LOCAL_JSON_FILE
      ? { localStreamJsonFile: resolve(process.cwd(), process.env.STREAM_PROVIDER_LOCAL_JSON_FILE) }
      : {}),
    localStreamJsonDirectory: resolve(process.cwd(), process.env.STREAM_PROVIDER_LOCAL_JSON_DIRECTORY ?? "."),
    ...(process.env.LEGAL_TEST_MAGNET ? { legalTestMagnet: process.env.LEGAL_TEST_MAGNET } : {}),
    metadataTimeoutMs: positiveInteger("METADATA_TIMEOUT_MS", 90_000),
    noSeedsTimeoutMs: positiveInteger("NO_SEEDS_TIMEOUT_MS", 30_000),
    pollIntervalMs: positiveInteger("POLL_INTERVAL_MS", 1_000),
    streamHeaderTimeoutMs: positiveInteger("STREAM_HEADER_TIMEOUT_MS", 30_000),
    triblerStreamBuffer: {
      enabled: booleanValue("TRIBLER_STREAM_BUFFER_ENABLED", true), startupBytes, seekBytes, maxBytes,
      prebufferTimeoutMs: positiveInteger("TRIBLER_STREAM_PREBUFFER_TIMEOUT_MS", 15_000)
    },
    downloadRetentionMode: downloadRetentionMode(),
    cleanupIntervalMs: positiveInteger("CLEANUP_INTERVAL_MS", 60 * 1_000),
    cleanupRemoveData: booleanValue("CLEANUP_REMOVE_DATA", true),
    managedDownloadsStateFile: resolve(process.cwd(), ".bridge-state", "managed-downloads.json")
  };
}
