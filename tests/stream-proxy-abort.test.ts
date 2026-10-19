import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { DownloadService } from "../src/download-service";
import { createStreamHandler } from "../src/stream-proxy";
import { TriblerStreamingMetrics } from "../src/tribler-streaming-metrics";
import { silentLogger } from "./helpers";

const hash = "08ada5a7a6183aae1e09d831df6748d566095a10";

afterEach(() => vi.unstubAllGlobals());

describe("stream proxy cancellation during backpressure", () => {
  it("leaves the drain wait when the client closes and records one aborted stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new globalThis.Response(new Uint8Array([1, 2]), {
      status: 206, headers: { "content-length": "2", "content-range": "bytes 0-1/2" }
    })));
    const request = Object.assign(new EventEmitter(), {
      headers: { range: "bytes=0-1" },
      params: { infohash: hash, fileIndex: "5" }
    }) as unknown as Request;
    let wrote!: () => void;
    const writeStarted = new Promise<void>(resolve => { wrote = resolve; });
    const destroy = vi.fn();
    const endStream = vi.fn();
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      headersSent: true,
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      write: vi.fn().mockImplementation(() => { wrote(); return false; }),
      end: vi.fn(),
      destroy
    }) as unknown as Response;
    const service = {
      client: { streamUrl: () => "http://127.0.0.1:1/stream", streamHeaders: () => new Headers() },
      beginStream: vi.fn(), endStream
    } as unknown as DownloadService;
    const metrics = new TriblerStreamingMetrics();
    const handler = createStreamHandler(service, 1_000, silentLogger, {
      enabled: true, startupBytes: 1, seekBytes: 1, maxBytes: 4, prebufferTimeoutMs: 1_000
    }, metrics);
    const running = handler(request, response);
    await writeStarted;
    response.emit("close");
    await running;
    expect(metrics.streamsStarted).toBe(1);
    expect(metrics.streamsCompleted).toBe(0);
    expect(metrics.streamsAborted).toBe(1);
    expect(metrics.snapshot()).toMatchObject({ upstreamHeaderCount: 1, upstreamFirstByteCount: 1, bridgeFirstByteCount: 1 });
    expect(destroy).toHaveBeenCalledOnce();
    expect(endStream).toHaveBeenCalledOnce();
  });
});
