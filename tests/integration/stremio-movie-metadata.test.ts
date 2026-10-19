import { fixtureOutboundRequest, type FixtureOutboundRequest } from "../helpers";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "../http-client";
import { getRouter } from "stremio-addon-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { createAddon } from "../../src/addon";
import type { CatalogProvider } from "../../src/catalog/types";
import type { DownloadService } from "../../src/download-service";
import { StremioMovieMetadataLookup, type MovieMetadataLookup } from "../../src/metadata/movie-metadata";
import type { OutboundTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { PlaybackManager } from "../../src/playback/manager";
import { DirectStreamProbe } from "../../src/streams/direct-stream-probe";
import { StremioAddonStreamProvider } from "../../src/streams/providers/stremio-addon-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../../src/streams/resolver";
import { silentLogger, testConfig } from "../helpers";
import { mp4Fixture } from "../mp4-fixture";

// These fixture identities, localized labels and provider/release names are invented.
// Alternate labels do not assert a trusted alias relation; no remote corpus is used.
const imdbId = "tt9900000005";
const skyId = "tt9900000001";
const labels = [
  "Tavin Meets Luma (2020) 1080p",
  "Luma (2011) 1080p",
  "루마리 (2011) 1080p",
  "Lumari (2011) 1080p",
  "Other Name (2011) 1080p",
  "Luma 1080p",
  "Server 1",
  "1080p HEVC"
];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("public movie stream route with independent trusted metadata", () => {
  let metaServer: Server;
  let streamServer: Server;
  let metaBase: string;
  let streamManifest: string;
  let releaseInfo: string | undefined = "2011";
  let metaOverride: unknown;
  let metaRequests = 0;
  let streamRequests = 0;
  let rawStreamOverride: unknown[] | undefined;
  let requestedId = imdbId;

  beforeAll(async () => {
    metaServer = createServer((incoming, response) => {
      metaRequests += 1;
      response.setHeader("Content-Type", "application/json");
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (path !== `/meta/movie/${requestedId}.json`) {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      response.end(JSON.stringify(metaOverride ?? { meta: {
        id: imdbId, type: "movie", name: "Luma",
        ...(releaseInfo ? { releaseInfo } : {})
      } }));
    });
    streamServer = createServer((incoming, response) => {
      response.setHeader("Content-Type", "application/json");
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (path === "/manifest.json") {
        response.end(JSON.stringify({ id: "org.fixture.streams", name: "Separate streams",
          description: "Raw stream fixture", version: "1.0.0",
          resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
          types: ["movie"] }));
        return;
      }
      if (path === `/stream/movie/${requestedId}.json`) {
        streamRequests += 1;
        response.end(JSON.stringify({ streams: rawStreamOverride ?? labels.map((description, index) => ({
          url: `https://media.example/variant-${index}.mp4`, name: "Direct",
          description, behaviorHints: { filename: `variant-${index}.mp4` }
        })) }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    metaBase = await listen(metaServer);
    streamManifest = `${await listen(streamServer)}manifest.json`;
  });

  afterAll(async () => {
    await Promise.all([close(metaServer), close(streamServer)]);
  });

  afterEach(() => {
    releaseInfo = "2011";
    metaOverride = undefined;
    rawStreamOverride = undefined;
    requestedId = imdbId;
  });

  async function publicStreams(metadata?: MovieMetadataLookup, catalog?: CatalogProvider,
    directProbe?: DirectStreamProbe): Promise<{
    titles: string[]; fixtureLabels: string[]; registered: string[];
  }> {
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(new StremioAddonStreamProvider({ id: "raw-fixture", name: "Raw fixture",
      manifestUrl: streamManifest, enabled: true, timeoutMs: 1_000, manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] }) }));
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }), directProbe);
    const playback = new PlaybackManager([{ id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source }) }]);
    const registered: string[] = [];
    const register = playback.register.bind(playback);
    vi.spyOn(playback, "register").mockImplementation((source) => {
      registered.push(source.title ?? "");
      return register(source);
    });
    const service = { inspect: () => Promise.resolve({ files: [] }) } as unknown as DownloadService;
    const app = express();
    app.use(getRouter(createAddon(service, silentLogger, catalog ?? [], "http://127.0.0.1:7000",
      undefined, resolver, playback, metadata)));
    const result = await request(app).get(`/stream/movie/${requestedId}.json`).expect(200);
    const titles = (result.body as { streams: Array<{ name: string; title?: string }> }).streams.map(({ name, title }) => {
      expect(title).toBeUndefined();
      return name;
    });
    expect(playback.activeTokenCount()).toBe(titles.length);
    const publicRows = (result.body as { streams: Array<{ title?: string; url: string }> }).streams;
    const fixtureLabels = await Promise.all(publicRows.map(async row => {
      const token = /\/source\/([A-Za-z0-9_-]{32})\//.exec(row.url)![1]!;
      return (await playback.prepare(token)).source!.title ?? "";
    }));
    for (const title of titles) expect(title).toMatch(/^HTTPS?\u2713?(?: \u00b7 (?:ID[?!\u2713]|\d+p|\d+MB|\d+\.\dGB|\d+\.\ds))*$/);
    return { titles, fixtureLabels, registered };
  }

  function realLookup(): MovieMetadataLookup {
    return new StremioMovieMetadataLookup({ baseUrl: metaBase,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] }) });
  }

  function probeForSyntheticProvider(response: 206 | 428 | "timeout"): { probe: DirectStreamProbe;
    request: ReturnType<typeof vi.fn<FixtureOutboundRequest>> } {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => {
      if (response === "timeout") return Promise.reject(new DOMException("Timed out", "TimeoutError"));
      if (response === 428) return Promise.resolve(new Response(null, { status: 428 }));
      return Promise.resolve(new Response(new Uint8Array([0]), {
        status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/100" }
      }));
    });
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fixture", requests: request.mock.calls.length, failures: 0, averageLatencyMs: 0 }) };
    return { probe: new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 2
    }, silentLogger), request };
  }

  function syntheticSixCandidateShape(): void {
    rawStreamOverride = [
      ...[1, 2].map((index) => ({
        url: `https://media.example/fixture-lantern-${index}.mp4`,
        name: "Fixture Lantern 720p", title: "Luma", description: "Luma\nFixture Lantern\n720p",
        behaviorHints: { filename: "Luma.2011.720p.mp4" }
      })),
      ...[1, 2, 3, 4].map((index) => ({
        url: `https://media.example/tavin-${index}.mp4`,
        name: "Direct", title: "Tavin Meets Luma (2020) 1080p",
        behaviorHints: { filename: "Tavin.Meets.Luma.2020.mp4" }
      }))
    ];
  }

  it("rejects only the contradictory 2020 movie before registering playback", async () => {
    releaseInfo = "2011";
    metaRequests = 0;
    streamRequests = 0;
    const result = await publicStreams(realLookup());
    expect(metaRequests).toBe(1);
    expect(streamRequests).toBe(1);
    expect(result.fixtureLabels).toHaveLength(labels.length - 1);
    expect(result.fixtureLabels).not.toContain(labels[0]);
    expect(result.registered).not.toContain(labels[0]);
    expect(result.fixtureLabels).toEqual(expect.arrayContaining(labels.slice(1)));
    expect(result.registered).toEqual(expect.arrayContaining(labels.slice(1)));
  });

  it("restores trusted year/runtime through a safe redirect before qualifying Recollection on the public route", async () => {
    requestedId = "tt9900000003";
    const wrong = ["The.Recollection.1999.mkv", "The.Recollection.2025.mkv", "Recollection.2022.mp4",
      "The.Cost.of.Recollection.S01E01.mkv", "Maps.and.Recollections.S01.E06.mkv",
      "Recollection\n2:30:00"];
    const retained = ["Server 1", "Unrelated title only"];
    rawStreamOverride = [...wrong, ...retained].map((title, index) => ({
      url: `https://media.example/recollection-${index}.mp4`, name: "Direct", title
    }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: "https://metadata-cdn.example/movie.json" }
    })).mockResolvedValueOnce(new Response(JSON.stringify({ meta: {
      id: requestedId, type: "movie", name: "Recollection", releaseInfo: "1968", runtime: "71 min"
    } }), { headers: { "Content-Type": "application/json" } }));
    const lookup = new StremioMovieMetadataLookup({ baseUrl: "https://metadata.example/",
      endpointPolicy: () => new ExternalUrlPolicy({
        resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
      }), fetchImplementation: fetcher });
    const result = await publicStreams(lookup);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.fixtureLabels).toEqual(expect.arrayContaining(retained));
    expect(result.registered).toHaveLength(retained.length);
    for (const title of wrong) expect(result.registered).not.toContain(title);
  });

  it("rejects weak multiline runtime after an inconclusive HLS probe while retaining a source without duration", async () => {
    requestedId = skyId;
    metaOverride = { meta: { id: skyId, type: "movie", name: "The Copper Sky",
      year: 2013, releaseInfo: "2013", runtime: "126 min" } };
    const wrong = "Fixture Brook HLS\n2:57:17\nLetters Under Copper Skies- DRAMA MOVIE ENGLISH SUB [Full Movie]";
    const good = "The Copper Sky (2013) 720p";
    rawStreamOverride = [
      { url: "https://media.example/wrong.m3u8", name: "HLS", description: wrong },
      { url: "https://media.example/good.mp4", name: "Direct", description: good,
        behaviorHints: { filename: "The.Copper.Sky.2013.mp4" } }
    ];
    const { probe, request: probeRequest } = probeForSyntheticProvider(206);
    const result = await publicStreams(realLookup(), undefined, probe);
    expect(probeRequest).toHaveBeenCalledTimes(3); // Two existing HLS requests and one healthy MP4 request.
    expect(probeRequest.mock.calls.filter(([input]) => input.url.endsWith("wrong.m3u8"))).toHaveLength(2);
    expect(probeRequest.mock.calls.filter(([input]) => input.url.endsWith("good.mp4"))).toHaveLength(1);
    expect(result.fixtureLabels).toEqual([good]);
    expect(result.registered).toEqual([good]);
  });

  it("keeps synthetic Luma.2011 Fixture Lantern candidates through identity, then excludes an explicit 428", async () => {
    syntheticSixCandidateShape();
    const { probe, request: probeRequest } = probeForSyntheticProvider(428);
    const result = await publicStreams(realLookup(), undefined, probe);
    expect(streamRequests).toBeGreaterThan(0);
    expect(probeRequest).toHaveBeenCalledTimes(2);
    expect(result.fixtureLabels).toEqual([]);
    expect(result.registered).toEqual([]);
  });

  it.each([206, "timeout"] as const)("keeps synthetic Luma.2011 Fixture Lantern candidates after %s probe evidence", async (status) => {
    syntheticSixCandidateShape();
    const { probe, request: probeRequest } = probeForSyntheticProvider(status);
    const result = await publicStreams(realLookup(), undefined, probe);
    expect(probeRequest).toHaveBeenCalledTimes(2);
    expect(result.fixtureLabels).toEqual(["Luma\nFixture Lantern\n720p", "Luma\nFixture Lantern\n720p"]);
    expect(result.registered).toEqual(["Luma\nFixture Lantern\n720p", "Luma\nFixture Lantern\n720p"]);
  });

  it("reproduces the six-candidate unenriched control with the same raw stream shape", async () => {
    syntheticSixCandidateShape();
    const { probe, request: probeRequest } = probeForSyntheticProvider(206);
    const result = await publicStreams(undefined, undefined, probe);
    expect(probeRequest).toHaveBeenCalledTimes(6);
    expect(result.fixtureLabels).toHaveLength(6);
    expect(result.fixtureLabels.filter((title) => title === "Luma\nFixture Lantern\n720p")).toHaveLength(2);
    expect(result.registered).toHaveLength(6);
  });

  it("keeps streams available when trusted meta supplies a title without a year", async () => {
    releaseInfo = undefined;
    streamRequests = 0;
    const result = await publicStreams(realLookup());
    expect(streamRequests).toBe(1);
    expect(result.fixtureLabels).toEqual(expect.arrayContaining(labels));
    expect(result.registered).toHaveLength(labels.length);
  });

  it("keeps streams available when metadata lookup times out", async () => {
    streamRequests = 0;
    const timeout: MovieMetadataLookup = { lookup: () => Promise.reject(new DOMException("timeout", "TimeoutError")) };
    const result = await publicStreams(timeout);
    expect(streamRequests).toBe(1);
    expect(result.fixtureLabels).toEqual(expect.arrayContaining(labels));
    expect(result.registered).toHaveLength(labels.length);
  });

  it.each([
    ["mismatched ID", { meta: { id: "tt9999999", type: "movie", name: "Luma", releaseInfo: "2011" } }],
    ["mismatched type", { meta: { id: imdbId, type: "series", name: "Luma", releaseInfo: "2011" } }],
    ["malformed response", { meta: [] }],
    ["oversized response", { meta: { id: imdbId, type: "movie", name: "x".repeat(150_000) } }]
  ])("keeps streams available after %s from the trusted endpoint", async (_description, payload) => {
    metaOverride = payload;
    streamRequests = 0;
    const result = await publicStreams(realLookup());
    expect(streamRequests).toBe(1);
    expect(result.fixtureLabels).toEqual(expect.arrayContaining(labels));
  });

  it("does not contact metadata when none is configured", async () => {
    metaRequests = 0;
    const result = await publicStreams();
    expect(metaRequests).toBe(0);
    expect(result.fixtureLabels).toEqual(expect.arrayContaining(labels));
  });

  it("fetches trusted runtime while preserving the owning catalog movie title/year", async () => {
    requestedId = "tt9999999999";
    metaRequests = 0;
    metaOverride = { meta: { id: requestedId, type: "movie", name: "Synthetic Alternate Label",
      releaseInfo: "2004", runtime: "71 min" } };
    rawStreamOverride = ["Server 1", "Server 2"].map((title, index) => ({ title,
      url: `https://media.example/opaque-${index}/master.mp4` }));
    const catalog: CatalogProvider = {
      definition: { id: "owned", type: "movie", name: "Owned" },
      owns: (id) => id === requestedId,
      list: () => Promise.resolve([]),
      get: () => Promise.resolve({ id: requestedId, type: "movie", name: "Synthetic Meridian", releaseInfo: "1987" }),
      getTorrentSource: () => Promise.resolve("")
    };
    const resolve = vi.spyOn(StreamResolver.prototype, "resolve");
    try {
      const result = await publicStreams(realLookup(), catalog);
      expect(metaRequests).toBe(1);
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve.mock.calls[0]?.[0]).toMatchObject({ id: requestedId, kind: "movie",
        title: "Synthetic Meridian", year: 1987, runtimeSeconds: 4260 });
      expect(result.fixtureLabels).toEqual(["Server 1", "Server 2"]);
      expect(result.registered).toEqual(["Server 1", "Server 2"]);
    } finally { resolve.mockRestore(); }
  });

  it("fetches trusted runtime even when the owning catalog already supplies movie title/year", async () => {
    requestedId = "tt9999999999";
    metaRequests = 0;
    metaOverride = { meta: { id: requestedId, type: "movie", name: "Synthetic Alternate Label",
      releaseInfo: "2004", runtime: "71 min" } };
    rawStreamOverride = ["Server 1", "Server 2"].map((title, index) => ({ title,
      url: `https://media.example/opaque-${index}/master.mp4` }));
    const catalog: CatalogProvider = {
      definition: { id: "owned", type: "movie", name: "Owned" },
      owns: (id) => id === requestedId,
      list: () => Promise.resolve([]),
      get: () => Promise.resolve({ id: requestedId, type: "movie", name: "Synthetic Meridian", releaseInfo: "1987" }),
      getTorrentSource: () => Promise.resolve("")
    };
    const probeRequest = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url, headers }) => {
      const media = mp4Fixture((url.includes("opaque-0") ? 22 : 90) * 60);
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range")!)!;
      const start = Number(range[1]), end = Math.min(Number(range[2]), media.length - 1);
      return Promise.resolve(new Response(Uint8Array.from(media.subarray(start, end + 1)), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${media.length}` } }));
    });
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(probeRequest),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const probe = new DirectStreamProbe(transport,
      { enabled: true, timeoutMs: 500, maxCandidates: 2, maxConcurrent: 1 }, silentLogger);
    const result = await publicStreams(realLookup(), catalog, probe);
    expect(metaRequests).toBe(1);
    expect(result.fixtureLabels).toEqual(["Server 2"]);
    expect(result.registered).toEqual(["Server 2"]);
  });
});

describe("public episode route with authoritative series metadata", () => {
  let server: Server;
  let base: string;
  let payload: unknown;
  let failNetwork = false;
  const paths: string[] = [];
  const media: Array<Record<string, unknown>> = [];
  const series = { meta: { id: "tt9999999998", type: "series", name: "Synthetic Harbour",
    year: 1998, runtime: "60 min", videos: [{ id: "tt9999999998:1:1", title: "Pilot" }] } };

  beforeAll(async () => {
    server = createServer((incoming, response) => {
      response.setHeader("Content-Type", "application/json");
      if (incoming.url === "/resolve") {
        let body = "";
        incoming.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        incoming.on("end", () => {
          media.push(JSON.parse(body) as Record<string, unknown>);
          response.end(JSON.stringify({ streams: [{ type: "https",
            url: "https://media.example/fixture.mp4", filename: "Fixture.S01E01.mp4" }] }));
        });
        return;
      }
      paths.push(incoming.url ?? "");
      if (failNetwork) { incoming.socket.destroy(); return; }
      response.end(JSON.stringify(payload));
    });
    base = await listen(server);
  });
  afterAll(async () => { await close(server); });
  afterEach(() => { paths.length = 0; media.length = 0; failNetwork = false; });

  function configuredApp() {
    return createApp(testConfig({ stremioMovieMetadataBaseUrl: base,
      streamProviders: ["external_http"], externalStreamProviderEnabled: true,
      externalStreamProviderUrl: `${base}resolve`, externalStreamProviderTimeoutMs: 1_000,
      streamProviderTimeoutMs: 1_000
    }), silentLogger, undefined, [], new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }));
  }

  it("enriches the external IMDb episode with seriesTitle while preserving exact video identity", async () => {
    payload = series;
    const { app, service } = configuredApp();
    try {
      const result = await request(app).get("/stream/series/tt9999999998:1:1.json").expect(200);
      expect(paths).toEqual(["/meta/series/tt9999999998.json"]);
      expect(media).toEqual([{ id: "tt9999999998:1:1", type: "episode", title: "",
        seriesTitle: "Synthetic Harbour", year: 1998, season: 1, episode: 1, externalIds: { imdb: "tt9999999998" } }]);
      // Series-wide 60 min must not become a trusted episode runtime.
      expect(media[0]).not.toHaveProperty("runtimeSeconds");
      expect((result.body as { streams: unknown[] }).streams).toHaveLength(1);
      await request(app).get("/stream/series/tt9999999998:1:1.json").expect(200);
      expect(paths).toHaveLength(1);
    } finally { service.stopCleanup(); }
  });

  it.each(["wrong ID", "network failure"])("continues normal resolution after %s", async (failure) => {
    payload = { meta: { ...series.meta, id: "tt9999999" } };
    failNetwork = failure === "network failure";
    const { app, service } = configuredApp();
    try {
      const result = await request(app).get("/stream/series/tt9999999998:1:1.json").expect(200);
      expect(media).toEqual([{ id: "tt9999999998:1:1", type: "episode", title: "",
        season: 1, episode: 1, externalIds: { imdb: "tt9999999998" } }]);
      expect((result.body as { streams: unknown[] }).streams).toHaveLength(1);
    } finally { service.stopCleanup(); }
  });

  it("performs only the existing movie lookup for movies", async () => {
    payload = { meta: { id: "tt9999999998", type: "movie", name: "Fixture", year: 1998 } };
    const { app, service } = configuredApp();
    try {
      await request(app).get("/stream/movie/tt9999999998.json").expect(200);
      expect(paths).toEqual(["/meta/movie/tt9999999998.json"]);
      expect(media).toEqual([{ id: "tt9999999998", type: "movie", title: "Fixture", year: 1998,
        externalIds: { imdb: "tt9999999998" } }]);
    } finally { service.stopCleanup(); }
  });
});
