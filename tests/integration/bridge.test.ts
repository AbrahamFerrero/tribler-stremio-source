import { fixtureOutboundRequest } from "../helpers";
import type { Server } from "node:http";
import express from "express";
import request from "../http-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { encodeStreamId } from "../../src/automatic-stream";
import type { CatalogProvider } from "../../src/catalog/types";
import type { OutboundTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { silentLogger, testConfig } from "../helpers";

const hash = "d".repeat(40);
const legalSyntheticVideo = Buffer.from("synthetic-public-domain-video-bytes");
class LocalFixtureUrlPolicy extends ExternalUrlPolicy {
  override validate(raw: string): Promise<URL> { return Promise.resolve(new URL(raw)); }
  override resolveValidated(raw: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
    return Promise.resolve({ url: new URL(raw), address: "127.0.0.1", family: 4 });
  }
}

describe("bridge integration with a local Tribler-compatible fixture", () => {
  let triblerServer: Server;
  let bridge: ReturnType<typeof createApp>["app"];
  let directBridge: ReturnType<typeof createApp>["app"];
  let providerBridge: ReturnType<typeof createApp>["app"];
  let rankedBridge: ReturnType<typeof createApp>["app"];
  let multiCatalogBridge: ReturnType<typeof createApp>["app"];
  const seenRequests: Array<{ path: string; apiKey: string | undefined }> = [];
  const seenDirectHeaders: Array<Record<string, string | string[] | undefined>> = [];
  let putCount = 0;
  let providerDirectRequests = 0;
  let downloadExists = false;
  let downloadStatus = "DOWNLOADING";

  beforeAll(async () => {
    const fakeTribler = express();
    fakeTribler.use(express.json());
    fakeTribler.use((req, _res, next) => {
      seenRequests.push({ path: req.path, apiKey: req.header("X-Api-Key") });
      next();
    });
    fakeTribler.get("/api/downloads", (_req, res) => {
      res.json({ downloads: downloadExists ? [{
        infohash: hash,
        name: "legal-test",
        status: downloadStatus,
        progress: 0,
        speed_down: 0,
        speed_up: 0,
        num_peers: 1,
        num_seeds: 1
      }] : [] });
    });
    fakeTribler.put("/api/downloads", (_req, res) => {
      putCount += 1;
      downloadExists = true;
      downloadStatus = "DOWNLOADING";
      res.json({ started: true, infohash: hash });
    });
    fakeTribler.get(`/api/downloads/${hash}/files`, (_req, res) => {
      res.json({
        infohash: hash,
        files: [
          { index: 0, name: "readme.txt", size: 10, included: true, progress: 1 },
          { index: 2, name: "legal-test.webm", size: legalSyntheticVideo.length, included: true, progress: 0 }
        ]
      });
    });
    fakeTribler.patch(`/api/downloads/${hash}`, (req, res) => {
      const body = req.body as { state?: string };
      if (body.state === "stop") downloadStatus = "STOPPED";
      if (body.state === "resume") downloadStatus = "DOWNLOADING";
      res.json({ modified: true, infohash: hash });
    });
    fakeTribler.get(`/api/downloads/${hash}/stream/2`, (req, res) => {
      res.setHeader("Accept-Ranges", "bytes");
      res.type("video/webm");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.header("Range") ?? "");
      if (!range) {
        res.setHeader("Content-Length", String(legalSyntheticVideo.length));
        res.send(legalSyntheticVideo);
        return;
      }
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : legalSyntheticVideo.length - 1;
      const chunk = legalSyntheticVideo.subarray(start, end + 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${legalSyntheticVideo.length}`);
      res.setHeader("Content-Length", String(chunk.length));
      res.send(chunk);
    });
    fakeTribler.get("/direct.webm", (req, res) => {
      seenDirectHeaders.push(req.headers);
      res.setHeader("Set-Cookie", "remote-session=must-not-reach-player");
      res.setHeader("Accept-Ranges", "bytes");
      res.type("video/webm");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.header("Range") ?? "");
      if (!range) {
        res.setHeader("Content-Length", String(legalSyntheticVideo.length));
        res.send(legalSyntheticVideo);
        return;
      }
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : legalSyntheticVideo.length - 1;
      const chunk = legalSyntheticVideo.subarray(start, end + 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${legalSyntheticVideo.length}`);
      res.setHeader("Content-Length", String(chunk.length));
      res.send(chunk);
    });
    fakeTribler.get("/broken.webm", (_req, res) => {
      res.status(503).end();
    });
    fakeTribler.get("/direct.m3u8", (_req, res) => {
      res.type("application/vnd.apple.mpegurl");
      res.send("#EXTM3U\n#EXTINF:4,\nsegment.ts");
    });
    fakeTribler.get("/segment.ts", (_req, res) => {
      res.type("video/mp2t");
      res.send(Buffer.from("synthetic-hls-segment"));
    });

    await new Promise<void>((resolve) => {
      triblerServer = fakeTribler.listen(0, "127.0.0.1", () => resolve());
    });
    const address = triblerServer.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
    bridge = createApp(testConfig({ triblerUrl: `http://127.0.0.1:${address.port}` }), silentLogger).app;
    const directId = "tribler:test:direct";
    const brokenId = "tribler:test:broken";
    const hlsId = "tribler:test:hls";
    const directProvider: CatalogProvider = {
      definition: { id: "test-direct", type: "movie", name: "Direct test" },
      owns: (id) => id === directId || id === brokenId || id === hlsId,
      list: () => Promise.resolve([]),
      get: (id) => Promise.resolve({ id, type: "movie", name: "Direct test" }),
      getTorrentSource: () => Promise.resolve("https://example.test/direct.torrent"),
      getDirectStream: (id) => Promise.resolve({
        url: `http://127.0.0.1:${address.port}/${id === hlsId ? "direct.m3u8" : id === brokenId ? "broken.webm" : "direct.webm"}`,
        fileName: id === hlsId ? "direct.m3u8" : "direct.webm",
        size: legalSyntheticVideo.length
      })
    };
    directBridge = createApp(
      testConfig({ triblerUrl: `http://127.0.0.1:${address.port}`,
        directHttpProbe: { enabled: true, timeoutMs: 250, maxCandidates: 8, maxConcurrent: 3 } }),
      silentLogger,
      undefined,
      directProvider,
      new LocalFixtureUrlPolicy()
    ).app;
    const providerCatalog: CatalogProvider = {
      definition: { id: "provider-test", type: "movie", name: "Provider test" },
      owns: (id) => id.startsWith("tribler:test:provider-"),
      list: () => Promise.resolve([]),
      get: (id) => Promise.resolve({ id, type: "movie", name: "Synthetic provider item" }),
      getTorrentSource: () => Promise.resolve(`magnet:?xt=urn:btih:${hash}`),
      getDirectStream: (id) => Promise.resolve({
        url: `https://media.example/${id.slice("tribler:test:provider-".length)}.webm`,
        fileName: "legal-test.webm",
        size: legalSyntheticVideo.length
      })
    };
    const providerTransport: OutboundTransport = {
      id: "fixture",
      request: fixtureOutboundRequest(({ url }, signal) => {
        providerDirectRequests += 1;
        if (url.endsWith("/timeout.webm")) {
          return new Promise<Response>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("Direct HTTP header timeout"));
            else signal?.addEventListener("abort", () => reject(new Error("Direct HTTP header timeout")), { once: true });
          });
        }
        if (url.endsWith("/not-found.webm")) return Promise.resolve(new Response(null, { status: 404 }));
        if (url.endsWith("/server-error.webm")) return Promise.resolve(new Response(null, { status: 503 }));
        return Promise.resolve(new Response(legalSyntheticVideo.toString("utf8"), {
          status: 200, headers: { "Content-Type": "video/webm" }
        }));
      }),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    providerBridge = createApp(
      testConfig({ triblerUrl: `http://127.0.0.1:${address.port}` }),
      silentLogger, undefined, providerCatalog, new LocalFixtureUrlPolicy(), providerTransport
    ).app;
    const rankedCatalog: CatalogProvider = {
      definition: { id: "ranking-test", type: "movie", name: "Ranking test" },
      owns: (id) => id === "tribler:test:ranking",
      list: () => Promise.resolve([]),
      get: (id) => Promise.resolve({ id, type: "movie", name: "Synthetic ranking item" }),
      getTorrentSource: () => Promise.resolve(`magnet:?xt=urn:btih:${hash}`),
      getDirectStreams: () => Promise.resolve((["720p", "480p"] as const).map((quality) => ({
        url: `https://media.example/${quality}.mp4`, fileName: `synthetic-${quality}.mp4`, size: 1024 ** 3
      })))
    };
    rankedBridge = createApp(
      testConfig({ triblerUrl: `http://127.0.0.1:${address.port}`,
        directHttpProbe: { enabled: true, timeoutMs: 250, maxCandidates: 8, maxConcurrent: 2 } }),
      silentLogger, undefined, rankedCatalog, new LocalFixtureUrlPolicy(), {
        id: "fixture",
        request: fixtureOutboundRequest(() => Promise.resolve(new Response(new Uint8Array([1]), {
          status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/1024" }
        }))),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 })
      }
    ).app;
    const secondProvider: CatalogProvider = {
      definition: { id: "second-test", type: "series", name: "Second test" },
      owns: (id) => id === "tribler:test:second",
      list: () => Promise.resolve([{ id: "tribler:test:second", type: "series", name: "Second item" }]),
      get: (id) => Promise.resolve({ id, type: "series", name: "Second item" }),
      getTorrentSource: () => Promise.resolve(hash)
    };
    multiCatalogBridge = createApp(
      testConfig({ triblerUrl: `http://127.0.0.1:${address.port}` }),
      silentLogger,
      undefined,
      [directProvider, secondProvider],
      new LocalFixtureUrlPolicy()
    ).app;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      triblerServer.close((error) => error ? reject(error) : resolve());
    });
  });

  it("resolves a legal synthetic torrent and proxies byte ranges for seek", async () => {
    const manifest = await request(bridge).get("/manifest.json").expect(200);
    expect((manifest.body as { resources: string[] }).resources).toContain("stream");
    expect((manifest.body as { version: string }).version).toBe("1.1.0");

    const resolved = await request(bridge)
      .get(`/stream/movie/${hash}.json`)
      .expect(200);

    const resolvedBody = resolved.body as { streams: Array<{ url: string }> };
    expect(resolvedBody.streams).toHaveLength(1);
    expect(putCount).toBe(1);
    const automaticUrl = new URL(resolvedBody.streams[0]?.url ?? "");
    expect(automaticUrl.searchParams.get("source")).toBe("tribler");
    const fallback = await request(bridge)
      .get(`${automaticUrl.pathname}${automaticUrl.search}`)
      .set("Range", "bytes=10-20")
      .expect(307);
    expect(putCount).toBe(1);
    const playPath = new URL(fallback.headers.location as string).pathname;
    const streamed = await request(bridge)
      .get(playPath)
      .set("Range", "bytes=10-20")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(206);

    expect(streamed.headers["accept-ranges"]).toBe("bytes");
    expect(streamed.headers["content-range"]).toBe(`bytes 10-20/${legalSyntheticVideo.length}`);
    expect(streamed.body).toEqual(legalSyntheticVideo.subarray(10, 21));
    expect(seenRequests.filter((entry) => entry.path.startsWith("/api/")).every(
      (entry) => entry.apiKey === "test-key"
    )).toBe(true);
  });

  it("reports privacy posture and aggregate-only outbound metrics", async () => {
    const health = await request(directBridge).get("/health").expect(200);
    const privacy = (health.body as { httpPrivacy: {
      mode: string; transport: string; dnsMode: string; cookies: boolean; referer: boolean;
      metrics: { requests: number; failures: number; averageLatencyMs: number }
    } }).httpPrivacy;
    expect(privacy).toMatchObject({
      mode: "strict",
      transport: "direct",
      dnsMode: "system",
      cookies: false,
      referer: false
    });
    expect(typeof privacy.metrics.requests).toBe("number");
    expect(typeof privacy.metrics.failures).toBe("number");
    expect(typeof privacy.metrics.averageLatencyMs).toBe("number");
    expect(JSON.stringify(privacy)).not.toContain("http://");
  });

  it("serves direct HTTP lazily without creating a Tribler download", async () => {
    const putsBefore = putCount;
    const resolved = await request(directBridge)
      .get("/stream/movie/tribler%3Atest%3Adirect.json")
      .expect(200);
    const body = resolved.body as { streams: Array<{ url: string }> };
    expect(body.streams).toHaveLength(2);
    expect(putCount).toBe(putsBefore);

    const automaticPath = new URL(body.streams[0]?.url ?? "").pathname;
    const streamed = await request(directBridge)
      .get(automaticPath)
      .set("Range", "bytes=4-12")
      .set("Authorization", "Bearer must-not-leak")
      .set("Cookie", "session=must-not-leak")
      .set("X-Api-Key", "must-not-leak")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(206);

    expect(streamed.body).toEqual(legalSyntheticVideo.subarray(4, 13));
    expect(putCount).toBe(putsBefore);
    expect(seenDirectHeaders.at(-1)?.authorization).toBeUndefined();
    expect(seenDirectHeaders.at(-1)?.cookie).toBeUndefined();
    expect(seenDirectHeaders.at(-1)?.["x-api-key"]).toBeUndefined();
    expect(seenDirectHeaders.at(-1)?.referer).toBeUndefined();
    expect(seenDirectHeaders.at(-1)?.origin).toBeUndefined();
    expect(seenDirectHeaders.at(-1)?.["user-agent"]).toBe("Mozilla/5.0");
    expect(streamed.headers["set-cookie"]).toBeUndefined();
  });

  it("serves a direct HTTP 200 response without creating a Tribler download", async () => {
    const putsBefore = putCount;
    const resolved = await request(directBridge)
      .get("/stream/movie/tribler%3Atest%3Adirect.json")
      .expect(200);
    const body = resolved.body as { streams: Array<{ url: string }> };
    const automaticPath = new URL(body.streams[0]?.url ?? "").pathname;
    const streamed = await request(directBridge)
      .get(automaticPath)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(streamed.body).toEqual(legalSyntheticVideo);
    expect(putCount).toBe(putsBefore);
  });

  async function providerStreamPaths(suffix: string): Promise<{ direct: string; torrent: string }> {
    const response = await request(providerBridge)
      .get(`/stream/movie/${encodeURIComponent(`tribler:test:provider-${suffix}`)}.json`)
      .expect(200);
    const streams = (response.body as { streams: Array<{ name: string; url: string }> }).streams;
    const direct = streams.find((stream) => stream.name.startsWith("HTTPS"));
    const torrent = streams.find((stream) => stream.name.startsWith("Tribler"));
    expect(direct?.name).toContain("HTTPS");
    expect(torrent).toBeDefined();
    expect(streams).toHaveLength(2);
    expect(streams.every((stream) => !stream.name.includes("Automatic") && !stream.name.includes("fallback"))).toBe(true);
    return { direct: new URL(direct!.url).pathname, torrent: new URL(torrent!.url).pathname };
  }

  it("keeps an HTTPS-labelled provider stream on direct playback when it succeeds", async () => {
    const paths = await providerStreamPaths("ok");
    const putsBefore = putCount;
    const requestsBefore = seenRequests.length;
    const response = await request(providerBridge).get(paths.direct).expect(200);
    expect(Buffer.from(response.body as Uint8Array)).toEqual(legalSyntheticVideo);
    expect(putCount).toBe(putsBefore);
    expect(seenRequests).toHaveLength(requestsBefore);
  });

  it("fails an HTTPS-labelled provider stream on direct timeout without starting Tribler", async () => {
    const paths = await providerStreamPaths("timeout");
    const putsBefore = putCount;
    const requestsBefore = seenRequests.length;
    const failure = await request(providerBridge).get(paths.direct).expect(502);
    expect(failure.body).toEqual({ error: "Direct playback failed" });
    expect(failure.headers.location).toBeUndefined();
    expect(putCount).toBe(putsBefore);
    expect(seenRequests).toHaveLength(requestsBefore);
  });

  it.each(["not-found", "server-error"])(
    "fails an HTTPS-labelled provider stream on direct %s without starting Tribler", async (suffix) => {
      const paths = await providerStreamPaths(suffix);
      const putsBefore = putCount;
      const requestsBefore = seenRequests.length;
      await request(providerBridge).get(paths.direct).expect(502);
      expect(putCount).toBe(putsBefore);
      expect(seenRequests).toHaveLength(requestsBefore);
    }
  );

  it("retries a failed Direct source and plays Tribler only when selected for the same item", async () => {
    const paths = await providerStreamPaths("server-error");
    const putsBefore = putCount;
    const requestsBefore = seenRequests.length;
    const directBefore = providerDirectRequests;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await request(providerBridge).get(paths.direct).expect(502);
      expect(failure.body).toEqual({ error: "Direct playback failed" });
      expect(failure.headers.location).toBeUndefined();
      expect(providerDirectRequests).toBe(directBefore + attempt + 1);
      expect(seenRequests).toHaveLength(requestsBefore);
    }
    expect(putCount).toBe(putsBefore);
    await request(providerBridge).get("/health").expect(200);
    const triblerRequestsBefore = seenRequests.length;
    const response = await request(providerBridge).get(paths.torrent).expect(307);
    const playPath = new URL(response.headers.location as string).pathname;
    expect(playPath).toContain(`/play/${hash}/2/`);
    expect(seenRequests.length).toBeGreaterThan(triblerRequestsBefore);
    const played = await request(providerBridge).get(playPath).set("Range", "bytes=3-8").expect(206);
    expect(played.headers["content-range"]).toBe(`bytes 3-8/${legalSyntheticVideo.length}`);
    expect(Buffer.from(played.body as Uint8Array)).toEqual(legalSyntheticVideo.subarray(3, 9));
    expect(providerDirectRequests).toBe(directBefore + 2);
  });

  it("presents verified HTTPS variants together ahead of weak torrent variants", async () => {
    const response = await request(rankedBridge).get("/stream/movie/tribler%3Atest%3Aranking.json").expect(200);
    const names = (response.body as { streams: Array<{ name: string }> }).streams.map((stream) => stream.name);
    expect(names).toHaveLength(4);
    expect(names.slice(0, 2).every((name) => name.includes("HTTPS"))).toBe(true);
    expect(names.slice(0, 2).every((name) => name.startsWith("HTTPS✓ · "))).toBe(true);
    expect(names.slice(2).every((name) => name.startsWith("Tribler"))).toBe(true);
  });

  it("rewrites catalog HLS resources to local routes and proxies each child through the bridge", async () => {
    const resolved = await request(directBridge)
      .get("/stream/movie/tribler%3Atest%3Ahls.json")
      .expect(200);
    const body = resolved.body as { streams: Array<{ url: string }> };
    const automaticPath = new URL(body.streams.find((stream) => stream.url.includes("/source/"))?.url ?? "").pathname;
    const playlist = await request(directBridge).get(automaticPath).expect(200);
    expect(playlist.text).toContain("/hls/");
    expect(playlist.text).not.toContain("segment.ts");
    const childPath = new URL(/http:\/\/127\.0\.0\.1:7000(\/hls\/[A-Za-z0-9_-]{32})/.exec(playlist.text)?.[1] ?? "", "http://127.0.0.1:7000").pathname;
    const segment = await request(directBridge).get(childPath).expect(200);
    expect(Buffer.from(segment.body as Uint8Array).toString("utf8")).toBe("synthetic-hls-segment");
    const rangedSegment = await request(directBridge).get(childPath).set("Range", "bytes=3-10").expect(206);
    expect(rangedSegment.headers["content-range"]).toBe("bytes 3-10/21");
    expect(Buffer.from(rangedSegment.body as Uint8Array).toString("utf8")).toBe("thetic-h");
  });

  it("publishes and routes multiple catalogs in one manifest", async () => {
    const manifest = await request(multiCatalogBridge).get("/manifest.json").expect(200);
    const catalogs = (manifest.body as { catalogs: Array<{ id: string }> }).catalogs;
    expect(catalogs.map((catalog) => catalog.id)).toEqual(["test-direct", "second-test"]);
    const feed = await request(multiCatalogBridge).get("/catalog/series/second-test.json").expect(200);
    expect((feed.body as { metas: Array<{ name: string }> }).metas[0]?.name).toBe("Second item");
    const diagnostics = await request(multiCatalogBridge).get("/providers").expect(200);
    expect((diagnostics.body as { providers: Array<{ id: string }> }).providers.map((entry) => entry.id))
      .toContain("catalog_second-test");
  });

  it("keeps legacy /auto Direct failures on Direct and routes only explicit Tribler selections", async () => {
    const putsBefore = putCount;
    const token = encodeStreamId("tribler:test:provider-server-error");
    const path = `/auto/${token}/legal-test.webm?file=legal-test.webm`;
    const requestsBefore = seenRequests.length;
    const directBefore = providerDirectRequests;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await request(providerBridge).get(path).expect(502);
      expect(failure.body).toEqual({ error: "Direct playback failed" });
      expect(failure.headers.location).toBeUndefined();
      expect(providerDirectRequests).toBe(directBefore + attempt + 1);
      expect(seenRequests).toHaveLength(requestsBefore);
    }
    expect(putCount).toBe(putsBefore);
    const explicit = await request(providerBridge).get(`${path}&source=tribler`).expect(307);
    expect(new URL(explicit.headers.location as string).pathname).toContain(`/play/${hash}/2/`);
    expect(providerDirectRequests).toBe(directBefore + 2);
    expect(seenRequests.length).toBeGreaterThan(requestsBefore);
  });
});
