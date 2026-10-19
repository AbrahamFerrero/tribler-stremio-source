import { existsSync, readFileSync } from "node:fs";
import type { AppConfig } from "../types";
import { ConfiguredMagnetCatalogProvider } from "./configured-provider";
import { InternetArchiveCatalogProvider } from "./internet-archive-provider";
import { JsonCatalogProvider, type JsonFieldMapping } from "./json-provider";
import type { CatalogMediaType, CatalogProvider } from "./types";
import type { ExternalUrlPolicy } from "../network/url-policy";

interface SourceFile {
  version?: unknown;
  providers?: unknown;
}

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, description: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${description} must be a non-empty string`);
  return value.trim();
}

function integerValue(value: unknown, description: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${description} must be a positive integer`);
  return Number(value);
}

function mediaType(value: unknown, description: string): CatalogMediaType {
  if (value === undefined || value === "movie") return "movie";
  if (value === "series") return "series";
  throw new Error(`${description} must be movie or series`);
}

function stringMap(value: unknown, description: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, description);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = stringValue(entry, `${description}.${key}`);
  }
  return result;
}

function legacyProviders(config: AppConfig, urlPolicy?: ExternalUrlPolicy): CatalogProvider[] {
  if (config.catalogProvider === "configured") {
    if (!config.legalTestMagnet) {
      throw new Error("LEGAL_TEST_MAGNET is required when CATALOG_PROVIDER=configured");
    }
    return [new ConfiguredMagnetCatalogProvider(config.legalTestMagnet)];
  }
  return [new InternetArchiveCatalogProvider({
    query: config.catalogQuery,
    pageSize: config.catalogPageSize,
    cacheTtlMs: config.catalogCacheTtlMs,
    requestTimeoutMs: config.catalogRequestTimeoutMs,
    httpStreamsEnabled: config.archiveHttpStreams,
    ...(urlPolicy ? { urlPolicy } : {})
  })];
}

function configuredProviders(config: AppConfig, file: SourceFile, urlPolicy?: ExternalUrlPolicy): CatalogProvider[] {
  if (file.version !== 1) throw new Error("Catalog sources file version must be 1");
  if (!Array.isArray(file.providers)) throw new Error("Catalog sources file must contain a providers array");
  const providers: CatalogProvider[] = [];
  let internetArchiveCount = 0;

  for (const [index, raw] of file.providers.entries()) {
    const entry = objectValue(raw, `providers[${index}]`);
    if (entry.enabled === false) continue;
    const kind = stringValue(entry.kind, `providers[${index}].kind`);
    if (kind === "internet-archive") {
      internetArchiveCount += 1;
      if (internetArchiveCount > 1) {
        throw new Error("Only one internet-archive provider can be enabled; use json providers for additional APIs");
      }
      providers.push(new InternetArchiveCatalogProvider({
        query: stringValue(entry.query, `providers[${index}].query`, config.catalogQuery),
        pageSize: integerValue(entry.pageSize, `providers[${index}].pageSize`, config.catalogPageSize),
        cacheTtlMs: integerValue(entry.cacheTtlMs, `providers[${index}].cacheTtlMs`, config.catalogCacheTtlMs),
        requestTimeoutMs: integerValue(
          entry.requestTimeoutMs,
          `providers[${index}].requestTimeoutMs`,
          config.catalogRequestTimeoutMs
        ),
        httpStreamsEnabled: entry.httpStreamsEnabled === undefined
          ? config.archiveHttpStreams
          : entry.httpStreamsEnabled === true,
        ...(urlPolicy ? { urlPolicy } : {})
      }));
      continue;
    }
    if (kind !== "json" && kind !== "static") {
      throw new Error(`providers[${index}].kind must be internet-archive, json or static`);
    }
    const id = stringValue(entry.id, `providers[${index}].id`);
    const name = stringValue(entry.name, `providers[${index}].name`);
    const catalogUrl = kind === "json"
      ? stringValue(entry.catalogUrl, `providers[${index}].catalogUrl`)
      : undefined;
    let items: unknown[] | undefined;
    if (kind === "static") {
      if (!Array.isArray(entry.items)) throw new Error(`providers[${index}].items must be an array`);
      items = entry.items;
    }
    const fieldMapping = stringMap(entry.mapping, `providers[${index}].mapping`) as JsonFieldMapping | undefined;
    const headersFromEnv = stringMap(entry.headersFromEnv, `providers[${index}].headersFromEnv`);
    providers.push(new JsonCatalogProvider({
      id,
      name,
      type: mediaType(entry.type, `providers[${index}].type`),
      ...(catalogUrl ? { catalogUrl } : {}),
      ...(typeof entry.itemUrl === "string" ? { itemUrl: entry.itemUrl } : {}),
      ...(typeof entry.itemsPath === "string" ? { itemsPath: entry.itemsPath } : {}),
      ...(typeof entry.itemPath === "string" ? { itemPath: entry.itemPath } : {}),
      ...(fieldMapping ? { mapping: fieldMapping } : {}),
      ...(headersFromEnv ? { headersFromEnv } : {}),
      ...(items ? { items } : {}),
      pageSize: integerValue(entry.pageSize, `providers[${index}].pageSize`, config.catalogPageSize),
      cacheTtlMs: integerValue(entry.cacheTtlMs, `providers[${index}].cacheTtlMs`, config.catalogCacheTtlMs),
      requestTimeoutMs: integerValue(
        entry.requestTimeoutMs,
        `providers[${index}].requestTimeoutMs`,
        config.catalogRequestTimeoutMs
      ),
      ...(urlPolicy ? { urlPolicy } : {})
    }));
  }
  if (providers.length === 0) throw new Error("Catalog sources file has no enabled providers");
  const ids = providers.map((provider) => provider.definition.id);
  if (new Set(ids).size !== ids.length) throw new Error("Enabled catalog provider ids must be unique");
  return providers;
}

export function createCatalogProviders(config: AppConfig, urlPolicy?: ExternalUrlPolicy): CatalogProvider[] {
  const path = config.catalogSourcesFile;
  if (!path || !existsSync(path)) return legacyProviders(config, urlPolicy);
  let payload: SourceFile;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as SourceFile;
  } catch (error) {
    throw new Error(`Could not read catalog sources file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return configuredProviders(config, payload, urlPolicy);
}

export function createCatalogProvider(config: AppConfig): CatalogProvider {
  return createCatalogProviders(config)[0] as CatalogProvider;
}
