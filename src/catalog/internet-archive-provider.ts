import { TimedCache } from "./cache";
import type { TriblerFile } from "../types";
import { isVideoFile } from "../video-selection";
import { fetchWithValidatedRedirects, type ExternalUrlPolicy } from "../network/url-policy";
import { readLimitedJson } from "../network/limited-json";
import type { CatalogItem, CatalogProvider, CatalogRequest, DirectStreamSource } from "./types";

interface InternetArchiveSearchDoc {
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  date?: unknown;
  year?: unknown;
  subject?: unknown;
}

interface InternetArchiveSearchResponse {
  response?: {
    docs?: InternetArchiveSearchDoc[];
  };
}

interface InternetArchiveFile {
  name?: unknown;
  format?: unknown;
  size?: unknown;
  width?: unknown;
  height?: unknown;
  source?: unknown;
}

interface InternetArchiveMetadataResponse {
  metadata?: InternetArchiveSearchDoc;
  files?: InternetArchiveFile[];
}

interface CachedDetails {
  item: CatalogItem;
  torrentSource?: string;
  directStreams: DirectStreamSource[];
}

const ID_PREFIX = "tribler:ia:";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return scalar(value[0]);
  return undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
  const raw = scalar(value);
  if (!raw) return undefined;
  const plain = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, maxLength) : undefined;
}

function genres(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const result = values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12);
  return result.length > 0 ? result : undefined;
}

function safeEncodedPath(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return segments.map(encodeURIComponent).join("/");
}

function safeSearch(value: string): string {
  return value.replace(/[^\p{L}\p{N}\s._-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(scalar(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sortDirectStreams(left: DirectStreamSource, right: DirectStreamSource): number {
  const leftPixels = (left.width ?? 0) * (left.height ?? 0);
  const rightPixels = (right.width ?? 0) * (right.height ?? 0);
  if (leftPixels !== rightPixels) return rightPixels - leftPixels;
  if ((left.height ?? 0) !== (right.height ?? 0)) return (right.height ?? 0) - (left.height ?? 0);
  if (left.size !== right.size) return right.size - left.size;
  return left.fileName.localeCompare(right.fileName);
}

export interface InternetArchiveProviderOptions {
  query: string;
  pageSize: number;
  cacheTtlMs: number;
  requestTimeoutMs: number;
  httpStreamsEnabled?: boolean;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  urlPolicy?: ExternalUrlPolicy;
}

export class InternetArchiveCatalogProvider implements CatalogProvider {
  readonly definition = {
    id: "tribler-internet-archive",
    type: "movie" as const,
    name: "Internet Archive",
    supportsSearch: true
  };

  private readonly fetchImplementation: typeof fetch | undefined;
  private readonly baseUrl: string;
  private readonly listCache: TimedCache<CatalogItem[]>;
  private readonly detailsCache: TimedCache<CachedDetails>;

  constructor(private readonly options: InternetArchiveProviderOptions) {
    this.fetchImplementation = options.fetchImplementation;
    this.baseUrl = (options.baseUrl ?? "https://archive.org").replace(/\/$/, "");
    this.listCache = new TimedCache(options.cacheTtlMs);
    this.detailsCache = new TimedCache(options.cacheTtlMs);
  }

  owns(stremioId: string): boolean {
    return stremioId.startsWith(ID_PREFIX) && IDENTIFIER_PATTERN.test(stremioId.slice(ID_PREFIX.length));
  }

  private identifier(stremioId: string): string {
    if (!this.owns(stremioId)) throw new Error("Unknown Internet Archive item");
    return stremioId.slice(ID_PREFIX.length);
  }

  private item(document: InternetArchiveSearchDoc): CatalogItem | undefined {
    const identifier = scalar(document.identifier);
    if (!identifier || !IDENTIFIER_PATTERN.test(identifier)) return undefined;
    const name = text(document.title, 300) ?? identifier;
    const poster = `${this.baseUrl}/services/img/${encodeURIComponent(identifier)}`;
    const description = text(document.description, 4_000);
    const releaseInfo = text(document.year, 32) ?? text(document.date, 32);
    const itemGenres = genres(document.subject);
    return {
      id: `${ID_PREFIX}${identifier}`,
      type: "movie",
      name,
      poster,
      background: poster,
      ...(description ? { description } : {}),
      ...(releaseInfo ? { releaseInfo } : {}),
      ...(itemGenres ? { genres: itemGenres } : {})
    };
  }

  private async json<T>(url: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const init = {
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      signal: combined
    };
    const response = this.options.urlPolicy
      ? await fetchWithValidatedRedirects(url, this.options.urlPolicy, init, this.fetchImplementation)
      : await (this.fetchImplementation ?? fetch)(url, init);
    if (!response.ok) throw new Error(`Internet Archive returned HTTP ${response.status}`);
    return await readLimitedJson(response, 4 * 1_024 * 1_024) as T;
  }

  async list(request: CatalogRequest, signal?: AbortSignal): Promise<CatalogItem[]> {
    if (request.type !== "movie") return [];
    const skip = Math.max(0, request.skip);
    const search = request.search ? safeSearch(request.search) : "";
    const cacheKey = `${skip}:${search}`;
    const cached = this.listCache.get(cacheKey);
    if (cached) return cached;

    const query = search
      ? `(${this.options.query}) AND title:(${search})`
      : this.options.query;
    const page = Math.floor(skip / this.options.pageSize) + 1;
    const params = new URLSearchParams({
      q: query,
      output: "json",
      rows: String(this.options.pageSize),
      page: String(page)
    });
    for (const field of ["identifier", "title", "description", "date", "year", "subject"]) {
      params.append("fl[]", field);
    }
    params.append("sort[]", "downloads desc");
    const payload = await this.json<InternetArchiveSearchResponse>(
      `${this.baseUrl}/advancedsearch.php?${params.toString()}`,
      signal
    );
    const items = (payload.response?.docs ?? [])
      .map((document) => this.item(document))
      .filter((item): item is CatalogItem => item !== undefined);
    this.listCache.set(cacheKey, items);
    return items;
  }

  private async details(stremioId: string, signal?: AbortSignal): Promise<CachedDetails> {
    const identifier = this.identifier(stremioId);
    const cached = this.detailsCache.get(identifier);
    if (cached) return cached;
    const payload = await this.json<InternetArchiveMetadataResponse>(
      `${this.baseUrl}/metadata/${encodeURIComponent(identifier)}`,
      signal
    );
    const item = this.item({ ...payload.metadata, identifier });
    if (!item) throw new Error("Internet Archive returned invalid item metadata");
    const torrentFile = (payload.files ?? []).find((file) => {
      const format = scalar(file.format)?.toLowerCase();
      const name = scalar(file.name)?.toLowerCase();
      return format === "archive bittorrent" || name?.endsWith(".torrent");
    });
    const torrentName = scalar(torrentFile?.name);
    const encodedTorrentName = torrentName ? safeEncodedPath(torrentName) : undefined;
    const torrentSource = encodedTorrentName
      ? `${this.baseUrl}/download/${encodeURIComponent(identifier)}/${encodedTorrentName}`
      : undefined;
    const directStreams = this.options.httpStreamsEnabled === false ? [] : (payload.files ?? []).flatMap((file, index) => {
      const name = scalar(file.name);
      const encodedName = name ? safeEncodedPath(name) : undefined;
      const parsedSize = Number(scalar(file.size) ?? 0);
      if (!name || !encodedName || !Number.isFinite(parsedSize) || parsedSize < 0) return [];
      const candidate: TriblerFile = { index, name, size: parsedSize, included: true, progress: 0 };
      if (!isVideoFile(candidate)) return [];
      const width = nonNegativeNumber(file.width);
      const height = nonNegativeNumber(file.height);
      const format = text(file.format, 120);
      const source = text(file.source, 120);
      return [{
          url: `${this.baseUrl}/download/${encodeURIComponent(identifier)}/${encodedName}`,
          fileName: name,
          size: parsedSize,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(format ? { format } : {}),
          ...(source ? { source } : {})
        }];
    }).sort(sortDirectStreams);
    const details = {
      item,
      ...(torrentSource ? { torrentSource } : {}),
      directStreams
    };
    this.detailsCache.set(identifier, details);
    return details;
  }

  async get(stremioId: string, signal?: AbortSignal): Promise<CatalogItem | undefined> {
    if (!this.owns(stremioId)) return undefined;
    return (await this.details(stremioId, signal)).item;
  }

  async getTorrentSource(stremioId: string, signal?: AbortSignal): Promise<string> {
    const details = await this.details(stremioId, signal);
    if (!details.torrentSource) throw new Error("This Internet Archive item has no torrent file");
    return details.torrentSource;
  }


  async getDirectStream(stremioId: string, signal?: AbortSignal): Promise<DirectStreamSource | undefined> {
    return (await this.details(stremioId, signal)).directStreams[0];
  }

  async getDirectStreams(stremioId: string, signal?: AbortSignal): Promise<DirectStreamSource[]> {
    return [...(await this.details(stremioId, signal)).directStreams];
  }
}
