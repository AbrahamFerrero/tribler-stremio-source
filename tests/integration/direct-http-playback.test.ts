import { fixtureOutboundRequest } from "../helpers";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "../http-client";
import { createApp } from "../../src/app";
import type { CatalogProvider } from "../../src/catalog/types";
import { DirectTransport, type OutboundTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { silentLogger, testConfig } from "../helpers";

const movieId = "integration:direct-http-playback";
const upstreamUrl = "https://ac5-origin.example/ac5-video.mp4?opaque=upstream-secret";
const payload = Buffer.from(Array.from({ length: 512 }, (_, index) => index));
const ranges = [
  { header: "bytes=0-31", start: 0, end: 31 },
  { header: "bytes=256-287", start: 256, end: 287 },
  { header: "bytes=128-159", start: 128, end: 159 }
] as const;

interface ObservedRequest {
  method: "GET" | "HEAD";
  range: string | null;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("integration bridge failed to bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("integration timeout")), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("direct HTTP playback integration", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await close(server);
    server = undefined;
  });

  it.each([204, 205, 304, 600])("returns a private controlled playback error for upstream %i and then recovers", async status => {
    let failed = true;
    const upstream = createServer((_req, res) => {
      res.writeHead(failed ? status : 200, {
        "Content-Type": "video/mp4", "X-Upstream-Secret": "synthetic-private-header"
      });
      res.end(failed ? undefined : payload);
    });
    try {
      const localUrl = `${await listen(upstream)}/synthetic-private-path.mp4?token=synthetic-private-query`;
      const config = testConfig();
      const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: [localUrl] });
      const transport = new DirectTransport(policy, config.httpPrivacy, silentLogger);
      const catalog: CatalogProvider = {
        definition: { id: "bodyless-fixture", type: "movie", name: "Synthetic fixture" },
        owns: id => id === movieId,
        list: () => Promise.resolve([]),
        get: id => Promise.resolve({ id, type: "movie", name: "Synthetic fixture" }),
        getDirectStream: () => Promise.resolve({ url: localUrl, fileName: "video.mp4", size: payload.length }),
        getTorrentSource: () => Promise.reject(new Error("fixture must use direct playback")),
        supportsTriblerFallback: () => Promise.resolve(false)
      };
      const app = createApp(config, silentLogger, undefined, catalog, policy, transport).app;
      const discovery = await request(app).get(`/stream/movie/${encodeURIComponent(movieId)}.json`).expect(200);
      const discovered = discovery.body as { streams: Array<{ url: string }> };
      const path = new URL(discovered.streams[0]!.url).pathname;
      const response = await request(app).get(path).expect(502);
      expect(response.body).toEqual({ error: "Direct playback failed" });
      expect(JSON.stringify(response.headers)).not.toContain("synthetic-private");
      failed = false;
      const recovered = await request(app).get(path).expect(200);
      expect(recovered.body).toEqual(payload);
    } finally {
      upstream.closeAllConnections();
      await close(upstream);
    }
  });

  it("AC5 proxies HEAD, bytes, seeks, and client abort through the public source route", async () => {
    const observed: ObservedRequest[] = [];
    let torrentCalls = 0;
    let pending = false;
    let signalForPendingRequest: AbortSignal | undefined;
    let pendingStartedResolve!: () => void;
    let pendingAbortedResolve!: () => void;
    const pendingStarted = new Promise<void>((resolve) => { pendingStartedResolve = resolve; });
    const pendingAborted = new Promise<void>((resolve) => { pendingAbortedResolve = resolve; });
    const transport: OutboundTransport = {
      id: "ac5-deterministic-origin",
      request: fixtureOutboundRequest(({ method, headers }, signal) => {
        const range = new Headers(headers).get("range");
        observed.push({ method, range });
        if (pending) {
          signalForPendingRequest = signal;
          pendingStartedResolve();
          return new Promise<Response>((_resolve, reject) => {
            const abort = (): void => {
              pendingAbortedResolve();
              reject(signal?.reason instanceof Error ? signal.reason : new Error("client aborted"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        const common = {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes"
        };
        if (method === "HEAD") {
          return Promise.resolve(new Response(null, {
            status: 200, headers: { ...common, "Content-Length": String(payload.length) }
          }));
        }
        const selected = ranges.find((entry) => entry.header === range);
        if (selected) {
          const chunk = payload.subarray(selected.start, selected.end + 1);
          return Promise.resolve(new Response(chunk, {
            status: 206,
            headers: {
              ...common,
              "Content-Length": String(chunk.length),
              "Content-Range": `bytes ${selected.start}-${selected.end}/${payload.length}`
            }
          }));
        }
        if (range) return Promise.resolve(new Response(null, { status: 416 }));
        return Promise.resolve(new Response(payload, {
          status: 200, headers: { ...common, "Content-Length": String(payload.length) }
        }));
      }),
      diagnostics: () => ({ transport: "ac5-deterministic-origin", requests: observed.length, failures: 0, averageLatencyMs: 0 })
    };
    const catalog: CatalogProvider = {
      definition: { id: "ac5-direct", type: "movie", name: "AC5 direct fixture" },
      owns: (id) => id === movieId,
      list: () => Promise.resolve([]),
      get: (id) => Promise.resolve({ id, type: "movie", name: "AC5 direct fixture" }),
      getDirectStream: () => Promise.resolve({ url: upstreamUrl, fileName: "ac5-video.mp4", size: payload.length }),
      getTorrentSource: () => {
        torrentCalls += 1;
        return Promise.reject(new Error("AC5 must not resolve a torrent"));
      },
      supportsTriblerFallback: () => Promise.resolve(false)
    };
    server = createServer();
    const baseUrl = await listen(server);
    const policy = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const log = { ...silentLogger, error: vi.fn() };
    const app = createApp(
      testConfig({ publicBaseUrl: baseUrl, triblerUrl: "http://127.0.0.1:1", httpStreamTokenTtlMs: 60_000 }),
      log, undefined, catalog, policy, transport
    ).app;
    server.on("request", app);

    const discovery = await fetch(`${baseUrl}/stream/movie/${encodeURIComponent(movieId)}.json`, { headers: { Origin: "https://web.stremio.com", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });
    expect(discovery.status).toBe(200);
    const discovered = await discovery.json() as { streams: Array<{ url: string; name: string }> };
    expect(discovered.streams).toHaveLength(1);
    expect(discovered.streams[0]?.name).toBe("HTTPS · ID?");
    const playbackUrl = new URL(discovered.streams[0]!.url);
    expect(playbackUrl.origin).toBe(baseUrl);
    expect(playbackUrl.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
    expect(JSON.stringify(discovered)).not.toContain("ac5-origin.example");
    expect(JSON.stringify(discovered)).not.toContain("upstream-secret");

    const head = await fetch(playbackUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("content-length")).toBe(String(payload.length));
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const full = await fetch(playbackUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(payload.length));
    expect(Buffer.from(await full.arrayBuffer())).toEqual(payload);

    for (const entry of ranges) {
      const response = await fetch(playbackUrl, { headers: { Range: entry.header } });
      expect(response.status).toBe(206);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-range")).toBe(`bytes ${entry.start}-${entry.end}/${payload.length}`);
      expect(response.headers.get("content-length")).toBe(String(entry.end - entry.start + 1));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload.subarray(entry.start, entry.end + 1));
    }
    expect(observed).toEqual([
      { method: "HEAD", range: null },
      { method: "GET", range: null },
      ...ranges.map(({ header }) => ({ method: "GET" as const, range: header }))
    ]);

    pending = true;
    const client = httpRequest(playbackUrl);
    client.on("error", () => undefined);
    client.end();
    await within(pendingStarted);
    client.destroy();
    await within(pendingAborted);
    expect(signalForPendingRequest?.aborted).toBe(true);
    expect(torrentCalls).toBe(0);
    const unknown = await fetch(baseUrl + "/source/" + "A".repeat(32) + "/video.mp4");
    expect(unknown.status).toBe(400);
    expect(log.error).toHaveBeenLastCalledWith("HTTP request failed", { error: { type: "PlaybackTokenInvalidError" } });

    now += 60_001;
    const expired = await fetch(playbackUrl);
    expect(expired.status).toBe(400);
    expect(log.error).toHaveBeenLastCalledWith("HTTP request failed", { error: { type: "PlaybackTokenExpiredError" } });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(playbackUrl.pathname.split("/")[2]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(upstreamUrl);
  });
});
