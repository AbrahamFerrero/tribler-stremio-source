import { fetchWithValidatedRedirects, type ExternalUrlPolicy } from "../../network/url-policy";
import { sanitizeSourceRequestHeaders } from "../../network/http-privacy";
import { extractInfohash } from "../../source";
import { AddonRequestIdentityResolver } from "../addon-request-identity";
import { allowsContentType, type ContentTypePolicy } from "../content-type-policy";
import { parseStreamResourceCapabilities, type StreamResourceCapabilities } from "../stremio-addon-manifest";
import type {
  NormalizedMediaItem,
  NormalizedStreamSource,
  ProviderDiagnostic,
  StreamProvider,
  StreamProviderContext
} from "../types";

interface CachedManifest {
  expiresAt: number;
  resource: StreamResourceCapabilities;
}

interface CachedFailure {
  expiresAt: number;
  error: Error;
}

export interface StremioAddonStreamProviderOptions {
  id: string;
  name: string;
  manifestUrl: string;
  enabled: boolean;
  contentTypes?: ContentTypePolicy;
  timeoutMs: number;
  manifestTtlMs: number;
  endpointPolicy: (url: string) => ExternalUrlPolicy;
  maxManifestBytes?: number;
  maxResponseBytes?: number;
  maxStreams?: number;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  identityResolver?: AddonRequestIdentityResolver;
  /** Ephemeral local diagnostics; production does not configure this callback. */
  diagnostic?: (event: StremioAddonDiagnosticEvent) => void;
}

export type StremioAddonDiagnosticEvent =
  | { type: "request"; requestType: string; requestId: string }
  | { type: "response"; httpStatus: number }
  | { type: "raw-streams"; streams: unknown[] };

function jsonDepth(value: unknown, current = 0): number {
  if (current > 8 || typeof value !== "object" || value === null) return current;
  return Math.max(current, ...Object.values(value).map((entry) => jsonDepth(entry, current + 1)));
}

async function limitedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Stremio addon returned an unexpected content type");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new Error("Stremio addon response is too large");
  if (!response.body) throw new Error("Stremio addon returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("Stremio addon response is too large");
    }
    chunks.push(chunk.value);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Stremio addon returned malformed JSON");
  }
  if (jsonDepth(payload) > 8) throw new Error("Stremio addon JSON is too deeply nested");
  return payload;
}


function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isInformationalNotice(stream: Record<string, unknown>): boolean {
  const mediaUrl = text(stream.url, 8_192);
  const externalUrl = text(stream.externalUrl, 8_192);
  if (!mediaUrl || !externalUrl || mediaUrl === externalUrl) return false;
  try {
    const destination = new URL(externalUrl);
    if ((destination.protocol !== "http:" && destination.protocol !== "https:")
      || destination.toString() === new URL(mediaUrl).toString()) return false;
  } catch { return false; }
  const labels = [text(stream.name, 200), text(stream.title, 500), text(stream.description, 500)]
    .filter((value): value is string => Boolean(value));
  // An external navigation link repeated in the label plus a lifecycle notice
  // identifies an announcement, even if its separate URL serves a video.
  return labels.some((value) => value.includes(externalUrl))
    && labels.some((value) => /\b(?:deprecated|discontinued|inactive|retired|moved)\b/i.test(
      value.replaceAll(externalUrl, "")
    ));
}

function normalizeResult(raw: unknown, providerId: string): NormalizedStreamSource | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const stream = raw as Record<string, unknown>;
  if (isInformationalNotice(stream)) return undefined;
  const infoHash = text(stream.infoHash, 128);
  const validHash = infoHash ? extractInfohash(infoHash) : undefined;
  const hints = typeof stream.behaviorHints === "object" && stream.behaviorHints !== null &&
    !Array.isArray(stream.behaviorHints) ? stream.behaviorHints as Record<string, unknown> : {};
  const filename = text(hints.filename, 1_024);
  const sizeBytes = typeof hints.videoSize === "number" && Number.isFinite(hints.videoSize) && hints.videoSize >= 0
    ? hints.videoSize
    : undefined;
  const title = text(stream.description, 500) ?? text(stream.title, 500) ?? text(stream.name, 200);
  const quality = text(stream.name, 80);
  const fileIndex = nonNegativeInteger(stream.fileIdx);
  if (validHash) {
    return {
      providerId,
      type: "magnet",
      magnet: `magnet:?xt=urn:btih:${validHash}`,
      infoHash: validHash,
      ...(fileIndex !== undefined ? { fileIndex } : {}),
      ...(filename ? { filename } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(title ? { title } : {}),
      ...(quality ? { quality } : {})
    };
  }
  const rawUrl = text(stream.url, 8_192);
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const proxyHeaders = hints.proxyHeaders && typeof hints.proxyHeaders === "object" && !Array.isArray(hints.proxyHeaders)
    ? hints.proxyHeaders as Record<string, unknown> : undefined;
  const requestHeaders = sanitizeSourceRequestHeaders(proxyHeaders?.request);
  return {
    providerId,
    type: url.protocol === "https:" ? "https" : "http",
    url: url.toString(),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(filename ? { filename } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(title ? { title } : {}),
    ...(quality ? { quality } : {})
  };
}

export class StremioAddonStreamProvider implements StreamProvider {
  readonly id: string;
  readonly name: string;
  readonly type = "stremio_addon";
  private readonly now: () => number;
  private readonly identityResolver: AddonRequestIdentityResolver;
  private manifestCache: CachedManifest | undefined;
  private manifestFailure: CachedFailure | undefined;
  private manifestPending: Promise<StreamResourceCapabilities> | undefined;

  constructor(private readonly options: StremioAddonStreamProviderOptions) {
    this.id = `stremio-addon-${options.id}`;
    this.name = options.name;
    this.now = options.now ?? Date.now;
    this.identityResolver = options.identityResolver ?? new AddonRequestIdentityResolver();
  }

  isEnabled(): boolean {
    return this.options.enabled && !(this.manifestFailure && this.manifestFailure.expiresAt > this.now());
  }

  diagnosticDetails(): Pick<ProviderDiagnostic, "type" | "supports" | "streamCapabilities"> {
    const resource = this.manifestCache?.resource;
    const supports = resource ? [...new Set(resource.types)] : [];
    return {
      type: this.type,
      supports,
      ...(resource ? { streamCapabilities: {
        types: [...resource.types],
        ...(resource.idPrefixes ? { idPrefixes: [...resource.idPrefixes] } : {})
      } } : {})
    };
  }

  private async fetchManifest(signal: AbortSignal): Promise<StreamResourceCapabilities> {
    const response = await fetchWithValidatedRedirects(
      this.options.manifestUrl,
      this.options.endpointPolicy(this.options.manifestUrl),
      { headers: { Accept: "application/json", "Accept-Encoding": "identity" }, signal },
      this.options.fetchImplementation
    );
    if (!response.ok) throw new Error(`Stremio addon manifest returned HTTP ${response.status}`);
    return parseStreamResourceCapabilities(await limitedJson(response, this.options.maxManifestBytes ?? 262_144));
  }

  private async manifest(contextSignal: AbortSignal): Promise<StreamResourceCapabilities> {
    const now = this.now();
    if (this.manifestCache && this.manifestCache.expiresAt > now) return this.manifestCache.resource;
    if (this.manifestFailure && this.manifestFailure.expiresAt > now) throw this.manifestFailure.error;
    if (this.manifestPending) return await this.manifestPending;
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = AbortSignal.any([contextSignal, timeout]);
    this.manifestPending = this.fetchManifest(signal).then((resource) => {
      this.manifestCache = { resource, expiresAt: this.now() + this.options.manifestTtlMs };
      this.manifestFailure = undefined;
      return resource;
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error("Stremio addon manifest failed");
      this.manifestFailure = { error: failure, expiresAt: this.now() + this.options.manifestTtlMs };
      throw failure;
    }).finally(() => {
      this.manifestPending = undefined;
    });
    return await this.manifestPending;
  }

  private streamUrl(type: string, id: string): string {
    const base = new URL("./", this.options.manifestUrl);
    return new URL(`stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, base).toString();
  }

  async resolve(item: NormalizedMediaItem, context: StreamProviderContext): Promise<NormalizedStreamSource[]> {
    if (!this.options.enabled) return [];
    if (!allowsContentType(this.options.contentTypes, item)) return [];
    const resource = await this.manifest(context.signal);
    const identity = await this.identityResolver.resolve(item, resource);
    if (!identity) return [];
    this.options.diagnostic?.({ type: "request", requestType: identity.type, requestId: identity.id });
    const url = this.streamUrl(identity.type, identity.id);
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const response = await fetchWithValidatedRedirects(
      url,
      this.options.endpointPolicy(url),
      { headers: { Accept: "application/json", "Accept-Encoding": "identity" }, signal: AbortSignal.any([context.signal, timeout]) },
      this.options.fetchImplementation
    );
    this.options.diagnostic?.({ type: "response", httpStatus: response.status });
    if (!response.ok) throw new Error(`Stremio addon stream resource returned HTTP ${response.status}`);
    const payload = await limitedJson(response, this.options.maxResponseBytes ?? 1_048_576);
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { streams?: unknown }).streams)) {
      throw new Error("Stremio addon stream response schema is invalid");
    }
    const streams = (payload as { streams: unknown[] }).streams;
    this.options.diagnostic?.({ type: "raw-streams", streams });
    const normalized: NormalizedStreamSource[] = [];
    // The JSON body is already byte-bounded. Invalid raw entries must not use
    // the quota intended for usable provider results.
    for (const stream of streams) {
      const result = normalizeResult(stream, this.id);
      if (result) normalized.push(result);
      if (normalized.length >= (this.options.maxStreams ?? 100)) break;
    }
    return normalized;
  }
}
