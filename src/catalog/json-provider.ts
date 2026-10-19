import { TimedCache } from "./cache";
import { normalizeTorrentSource } from "../source";
import { isVideoFile } from "../video-selection";
import { fetchWithValidatedRedirects, type ExternalUrlPolicy } from "../network/url-policy";
import { readLimitedJson } from "../network/limited-json";
import type {
  CatalogDefinition,
  CatalogItem,
  CatalogMediaType,
  CatalogProvider,
  CatalogRequest,
  DirectStreamSource
} from "./types";

export interface JsonFieldMapping {
  id?: string;
  name?: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string;
  kind?: string;
  season?: string;
  episode?: string;
  externalIds?: string;
  classifications?: string;
  stremioType?: string;
  stremioVideoId?: string;
  torrent?: string;
  streams?: string;
  streamUrl?: string;
  streamFileName?: string;
  streamSize?: string;
  streamWidth?: string;
  streamHeight?: string;
  streamFormat?: string;
  streamSource?: string;
}

export interface JsonCatalogProviderOptions {
  id: string;
  name: string;
  type: CatalogMediaType;
  catalogUrl?: string;
  itemUrl?: string;
  itemsPath?: string;
  itemPath?: string;
  mapping?: JsonFieldMapping;
  headersFromEnv?: Record<string, string>;
  items?: unknown[];
  pageSize: number;
  cacheTtlMs: number;
  requestTimeoutMs: number;
  fetchImplementation?: typeof fetch;
  urlPolicy?: ExternalUrlPolicy;
}

interface NormalizedRecord {
  externalId: string;
  item: CatalogItem;
  torrentSource?: string;
  streams: DirectStreamSource[];
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);
const DEFAULT_MAPPING: Required<JsonFieldMapping> = {
  id: "id",
  name: "name",
  poster: "poster",
  background: "background",
  description: "description",
  releaseInfo: "releaseInfo",
  genres: "genres",
  kind: "kind",
  season: "season",
  episode: "episode",
  externalIds: "externalIds",
  classifications: "classifications",
  stremioType: "stremio.type",
  stremioVideoId: "stremio.videoId",
  torrent: "torrent",
  streams: "streams",
  streamUrl: "url",
  streamFileName: "fileName",
  streamSize: "size",
  streamWidth: "width",
  streamHeight: "height",
  streamFormat: "format",
  streamSource: "source"
};

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split(".")) {
    if (!part || FORBIDDEN_PATH_PARTS.has(part) || typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result ? result.slice(0, maxLength) : undefined;
}

function numberValue(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = stringValue(value, 8_192);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function genresValue(value: unknown): string[] | undefined {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const result = input
    .map((entry) => stringValue(entry, 120))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 20);
  return result.length > 0 ? result : undefined;
}

function externalIdsValue(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([namespace, raw]) => {
    const id = stringValue(raw, 2_048);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace) || !id ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,2047}$/.test(id)) return [];
    return [[namespace, id] as const];
  }).slice(0, 30);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function replaceTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(id|type|skip|search|limit)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? "")
  );
}

function requestUrl(template: string, request: CatalogRequest, pageSize: number): string {
  const values = {
    id: "",
    type: request.type,
    skip: String(request.skip),
    search: request.search ?? "",
    limit: String(pageSize)
  };
  const expanded = replaceTemplate(template, values);
  const url = new URL(expanded);
  if (!template.includes("{type}")) url.searchParams.set("type", request.type);
  if (!template.includes("{skip}")) url.searchParams.set("skip", String(request.skip));
  if (!template.includes("{limit}")) url.searchParams.set("limit", String(pageSize));
  if (request.search && !template.includes("{search}")) url.searchParams.set("search", request.search);
  return url.toString();
}

export class JsonCatalogProvider implements CatalogProvider {
  readonly definition: CatalogDefinition;
  private readonly prefix: string;
  private readonly mapping: Required<JsonFieldMapping>;
  private readonly fetchImplementation: typeof fetch | undefined;
  private readonly headers: Record<string, string>;
  private readonly authenticated: boolean;
  private readonly cache: TimedCache<NormalizedRecord>;
  private readonly staticRecords = new Map<string, NormalizedRecord>();

  constructor(private readonly options: JsonCatalogProviderOptions) {
    if (!PROVIDER_ID.test(options.id)) {
      throw new Error(`Catalog id ${options.id} must match ${PROVIDER_ID.source}`);
    }
    if (!options.catalogUrl && !options.items) {
      throw new Error(`Catalog ${options.id} requires catalogUrl or items`);
    }
    this.definition = {
      id: options.id,
      type: options.type,
      name: options.name,
      supportsSearch: true
    };
    this.prefix = `tribler:source:${options.id}:`;
    this.mapping = { ...DEFAULT_MAPPING, ...options.mapping };
    this.fetchImplementation = options.fetchImplementation;
    this.cache = new TimedCache(options.cacheTtlMs);
    this.headers = { Accept: "application/json", "Accept-Encoding": "identity" };
    this.authenticated = Object.keys(options.headersFromEnv ?? {}).length > 0;
    for (const [header, environmentName] of Object.entries(options.headersFromEnv ?? {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) {
        throw new Error(`Catalog ${options.id} contains an invalid HTTP header name`);
      }
      const value = process.env[environmentName];
      if (!value) throw new Error(`Catalog ${options.id} requires environment variable ${environmentName}`);
      this.headers[header] = value;
    }
    for (const raw of options.items ?? []) {
      const record = this.normalize(raw);
      if (record) this.staticRecords.set(record.externalId, record);
    }
  }

  owns(stremioId: string): boolean {
    if (!stremioId.startsWith(this.prefix)) return false;
    try {
      return this.encodeId(this.decodeId(stremioId)) === stremioId;
    } catch {
      return false;
    }
  }

  private encodeId(externalId: string): string {
    return `${this.prefix}${Buffer.from(externalId, "utf8").toString("base64url")}`;
  }

  private decodeId(stremioId: string): string {
    if (!stremioId.startsWith(this.prefix)) throw new Error("Item does not belong to this catalog");
    const token = stremioId.slice(this.prefix.length);
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) throw new Error("Invalid catalog item id");
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (!decoded) throw new Error("Invalid catalog item id");
    return decoded;
  }

  private normalize(raw: unknown): NormalizedRecord | undefined {
    const externalId = stringValue(readPath(raw, this.mapping.id), 1_024);
    const name = stringValue(readPath(raw, this.mapping.name), 300);
    if (!externalId || !name) return undefined;
    const poster = safeHttpUrl(readPath(raw, this.mapping.poster));
    const background = safeHttpUrl(readPath(raw, this.mapping.background));
    const description = stringValue(readPath(raw, this.mapping.description), 4_000);
    const releaseInfo = stringValue(readPath(raw, this.mapping.releaseInfo), 64);
    const genres = genresValue(readPath(raw, this.mapping.genres));
    const kindValue = stringValue(readPath(raw, this.mapping.kind), 20);
    const kind = kindValue === "movie" || kindValue === "series" || kindValue === "episode"
      ? kindValue
      : undefined;
    const season = numberValue(readPath(raw, this.mapping.season));
    const episode = numberValue(readPath(raw, this.mapping.episode));
    const externalIds = externalIdsValue(readPath(raw, this.mapping.externalIds));
    const classifications = genresValue(readPath(raw, this.mapping.classifications));
    const stremioType = stringValue(readPath(raw, this.mapping.stremioType), 64);
    const stremioVideoId = stringValue(readPath(raw, this.mapping.stremioVideoId), 2_048);
    const torrentRaw = stringValue(readPath(raw, this.mapping.torrent), 16_384);
    let torrentSource: string | undefined;
    if (torrentRaw) {
      try {
        torrentSource = normalizeTorrentSource(torrentRaw);
      } catch {
        torrentSource = undefined;
      }
    }
    const streamValues = readPath(raw, this.mapping.streams);
    const streams = (Array.isArray(streamValues) ? streamValues : []).flatMap((stream) => {
      const url = safeHttpUrl(readPath(stream, this.mapping.streamUrl));
      const fileName = stringValue(readPath(stream, this.mapping.streamFileName), 1_024);
      if (!url || !fileName) return [];
      const size = numberValue(readPath(stream, this.mapping.streamSize)) ?? 0;
      if (!isVideoFile({ index: 0, name: fileName, size, included: true, progress: 0 })) return [];
      const width = numberValue(readPath(stream, this.mapping.streamWidth));
      const height = numberValue(readPath(stream, this.mapping.streamHeight));
      const format = stringValue(readPath(stream, this.mapping.streamFormat), 120);
      const source = stringValue(readPath(stream, this.mapping.streamSource), 120);
      return [{
        url,
        fileName,
        size,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(format ? { format } : {}),
        ...(source ? { source } : {})
      }];
    });
    return {
      externalId,
      item: {
        id: this.encodeId(externalId),
        type: this.options.type,
        name,
        ...(poster ? { poster } : {}),
        ...(background ? { background } : {}),
        ...(description ? { description } : {}),
        ...(releaseInfo ? { releaseInfo } : {}),
        ...(genres ? { genres } : {}),
        ...(kind ? { kind } : {}),
        ...(season !== undefined && Number.isSafeInteger(season) ? { season } : {}),
        ...(episode !== undefined && Number.isSafeInteger(episode) ? { episode } : {}),
        ...(externalIds ? { externalIds } : {}),
        ...(classifications ? { classifications } : {}),
        ...(stremioType || stremioVideoId ? { stremio: {
          ...(stremioType ? { type: stremioType } : {}),
          ...(stremioVideoId ? { videoId: stremioVideoId } : {})
        } } : {})
      },
      ...(torrentSource ? { torrentSource } : {}),
      streams
    };
  }

  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const init = {
      headers: this.headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    };
    const response = this.options.urlPolicy || this.authenticated
      ? await fetchWithValidatedRedirects(
        url, this.options.urlPolicy, init, this.fetchImplementation, this.options.urlPolicy ? 3 : 20,
        this.authenticated ? "same-origin" : "any-origin"
      )
      : await (this.fetchImplementation ?? fetch)(url, init);
    if (!response.ok) throw new Error(`Catalog ${this.options.id} returned HTTP ${response.status}`);
    return await readLimitedJson(response, 2 * 1_024 * 1_024);
  }

  private async safeRecord(record: NormalizedRecord): Promise<NormalizedRecord> {
    if (!this.options.urlPolicy) return record;
    const item = { ...record.item };
    for (const field of ["poster", "background"] as const) {
      const value = item[field];
      if (!value) continue;
      try {
        await this.options.urlPolicy.validate(value);
      } catch {
        delete item[field];
      }
    }
    return { ...record, item };
  }

  async list(request: CatalogRequest, signal?: AbortSignal): Promise<CatalogItem[]> {
    if (request.type !== this.options.type) return [];
    if (!this.options.catalogUrl) {
      const all = await Promise.all([...this.staticRecords.values()].map((record) => this.safeRecord(record)));
      const search = request.search?.trim().toLowerCase();
      return all
        .filter((record) => !search || record.item.name.toLowerCase().includes(search))
        .slice(request.skip, request.skip + this.options.pageSize)
        .map((record) => record.item);
    }
    const payload = await this.json(requestUrl(this.options.catalogUrl, request, this.options.pageSize), signal);
    const rawItems = readPath(payload, this.options.itemsPath ?? "items");
    if (!Array.isArray(rawItems)) throw new Error(`Catalog ${this.options.id} did not return an item array`);
    const result: CatalogItem[] = [];
    for (const raw of rawItems.slice(0, 200)) {
      const record = this.normalize(raw);
      if (!record) continue;
      const safe = await this.safeRecord(record);
      this.cache.set(safe.externalId, safe);
      result.push(safe.item);
    }
    return result;
  }

  private async record(stremioId: string, signal?: AbortSignal): Promise<NormalizedRecord | undefined> {
    const externalId = this.decodeId(stremioId);
    const staticRecord = this.staticRecords.get(externalId);
    if (staticRecord) return await this.safeRecord(staticRecord);
    const cached = this.cache.get(externalId);
    if (cached) return cached;
    if (!this.options.itemUrl) return undefined;
    const url = replaceTemplate(this.options.itemUrl, {
      id: externalId,
      type: this.options.type,
      skip: "0",
      search: "",
      limit: String(this.options.pageSize)
    });
    const payload = await this.json(url, signal);
    const record = this.normalize(readPath(payload, this.options.itemPath ?? "item"));
    if (!record || record.externalId !== externalId) return undefined;
    const safe = await this.safeRecord(record);
    this.cache.set(externalId, safe);
    return safe;
  }

  async get(stremioId: string, signal?: AbortSignal): Promise<CatalogItem | undefined> {
    if (!this.owns(stremioId)) return undefined;
    return (await this.record(stremioId, signal))?.item;
  }

  async getTorrentSource(stremioId: string, signal?: AbortSignal): Promise<string> {
    const source = (await this.record(stremioId, signal))?.torrentSource;
    if (!source) throw new Error(`Catalog ${this.options.id} item has no torrent source`);
    return source;
  }

  async supportsTriblerFallback(stremioId: string, signal?: AbortSignal): Promise<boolean> {
    return Boolean((await this.record(stremioId, signal))?.torrentSource);
  }

  async getDirectStream(stremioId: string, signal?: AbortSignal): Promise<DirectStreamSource | undefined> {
    return (await this.record(stremioId, signal))?.streams[0];
  }

  async getDirectStreams(stremioId: string, signal?: AbortSignal): Promise<DirectStreamSource[]> {
    return [...((await this.record(stremioId, signal))?.streams ?? [])];
  }
}
