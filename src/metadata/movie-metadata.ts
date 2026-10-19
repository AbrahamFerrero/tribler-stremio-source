import { readLimitedJson } from "../network/limited-json";
import { fetchWithValidatedRedirects, type ExternalUrlPolicy } from "../network/url-policy";
import { isImdbMovieId } from "../streams/media-id-mapper";

export interface MovieIdentityMetadata {
  title: string;
  year?: number;
  runtimeSeconds?: number;
}

/** Trusted metadata for the requested identity, independent of stream candidates. */
export interface MovieMetadataLookup {
  lookup(imdbId: string): Promise<MovieIdentityMetadata | undefined>;
  lookupSeries?(imdbId: string): Promise<Pick<MovieIdentityMetadata, "title" | "year"> | undefined>;
}

interface CachedResult {
  value: MovieIdentityMetadata | undefined;
  expiresAt: number;
}

export interface StremioMovieMetadataOptions {
  baseUrl: string;
  endpointPolicy: (url: string) => ExternalUrlPolicy;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxEntries?: number;
  maxInFlight?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
}

function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`Invalid movie metadata ${name}`);
  }
  return result;
}

function metadata(payload: unknown, requestedId: string, type: "movie" | "series"): MovieIdentityMetadata | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const rawMeta = (payload as Record<string, unknown>).meta;
  if (typeof rawMeta !== "object" || rawMeta === null || Array.isArray(rawMeta)) return undefined;
  const meta = rawMeta as Record<string, unknown>;
  if (meta.id !== requestedId || meta.type !== type || typeof meta.name !== "string") return undefined;
  const title = meta.name.trim();
  if (!title || title.length > 300 || [...title].some((character) => character.charCodeAt(0) < 32)) return undefined;
  const releaseYear = typeof meta.releaseInfo === "string" && /^\d{4}$/.test(meta.releaseInfo.trim())
    ? Number(meta.releaseInfo.trim()) : undefined;
  const numericYear = Number.isSafeInteger(meta.year) && Number(meta.year) >= 1000 && Number(meta.year) <= 9999
    ? Number(meta.year) : undefined;
  const year = releaseYear !== undefined && numericYear !== undefined && releaseYear !== numericYear
    ? undefined : releaseYear ?? numericYear;
  // Cinemeta's series runtime is not an exact requested episode duration.
  // Its observed video entries expose coordinates/air dates, without runtime.
  if (type === "series") return { title, ...(year !== undefined && year >= 1000 && year <= 9999 ? { year } : {}) };
  const runtimeMatch = typeof meta.runtime === "string" ? /^([1-9]\d{0,2}) min$/.exec(meta.runtime.trim()) : null;
  const runtimeMinutes = runtimeMatch ? Number(runtimeMatch[1]) : undefined;
  const runtimeSeconds = runtimeMinutes !== undefined && runtimeMinutes <= 600 ? runtimeMinutes * 60 : undefined;
  return { title, ...(year !== undefined && year >= 1000 && year <= 9999 ? { year } : {}),
    ...(runtimeSeconds !== undefined ? { runtimeSeconds } : {}) };
}

export class StremioMovieMetadataLookup implements MovieMetadataLookup {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxEntries: number;
  private readonly maxInFlight: number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedResult>();
  private readonly pending = new Map<string, Promise<MovieIdentityMetadata | undefined>>();

  constructor(private readonly options: StremioMovieMetadataOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new Error("Invalid Stremio movie metadata base URL"); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
      url.search || url.hash || !url.pathname.endsWith("/")) {
      throw new Error("Stremio movie metadata base URL must be an HTTP(S) directory without credentials or query");
    }
    this.baseUrl = url;
    this.timeoutMs = bounded(options.timeoutMs, 2_500, 10_000, "timeout");
    this.maxResponseBytes = bounded(options.maxResponseBytes, 128 * 1_024, 128 * 1_024, "response size");
    this.maxEntries = bounded(options.maxEntries, 256, 500, "cache size");
    this.maxInFlight = bounded(options.maxInFlight, 4, 8, "concurrency");
    this.successTtlMs = bounded(options.successTtlMs, 5 * 60_000, 60 * 60_000, "success TTL");
    this.failureTtlMs = bounded(options.failureTtlMs, 30_000, 60_000, "failure TTL");
    this.now = options.now ?? Date.now;
  }

  async lookup(imdbId: string): Promise<MovieIdentityMetadata | undefined> {
    return this.lookupIdentity(imdbId, "movie");
  }

  async lookupSeries(imdbId: string): Promise<Pick<MovieIdentityMetadata, "title" | "year"> | undefined> {
    return this.lookupIdentity(imdbId, "series");
  }

  private async lookupIdentity(imdbId: string, type: "movie" | "series"): Promise<MovieIdentityMetadata | undefined> {
    if (!isImdbMovieId(imdbId)) return undefined;
    const key = `${type}:${imdbId}`;
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > this.now()) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.value;
      }
      this.cache.delete(key);
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return await inFlight;
    if (this.pending.size >= this.maxInFlight) return undefined;
    const task = this.fetchMetadata(imdbId, type).then((value) => {
      if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expiresAt: this.now() + (value ? this.successTtlMs : this.failureTtlMs) });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return await task;
  }

  private async fetchMetadata(imdbId: string, type: "movie" | "series"): Promise<MovieIdentityMetadata | undefined> {
    const url = new URL(`meta/${type}/${imdbId}.json`, this.baseUrl).toString();
    let response: Response | undefined;
    try {
      response = await fetchWithValidatedRedirects(url, this.options.endpointPolicy(url), {
        method: "GET",
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(this.timeoutMs)
      }, this.options.fetchImplementation);
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      return metadata(await readLimitedJson(response, this.maxResponseBytes), imdbId, type);
    } catch {
      return undefined;
    } finally {
      try { await response?.body?.cancel(); } catch { /* Body may already be consumed or cancelled. */ }
    }
  }
}
