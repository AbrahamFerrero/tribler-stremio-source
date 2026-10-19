import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import type { NormalizedStreamSource } from "../src/streams/types";
import { MP4_INSPECTION_BYTES } from "../src/streams/mp4-runtime";
import { mp4Fixture } from "./mp4-fixture";
import { fixtureOutboundRequest, silentLogger, type FixtureOutboundRequest } from "./helpers";

function source(url = "https://media.example/video.mp4"): NormalizedStreamSource {
  return { providerId: "test", type: "https", url, quality: "1080p", sizeBytes: 8 * 1024 ** 3 };
}

function transport(request: FixtureOutboundRequest): OutboundTransport {
  return { id: "fake", request: fixtureOutboundRequest(request), diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 }) };
}

function probe(request: FixtureOutboundRequest, log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }): DirectStreamProbe {
  return new DirectStreamProbe(transport(request), {
    enabled: true, timeoutMs: 50, maxCandidates: 8, maxConcurrent: 2
  }, log);
}

describe("DirectStreamProbe", () => {
  it("retries Range 403 within one candidate, preserving headers and the fallback's HLS effective URL", async () => {
    const url = "https://entry.example/opaque";
    const finalUrl = "https://cdn.example/live/index.m3u8";
    const sourceHeaders = { Referer: "https://entry.example/", Origin: "https://entry.example", Accept: "*/*" };
    const cancel = vi.fn();
    const request = vi.fn<OutboundTransport["request"]>().mockImplementation((outbound) => {
      if (new Headers(outbound.headers).has("range")) {
        return Promise.resolve({ response: new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 403, headers: { "Content-Type": "text/html" }
        }), effectiveUrl: "https://entry.example/denied" });
      }
      expect(cancel).toHaveBeenCalledOnce();
      return Promise.resolve(outbound.url === url
        ? { response: new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts", {
            headers: { "Content-Type": "application/octet-stream" }
          }), effectiveUrl: finalUrl }
        : { response: new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "video/mp2t" }
          }), effectiveUrl: outbound.url });
    });
    const instance = new DirectStreamProbe({ ...transport(() => Promise.reject(new Error("unused"))), request }, {
      enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
    }, silentLogger);
    const result = await instance.probe([{ ...source(url), requestHeaders: sourceHeaders }, source("https://media.example/unused")]);
    expect(result[0]?.directHttp).toMatchObject({ status: "verified", verified: true, hls: true,
      rangeSupported: false, responseStatus: 200 });
    expect(result[1]?.directHttp).toBeUndefined();
    expect(request.mock.calls.map(([outbound]) => outbound.url)).toEqual([url, url, "https://cdn.example/live/segment.ts"]);
    expect(request.mock.calls.map(([outbound]) => new Headers(outbound.headers).get("range")))
      .toEqual(["bytes=0-63", null, null]);
    expect(request.mock.calls.every(([outbound]) => outbound.sourceHeaders === sourceHeaders)).toBe(true);
    const signal = request.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(request.mock.calls.every(([, current]) => current === signal)).toBe(true);
    expect(instance.diagnostics().requests).toBe(1);
  });

  it("handles Range 416 with a bounded no-Range media prefix using the existing reachable policy", async () => {
    const cancel = vi.fn();
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(64) });
    const body = { getReader: () => ({ read, cancel }) } as unknown as ReadableStream<Uint8Array>;
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response(null, { status: 416 }))
      .mockResolvedValueOnce({ status: 200, headers: new Headers({ "Content-Type": "video/mp4" }), body } as Response);
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp).toMatchObject({ status: "reachable", verified: false,
      rangeSupported: false, responseStatus: 200, contentType: "video/mp4" });
    expect(request.mock.calls.map(([outbound]) => new Headers(outbound.headers).get("range")))
      .toEqual(["bytes=0-63", null]);
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([403, 416, 404])("does not retry again when the fallback returns %s", async (status) => {
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status }));
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false, responseStatus: status });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 404, 408, 425, 428, 429, 500])("does not trigger a compatibility fallback for initial %s", async (status) => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(null, { status }));
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", responseStatus: status });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not certify a partial HLS response from the compatibility fallback", async () => {
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response("#EXTM3U\n", { status: 206,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Content-Range": "bytes 0-7/100" } }));
    const result = await probe(request).probe([source("https://media.example/opaque")]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false, responseStatus: 206 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the original deadline when the compatibility fallback stalls", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<FixtureOutboundRequest>()
        .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(new Response(null, { status: 403 })), 20)))
        .mockImplementationOnce((_outbound, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(
          signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
        ), { once: true })));
      const pending = probe(request).probe([source()]);
      await vi.advanceTimersByTimeAsync(20);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30);
      expect((await pending)[0]?.directHttp).toMatchObject({ status: "budget_exhausted", verified: false });
      expect(request.mock.calls[1]?.[1]).toBe(request.mock.calls[0]?.[1]);
      expect(request.mock.calls[1]?.[1]?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("prioritizes structural video evidence within providers without changing round-robin slots", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(new Response(new Uint8Array(16), {
      status: 206, headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "video/mp4" }
    })));
    const instance = new DirectStreamProbe(transport(request), {
      enabled: true, timeoutMs: 500, maxCandidates: 4, maxConcurrent: 1
    }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
    const candidates: NormalizedStreamSource[] = [
      { ...source("https://media.example/a-opaque"), providerId: "a" },
      { ...source("http://media.example/a-video.mp4"), type: "http", providerId: "a" },
      { ...source("https://media.example/a-first.mp4"), providerId: "a" },
      { ...source("https://media.example/a-second.mp4"), providerId: "a" },
      { ...source("http://media.example/b-opaque"), type: "http", providerId: "b" },
      { ...source("https://media.example/b-video.mp4"), providerId: "b" }
    ];
    const result = await instance.probe(candidates);
    expect(request.mock.calls.map(([outbound]) => outbound.url)).toEqual([
      "https://media.example/a-first.mp4", "https://media.example/b-video.mp4",
      "https://media.example/a-second.mp4", "http://media.example/b-opaque"
    ]);
    expect(result.map((candidate) => candidate.directHttp?.status)).toEqual([
      undefined, undefined, "verified", "verified", "verified", "verified"
    ]);
    expect(instance.diagnostics().requests).toBe(4);
  });

  it.each(["prefix", "tail"] as const)("measures %s MP4 with at most one bounded extra range", async (placement) => {
    const media = mp4Fixture(240, placement);
    let inspected = 0;
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation((outbound) => {
      const range = new Headers(outbound.headers).get("range")!;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), media.length - 1);
      inspected += end - start + 1;
      return Promise.resolve(new Response(Uint8Array.from(media.subarray(start, end + 1)), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${media.length}` } }));
    });
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp).toMatchObject({ status: "verified", actualRuntimeSeconds: 240,
      runtimeEvidence: "mp4_mvhd" });
    expect(request).toHaveBeenCalledTimes(placement === "prefix" ? 1 : 2);
    expect(inspected).toBeLessThanOrEqual(64 + MP4_INSPECTION_BYTES);
  });

  it("fails open on an invalid MP4 follow-up Range without reading further", async () => {
    const media = mp4Fixture(240, "tail");
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response(Uint8Array.from(media.subarray(0, 16)), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-15/${media.length}` } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(media), { status: 200,
        headers: { "Content-Type": "video/mp4" } }));
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp).toMatchObject({ status: "verified", verified: true });
    expect(result[0]?.directHttp?.actualRuntimeSeconds).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("leaves a moov followed by extra padding unknown within the bounded boundary read", async () => {
    const media = Buffer.concat([mp4Fixture(240, "tail"), Buffer.alloc(MP4_INSPECTION_BYTES)]);
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation((outbound) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(outbound.headers).get("range")!)!;
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), media.length - 1);
      return Promise.resolve(new Response(Uint8Array.from(media.subarray(start, end + 1)), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${media.length}` } }));
    });
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp?.actualRuntimeSeconds).toBeUndefined();
    expect(result[0]?.directHttp?.status).toBe("verified");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("caller cancellation during MP4 inspection stops before a tail request", async () => {
    const media = mp4Fixture(240, "tail");
    const caller = new AbortController();
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation((outbound, signal) => {
      if (new Headers(outbound.headers).get("range") !== "bytes=0-63") {
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(
          signal.reason instanceof Error ? signal.reason : new Error("cancelled")
        ), { once: true }));
      }
      return Promise.resolve(new Response(Uint8Array.from(media.subarray(0, 16)), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-15/${media.length}` } }));
    });
    const instance = new DirectStreamProbe(transport(request), {
      enabled: true, timeoutMs: 5_000, maxCandidates: 1, maxConcurrent: 1
    }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
    const pending = instance.probe([source()], caller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    caller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("releases a slow MP4 metadata read at its attempt slice so the queued source is probed", async () => {
    vi.useFakeTimers();
    try {
      const media = mp4Fixture(240);
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation((outbound, signal) => {
        if (outbound.url.endsWith("slow.mp4") && new Headers(outbound.headers).get("range") !== "bytes=0-63") {
          return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(
            signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
          ), { once: true }));
        }
        return Promise.resolve(new Response(outbound.url.endsWith("slow.mp4")
          ? Uint8Array.from(media.subarray(0, 16)) : new Uint8Array(16), {
          status: 206, headers: { "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-15/${outbound.url.endsWith("slow.mp4") ? media.length : 100}` }
        }));
      });
      const instance = new DirectStreamProbe(transport(request), {
        enabled: true, timeoutMs: 90, maxCandidates: 2, maxConcurrent: 1
      }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
      const pending = instance.probe([source("https://media.example/slow.mp4"), source("https://media.example/fast.mp4")]);
      await vi.advanceTimersByTimeAsync(90);
      const result = await pending;
      expect(result.map((entry) => entry.directHttp?.status)).toEqual(["budget_exhausted", "verified"]);
      expect(request.mock.calls.map(([outbound]) => new Headers(outbound.headers).get("range")))
        .toEqual(["bytes=0-63", `bytes=16-${media.length - 1}`, "bytes=0-63"]);
    } finally { vi.useRealTimers(); }
  });

  it("verifies a valid byte range through the injected transport", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array(16), {
      status: 206,
      headers: { "Content-Range": "bytes 0-15/1234", "Content-Type": "video/mp4" }
    }));
    const result = await probe(request).probe([source()]);
    expect(request).toHaveBeenCalledOnce();
    expect(new Headers(request.mock.calls[0]?.[0].headers).get("range")).toBe("bytes=0-63");
    expect(new Headers(request.mock.calls[0]?.[0].headers).get("accept-encoding")).toBe("identity");
    expect(result[0]?.directHttp).toMatchObject({
      status: "verified", verified: true, rangeSupported: true, responseStatus: 206,
      observedSizeBytes: 1234, contentType: "video/mp4"
    });
    expect(result[0]?.directHttp?.firstByteLatencyMs).toEqual(expect.any(Number));
  });

  it("treats a non-ZIP HTTP 200 as reachable after reading only its initial prefix", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(64) });
    const body = { getReader: () => ({ read, cancel }) } as unknown as ReadableStream<Uint8Array>;
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue({
      status: 200, headers: new Headers({ "Content-Length": "42" }), body
    } as Response);
    const result = await probe(request).probe([source()]);
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(result[0]?.directHttp).toEqual({
      status: "reachable", verified: false, rangeSupported: false, responseStatus: 200, observedSizeBytes: 42
    });
  });

  it.each([
    ["local file header", [0x50, 0x4b, 0x03, 0x04]],
    ["empty archive", [0x50, 0x4b, 0x05, 0x06]],
    ["spanned archive", [0x50, 0x4b, 0x07, 0x08]]
  ])("recognizes a ZIP %s in a bounded 206 response", async (_name, signature) => {
    const bytes = new Uint8Array([...signature, ...new Uint8Array(12)]);
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(bytes, {
      status: 206, headers: { "Content-Range": "bytes 0-15/920441036", "Content-Type": "application/x-zip" }
    }));
    const result = await probe(request).probe([source("https://media.example/movie.mkv")]);
    expect(result[0]?.directHttp).toMatchObject({
      status: "reachable", verified: false, rangeSupported: true, responseStatus: 206,
      archiveFormat: "zip", observedSizeBytes: 920441036, contentType: "application/x-zip"
    });
    expect(new Headers(request.mock.calls[0]?.[0].headers).get("range")).toBe("bytes=0-63");
  });

  it("recognizes an explicit ZIP prefix when a server ignores the range and returns 200", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), { status: 200,
        headers: { "Content-Type": "application/octet-stream" } }
    ));
    const result = await probe(request).probe([source("https://media.example/movie.mkv")]);
    expect(result[0]?.directHttp).toMatchObject({
      status: "reachable", verified: false, rangeSupported: false, responseStatus: 200,
      archiveFormat: "zip", contentType: "application/octet-stream"
    });
  });

  it.each([
    ["html", "\uFEFF  <html>Oops"],
    ["html", " <!doctype html>"],
    ["xml", "  <?xml version"],
    ["json", ' {"error":true}']
  ] as const)("recognizes %s document bytes despite video MIME and leading whitespace", async (format, body) => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(body, {
      status: 206, headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "video/mp4" }
    }));
    const result = await probe(request).probe([source()]);
    expect(result[0]?.directHttp).toMatchObject({ status: "reachable", verified: false,
      documentFormat: format, responseStatus: 206 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps an unknown binary prefix eligible for the existing 206 transport probe", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), {
        status: 206, headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "application/octet-stream" }
      }
    ));
    expect((await probe(request).probe([source()]))[0]?.directHttp).toMatchObject({ status: "verified", verified: true });
  });

  it("does not verify a 206 response with a non-initial or oversized Content-Range", async () => {
    for (const contentRange of ["bytes 1-15/100", "bytes 0-64/100", "bytes 0-15/15"]) {
      const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array(16), {
        status: 206, headers: { "Content-Range": contentRange, "Content-Type": "video/mp4" }
      }));
      const result = await probe(request).probe([source()]);
      expect(result[0]?.directHttp).toMatchObject({
        status: "reachable", verified: false, rangeSupported: false, responseStatus: 206
      });
    }
  });

  it.each([
    ["URL", "https://media.example/live/index.m3u8", "application/octet-stream"],
    ["MIME", "https://media.example/live/stream", "application/vnd.apple.mpegurl"]
  ])("verifies a partial HLS root identified by %s only after traversing media", async (_kind, url, contentType) => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8";
    for (const failure of [undefined, "variant", "segment"] as const) {
      const cancel = vi.fn();
      const partial = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(master.padEnd(64, " "))); },
        cancel
      });
      const request = vi.fn<FixtureOutboundRequest>()
        .mockResolvedValueOnce(new Response(partial, { status: 206,
          headers: { "Content-Type": contentType, "Content-Range": "bytes 0-63/100" } }))
        .mockImplementationOnce(() => {
          expect(cancel).toHaveBeenCalledOnce();
          // Preserve HLS classification even when the full root has no MIME.
          return Promise.resolve(new Response(master));
        })
        .mockResolvedValueOnce(new Response(failure === "variant" ? null : "#EXTM3U\n#EXTINF:4,\nsegment.ts",
          { status: failure === "variant" ? 404 : 200,
            headers: { "Content-Type": "application/vnd.apple.mpegurl" } }))
        .mockResolvedValueOnce(new Response(failure === "segment" ? null : new Uint8Array([1]),
          { status: failure === "segment" ? 404 : 200, headers: { "Content-Type": "video/mp2t" } }));
      const result = await probe(request).probe([source(url)]);
      expect(result[0]?.directHttp).toMatchObject({
        status: failure ? "unreachable" : "verified", verified: !failure, rangeSupported: false, responseStatus: 200
      });
      if (!failure) expect(result[0]?.directHttp?.hls).toBe(true);
      expect(request.mock.calls.map(([outbound]) => outbound.url)).toEqual([
        url, url, "https://media.example/live/media.m3u8",
        ...(failure === "variant" ? [] : ["https://media.example/live/segment.ts"])
      ]);
      expect(request.mock.calls.map(([outbound]) => new Headers(outbound.headers).get("range")))
        .toEqual(["bytes=0-63", null, null, ...(failure === "variant" ? [] : [null])]);
      const signal = request.mock.calls[0]?.[1];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(request.mock.calls.every(([, current]) => current === signal)).toBe(true);
    }
  });

  it.each(["https://media.example/index.m3u8", "https://media.example/stream"])(
    "does not verify or repeatedly retry HLS when %s keeps returning 206", async (url) => {
      const cancelled: number[] = [];
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => {
        const index = request.mock.calls.length;
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode("#EXTM3U\n".padEnd(64, " "))); },
          cancel() { cancelled.push(index); }
        }), { status: 206, headers: {
          ...(index === 1 ? { "Content-Type": "application/vnd.apple.mpegurl" } : {}),
          "Content-Range": "bytes 0-63/100"
        } }));
      });
      const result = await probe(request).probe([source(url)]);
      expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false, responseStatus: 206 });
      expect(request).toHaveBeenCalledTimes(2);
      expect(cancelled).toEqual([1, 2]);
    }
  );

  it("verifies a valid HLS playlist without requiring playlist byte-range support", async () => {
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts?temporary=preserved", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "video/mp2t" } }));
    const result = await probe(request).probe([source("https://media.example/live/index.m3u8")]);
    expect(result[0]?.directHttp).toMatchObject({
      status: "verified", verified: true, hls: true, rangeSupported: false,
      responseStatus: 200, contentType: "application/vnd.apple.mpegurl"
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0].url).toContain("temporary=preserved");
  });

  it("verifies a mislabelled HLS MPEG-TS segment from its bounded packet signature", async () => {
    const segment = new Uint8Array(377);
    segment[0] = 0x47;
    segment[188] = 0x47;
    segment[376] = 0x47;

    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:4,\nsegment.png", {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))
      .mockResolvedValueOnce(new Response(segment, {
        status: 200,
        headers: { "Content-Type": "image/png" }
      }));

    const result = await probe(request)
      .probe([source("https://media.example/live/index.m3u8")]);

    expect(result[0]?.directHttp).toMatchObject({
      status: "verified",
      verified: true,
      hls: true,
      responseStatus: 200
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a false MPEG-TS prefix when only the first sync byte matches", async () => {
    const fake = new Uint8Array(377);
    fake[0] = 0x47;

    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:4,\nimage.png", {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))
      .mockResolvedValueOnce(new Response(fake, {
        status: 200,
        headers: { "Content-Type": "image/png" }
      }));

    const result = await probe(request)
      .probe([source("https://media.example/live/index.m3u8")]);

    expect(result[0]?.directHttp).toMatchObject({
      status: "unreachable",
      verified: false,
      responseStatus: 200
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a valid HLS root leads to an unreachable media reference", async () => {
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:4,\nsegment.html", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))
      .mockResolvedValueOnce(new Response("<html>forbidden</html>", { status: 403, headers: { "Content-Type": "text/html" } }));
    const result = await probe(request).probe([source("https://media.example/live/index.m3u8")]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false, rangeSupported: false, responseStatus: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds nested HLS playlists at two transitions without requesting another variant", async () => {
    const master = new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nnext.m3u8", {
      status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
    });
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(master)
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nnext.m3u8", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nnext.m3u8", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }));
    const result = await probe(request).probe([source("https://media.example/live/index.m3u8")]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not certify progression when every listed segment resolves to the same URL", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(
      "#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXTINF:4,\nsegment.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }
    ));
    const result = await probe(request).probe([source("https://media.example/live/index.m3u8")]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it("fails closed when an HLS-looking response has no playlist header", async () => {
    const result = await probe(() => Promise.resolve(new Response("not a playlist", {
      status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
    }))).probe([source("https://media.example/live/index.m3u8")]);
    expect(result[0]?.directHttp).toMatchObject({ status: "unreachable" });
    expect(result[0]?.directHttp).not.toHaveProperty("hls");
  });

  it("classifies non-successes and shared-budget exhaustion without leaking destinations to logs", async () => {
    const entries: Array<Record<string, unknown> | undefined> = [];
    const log: Logger = { debug: () => undefined, warn: () => undefined, error: () => undefined,
      info: (_message, context) => entries.push(context) };
    const unavailable = await probe(
      () => Promise.resolve(new Response(null, { status: 503 })), log
    ).probe([source("https://media.example/private?token=not-for-logs")]);
    expect(unavailable[0]?.directHttp?.status).toBe("unreachable");
    expect(JSON.stringify(entries)).not.toContain("token");
    expect(JSON.stringify(entries)).not.toContain("media.example");

    const timedOut = await probe((_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(
        signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
      ), { once: true });
    })).probe([source()]);
    expect(timedOut[0]?.directHttp?.status).toBe("budget_exhausted");
  });

  it("derives and caches bounded HLS VOD duration from the fetched media playlist", async () => {
    const media = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:60,\nfirst.ts\n#EXTINF:60,\nlast.ts\n#EXT-X-ENDLIST\n";
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response(media, { status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": String(Buffer.byteLength(media)) } }))
      .mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1]), { status: 200,
        headers: { "Content-Type": "video/mp2t" } })));
    const instance = probe(request);
    const input = source("https://media.example/movie/index.m3u8");
    const first = await instance.probe([input]);
    const cached = await instance.probe([input]);
    expect(first[0]?.directHttp).toMatchObject({ status: "verified", verified: true, hls: true,
      runtimeEvidence: "hls_vod", actualRuntimeSeconds: 120 });
    expect(cached[0]?.directHttp).toEqual(first[0]?.directHttp);
    expect(request).toHaveBeenCalledTimes(3);
    expect(instance.diagnostics().cacheHits).toBe(1);
  });

  it("does not start a later selected candidate after the shared budget expires", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation((_outbound, signal) => {
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(
          signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
        ), { once: true }));
      });
      const instance = new DirectStreamProbe(transport(request), {
        enabled: true, timeoutMs: 50, maxCandidates: 3, maxConcurrent: 1
      }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
      const pending = instance.probe([source("https://media.example/first.mp4"),
        source("https://media.example/second.mp4"), source("https://media.example/third.mp4")]);
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(request).toHaveBeenCalledTimes(2);
      expect(result.map((entry) => entry.directHttp?.status)).toEqual([
        "budget_exhausted", "budget_exhausted", "budget_exhausted"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses at most one replacement for a deterministic rejection with a one-candidate cap", async () => {
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response(null, { status: 428 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(16), { status: 206,
        headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "video/mp4" } }));
    const instance = new DirectStreamProbe(transport(request), {
      enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
    }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
    const candidates = [source("https://media.example/bad.mp4"), source("https://media.example/good.mp4"),
      source("https://media.example/unprobed.mp4")];
    const result = await instance.probe(candidates, undefined,
      (candidate) => candidate.directHttp?.responseStatus === 428);
    expect(result.map((candidate) => candidate.directHttp?.status)).toEqual(["unreachable", "verified", undefined]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("marks an in-flight shared-budget abort distinctly and retries it on a later resolution", async () => {
    vi.useFakeTimers();
    try {
      const entries: Array<Record<string, unknown> | undefined> = [];
      const log: Logger = { debug: () => undefined, warn: () => undefined, error: () => undefined,
        info: (_message, context) => entries.push(context) };
      const request = vi.fn<FixtureOutboundRequest>()
        .mockImplementationOnce((_outbound, signal) => new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(
            signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
          ), { once: true })))
        .mockResolvedValue(new Response(new Uint8Array(16), {
          status: 206, headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "video/mp4" }
        }));
      const instance = new DirectStreamProbe(transport(request), {
        enabled: true, timeoutMs: 50, maxCandidates: 1, maxConcurrent: 1
      }, log);
      const candidate = source("https://media.example/movie.mp4?signature=private");
      const pending = instance.probe([candidate]);
      await vi.advanceTimersByTimeAsync(50);
      expect((await pending)[0]?.directHttp).toMatchObject({
        status: "budget_exhausted", verified: false, rangeSupported: false
      });
      expect(JSON.stringify(entries)).toContain("budget_exhausted");
      expect(JSON.stringify(entries)).not.toContain("media.example");
      expect(JSON.stringify(entries)).not.toContain("signature");
      expect((await instance.probe([candidate]))[0]?.directHttp?.status).toBe("verified");
      expect(request).toHaveBeenCalledTimes(2);
      expect(instance.diagnostics().cacheHits).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a candidate's own early timeout classification", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() =>
        new Promise((_resolve, reject) => setTimeout(() => reject(new DOMException("request timed out", "TimeoutError")), 10)));
      const pending = probe(request).probe([source()]);
      await vi.advanceTimersByTimeAsync(10);
      expect((await pending)[0]?.directHttp).toMatchObject({ status: "timeout", verified: false });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates caller cancellation instead of reporting budget exhaustion", async () => {
    const caller = new AbortController();
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation((_outbound, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(
        signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
      ), { once: true })));
    const pending = probe(request).probe([source()], caller.signal);
    caller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
    expect(request).toHaveBeenCalledOnce();
  });

  it("caches only an opaque in-memory result and keeps provider metadata immutable", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Range": "bytes 0-0/1" }
    }));
    const instance = probe(request);
    const original = source("https://media.example/video.mp4?temporary=secret");
    await instance.probe([original]);
    const second = await instance.probe([original]);
    expect(request).toHaveBeenCalledOnce();
    expect(original.directHttp).toBeUndefined();
    expect(second[0]?.directHttp?.status).toBe("verified");
    expect(instance.diagnostics()).toMatchObject({ requests: 1, cacheHits: 1, verified: 1 });
  });
});


describe("redirected HLS probe bases", () => {
  it("resolves root, variant, audio, key, map, and segments from each final playlist URL", async () => {
    const entry = "https://entry.example/redirect?token=hidden";
    const root = "https://cdn.example/series/master.m3u8";
    const audioRequest = "https://cdn.example/series/audio.m3u8";
    const audioFinal = "https://audio.example/renditions/en/index";
    const variantRequest = "https://cdn.example/series/variant.m3u8";
    const variantFinal = "https://video.example/asset/variant";
    const seen: string[] = [];
    const playlist = (body: string, effectiveUrl: string) => ({
      response: new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
      effectiveUrl
    });
    const transport: OutboundTransport = {
      id: "redirect-fixture",
      diagnostics: () => ({ transport: "redirect-fixture", requests: seen.length, failures: 0, averageLatencyMs: 0 }),
      request: (outbound) => {
        seen.push(outbound.url);
        if (outbound.url === entry) return Promise.resolve(playlist(
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n'
          + '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\nvariant.m3u8', root));
        if (outbound.url === audioRequest) return Promise.resolve(playlist(
          "#EXTM3U\n#EXTINF:4,\naudio.ts", audioFinal));
        if (outbound.url === variantRequest) return Promise.resolve(playlist(
          '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
          + '#EXTINF:4,\nfirst.ts\n#EXTINF:4,\nlast.ts', variantFinal));
        return Promise.resolve({
          response: new Response(new Uint8Array([1, 2, 3]), { status: 200,
            headers: { "Content-Type": outbound.url.endsWith("audio.ts") ? "audio/aac" : "video/mp2t" } }),
          effectiveUrl: outbound.url
        });
      }
    };
    const instance = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
    }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
    const result = await instance.probe([source(entry)]);
    expect(result[0]?.directHttp).toMatchObject({ status: "verified", hls: true });
    expect(seen).toEqual([
      entry, audioRequest, "https://audio.example/renditions/en/audio.ts",
      variantRequest, "https://video.example/asset/init.mp4", "https://video.example/asset/key.bin",
      "https://video.example/asset/first.ts", "https://video.example/asset/last.ts"
    ]);
    expect(JSON.stringify(instance.diagnostics())).not.toContain("hidden");
  });
});


describe("redirected HLS source extension", () => {
  it("keeps the original playlist extension hint when the final URL has no extension", async () => {
    const entry = "https://entry.example/master.m3u8";
    const finalUrl = "https://cdn.example/hls/manifest";
    const seen: string[] = [];
    const redirected: OutboundTransport = {
      id: "fixture",
      request: (outbound) => {
        seen.push(outbound.url);
        return Promise.resolve(outbound.url === entry
          ? { response: new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts", {
              status: 200, headers: { "Content-Type": "application/octet-stream" }
            }), effectiveUrl: finalUrl }
          : { response: new Response(new Uint8Array([1]), {
              status: 200, headers: { "Content-Type": "video/mp2t" }
            }), effectiveUrl: outbound.url });
      },
      diagnostics: () => ({ transport: "fixture", requests: seen.length, failures: 0, averageLatencyMs: 0 })
    };
    const instance = new DirectStreamProbe(redirected, {
      enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
    }, { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
    const result = await instance.probe([source(entry)]);
    expect(result[0]?.directHttp).toMatchObject({ status: "verified", hls: true });
    expect(seen).toEqual([entry, "https://cdn.example/hls/segment.ts"]);
  });
});
