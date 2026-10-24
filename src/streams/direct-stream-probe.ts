import { createHmac, randomBytes } from "node:crypto";
import { hlsRequiredDependencies, hlsMediaReferences, hlsSelectedAudioRenditions, hlsVodDurationSeconds, isHlsContentType, readHlsPlaylist } from "../hls-playlist";
import type { Logger } from "../logger";
import { sourceRequestHeadersKey, type SourceHeaderScope } from "../network/http-privacy";
import { OutboundRedirectError, type OutboundTransport, type OutboundRequest } from "../network/outbound-transport";
import { ExternalUrlPolicyError } from "../network/url-policy";
import { MP4_INSPECTION_BYTES, mp4RuntimeFromPrefix, mp4RuntimeFromTail } from "./mp4-runtime";
import { hasKnownDirectVideoName } from "./normalization";
import { episodeResourceObservationFromUrl, movieResourceObservationFromUrl, resourceIdentityFromUrl } from "./identity-qualification";
import type { DirectHttpProbeMetadata, DirectHttpProbeStatus, NormalizedStreamSource, ResourceIdentity } from "./types";

const SUCCESS_TTL_MS = 2 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
const INITIAL_RANGE_END = 63;
const SIGNATURE_BYTES = 4;
const INITIAL_PREFIX_BYTES = INITIAL_RANGE_END + 1;
const MPEG_TS_PACKET_BYTES = 188;
const MPEG_TS_SNIFF_BYTES = MPEG_TS_PACKET_BYTES * 2 + 1;
const MAX_HLS_PLAYLIST_TRANSITIONS = 2;

export interface DirectStreamProbeOptions {
  enabled: boolean;
  timeoutMs: number;
  maxCandidates: number;
  maxConcurrent: number;
}

export interface DirectStreamProbeDiagnostics {
  enabled: boolean;
  requests: number;
  cacheHits: number;
  verified: number;
  failures: number;
}

interface CachedProbe {
  metadata: DirectHttpProbeMetadata;
  expiresAt: number;
}

function isDirect(source: NormalizedStreamSource): source is NormalizedStreamSource & { url: string } {
  return (source.type === "http" || source.type === "https") && Boolean(source.url);
}

export function normalizedContentType(headers: Headers): string | undefined {
  const raw = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return raw && raw.length <= 128 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw)
    ? raw
    : undefined;
}

function safeSize(value: string | null): number | undefined {
  if (!value || !/^\d{1,20}$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function parseInitialRange(value: string | null): { end: number; total: number } | undefined {
  const match = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(value?.trim() ?? "");
  const end = match?.[1] ? safeSize(match[1]) : undefined;
  const total = match?.[2] ? safeSize(match[2]) : undefined;
  return end !== undefined && end <= INITIAL_RANGE_END && total !== undefined && total > end
    ? { end, total } : undefined;
}

/** Qualify size only; preserve existing availability/admission and network work. */
function initialRangeSizeEvidence(headers: Headers, prefix: Uint8Array): boolean {
  const range = parseInitialRange(headers.get("content-range"));
  if (!range) return false;
  const intervalBytes = range.end + 1;
  const length = headers.get("content-length");
  const encoding = headers.get("content-encoding");
  // The reader deliberately caps inspection at 64 bytes and cancels the body.
  // Require the inspected prefix, never an entire larger announced interval.
  // Smaller intervals must fit exactly; no claim about the rest of the file.
  return (length === null || safeSize(length) === intervalBytes)
    && (encoding === null || encoding.trim().toLowerCase() === "identity")
    && prefix.length === Math.min(intervalBytes, INITIAL_PREFIX_BYTES)
    && !new TextDecoder().decode(prefix).trimStart().startsWith("#EXTM3U")
    && !normalizedContentType(headers)?.startsWith("multipart/");
}

function exactRange(value: string | null, start: number, end: number, total: number): boolean {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() ?? "");
  return Boolean(match && safeSize(match[1]!) === start && safeSize(match[2]!) === end
    && safeSize(match[3]!) === total);
}

async function boundedRange(
  url: string, start: number, end: number, total: number,
  request: OutboundTransport["request"], signal: AbortSignal
): Promise<Uint8Array | undefined> {
  signal.throwIfAborted();
  if (start < 0 || end < start || end >= total || end - start + 1 > MP4_INSPECTION_BYTES) return undefined;
  const { response } = await request({ url, method: "GET",
    headers: new Headers({ Accept: "*/*", Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" }) }, signal);
  const encoding = response.headers.get("content-encoding")?.toLowerCase();
  if (response.status !== 206 || (encoding && encoding !== "identity")
    || !exactRange(response.headers.get("content-range"), start, end, total) || !response.body) {
    await response.body?.cancel();
    return undefined;
  }
  const expected = end - start + 1;
  const declared = response.headers.get("content-length");
  if (declared !== null && safeSize(declared) !== expected) {
    await response.body.cancel();
    return undefined;
  }
  const output = new Uint8Array(expected);
  const reader = response.body.getReader();
  let length = 0;
  try {
    for (let reads = 0; length < expected && reads <= expected; reads += 1) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.length > expected - length) return undefined;
      output.set(part.value, length);
      length += part.value.length;
    }
    signal.throwIfAborted();
    return length === expected ? output : undefined;
  } finally {
    await reader.cancel();
  }
}

async function inspectMp4Runtime(
  url: string, initial: Uint8Array, total: number,
  request: OutboundTransport["request"], signal: AbortSignal
): Promise<number | undefined> {
  signal.throwIfAborted();
  // Only a real ftyp signature from the verified initial response triggers extra work.
  if (initial.length < 16 || String.fromCharCode(...initial.subarray(4, 8)) !== "ftyp"
    || total <= initial.length) return undefined;
  let parsed = mp4RuntimeFromPrefix(initial, total);
  if (parsed.seconds === undefined && parsed.tailOffset === undefined) {
    const prefixEnd = Math.min(total, MP4_INSPECTION_BYTES) - 1;
    const remainder = await boundedRange(url, initial.length, prefixEnd, total, request, signal);
    if (!remainder) return undefined;
    const prefix = new Uint8Array(initial.length + remainder.length);
    prefix.set(initial);
    prefix.set(remainder, initial.length);
    parsed = mp4RuntimeFromPrefix(prefix, total);
  }
  signal.throwIfAborted();
  if (parsed.seconds !== undefined || parsed.tailOffset === undefined) return parsed.seconds;
  const tailEnd = Math.min(total - 1, parsed.tailOffset + MP4_INSPECTION_BYTES - 1);
  const tail = await boundedRange(url, parsed.tailOffset, tailEnd, total, request, signal);
  return tail ? mp4RuntimeFromTail(tail, parsed.tailOffset, total) : undefined;
}

function playlistBodyLength(response: Response): number | undefined {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  return !encoding || encoding === "identity" ? safeSize(response.headers.get("content-length")) : undefined;
}

async function initialPrefix(
  body: ReadableStream<Uint8Array>,
  maximum = INITIAL_PREFIX_BYTES
): Promise<Uint8Array> {
  const reader = body.getReader();
  const prefix = new Uint8Array(maximum);
  let length = 0;
  try {
    for (let reads = 0; length < prefix.length && reads < maximum; reads += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const slice = chunk.value.subarray(0, prefix.length - length);
      prefix.set(slice, length);
      length += slice.length;
    }
    return prefix.subarray(0, length);
  } finally {
    await reader.cancel();
  }
}

function documentFormat(bytes: Uint8Array): "html" | "xml" | "json" | undefined {
  let encoding = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  const prefix = new TextDecoder(encoding).decode(bytes.subarray(offset)).trimStart().toLowerCase();
  if (/^<(?:!doctype(?:\s|>)|html(?:\s|>)|head(?:\s|>)|body(?:\s|>))/.test(prefix)) return "html";
  if (/^<\?xml(?:\s|\?)/.test(prefix)) return "xml";
  if (/^(?:\{\s*"|\[\s*(?:\{|"))/.test(prefix)) return "json";
  return undefined;
}

function isZipPrefix(bytes: Uint8Array): boolean {
  return bytes.length >= SIGNATURE_BYTES && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04)
      || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08));
}

function isMpegTsPrefix(bytes: Uint8Array): boolean {
  return bytes.length >= MPEG_TS_SNIFF_BYTES
    && bytes[0] === 0x47
    && bytes[MPEG_TS_PACKET_BYTES] === 0x47
    && bytes[MPEG_TS_PACKET_BYTES * 2] === 0x47;
}

function errorStatus(error: unknown, timedOut: boolean): DirectHttpProbeStatus {
  if (error instanceof OutboundRedirectError || error instanceof ExternalUrlPolicyError) return "route_rejected";
  if (timedOut || (error instanceof DOMException && error.name === "TimeoutError")) return "timeout";
  return "unreachable";
}

function budgetExhausted(): DirectHttpProbeMetadata {
  return { status: "budget_exhausted", verified: false, rangeSupported: false };
}

export function isHlsCandidate(url: string, contentType: string | undefined): boolean {
  try {
    return isHlsContentType(contentType) || new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return isHlsContentType(contentType);
  }
}

function isMediaSegmentType(contentType: string | undefined): boolean {
  return contentType?.startsWith("video/") || contentType?.startsWith("audio/")
    || contentType === "application/octet-stream" || contentType === "application/mp4";
}

async function verifyHlsSegment(
  url: string,
  request: OutboundTransport["request"],
  signal: AbortSignal,
  kind: "map" | "key" | "segment" = "segment"
): Promise<void> {
  const { response } = await request({ url, method: "GET", headers: new Headers({ Accept: "*/*", "Accept-Encoding": "identity" }) }, signal);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("HLS required resource did not provide usable bytes");
  }
  const contentType = normalizedContentType(response.headers);
  const needsMediaSignature = kind !== "key" && !isMediaSegmentType(contentType);
  const prefix = await initialPrefix(
    response.body,
    needsMediaSignature ? MPEG_TS_SNIFF_BYTES : INITIAL_PREFIX_BYTES
  );
  if (!prefix.length || documentFormat(prefix) || isZipPrefix(prefix)
    || (needsMediaSignature && !isMpegTsPrefix(prefix))) {
    throw new Error("HLS required resource has no media bytes");
  }
}

async function verifyHlsMediaPath(
  rootUrl: string,
  rootBody: ReadableStream<Uint8Array> | null,
  transportRequest: OutboundTransport["request"],
  signal: AbortSignal,
  rootContentLength?: number,
  sourceHeaderScope?: SourceHeaderScope
): Promise<Pick<DirectHttpProbeMetadata, "actualRuntimeSeconds" | "resourceIdentities">> {
  let playlistUrl = rootUrl;
  let scope = sourceHeaderScope;
  const request: OutboundTransport["request"] = (outbound, signal) =>
    transportRequest({ ...outbound, ...(scope ? { sourceHeaderScope: scope } : {}) }, signal);
  let playlist = await readHlsPlaylist(rootBody, signal, rootContentLength);
  const resourceIdentities: ResourceIdentity[] = [];
  // At most two playlist transitions and two representative media requests.
  for (let depth = 0; depth <= MAX_HLS_PLAYLIST_TRANSITIONS; depth += 1) {
    const identity = resourceIdentityFromUrl(playlistUrl);
    if (identity) resourceIdentities.push(identity);
    const references = hlsMediaReferences(playlist, playlistUrl);
    const variant = references.find((reference) => reference.kind === "variant");
    if (variant) {
      if (depth === MAX_HLS_PLAYLIST_TRANSITIONS) throw new Error("HLS playlist exceeded the bounded probe depth");
      for (const dependency of hlsRequiredDependencies(playlist, playlistUrl)) {
        await verifyHlsSegment(dependency.url, request, signal, dependency.kind);
      }
      for (const audioUrl of hlsSelectedAudioRenditions(playlist, playlistUrl)) {
        const { response: audio, effectiveUrl: audioEffectiveUrl, sourceHeaderScope: audioScope } = await request({ url: audioUrl, method: "GET",
          headers: new Headers({ Accept: "*/*", "Accept-Encoding": "identity" }) }, signal);
        if (!audio.ok || !(isHlsCandidate(audioUrl, normalizedContentType(audio.headers))
          || isHlsCandidate(audioEffectiveUrl, normalizedContentType(audio.headers)))) {
          await audio.body?.cancel();
          throw new Error("HLS selected audio rendition did not provide a playlist");
        }
        const audioPlaylist = await readHlsPlaylist(audio.body, signal, playlistBodyLength(audio));
        const audioReferences = hlsMediaReferences(audioPlaylist, audioEffectiveUrl);
        const audioRequest: OutboundTransport["request"] = (outbound, signal) => transportRequest({ ...outbound,
          ...(scope ? { sourceHeaderScope: audioScope ?? { ...scope,
            httpsOnly: scope.httpsOnly || new URL(audioEffectiveUrl).protocol === "https:" } } : {}) }, signal);
        const audioSegment = audioReferences.find((reference) => reference.kind === "segment");
        if (!audioSegment || audioReferences.some((reference) => reference.kind === "variant")) {
          throw new Error("HLS selected audio rendition has no direct media path");
        }
        for (const dependency of hlsRequiredDependencies(audioPlaylist, audioEffectiveUrl)) {
          await verifyHlsSegment(dependency.url, audioRequest, signal, dependency.kind);
        }
        await verifyHlsSegment(audioSegment.url, audioRequest, signal);
      }
      const { response, effectiveUrl, sourceHeaderScope: variantScope } = await request({ url: variant.url, method: "GET", headers: new Headers({ Accept: "*/*", "Accept-Encoding": "identity" }) }, signal);
      if (!response.ok || !(isHlsCandidate(variant.url, normalizedContentType(response.headers))
        || isHlsCandidate(effectiveUrl, normalizedContentType(response.headers)))) {
        await response.body?.cancel();
        throw new Error("HLS variant did not provide a playlist");
      }
      playlistUrl = effectiveUrl;
      if (scope) scope = variantScope ?? { ...scope, httpsOnly: scope.httpsOnly || new URL(effectiveUrl).protocol === "https:" };
      playlist = await readHlsPlaylist(response.body, signal, playlistBodyLength(response));
      continue;
    }
    const segments = references.filter((reference) => reference.kind === "segment");
    if (!segments.length) throw new Error("HLS playlist has no playable media reference");
    const first = segments[0]!;
    const later = segments.length > 1 ? [...segments].reverse().find((segment) => segment.url !== first.url) : undefined;
    if (segments.length > 1 && !later) throw new Error("HLS playlist has no distinct later media reference");
    for (const dependency of hlsRequiredDependencies(playlist, playlistUrl)) {
      await verifyHlsSegment(dependency.url, request, signal, dependency.kind);
    }
    await verifyHlsSegment(first.url, request, signal);
    if (later) await verifyHlsSegment(later.url, request, signal);
    const seconds = hlsVodDurationSeconds(playlist);
    return { ...(seconds !== undefined ? { actualRuntimeSeconds: seconds } : {}),
      ...(resourceIdentities.length ? { resourceIdentities } : {}) };
  }
  throw new Error("HLS media path exceeded the bounded probe depth");
}

/**
 * Small preflight that intentionally has no HTTP client of its own. Every request
 * goes through OutboundTransport, so URL policy, redirect validation, DNS pinning
 * and header minimisation remain identical to real playback.
 */
export class DirectStreamProbe {
  private readonly secret = randomBytes(32);
  private readonly cache = new Map<string, CachedProbe>();
  private requests = 0;
  private cacheHits = 0;
  private verified = 0;
  private failures = 0;

  constructor(
    private readonly transport: OutboundTransport,
    private readonly options: DirectStreamProbeOptions,
    private readonly log: Logger,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
      || !Number.isSafeInteger(options.maxCandidates) || options.maxCandidates <= 0
      || !Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
      throw new Error("Invalid direct HTTP probe limits");
    }
  }

  diagnostics(): DirectStreamProbeDiagnostics {
    return {
      enabled: this.options.enabled,
      requests: this.requests,
      cacheHits: this.cacheHits,
      verified: this.verified,
      failures: this.failures
    };
  }

  async probe(
    sources: NormalizedStreamSource[],
    signal?: AbortSignal,
    shouldBackfill?: (source: NormalizedStreamSource) => boolean,
    networkStart?: (providerId: string) => void,
    /** Optional resolver-owned scheduling decision; never provider metadata. */
    shouldDefer?: (source: NormalizedStreamSource) => boolean
  ): Promise<NormalizedStreamSource[]> {
    if (!this.options.enabled) return sources;
    const output = [...sources];
    // Ordinary candidates precede deferred speculation, then prefer video hints and HTTPS.
    // Ties retain arrival order; provider turns and probe limits stay shared.
    const byProvider = new Map<string, number[]>();
    sources.forEach((source, index) => {
      if (!isDirect(source)) return;
      if (signal?.aborted) throw signal.reason instanceof Error
        ? signal.reason : new Error("Direct probe cancelled");
      // Recover observations for every validated, deduplicated source before
      // assigning network slots. Cached failures stay failures; admission and
      // request-specific identity checks remain the resolver's responsibility.
      const prior = this.cached(this.cacheKey(source.url, source.requestHeaders));
      if (prior) {
        output[index] = { ...source, directHttp: prior };
        return;
      }
      const group = byProvider.get(source.providerId) ?? [];
      group.push(index);
      byProvider.set(source.providerId, group);
    });
    for (const group of byProvider.values()) {
      group.sort((left, right) => {
        const first = sources[left]!;
        const second = sources[right]!;
        return Number(shouldDefer?.(first) ?? false) - Number(shouldDefer?.(second) ?? false)
          || Number(hasKnownDirectVideoName(second)) - Number(hasKnownDirectVideoName(first))
          || Number(second.type === "https") - Number(first.type === "https")
          || left - right;
      });
    }
    const candidates: number[] = [];
    let round = 0;
    while (candidates.length < sources.length) {
      let added = false;
      for (const group of byProvider.values()) {
        const index = group[round];
        if (index !== undefined) { candidates.push(index); added = true; }
      }
      if (!added) break;
      round += 1;
    }
    const maxAttempts = Math.min(candidates.length, this.options.maxCandidates * 2);
    let cursor = 0;
    let replacementsPending = 0;
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new DOMException("Direct probe budget timed out", "TimeoutError")), this.options.timeoutMs);
    const workersCount = Math.min(this.options.maxConcurrent, this.options.maxCandidates, candidates.length);
    // A slow first wave must leave a bounded part of the shared deadline for
    // queued candidates. A sole wave retains the full timeout.
    const attemptTimeoutMs = candidates.length > workersCount
      ? Math.max(1, Math.floor(this.options.timeoutMs * 2 / 3)) : this.options.timeoutMs;
    // Probe the initial slots, then permit one bounded replacement for each
    // deterministic rejection. Total attempts stay at most 2x.
    const workers = Array.from({ length: workersCount }, async () => {
      while (cursor < maxAttempts) {
        if (cursor >= this.options.maxCandidates) {
          if (replacementsPending === 0 || budget.signal.aborted) break;
          replacementsPending -= 1;
        }
        const position = cursor++;
        // Preserve explicit budget_exhausted metadata for original slots;
        // never start a replacement after the shared deadline.
        if (budget.signal.aborted && position >= this.options.maxCandidates) break;
        const index = candidates[position];
        if (index === undefined) break;
        const source = output[index];
        if (!source || !isDirect(source)) break;
        output[index] = { ...source, directHttp: await this.probeOne(source.url, source.requestHeaders, signal, budget.signal, attemptTimeoutMs,
          networkStart ? () => networkStart(source.providerId) : undefined) };
        if (shouldBackfill?.(output[index])) replacementsPending += 1;
      }
    });
    try {
      await Promise.all(workers);
      return output;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  private cacheKey(url: string, sourceHeaders?: NormalizedStreamSource["requestHeaders"]): string {
    return createHmac("sha256", this.secret).update(JSON.stringify([url, sourceRequestHeadersKey(sourceHeaders)])).digest("base64url");
  }

  private cached(key: string): DirectHttpProbeMetadata | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU without exposing source identities: the key is an in-memory HMAC only.
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.cacheHits += 1;
    return entry.metadata;
  }

  private store(key: string, metadata: DirectHttpProbeMetadata): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    const ttl = metadata.status === "verified" || metadata.status === "reachable" ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    this.cache.set(key, { metadata, expiresAt: this.now() + ttl });
  }

  private async probeOne(
    url: string,
    sourceHeaders?: NormalizedStreamSource["requestHeaders"],
    parentSignal?: AbortSignal,
    budgetSignal?: AbortSignal,
    attemptTimeoutMs = this.options.timeoutMs,
    networkStart?: () => void
  ): Promise<DirectHttpProbeMetadata> {
    if (parentSignal?.aborted) throw parentSignal.reason instanceof Error
      ? parentSignal.reason : new Error("Direct probe cancelled");
    const key = this.cacheKey(url, sourceHeaders);
    const initialScope = { origin: new URL(url).origin, httpsOnly: new URL(url).protocol === "https:" };
    const request: OutboundTransport["request"] = (outbound: OutboundRequest, activeSignal?: AbortSignal) =>
      this.transport.request({ ...outbound, sourceHeaderScope: outbound.sourceHeaderScope ?? initialScope,
        ...(sourceHeaders ? { sourceHeaders } : {}) }, activeSignal);
    const prior = this.cached(key);
    if (prior) return prior;
    if (budgetSignal?.aborted) {
      this.log.info("Direct HTTP probe skipped", { status: "budget_exhausted" });
      return budgetExhausted();
    }

    this.requests += 1;
    networkStart?.();
    const controller = new AbortController();
    let abortedByBudget = false;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      if (attemptTimeoutMs < this.options.timeoutMs) abortedByBudget = true;
      controller.abort(new DOMException("Direct probe timed out", "TimeoutError"));
    }, attemptTimeoutMs);
    const abort = (): void => controller.abort(parentSignal?.reason);
    const budgetAbort = (): void => {
      if (controller.signal.aborted) return;
      abortedByBudget = true;
      controller.abort(budgetSignal?.reason instanceof Error
        ? budgetSignal.reason : new DOMException("Direct probe budget timed out", "TimeoutError"));
    };
    parentSignal?.addEventListener("abort", abort, { once: true });
    budgetSignal?.addEventListener("abort", budgetAbort, { once: true });
    const started = this.now();
    let metadata: DirectHttpProbeMetadata;
    let resourceIdentities: ResourceIdentity[] = [];
    let effectiveResourceUrl: string | undefined;
    try {
      let outbound = await request({
        url,
        method: "GET",
        headers: new Headers({ Accept: "*/*", Range: `bytes=0-${INITIAL_RANGE_END}`, "Accept-Encoding": "identity" })
      }, controller.signal);
      let { response, effectiveUrl } = outbound;
      let hls = isHlsCandidate(url, normalizedContentType(response.headers))
        || isHlsCandidate(effectiveUrl, normalizedContentType(response.headers));
      if (response.status === 403 || response.status === 416 || (response.status === 206 && hls)) {
        // Some servers reject Range (403/416); a partial HLS manifest also
        // needs a full GET. Retry once within this candidate's existing deadline.
        // Retain HLS classification even if the retry omits its MIME type.
        await response.body?.cancel();
        controller.signal.throwIfAborted();
        outbound = await request({
          url, method: "GET",
          headers: new Headers({ Accept: "*/*", "Accept-Encoding": "identity" })
        }, controller.signal);
      }
      ({ response, effectiveUrl } = outbound);
      // The transport returns at headers, including redirects and any root GET
      // fallback above. Capture before body/MP4/HLS work; this is not body TTFB.
      const elapsed = this.now() - started;
      const headerLatency = Number.isFinite(elapsed) && elapsed >= 0 ? { responseHeaderLatencyMs: elapsed } : {};
      effectiveResourceUrl = effectiveUrl;
      const resourceIdentity = response.ok ? resourceIdentityFromUrl(effectiveUrl) : undefined;
      if (resourceIdentity) resourceIdentities = [resourceIdentity];
      const type = normalizedContentType(response.headers);
      hls = hls || isHlsCandidate(url, type) || isHlsCandidate(effectiveUrl, type);
      const common = type ? { contentType: type } : {};
      if (response.status === 200) {
        const observedSizeBytes = safeSize(response.headers.get("content-length"));
        if (hls || isHlsCandidate(effectiveUrl, type)) {
          try {
            const observation = await verifyHlsMediaPath(
              effectiveUrl, response.body, request, controller.signal, playlistBodyLength(response),
              outbound.sourceHeaderScope ?? { ...initialScope, httpsOnly: initialScope.httpsOnly || new URL(effectiveUrl).protocol === "https:" }
            );
            metadata = {
              status: "verified", verified: true, rangeSupported: false, responseStatus: 200, hls: true,
              ...headerLatency, ...common,
              ...(observedSizeBytes !== undefined ? { observedSizeBytes } : {}),
              ...observation,
              ...(observation.actualRuntimeSeconds !== undefined ? { runtimeEvidence: "hls_vod" as const } : {})
            };
          } catch (error) {
            if (parentSignal?.aborted) throw error instanceof Error ? error : new Error("Direct probe cancelled");
            const status = abortedByBudget ? "budget_exhausted"
              : errorStatus(error, controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError");
            metadata = { status, verified: false, rangeSupported: false, responseStatus: 200, ...common };
          }
        } else {
          const prefix = response.body ? await initialPrefix(response.body) : undefined;
          const format = prefix ? documentFormat(prefix) : undefined;
          metadata = { status: "reachable", verified: false, rangeSupported: false, responseStatus: 200, ...common,
            ...(observedSizeBytes !== undefined ? { observedSizeBytes } : {}),
            ...(prefix && isZipPrefix(prefix) ? { archiveFormat: "zip" as const } : {}),
            ...(format ? { documentFormat: format } : {}) };
        }
      } else if (response.status === 206 && !hls) {
        const observedSizeBytes = parseInitialRange(response.headers.get("content-range"))?.total;
        if (observedSizeBytes === undefined || !response.body) {
          await response.body?.cancel();
          metadata = { status: "reachable", verified: false, rangeSupported: false, responseStatus: 206, ...common };
        } else {
          const prefix = await initialPrefix(response.body);
          const format = documentFormat(prefix);
          if (prefix.length === 0) {
            metadata = { status: "reachable", verified: false, rangeSupported: false, responseStatus: 206,
              ...common, observedSizeBytes };
          } else if (isZipPrefix(prefix)) {
            metadata = { status: "reachable", verified: false, rangeSupported: true, responseStatus: 206,
              archiveFormat: "zip", ...common, observedSizeBytes };
          } else if (format) {
            metadata = { status: "reachable", verified: false, rangeSupported: true, responseStatus: 206,
              documentFormat: format, ...common, observedSizeBytes };
          } else {
            let actualRuntimeSeconds: number | undefined;
            try {
              const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
              if (!encoding || encoding === "identity") {
                actualRuntimeSeconds = await inspectMp4Runtime(url, prefix, observedSizeBytes,
                  request, controller.signal);
              }
              controller.signal.throwIfAborted();
            } catch (error) {
              if (controller.signal.aborted) throw error;
              // Unsupported or unavailable metadata cannot contradict identity.
            }
            metadata = { status: "verified", verified: true, rangeSupported: true, responseStatus: 206,
              ...headerLatency, ...common, observedSizeBytes,
              ...(initialRangeSizeEvidence(response.headers, prefix)
                ? { sizeEvidence: "initial_range_206" as const } : {}),
              ...(actualRuntimeSeconds !== undefined
                ? { actualRuntimeSeconds, runtimeEvidence: "mp4_mvhd" as const } : {}) };
          }
        }
      } else {
        await response.body?.cancel();
        metadata = { status: "unreachable", verified: false, rangeSupported: false, responseStatus: response.status, ...common };
      }
    } catch (error) {
      if (parentSignal?.aborted) {
        throw error instanceof Error ? error : new Error("Direct probe cancelled");
      }
      metadata = abortedByBudget ? budgetExhausted() : {
        status: errorStatus(error, controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError"),
        verified: false, rangeSupported: false
      };
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
      budgetSignal?.removeEventListener("abort", budgetAbort);
    }
    if (abortedByBudget && (metadata.status === "verified" || (metadata.status === "reachable" && !metadata.archiveFormat))) {
      metadata = budgetExhausted();
    }
    if (!metadata.resourceIdentities && resourceIdentities.length && !metadata.archiveFormat && !metadata.documentFormat
      && (metadata.verified || (metadata.status === "reachable" && metadata.responseStatus === 200
        && metadata.contentType?.startsWith("video/")))) {
      metadata = { ...metadata, resourceIdentities };
    }
    if (metadata.status === "verified") this.verified += 1;
    if (effectiveResourceUrl && !metadata.hls && !metadata.archiveFormat && !metadata.documentFormat) {
      const validation = metadata.verified && metadata.rangeSupported && metadata.responseStatus === 206 ? "range_206"
        : metadata.status === "reachable" && metadata.responseStatus === 200 && metadata.contentType?.startsWith("video/")
          ? "video_200" : undefined;
      const movieResource = validation ? movieResourceObservationFromUrl(effectiveResourceUrl, validation) : undefined;
      const episodeResource = validation ? episodeResourceObservationFromUrl(effectiveResourceUrl, validation) : undefined;
      if (movieResource) metadata = { ...metadata, movieResource };
      if (episodeResource) metadata = { ...metadata, episodeResource };
    }
    if (metadata.status === "unreachable" || metadata.status === "timeout" || metadata.status === "route_rejected") this.failures += 1;
    if (metadata.status !== "budget_exhausted") this.store(key, metadata);
    this.log.info("Direct HTTP probe completed", {
      status: metadata.status,
      rangeSupported: metadata.rangeSupported,
      ...(metadata.responseHeaderLatencyMs !== undefined ? { responseHeaderLatencyMs: metadata.responseHeaderLatencyMs } : {})
    });
    return metadata;
  }
}
