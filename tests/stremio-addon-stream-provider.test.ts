import { fixtureOutboundRequest, type FixtureOutboundRequest } from "./helpers";
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { AddonRequestIdentityResolver } from "../src/streams/addon-request-identity";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StremioAddonStreamProvider } from "../src/streams/providers/stremio-addon-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { NormalizedMediaItem } from "../src/streams/types";
import { silentLogger } from "./helpers";

const manifest = {
  id: "org.example.streams",
  name: "Fixture",
  description: "Controlled test addon",
  version: "1.0.0",
  resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
  types: ["movie", "series"]
};
const item: NormalizedMediaItem = {
  id: "internal:item",
  kind: "movie",
  title: "Fixture movie",
  externalIds: { imdb: "tt1254207", tmdb: "123" }
};
const context = { signal: new AbortController().signal };
const publicResolver = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
const publicPolicy = () => new ExternalUrlPolicy({ resolver: publicResolver });

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

function provider(fetchImplementation: typeof fetch, overrides: Partial<ConstructorParameters<typeof StremioAddonStreamProvider>[0]> = {}) {
  return new StremioAddonStreamProvider({
    id: "fixture",
    name: "Fixture addon",
    manifestUrl: "https://addon.example/manifest.json",
    enabled: true,
    timeoutMs: 100,
    manifestTtlMs: 60_000,
    endpointPolicy: publicPolicy,
    fetchImplementation,
    ...overrides
  });
}

describe("StremioAddonStreamProvider", () => {
  it("loads and caches a valid manifest and maps infoHash plus fileIdx through IMDb", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{
        infoHash: "A".repeat(40), fileIdx: 7, name: "1080p", title: "Torrent",
        behaviorHints: { filename: "movie.mkv", videoSize: 123_456 }
      }] }))
      .mockResolvedValueOnce(json({ streams: [{
        infoHash: "A".repeat(40), fileIdx: 7, name: "1080p", title: "Torrent",
        behaviorHints: { filename: "movie.mkv", videoSize: 123_456 }
      }] }));
    const addon = provider(fetchImplementation);
    const first = await addon.resolve(item, context);
    const second = await addon.resolve(item, context);
    expect(first[0]).toMatchObject({
      type: "magnet", infoHash: "a".repeat(40), fileIndex: 7,
      filename: "movie.mkv", sizeBytes: 123_456
    });
    const requested = fetchImplementation.mock.calls[1]?.[0];
    const requestedUrl = typeof requested === "string" ? requested
      : requested instanceof URL ? requested.href
        : requested?.url;
    expect(requestedUrl).toBe("https://addon.example/stream/movie/tt1254207.json");
    expect(second).toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(addon.diagnosticDetails()).toEqual(expect.objectContaining({
      type: "stremio_addon",
      supports: ["movie", "series"],
      streamCapabilities: { types: ["movie", "series"], idPrefixes: ["tt"] }
    }));
  });

  it("reports the exact episodic request and raw response only to an in-memory diagnostic callback", async () => {
    const events: Array<{ type: string; requestType?: string; requestId?: string; streams?: unknown[] }> = [];
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{ infoHash: "c".repeat(40), fileIdx: 2 }] }));
    const episode: NormalizedMediaItem = {
      id: "tt9999999999:2:3", kind: "episode", title: "", externalIds: { imdb: "tt9999999999" },
      season: 2, episode: 3, stremio: { type: "series", videoId: "tt9999999999:2:3" }
    };
    await provider(fetchImplementation, { diagnostic: (event) => events.push(event) }).resolve(episode, context);
    expect(events).toEqual([
      { type: "request", requestType: "series", requestId: "tt9999999999:2:3" },
      { type: "response", httpStatus: 200 },
      { type: "raw-streams", streams: [{ infoHash: "c".repeat(40), fileIdx: 2 }] }
    ]);
  });

  it("maps direct HTTP URLs structurally, including opaque paths, sanitizes proxy request headers and ignores unsupported targets", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [
        {
          url: "https://media.example/video.mp4", name: "720p", description: "Direct",
          behaviorHints: {
            filename: "video.mp4", videoSize: 999,
            proxyHeaders: { request: { Authorization: "must-not-pass", Cookie: "must-not-pass",
              Referer: "https://ref.example/watch", ACCEPT: "video/mp4", Host: "evil.example",
              Origin: "https://ref.example", "User-Agent": "AddonPlayer/1",
              "X-Bad": "no", "Bad Name": "no", Forwarded: "no", Range: "bytes=0-1",
              "If-Range": "bad", "Accept-Encoding": "gzip", "Proxy-Authorization": "no",
              "X-Forwarded-For": "no" } }
          }
        },
        { url: "https://media.example/signed/abc123", name: "Opaque direct" },
        { externalUrl: "https://not-media.example/watch/abc123" },
        { url: "ftp://media.example/video.mp4" },
        { ytId: "unsupported" }
      ] }));
    const streams = await provider(fetchImplementation).resolve(item, context);
    expect(streams).toHaveLength(2);
    expect(streams[0]).toEqual(expect.objectContaining({
      type: "https", url: "https://media.example/video.mp4", filename: "video.mp4", sizeBytes: 999
    }));
    expect(streams[0]?.requestHeaders).toEqual({
      Referer: "https://ref.example/watch", Origin: "https://ref.example",
      "User-Agent": "AddonPlayer/1", Accept: "video/mp4"
    });
    expect(JSON.stringify(streams[0])).not.toContain("must-not-pass");
    expect(JSON.stringify(streams[0])).not.toContain("proxyHeaders");
    expect(streams[1]).toMatchObject({ type: "https", url: "https://media.example/signed/abc123" });
    expect(streams[1]?.filename).toBeUndefined();
  });

  it("drops a linked lifecycle notice with a playable MP4 while retaining a sparse Server 1 stream", async () => {
    const destination = "https://navigation.example/new-addon";
    const notice = {
      externalUrl: destination,
      name: "SERVICE DEPRECATED - Visit the new location",
      title: `This service has moved. Visit ${destination}`,
      url: "https://media.example/announcement.mp4"
    };
    const generic = {
      externalUrl: "https://navigation.example/watch",
      name: "Server 1",
      url: "https://media.example/opaque"
    };
    const seen: unknown[][] = [];
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [notice, generic] }));
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/9" }
    }));
    const transport: OutboundTransport = { id: "fake", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(provider(fetchImplementation, {
      diagnostic: (event) => { if (event.type === "raw-streams") seen.push(event.streams); }
    }));
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 1
    }, silentLogger);
    const streams = await new StreamResolver(registry, publicPolicy(), probe).resolve(item);
    expect(seen).toEqual([[notice, generic]]);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ type: "https", url: generic.url, title: "Server 1" });
    expect(streams[0]?.directHttp).toMatchObject({ status: "verified", contentType: "video/mp4" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("admits an opaque addon stream only after the generic direct probe confirms video media", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{ url: "https://media.example/signed/abc123", name: "Opaque direct" }] }));
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/9" }
    }));
    const transport: OutboundTransport = {
      id: "fake", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 1
    }, silentLogger);
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(provider(fetchImplementation));
    const streams = await new StreamResolver(registry, publicPolicy(), probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      providerId: "stremio-addon-fixture", type: "https", url: "https://media.example/signed/abc123"
    });
    expect(streams[0]?.directHttp).toMatchObject({ rangeSupported: true, contentType: "video/mp4" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid manifest", json({ ...manifest, resources: "stream" }), /resources/],
    ["manifest without stream", json({ ...manifest, resources: ["meta"] }), /does not declare/],
    ["malformed manifest JSON", new Response("{", { headers: { "Content-Type": "application/json" } }), /malformed JSON/]
  ])("isolates %s", async (_name, response, expected) => {
    const addon = provider(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(addon.resolve(item, context)).rejects.toThrow(expected);
    expect(addon.isEnabled()).toBe(false);
  });

  it("accepts extensible manifest types and returns zero when the item has no matching type", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(json({
      ...manifest, types: ["anime"], resources: ["stream"], idPrefixes: ["kitsu"]
    }));
    const addon = provider(fetchImplementation);
    await expect(addon.resolve(item, context)).resolves.toEqual([]);
    expect(addon.isEnabled()).toBe(true);
    expect(addon.diagnosticDetails().supports).toEqual(["anime"]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("rejects malformed and oversized stream responses", async () => {
    const malformedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(new Response("{", { headers: { "Content-Type": "application/json" } }));
    await expect(provider(malformedFetch).resolve(item, context)).rejects.toThrow(/malformed JSON/);

    const oversizedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [], padding: "x".repeat(200) }));
    await expect(provider(oversizedFetch, { maxResponseBytes: 32 }).resolve(item, context)).rejects.toThrow(/too large/);
  });

  it("returns no streams when the addon prefix or media type is incompatible", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json(manifest));
    const addon = provider(fetchImplementation);
    await expect(addon.resolve({ ...item, externalIds: {}, id: "not-imdb" }, context)).resolves.toEqual([]);
    await expect(addon.resolve({ ...item, kind: "episode", externalIds: { tmdb: "123" }, id: "internal:episode" }, context))
      .resolves.toEqual([]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation/timeouts and isolates a down provider", async () => {
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(
        init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted")
      ), { once: true });
    }));
    await expect(provider(hanging, { timeoutMs: 5 }).resolve(item, context)).rejects.toThrow();

    const registry = new StreamProviderRegistry(50, silentLogger);
    registry.register(provider(vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"))));
    registry.register({
      id: "healthy", name: "Healthy", isEnabled: () => true,
      resolve: () => Promise.resolve([{ providerId: "healthy", type: "magnet", magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}` }])
    });
    const streams = await new StreamResolver(registry, publicPolicy()).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.providerId).toBe("healthy");
  });

  it("supports an explicitly configured localhost addon but not its returned localhost streams", async () => {
    const endpointPolicy = (url: string) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] });
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{
        url: "http://127.0.0.1:7100/private.mp4", behaviorHints: { filename: "private.mp4" }
      }] }));
    const addon = provider(fetchImplementation, {
      manifestUrl: "http://127.0.0.1:7100/manifest.json", endpointPolicy
    });
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(addon);
    await expect(new StreamResolver(registry, publicPolicy()).resolve(item)).resolves.toEqual([]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://127.0.0.1:54528/api/downloads/hash/stream/0",
    "http://127.0.0.1:7000/health"
  ])("blocks an addon stream targeting an internal endpoint: %s", async (url) => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{ url, behaviorHints: { filename: "video.mp4" } }] }));
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(provider(fetchImplementation));
    const strict = new ExternalUrlPolicy({
      blockedEndpoints: [
        { hostname: "127.0.0.1", port: "54528" },
        { hostname: "127.0.0.1", port: "7000" }
      ]
    });
    await expect(new StreamResolver(registry, strict).resolve(item)).resolves.toEqual([]);
  });

  it("deduplicates the same torrent returned by multiple Stremio addons", async () => {
    const hash = "c".repeat(40);
    const makeFetch = () => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{ infoHash: hash, fileIdx: 2 }] }));
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(provider(makeFetch(), { id: "first", name: "First" }));
    registry.register(provider(makeFetch(), { id: "second", name: "Second" }));
    const streams = await new StreamResolver(registry, publicPolicy()).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ infoHash: hash, fileIndex: 2 });
  });

  it("resolves several addons with different namespaces simultaneously", async () => {
    const imdbManifest = { ...manifest, resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }] };
    const kitsuManifest = {
      ...manifest,
      types: ["anime"],
      resources: [{ name: "stream", types: ["anime"], idPrefixes: ["kitsu"] }]
    };
    const imdbFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(imdbManifest))
      .mockResolvedValueOnce(json({ streams: [{ infoHash: "e".repeat(40), fileIdx: 1 }] }));
    const kitsuFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(kitsuManifest))
      .mockResolvedValueOnce(json({ streams: [{ infoHash: "f".repeat(40), fileIdx: 2 }] }));
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(provider(imdbFetch, { id: "imdb", name: "IMDb" }));
    registry.register(provider(kitsuFetch, { id: "kitsu", name: "Kitsu" }));
    const resolver = new StreamResolver(registry, publicPolicy());
    const streams = await resolver.resolve({
      id: "internal:anime-episode",
      kind: "episode",
      title: "Anime episode",
      season: 1,
      episode: 5,
      classifications: ["anime"],
      externalIds: { imdb: "tt1234567", kitsu: "kitsu:episode-5" }
    });
    expect(streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ infoHash: "e".repeat(40), fileIndex: 1 }),
      expect.objectContaining({ infoHash: "f".repeat(40), fileIndex: 2 })
    ]));
    const calledUrls = [imdbFetch, kitsuFetch].map((mock) => {
      const input = mock.mock.calls[1]?.[0];
      return typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    });
    expect(calledUrls).toEqual([
      "https://addon.example/stream/series/tt1234567%3A1%3A5.json",
      "https://addon.example/stream/anime/kitsu%3Aepisode-5.json"
    ]);
    expect(resolver.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "stremio-addon-imdb",
        streamCapabilities: { types: ["series"], idPrefixes: ["tt"] }
      }),
      expect.objectContaining({
        id: "stremio-addon-kitsu",
        streamCapabilities: { types: ["anime"], idPrefixes: ["kitsu"] }
      })
    ]));
  });

  it("validates redirects from a configured local manifest", async () => {
    const endpointPolicy = (url: string) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] });
    const redirected = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "http://127.0.0.1:54528/api/downloads" }
    }));
    await expect(provider(redirected, {
      manifestUrl: "http://127.0.0.1:7100/manifest.json", endpointPolicy
    }).resolve(item, context)).rejects.toThrow(/private|reserved/);
    expect(redirected).toHaveBeenCalledTimes(1);
  });
});

describe("Stremio addon content-type policy", () => {
  const seriesItem: NormalizedMediaItem = {
    id: "tt9999999", kind: "series", title: "Fixture series", externalIds: { imdb: "tt9999999" }
  };
  const episodeItem: NormalizedMediaItem = {
    ...seriesItem, kind: "episode", season: 1, episode: 2,
    stremio: { type: "series", videoId: "tt9999999:1:2" }
  };

  it("short-circuits a disabled movie before manifest and identity work, without a provider error", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const identityResolver = new AddonRequestIdentityResolver();
    const resolveIdentity = vi.spyOn(identityResolver, "resolve");
    const addon = provider(fetchImplementation, {
      contentTypes: { movie: false, series: true, anime: true }, identityResolver
    });
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register(addon);
    const resolver = new StreamResolver(registry, publicPolicy());
    await expect(resolver.resolve(item)).resolves.toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(addon.isEnabled()).toBe(true);
    expect(resolver.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stremio-addon-fixture", enabled: true, status: "ok" })
    ]));
  });

  it("still resolves series and episodes when movie is disabled", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(json({ streams: [{ infoHash: "a".repeat(40) }] }))
      .mockResolvedValueOnce(json({ streams: [{ infoHash: "b".repeat(40) }] }));
    const addon = provider(fetchImplementation, { contentTypes: { movie: false, series: true, anime: true } });
    expect(await addon.resolve(seriesItem, context)).toHaveLength(1);
    expect(await addon.resolve(episodeItem, context)).toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("applies anime policy to explicit classifications and Stremio type before structural kind", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const addon = provider(fetchImplementation, { contentTypes: { movie: true, series: true, anime: false } });
    for (const request of [
      { ...seriesItem, classifications: ["anime"] },
      { ...episodeItem, classifications: ["anime"] },
      { ...item, classifications: ["anime"] },
      { ...episodeItem, stremio: { type: "anime" } }
    ]) {
      await expect(addon.resolve(request, context)).resolves.toEqual([]);
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(addon.isEnabled()).toBe(true);
  });

  it("honors provider-wide enabled false even when every content type is true", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const addon = provider(fetchImplementation, {
      enabled: false, contentTypes: { movie: true, series: true, anime: true }
    });
    await expect(addon.resolve(item, context)).resolves.toEqual([]);
    expect(addon.isEnabled()).toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
