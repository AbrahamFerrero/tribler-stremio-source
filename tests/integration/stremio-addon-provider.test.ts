// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { fixtureOutboundRequest, type FixtureOutboundRequest } from "../helpers";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "../http-client";
import { getRouter } from "stremio-addon-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAddon, createStreamMediaItem } from "../../src/addon";
import type { DownloadService } from "../../src/download-service";
import type { OutboundTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { DirectHttpPlaybackBackend, TriblerPlaybackBackend } from "../../src/playback/backends";
import { PlaybackManager } from "../../src/playback/manager";
import type { PlaybackBackend } from "../../src/playback/types";
import { streamSummary } from "../../src/streams/presentation";
import { DirectStreamProbe } from "../../src/streams/direct-stream-probe";
import { StremioAddonStreamProvider } from "../../src/streams/providers/stremio-addon-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../../src/streams/resolver";
import type { NormalizedMediaItem } from "../../src/streams/types";
import { silentLogger } from "../helpers";

describe("mock Stremio addon -> resolver -> playback integration", () => {
  let server: Server;
  let manifestUrl: string;
  const requestedPaths: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requestedPaths.push(path);
      response.setHeader("Content-Type", "application/json");
      if (path === "/manifest.json") {
        response.end(JSON.stringify({
          id: "org.fixture.addon",
          name: "Local fixture",
          description: "Controlled integration fixture",
          version: "1.0.0",
          resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
          types: ["movie", "series"]
        }));
        return;
      }
      if (path === "/stream/movie/tt1254207.json") {
        response.end(JSON.stringify({ streams: [
          {
            url: "https://media.example/fixture.mp4",
            name: "720p",
            behaviorHints: { filename: "fixture.mp4", videoSize: 10_000 }
          },
          {
            infoHash: "d".repeat(40),
            fileIdx: 4,
            name: "1080p",
            behaviorHints: { filename: "fixture.mkv" }
          }
        ] }));
        return;
      }
      if (path === "/stream/movie/tt4280000.json") {
        response.end(JSON.stringify({ streams: Array.from({ length: 17 }, (_, index) => ({
          url: `https://media.example/variant-${index}.mp4`,
          name: "Direct",
          description: "Fixture movie (2011) 1080p HEVC",
          behaviorHints: { filename: `variant-${index}.mp4` }
        })) }));
        return;
      }
      if (path === "/stream/movie/tt9900106.json") {
        response.end(JSON.stringify({ streams: [
          { url: "https://media.example/wrong.mp4", name: "1080p HEVC",
            description: "Vekra Meets Zunra (2020) 1080p HEVC" },
          { url: "https://media.example/matching.mp4", name: "1080p HEVC",
            description: "Zunra (2011) 1080p HEVC" },
          { url: "https://media.example/generic.mp4", name: "1080p HEVC" }
        ] }));
        return;
      }
      if (path === "/stream/series/tt1234567%3A1%3A2.json") {
        response.end(JSON.stringify({ streams: [{
          url: "https://media.example/episode.mp4", name: "720p",
          behaviorHints: { filename: "episode.mp4", videoSize: 10_000 }
        }] }));
        return;
      }
      if (path === "/stream/series/tt1234567%3A1%3A5.json") {
        response.end(JSON.stringify({ streams: [
          { infoHash: "invalid", fileIdx: 5 }, { ytId: "unsupported" }
        ] }));
        return;
      }
      if (path === "/stream/series/tt1234567%3A1%3A3.json" ||
          path === "/stream/series/tt1234567%3A1%3A4.json" ||
          path === "/stream/movie/tt1234567.json") {
        const onlyTorrent = path.endsWith("%3A1%3A3.json");
        const isMovie = path === "/stream/movie/tt1234567.json";
        const torrentFilename = isMovie ? "synthetic-movie.mkv" : `season/episode-${onlyTorrent ? 3 : 4}.mkv`;
        const directFilename = isMovie ? "synthetic-movie.mp4" : "episode-4.mp4";
        const torrent = { infoHash: "e".repeat(40), fileIdx: onlyTorrent ? 3 : 4, name: "1080p",
          behaviorHints: { filename: torrentFilename, videoSize: 10_000 } };
        const direct = { url: `https://media.example/${directFilename}`, name: "720p",
          behaviorHints: { filename: directFilename, videoSize: 10_000 } };
        response.end(JSON.stringify({ streams: onlyTorrent
          ? [torrent] : [torrent, direct] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not-found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    manifestUrl = `http://127.0.0.1:${address.port}/manifest.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("normalizes HTTP and torrent sources and routes both through PlaybackManager", async () => {
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(new StremioAddonStreamProvider({
      id: "fixture",
      name: "Fixture",
      manifestUrl,
      enabled: true,
      timeoutMs: 1_000,
      manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
    }));
    const strictStreams = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    const item: NormalizedMediaItem = {
      id: "catalog:item",
      kind: "movie",
      title: "Fixture",
      externalIds: { imdb: "tt1254207" }
    };
    const sources = await new StreamResolver(registry, strictStreams).resolve(item);
    expect(sources).toHaveLength(2);
    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "https", filename: "fixture.mp4" }),
      expect.objectContaining({ type: "magnet", infoHash: "d".repeat(40), fileIndex: 4 })
    ]));

    const directPrepare = vi.fn<PlaybackBackend["prepare"]>((source) => Promise.resolve({ kind: "direct", source }));
    const torrentPrepare = vi.fn<PlaybackBackend["prepare"]>(() => Promise.resolve({
      kind: "redirect", url: "http://127.0.0.1:7000/play/hash/4/fixture.mkv"
    }));
    const playback = new PlaybackManager([
      {
        id: "direct-mock",
        canHandle: (source) => source.type === "http" || source.type === "https",
        prepare: directPrepare
      },
      {
        id: "tribler-mock",
        canHandle: (source) => source.type === "magnet" || source.type === "torrent",
        prepare: torrentPrepare
      }
    ]);
    const prepared = await Promise.all(sources.map(async (source) => await playback.prepare(playback.register(source))));
    expect(prepared.map(({ kind }) => kind).sort()).toEqual(["direct", "redirect"]);
    expect(directPrepare).toHaveBeenCalledOnce();
    expect(torrentPrepare).toHaveBeenCalledOnce();
  });

  it("bounds replacement probes and never registers a direct source left unprobed", async () => {
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(new StremioAddonStreamProvider({
      id: "probe-cap-fixture", name: "Probe cap fixture", manifestUrl, enabled: true,
      timeoutMs: 1_000, manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
    }));
    const streamPolicy = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    const probeRequest = vi.fn<FixtureOutboundRequest>()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 428 })));
    const transport: OutboundTransport = {
      id: "fixture", request: fixtureOutboundRequest(probeRequest),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    const resolver = new StreamResolver(registry, streamPolicy, new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 250, maxCandidates: 8, maxConcurrent: 2
    }, silentLogger));
    const playback = new PlaybackManager([{ id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source }) }]);
    const register = vi.spyOn(playback, "register");
    const service = { inspect: () => Promise.resolve({ files: [] }) } as unknown as DownloadService;
    const app = express();
    app.use(getRouter(createAddon(service, silentLogger, [], "http://127.0.0.1:7000",
      undefined, resolver, playback)));
    const response = await request(app).get("/stream/movie/tt4280000.json").expect(200);
    expect(probeRequest).toHaveBeenCalledTimes(16);
    expect((response.body as { streams: unknown[] }).streams).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(playback.activeTokenCount()).toBe(0);
  });

  it("qualifies structured movie labels from raw addon JSON when the request carries title and year", async () => {
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(new StremioAddonStreamProvider({
      id: "identity-fixture", name: "Identity fixture", manifestUrl, enabled: true,
      timeoutMs: 1_000, manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
    }));
    const item = createStreamMediaItem("movie", "tt9900106");
    expect(item).toMatchObject({ kind: "movie", title: "tt9900106" });
    expect(item.year).toBeUndefined();
    const stages = new Map<string, readonly { title?: string; metadata?: Record<string, unknown> }[]>();
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }), undefined, { stage: (stage, sources) => stages.set(stage, sources) });
    const withoutCatalog = await resolver.resolve(item);
    expect(stages.get("provider")?.[0]).toMatchObject({ title: "Vekra Meets Zunra (2020) 1080p HEVC" });
    expect(stages.get("normalized")?.[0]).toMatchObject({ title: "Vekra Meets Zunra (2020) 1080p HEVC" });
    expect(stages.get("provider")?.[0]?.metadata).toBeUndefined();
    expect(withoutCatalog.map((source) => source.title)).toContain("Vekra Meets Zunra (2020) 1080p HEVC");
    expect(registry.status()[0]?.identityRejections).toBe(0);
    const streams = await resolver.resolve({ ...item, title: "Zunra", year: 2011 });
    expect(streams.map((source) => source.title)).toEqual(["Zunra (2011) 1080p HEVC", "1080p HEVC"]);
    expect(registry.status()[0]?.identityRejections).toBe(1);
  });

  it("sends an exact IMDb episode identity to a series-capable addon and keeps direct playback", async () => {
    requestedPaths.length = 0;
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(new StremioAddonStreamProvider({
      id: "series-fixture", name: "Series fixture", manifestUrl, enabled: true,
      timeoutMs: 1_000, manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
    }));
    const streams = await new StreamResolver(registry, new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    })).resolve({
      id: "tt1234567:1:2", kind: "episode", title: "", externalIds: { imdb: "tt1234567" }, season: 1, episode: 2,
      stremio: { type: "series", videoId: "tt1234567:1:2" }
    });
    expect(requestedPaths).toContain("/stream/series/tt1234567%3A1%3A2.json");
    expect(streams).toEqual([expect.objectContaining({ type: "https", filename: "episode.mp4" })]);
    const direct = new PlaybackManager([{ id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source }) }]);
    await expect(direct.prepare(direct.register(streams[0]!))).resolves.toMatchObject({ kind: "direct" });
  });

  it("routes episode torrent-only and mixed sources through the same backends as movies", async () => {
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(new StremioAddonStreamProvider({
      id: "episode-fixture", name: "Episode fixture", manifestUrl, enabled: true,
      timeoutMs: 1_000, manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
    }));
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }));
    const episode = (number: number): NormalizedMediaItem => ({
      id: `tt1234567:1:${number}`, kind: "episode", title: "",
      externalIds: { imdb: "tt1234567" }, season: 1, episode: number,
      stremio: { type: "series", videoId: `tt1234567:1:${number}` }
    });
    const torrentOnly = await resolver.resolve(episode(3));
    const mixed = await resolver.resolve(episode(4));
    const malformed = await resolver.resolve(episode(5));
    const movie = await resolver.resolve({
      id: "tt1234567", kind: "movie", title: "Fixture movie",
      externalIds: { imdb: "tt1234567" }
    });
    expect(requestedPaths).toEqual(expect.arrayContaining([
      "/stream/series/tt1234567%3A1%3A3.json",
      "/stream/series/tt1234567%3A1%3A4.json",
      "/stream/movie/tt1234567.json"
    ]));
    expect(torrentOnly).toEqual([expect.objectContaining({
      type: "magnet", infoHash: "e".repeat(40), fileIndex: 3,
      filename: "season/episode-3.mkv", sizeBytes: 10_000
    })]);
    expect(mixed.map(({ type }) => type).sort()).toEqual(["https", "magnet"]);
    expect(malformed).toEqual([]);
    expect(movie.map(({ type }) => type)).toEqual(mixed.map(({ type }) => type));
    expect(movie.map(streamSummary)).toEqual(["Tribler · ID? · 1080p", "HTTPS · ID? · 720p"]);
    expect(mixed.map(streamSummary)).toEqual(["Tribler · 1080p", "HTTPS · 720p"]);

    const resolveDownload = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:7000/play/fixture" });
    const service = { resolve: resolveDownload } as unknown as DownloadService;
    const playback = new PlaybackManager([
      new DirectHttpPlaybackBackend({} as OutboundTransport),
      new TriblerPlaybackBackend(service)
    ]);
    const app = express();
    app.use(getRouter(createAddon(service, silentLogger, [], "http://127.0.0.1:7000",
      undefined, resolver, playback)));
    const directResponse = await request(app).get("/stream/series/tt1234567%3A1%3A2.json").expect(200);
    const torrentResponse = await request(app).get("/stream/series/tt1234567%3A1%3A3.json").expect(200);
    const mixedResponse = await request(app).get("/stream/series/tt1234567%3A1%3A4.json").expect(200);
    const directRows = directResponse.body as { streams: Array<{ name: string; url: string }> };
    const torrentRows = torrentResponse.body as { streams: Array<{ name: string; url: string }> };
    const mixedRows = mixedResponse.body as { streams: Array<{ name: string; url: string }> };
    expect(directRows.streams.map(({ name }) => name.startsWith("HTTPS"))).toEqual([true]);
    expect(torrentRows.streams.map(({ name }) => name.startsWith("Tribler"))).toEqual([true]);
    expect(mixedRows.streams.map(({ name }) => name.split(" ")[0]).sort()).toEqual(["HTTPS", "Tribler"]);
    const tokens = mixedRows.streams.map(({ url }) => new URL(url).pathname.split("/")[2]!);
    const prepared = await Promise.all(tokens.map(async (token) => await playback.prepare(token)));
    expect(prepared.map(({ kind }) => kind).sort()).toEqual(["direct", "redirect"]);
    expect(resolveDownload).toHaveBeenCalledWith(
      `magnet:?xt=urn:btih:${"e".repeat(40)}`, 4, undefined,
      { name: "season/episode-4.mkv", size: 10_000 }
    );
    expect(prepared.find(({ kind }) => kind === "direct")).toMatchObject({
      source: { type: "https", filename: "episode-4.mp4" }
    });
  });
});
