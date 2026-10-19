import { once } from "node:events";
import { extname } from "node:path";
import type { Request, Response } from "express";
import type { CatalogProvider, DirectStreamSource } from "./catalog/types";
import type { DownloadService } from "./download-service";
import { safeErrorDetails, type Logger } from "./logger";
import { strongEtag, type SourceHeaderScope, type SourceRequestHeaders } from "./network/http-privacy";
import type { RepresentationState } from "./playback/representation";
import type { OutboundResponse, OutboundTransport } from "./network/outbound-transport";
import { parseStreamId } from "./source";
import { isHlsContentType, readHlsPlaylist } from "./hls-playlist";

const responseHeaders = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges"
];
const contentTypes: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo"
};

export interface HlsProxyOptions {
  rewritePlaylist(text: string, parentUrl: string, sourceHeaders?: SourceRequestHeaders, scope?: SourceHeaderScope): Promise<string>;
  /** Only opaque HLS media-segment tokens may synthesize a local byte range. */
  mediaSegment?: boolean;
}

export function encodeStreamId(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeStreamId(token: string): string {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(token)) throw new Error("Invalid automatic stream token");
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  if (!decoded || encodeStreamId(decoded) !== token) throw new Error("Invalid automatic stream token");
  return decoded;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function queryFileIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid stream file index");
  return parsed;
}

function clientSignal(req: Request, res: Response): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(new Error("Player disconnected"));
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  };
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timer = setTimeout(() => controller.abort(new Error("Direct HTTP stream stalled")), timeoutMs);
  try {
    return await reader.read();
  } finally {
    clearTimeout(timer);
  }
}

const LOCAL_RANGE_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;

function parseSingleByteRange(
  value: string,
  totalLength: number
): { start: number; end: number } | undefined {
  if (totalLength <= 0) return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return undefined;

  const startText = match[1];
  const endText = match[2];

  if (!startText && !endText) return undefined;

  // Suffix range: bytes=-500
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }

    const length = Math.min(suffixLength, totalLength);
    return {
      start: totalLength - length,
      end: totalLength - 1
    };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalLength) {
    return undefined;
  }

  let end = totalLength - 1;

  if (endText) {
    const requestedEnd = Number(endText);
    if (
      !Number.isSafeInteger(requestedEnd) ||
      requestedEnd < start
    ) {
      return undefined;
    }

    end = Math.min(requestedEnd, totalLength - 1);
  }

  return { start, end };
}

async function readBodyBounded(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
  maxBytes: number
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const chunk = await readWithTimeout(reader, timeoutMs, controller);

      if (chunk.done) break;

      total += chunk.value.length;

      if (total > maxBytes) {
        throw new Error(
          "Direct HTTP ignored Range and response is too large for local range fallback"
        );
      }

      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel();
  }

  return Buffer.concat(chunks, total);
}

function supportedSingleRange(value: string): boolean {
  if (value.length > 256) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;
  return [match[1], match[2]].filter(Boolean).every(value => Number.isSafeInteger(Number(value)))
    && (match[1] ? !match[2] || Number(match[2]) >= Number(match[1]) : Number(match[2]) > 0);
}

function partialLength(response: globalThis.Response, range: string | undefined): number {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (!range || !match) throw new Error("Invalid partial response metadata");
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  const expected = parseSingleByteRange(range, total);
  if (![start, end, total].every(Number.isSafeInteger) || !expected || start !== expected.start
    || end < start || end > expected.end || end >= total) throw new Error("Invalid partial response range");
  const length = end - start + 1;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) throw new Error("Invalid partial response length");
  return length;
}

export async function proxyDirectHttp(
  direct: DirectStreamSource & { requestHeaders?: SourceRequestHeaders; sourceHeaderScope?: SourceHeaderScope },
  req: Request, res: Response, timeoutMs: number, clientAbort: AbortSignal,
  method: "GET" | "HEAD", transport: OutboundTransport, hls?: HlsProxyOptions,
  representation?: RepresentationState
): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(clientAbort.reason);
  clientAbort.addEventListener("abort", abort, { once: true });
  const headerTimer = setTimeout(() => controller.abort(new Error("Direct HTTP header timeout")), timeoutMs);
  const requestedRange = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const conditional = requestedRange !== undefined && req.headers["if-range"] !== undefined;
  const operation = representation?.begin(conditional ? req.headers["if-range"] : undefined);
  let outbound: OutboundResponse;
  let sourceHeaderScope = direct.sourceHeaderScope;
  let forceFullResponse = method === "HEAD" || Boolean(requestedRange && !supportedSingleRange(requestedRange));
  try {
    const entry = new URL(direct.url);
    sourceHeaderScope ??= { origin: entry.origin, httpsOnly: entry.protocol === "https:" };
    // Known playlists are transformed whole representations, never byte-range resources.
    forceFullResponse ||= Boolean(hls && !hls.mediaSegment && (entry.pathname.toLowerCase().endsWith(".m3u8")
      || direct.fileName.toLowerCase().endsWith(".m3u8")));
    const headers = new Headers({ Accept: "*/*" });
    if (requestedRange && !forceFullResponse) headers.set("Range", requestedRange);
    outbound = await transport.request({ url: direct.url, method, headers, sourceHeaderScope, conditionalRange: conditional,
      forceFullResponse, ...(operation?.binding ? { rangeBinding: operation.binding, rangeBindingActive: operation.bindingActive } : {}),
      ...(direct.requestHeaders ? { sourceHeaders: direct.requestHeaders } : {}) }, controller.signal);
    sourceHeaderScope = outbound.sourceHeaderScope ?? { ...sourceHeaderScope,
      httpsOnly: sourceHeaderScope.httpsOnly || new URL(outbound.effectiveUrl).protocol === "https:" };
  } catch (error) {
    operation?.invalidate(); clientAbort.removeEventListener("abort", abort);
    if (!controller.signal.aborted) controller.abort();
    throw error;
  } finally { clearTimeout(headerTimer); }

  const { response: upstream, effectiveUrl } = outbound;
  // Older boundary substitutes may lack metadata; only unconditional ranges may infer it.
  const rangeSent = outbound.rangeSent ?? (!conditional && !forceFullResponse ? requestedRange : undefined);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (upstream.status === 416) {
      const match = /^bytes \*\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "");
      const total = match ? Number(match[1]) : NaN;
      if (!rangeSent || !Number.isSafeInteger(total) || parseSingleByteRange(rangeSent, total)) throw new Error("Invalid unsatisfied range metadata");
      await upstream.body?.cancel();
      res.setHeader("Content-Range", `bytes */${total}`); res.setHeader("Content-Length", "0");
      res.status(416).end(); return;
    }
    if (!upstream.ok) throw new Error(`Direct HTTP returned ${upstream.status}`);
    const responseType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase();
    const identityEncoding = !encoding || encoding === "identity";
    const hlsCandidate = Boolean(hls) && (isHlsContentType(responseType)
      || new URL(direct.url).pathname.toLowerCase().endsWith(".m3u8")
      || new URL(effectiveUrl).pathname.toLowerCase().endsWith(".m3u8"));
    if (hlsCandidate && hls) {
      operation?.invalidate();
      if (upstream.status !== 200 || !identityEncoding) throw new Error("HLS playlist representation is incomplete");
      res.setHeader("Content-Type", responseType && isHlsContentType(responseType) ? responseType : "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      if (method === "HEAD") { await upstream.body?.cancel(); res.status(200).end(); return; }
      const playlist = await readHlsPlaylist(upstream.body, controller.signal);
      const rewritten = await hls.rewritePlaylist(playlist, effectiveUrl, direct.requestHeaders, sourceHeaderScope);
      res.setHeader("Content-Length", Buffer.byteLength(rewritten)); res.status(200).end(rewritten); return;
    }
    if ((upstream.status === 206 || conditional) && !identityEncoding) throw new Error("Unsupported range representation encoding");
    const expectedLength = upstream.status === 206 ? partialLength(upstream, rangeSent) : undefined;
    if (upstream.status === 206 && conditional && (!outbound.conditionalRangeSent || !operation?.active() || !operation.binding
      || outbound.representationRequestKey !== operation.binding.requestKey
      || strongEtag(upstream.headers.get("etag")) !== operation.binding.upstreamEtag)) {
      throw new Error("Conditional range representation is not verified");
    }
    const observe = (): string | undefined => operation?.observe(effectiveUrl,
      identityEncoding ? outbound.representationRequestKey : undefined, upstream.headers.get("etag"), method === "GET");
    const copyHeaders = (): void => {
      for (const header of responseHeaders) {
        if (header === "content-range" && upstream.status !== 206) continue;
        const value = upstream.headers.get(header);
        if (header === "accept-ranges" && value !== "bytes" && value !== "none") continue;
        if (value) res.setHeader(header, value);
      }
    };
    // Without framing, validate a bounded partial body completely before exposing it.
    if (method === "GET" && expectedLength !== undefined && !upstream.headers.has("content-length")) {
      if (expectedLength > LOCAL_RANGE_FALLBACK_MAX_BYTES || !upstream.body) throw new Error("Unframed partial response exceeds validation bound");
      const body = await readBodyBounded(upstream.body, timeoutMs, controller, expectedLength);
      if (body.length !== expectedLength || (conditional && !operation?.active())) throw new Error("Unframed partial response is not verified");
      const etag = observe(); if (etag) res.setHeader("ETag", etag);
      copyHeaders(); res.setHeader("Content-Length", expectedLength); res.status(206).end(body); return;
    }
    if (method === "GET" && rangeSent && !conditional && upstream.status === 200 && hls?.mediaSegment) {
      if (!identityEncoding) throw new Error("Unsupported range representation encoding");
      if (!upstream.body) throw new Error("Direct HTTP returned no body");
      const declared = upstream.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))
        || Number(declared) > LOCAL_RANGE_FALLBACK_MAX_BYTES)) throw new Error("Direct HTTP ignored Range and response is too large for local range fallback");
      const body = await readBodyBounded(upstream.body, timeoutMs, controller, LOCAL_RANGE_FALLBACK_MAX_BYTES);
      if (declared !== null && Number(declared) !== body.length) throw new Error("Invalid complete segment length");
      const range = parseSingleByteRange(rangeSent, body.length);
      if (!range) { res.setHeader("Content-Range", `bytes */${body.length}`); res.setHeader("Content-Length", "0"); res.status(416).end(); return; }
      const etag = observe(); if (etag) res.setHeader("ETag", etag);
      const selected = body.subarray(range.start, range.end + 1);
      res.setHeader("Content-Type", responseType ?? "application/octet-stream"); res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${body.length}`); res.setHeader("Content-Length", selected.length);
      res.status(206).end(selected); return;
    }
    if (rangeSent && !conditional && upstream.status !== 206) throw new Error("Direct HTTP did not honor the Range request");
    let firstChunk: ReadableStreamReadResult<Uint8Array> | undefined;
    if (method === "GET") {
      if (!upstream.body) throw new Error("Direct HTTP returned no body");
      reader = upstream.body.getReader(); firstChunk = await readWithTimeout(reader, timeoutMs, controller);
      if (expectedLength !== undefined && (firstChunk.done || firstChunk.value.length > expectedLength)) throw new Error("Invalid partial response body");
    }
    if (expectedLength !== undefined && conditional && !operation?.active()) throw new Error("Conditional range token expired");
    const etag = observe(); if (etag) res.setHeader("ETag", etag);
    copyHeaders();
    if (expectedLength !== undefined) res.setHeader("Content-Length", expectedLength);
    if (!res.hasHeader("Accept-Ranges")) res.setHeader("Accept-Ranges", "bytes");
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", contentTypes[extname(direct.fileName).toLowerCase()] ?? "application/octet-stream");
    res.status(upstream.status);
    if (method === "HEAD") { await upstream.body?.cancel(); res.end(); return; }
    let sent = 0;
    const write = async (value: Uint8Array): Promise<void> => {
      if (expectedLength !== undefined && conditional && !operation?.active()) throw new Error("Conditional range token expired");
      sent += value.length;
      if (expectedLength !== undefined && sent > expectedLength) throw new Error("Partial response body exceeds its range");
      if (value.length && !res.write(value)) await once(res, "drain");
    };
    if (firstChunk && !firstChunk.done) await write(firstChunk.value);
    while (reader) { const chunk = await readWithTimeout(reader, timeoutMs, controller); if (chunk.done) break; await write(chunk.value); }
    if (expectedLength !== undefined && sent !== expectedLength) throw new Error("Partial response body is truncated");
    res.end();
  } catch (error) { operation?.invalidate(); throw error; }
  finally {
    await reader?.cancel().catch(() => undefined);
    clientAbort.removeEventListener("abort", abort);
    if (!controller.signal.aborted) controller.abort();
  }
}

export function createAutomaticStreamHandler(
  service: DownloadService,
  catalogInput: CatalogProvider | CatalogProvider[],
  legalTestMagnet: string | undefined,
  timeoutMs: number,
  log: Logger,
  method: "GET" | "HEAD",
  transport: OutboundTransport,
  hls?: HlsProxyOptions
) {
  const catalogs = Array.isArray(catalogInput) ? catalogInput : [catalogInput];
  return async (req: Request, res: Response): Promise<void> => {
    const lifecycle = clientSignal(req, res);
    let id = "";
    let direct: DirectStreamSource | undefined;
    try {
      const rawToken = req.params.token;
      id = decodeStreamId(typeof rawToken === "string" ? rawToken : "");
      const catalog = catalogs.find((candidate) => candidate.owns(id));
      const ownedByCatalog = catalog !== undefined;
      const requestedFileName = queryString(req.query.file);
      const requestedFileIndex = queryFileIndex(req.query.fileIndex);
      if (ownedByCatalog) {
        const directStreams = catalog.getDirectStreams
          ? await catalog.getDirectStreams(id, lifecycle.signal)
          : catalog.getDirectStream
            ? [await catalog.getDirectStream(id, lifecycle.signal)].filter(
                (candidate): candidate is DirectStreamSource => candidate !== undefined
              )
            : [];
        direct = requestedFileName
          ? directStreams.find((candidate) => candidate.fileName === requestedFileName)
          : directStreams[0];
        if (requestedFileName && !direct) throw new Error("Unknown video variant");
      }
      const forceTribler = req.query.source === "tribler";
      if (!forceTribler) {
        if (!direct) throw new Error("Direct playback source is missing");
        await proxyDirectHttp(direct, req, res, timeoutMs, lifecycle.signal, method, transport, hls);
        log.info("Direct stream served over privacy transport");
        return;
      }

      const supportsTribler = catalog?.supportsTriblerFallback
        ? await catalog.supportsTriblerFallback(id, lifecycle.signal)
        : true;
      if (!supportsTribler) throw new Error("This item has no BitTorrent source");
      const request = ownedByCatalog
        ? { source: await catalog.getTorrentSource(id, lifecycle.signal) }
        : parseStreamId(id, legalTestMagnet);
      const resolved = await service.resolve(
        request.source,
        requestedFileIndex ?? request.fileIndex,
        lifecycle.signal,
        direct ? { name: direct.fileName, size: direct.size } : undefined
      );
      log.info("Explicit Tribler stream selected", {
        id,
        infohash: resolved.infohash,
        fileName: resolved.file.name
      });
      res.redirect(307, resolved.url);
    } catch (error) {
      const aborted = lifecycle.signal.aborted;
      log.warn(aborted ? "Stream playback cancelled" : "Stream playback failed", {
        id,
        error: safeErrorDetails(error)
      });
      if (!res.headersSent) {
        res.status(aborted ? 499 : 502).json({
          error: aborted ? "Player disconnected" : req.query.source === "tribler" ? "No playback source available" : "Direct playback failed"
        });
      } else {
        res.destroy();
      }
    } finally {
      lifecycle.dispose();
    }
  };
}
