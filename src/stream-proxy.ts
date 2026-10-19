import { once } from "node:events";
import { extname } from "node:path";
import type { Request, Response } from "express";
import type { DownloadService } from "./download-service";
import { safeErrorDetails, type Logger } from "./logger";
import type { AppConfig } from "./types";
import { TriblerReadAheadBuffer } from "./tribler-read-ahead-buffer";
import type { TriblerStreamingMetrics } from "./tribler-streaming-metrics";

const INFOHASH_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SINGLE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const responseHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"];
const contentTypes: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo"
};

function parseRange(range: string, size: number): { start: number; end: number } | undefined {
  const match = SINGLE_RANGE_PATTERN.exec(range.trim());
  if (!match) return undefined;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return undefined;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return undefined;
  }
  return { start, end };
}

function routeParams(req: Request): { infohash: string; fileIndex: number } {
  const rawInfohash = req.params.infohash;
  const rawFileIndex = req.params.fileIndex;
  const infohash = typeof rawInfohash === "string" ? rawInfohash : "";
  const fileIndex = Number(typeof rawFileIndex === "string" ? rawFileIndex : "");
  if (!INFOHASH_PATTERN.test(infohash) || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
    throw new Error("Invalid stream path");
  }
  return { infohash: infohash.toLowerCase(), fileIndex };
}

export function createHeadHandler(service: DownloadService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { infohash, fileIndex } = routeParams(req);
      const files = await service.client.getFiles(infohash);
      const file = files.find((candidate) => candidate.index === fileIndex);
      if (!file) {
        res.status(404).end();
        return;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentTypes[extname(file.name).toLowerCase()] ?? "application/octet-stream");
      if (req.headers.range) {
        const range = parseRange(req.headers.range, file.size);
        if (!range) {
          res.status(416).setHeader("Content-Range", `bytes */${file.size}`);
          res.end();
          return;
        }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
        res.setHeader("Content-Length", String(range.end - range.start + 1));
      } else {
        res.status(200);
        res.setHeader("Content-Length", String(file.size));
      }
      res.end();
    } catch {
      res.status(400).json({ error: "Stream metadata unavailable" });
    }
  };
}

export function createStreamHandler(
  service: DownloadService,
  timeoutMs: number,
  log: Logger,
  bufferConfig?: AppConfig["triblerStreamBuffer"], metrics?: TriblerStreamingMetrics
) {
  return async (req: Request, res: Response): Promise<void> => {
    let infohash = "";
    let deliveredBytes = 0;
    const streamStarted = performance.now();
    let observedUpstreamByte = false;
    let observedBridgeByte = false;
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Player disconnected"));
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) abort();
    });

    try {
      const params = routeParams(req);
      infohash = params.infohash;
      service.beginStream(infohash);
      if (metrics) metrics.streamsStarted += 1;
      const timer = setTimeout(() => controller.abort(new Error("Tribler stream header timeout")), timeoutMs);
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(service.client.streamUrl(infohash, params.fileIndex), {
          redirect: "error",
          headers: service.client.streamHeaders(req.headers.range),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      if (metrics) {
        metrics.upstreamHeaderCount += 1;
        metrics.upstreamHeaderMs += Math.round(performance.now() - streamStarted);
      }

      const upstreamByte = (bytes: number): void => {
        if (!metrics || observedUpstreamByte || bytes <= 0) return;
        observedUpstreamByte = true;
        metrics.upstreamFirstByteCount += 1;
        metrics.upstreamFirstByteMs += Math.round(performance.now() - streamStarted);
      };
      const write = async (chunk: Uint8Array): Promise<void> => {
        if (metrics && !observedBridgeByte && chunk.length > 0) {
          observedBridgeByte = true;
          metrics.bridgeFirstByteCount += 1;
          metrics.bridgeFirstByteMs += Math.round(performance.now() - streamStarted);
        }
        const writable = res.write(chunk);
        if (!writable) await once(res, "drain", { signal: controller.signal });
        deliveredBytes += chunk.length;
        if (metrics) metrics.downstreamBytes += chunk.length;
      };

      for (const header of responseHeaders) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.status(upstream.status);
      if (!upstream.body) {
        res.end();
        return;
      }
      if (!bufferConfig?.enabled) {
        for await (const chunk of upstream.body) {
          upstreamByte(chunk.length);
          if (metrics) metrics.upstreamBytes += chunk.length;
          await write(chunk);
        }
      } else {
        const requestedRange = req.headers.range;
        const seek = Boolean(requestedRange && !/^bytes=0-/.test(requestedRange));
        const remaining = Number(upstream.headers.get("content-length"));
        const target = Math.min(seek ? bufferConfig.seekBytes : bufferConfig.startupBytes,
          Number.isSafeInteger(remaining) && remaining > 0 ? remaining : bufferConfig.maxBytes);
        let deliveredBody = false;
        const buffer = new TriblerReadAheadBuffer(upstream.body, {
          startupBytes: target, maxBytes: Math.min(bufferConfig.maxBytes, Number.isSafeInteger(remaining) && remaining > 0 ? remaining : bufferConfig.maxBytes),
          prebufferTimeoutMs: bufferConfig.prebufferTimeoutMs,
          onQueued: (bytes) => { if (metrics) metrics.bufferHighWaterBytes = Math.max(metrics.bufferHighWaterBytes, bytes); },
          onProducerWait: () => { if (metrics) metrics.producerWaitCount += 1; },
          onProducerWaitMs: (ms) => { if (metrics) metrics.producerWaitMs += Math.round(ms); },
          onUpstreamRead: (bytes) => { upstreamByte(bytes); if (metrics) metrics.upstreamBytes += bytes; },
          onConsumerWaitStart: () => { if (metrics) metrics.consumerWaitCount += 1; },
          onConsumerWait: (ms, outcome) => {
            if (metrics && deliveredBody && outcome !== "eof") {
              metrics.underrunCount += 1;
              metrics.underrunMs += ms;
            }
          }
        });
        buffer.start(controller.signal);
        const prebufferStarted = performance.now();
        const prebufferBytes = await buffer.waitForStartup();
        if (metrics) {
          if (seek) { metrics.seekPrebufferCount += 1; metrics.seekPrebufferBytes += prebufferBytes; metrics.seekPrebufferMs += Math.round(performance.now() - prebufferStarted); }
          else { metrics.startupPrebufferCount += 1; metrics.startupPrebufferBytes += prebufferBytes; metrics.startupPrebufferMs += Math.round(performance.now() - prebufferStarted); }
        }
        let chunk: Uint8Array | undefined;
        while ((chunk = await buffer.read())) { deliveredBody = true; await write(chunk); }
      }
      res.end();
      if (metrics) metrics.streamsCompleted += 1;
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (aborted && metrics) metrics.streamsAborted += 1;
      log.warn(aborted ? "Stream cancelled" : "Stream proxy failed", {
        error: safeErrorDetails(error)
      });
      if (!res.headersSent) {
        res.status(aborted ? 504 : 502).json({ error: aborted ? "Stream cancelled or timed out" : "Tribler stream failed" });
      } else {
        res.destroy();
      }
    } finally {
      req.removeListener("aborted", abort);
      if (infohash) service.endStream(infohash, deliveredBytes);
    }
  };
}
