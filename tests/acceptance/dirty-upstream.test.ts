// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { MAX_HLS_RESOURCE_ENTRIES, PlaybackManager } from "../../src/playback/manager";
import type { NormalizedStreamSource } from "../../src/streams/types";
import type { AppConfig } from "../../src/types";
import { silentLogger, testConfig } from "../helpers";
import { mp4Fixture, mp4FixtureWithLargeMoov, mp4FixtureWithLargeTailMoov } from "../mp4-fixture";
import { DirtyUpstream } from "./dirty-upstream";

const movieId = "tt1234567";
const video = Buffer.from("000000186674797069736f6d00000000", "hex");

interface PublicStream { title: string; url: string; fixtureLabel: string }
const registeredByOrigin = new Map<string, Map<string, NormalizedStreamSource>>();

async function startScenario(fixture: DirtyUpstream, overrides: Partial<AppConfig> = {},
  peers: DirtyUpstream[] = []): Promise<{
  origin: string; close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "dirty-upstream-"));
  const server = createServer();
  const registered = new Map<string, NormalizedStreamSource>();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to the original manager below.
  const register = PlaybackManager.prototype.register;
  // Call-through observation only: correlate private fixture identity with real opaque tokens.
  const registration = vi.spyOn(PlaybackManager.prototype, "register").mockImplementation(function (this: PlaybackManager, source) {
    const token = register.call(this, source);
    registered.set(token, source);
    return token;
  });
  try {
    await writeFile(join(directory, "addons.json"), JSON.stringify([fixture, ...peers].map((upstream, index) => ({
      id: `dirty${index}`, name: `Dirty fixture ${index}`, manifestUrl: upstream.url("/manifest.json"), enabled: true
    }))));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    registeredByOrigin.set(origin, registered);
    const config = testConfig({
      publicBaseUrl: origin, triblerUrl: "http://127.0.0.1:1",
      streamProviders: ["stremio_addons"], stremioAddonProvidersFile: join(directory, "addons.json"),
      stremioMovieMetadataBaseUrl: fixture.url("/"),
      streamProviderTimeoutMs: 2_000, stremioAddonRequestTimeoutMs: 2_000,
      directHttpTimeoutMs: 5_000,
      directHttpProbe: { enabled: true, timeoutMs: 1_000, maxCandidates: 8, maxConcurrent: 2 },
      managedDownloadsStateFile: join(directory, "managed.json"), ...overrides
    });
    // The public bridge port stays blocked. Only exact fixture media URLs are test-allowed.
    const policy = new ExternalUrlPolicy({
      blockedEndpoints: [{ hostname: "127.0.0.1", port: String(port) }],
      allowedLoopbackUrls: [fixture, ...peers].flatMap((upstream) => upstream.allowedMediaUrls())
    });
    server.on("request", createApp(config, silentLogger, undefined, [], policy).app);
    return { origin, close: async () => {
      registration.mockRestore(); registeredByOrigin.delete(origin);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    registration.mockRestore();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function publicStreams(origin: string, id = movieId): Promise<PublicStream[]> {
  const response = await fetch(`${origin}/stream/movie/${id}.json`, { headers: { Origin: "https://web.stremio.com", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });
  expect(response.status).toBe(200);
  const body = await response.json() as { streams: PublicStream[] };
  return body.streams.map(stream => {
    const token = /^\/source\/([A-Za-z0-9_-]{32})\//.exec(new URL(stream.url).pathname)?.[1];
    const source = token ? registeredByOrigin.get(origin)?.get(token) : undefined;
    if (!source) throw new Error("Public fixture token has no registered source");
    return { ...stream, fixtureLabel: source.title ?? source.filename ?? source.providerId };
  });
}

function raw(url: string, title: string, filename: string, size = video.length): Record<string, unknown> {
  return { url, name: "Direct", description: title, behaviorHints: { filename, videoSize: size } };
}

async function playable(stream: PublicStream, origin: string, expected: Uint8Array = video): Promise<void> {
  const local = new URL(stream.url);
  expect(local.origin).toBe(origin);
  expect(local.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\//);
  const response = await fetch(local);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(expected));
}

async function playableHls(stream: PublicStream, origin: string): Promise<void> {
  const master = await fetch(stream.url);
  expect(master.status).toBe(200);
  const mediaPath = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await master.text())?.[0];
  expect(mediaPath).toBeTruthy();
  const media = await fetch(`${origin}${mediaPath}`);
  expect(media.status).toBe(200);
  const resourcePaths = [...(await media.text()).matchAll(/\/hls\/[A-Za-z0-9_-]{32}/g)].map(([path]) => path);
  expect(resourcePaths.length).toBeGreaterThanOrEqual(2);
  for (const [path, expected] of [[resourcePaths[0], "init-media"],
    [resourcePaths[1], "segment-0"]] as const) {
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
  }
}

describe("dirty upstream public-route acceptance", () => {
  it("compares both runtime directions when a large final MP4 index starts after mdat", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Example Movie",
      releaseInfo: "1994", runtime: "141 min" } };
    const cases = [
      { key: "too-short", title: "Too short", body: mp4FixtureWithLargeTailMoov(20 * 60), expected: false },
      { key: "too-long", title: "Too long", body: mp4FixtureWithLargeTailMoov(260 * 60), expected: false },
      { key: "compatible", title: "Server 1", body: mp4FixtureWithLargeTailMoov(140 * 60), expected: true },
      { key: "unknown", title: "Unknown", body: mp4FixtureWithLargeTailMoov(260 * 60, false), expected: true }
    ];
    fixture.streams = cases.map(({ key, title, body }) => raw(fixture.media(`/media/${key}.mp4`, {
      body, contentType: "video/mp4", range: "honor"
    }), title, "video.mp4", body.length));
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 4_000, maxCandidates: 4, maxConcurrent: 4
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel)))
        .toEqual(new Set(cases.filter(({ expected }) => expected).map(({ title }) => title)));
      for (const { key, title, body, expected } of cases) {
        const indexOffset = 24 + 16 + 80 * 1024;
        const ranges = fixture.hits.filter(({ path }) => path === `/media/${key}.mp4`)
          .map(({ range }) => range);
        expect(ranges).toEqual(["bytes=0-63", `bytes=${indexOffset}-${indexOffset + 65535}`]);
        const inspectedBytes = ranges.reduce((total, range) => {
          const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
          return total + (match ? Number(match[2]) - Number(match[1]) + 1 : 0);
        }, 0);
        expect(inspectedBytes).toBe(64 + 65_536);
        if (expected) await playable(streams.find((stream) => stream.fixtureLabel === title)!, bridge.origin, body);
      }
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("uses a complete early mvhd in an oversized fast-start moov to reject a short movie", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Example Movie",
      releaseInfo: "2008", runtime: "128 min" } };
    const shortVideo = mp4FixtureWithLargeMoov(197);
    const goodVideo = mp4Fixture(126 * 60);
    const unknownVideo = Buffer.from(mp4Fixture(4 * 60));
    unknownVideo.writeUInt32BE(0, 52);
    fixture.streams = [
      raw(fixture.media("/media/short.mp4", { body: shortVideo, contentType: "video/mp4", range: "honor" }),
        "Server A", "video.mp4", shortVideo.length),
      raw(fixture.media("/media/good.mp4", { body: goodVideo, contentType: "video/mp4", range: "honor" }),
        "Server 1", "video.mp4", goodVideo.length),
      raw(fixture.media("/media/unknown.mp4", { body: unknownVideo, contentType: "video/mp4", range: "honor" }),
        "Server 2", "video.mp4", unknownVideo.length)
    ];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(["Server 1", "Server 2"]));
      await playable(streams.find(({ fixtureLabel }) => fixtureLabel === "Server 1")!, bridge.origin, goodVideo);
      await playable(streams.find(({ fixtureLabel }) => fixtureLabel === "Server 2")!, bridge.origin, unknownVideo);
      expect(fixture.hits.filter(({ path }) => path === "/media/short.mp4")
        .map(({ range }) => range)).toEqual(["bytes=0-63"]);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects Vekra Signal Notes for Neral Signals using measured MP4 runtime contradiction", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: "tt9900103", type: "movie", name: "Neral Signals",
      releaseInfo: "2008", runtime: "128 min" } };
    const wrongVideo = mp4Fixture(4 * 60, "tail");
    const wrong = raw(fixture.media("/media/vekra-signal-notes.mp4", {
      body: wrongVideo, contentType: "video/mp4", range: "honor"
    }), "Vekra Signal Notes", "video.mp4", wrongVideo.length);
    fixture.streams = [wrong];
    const bridge = await startScenario(fixture);
    try {
      expect(await publicStreams(bridge.origin, "tt9900103")).toEqual([]);
      expect(fixture.hits.filter(({ path }) => path === "/media/vekra-signal-notes.mp4")
        .map(({ range }) => range)).toEqual(["bytes=0-63", `bytes=${wrongVideo.length - 36}-${wrongVideo.length - 1}`]);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps an opaque playable MP4 when the requested movie has no structured contradiction", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: "tt9900103", type: "movie", name: "Neral Signals",
      releaseInfo: "2008", runtime: "128 min" } };
    const goodVideo = mp4Fixture(126 * 60);
    fixture.streams = [raw(fixture.media("/media/opaque-movie.mp4", {
      body: goodVideo, contentType: "video/mp4", range: "honor"
    }), "Server 1", "video.mp4", goodVideo.length)];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin, "tt9900103");
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Server 1"]);
      await playable(streams[0]!, bridge.origin, goodVideo);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps localized and sparse playable movies while rejecting independent identity mutations", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title",
      releaseInfo: "1994", runtime: "126 min" } };
    const bad = [
      ["wrong-year", "Movie.Title.1985.1080p.mp4"],
      ["episode", "Movie.Title.S04E18.1994.1080p.mp4"],
      ["runtime", "Localized Movie\n3:06:00\n1080p"]
    ] as const;
    const good = [
      ["baseline", "Movie.Title.1994.720p.x264.mp4", 100],
      ["localized", "Kaze No Eiga.1994.1080p.x265.mp4", 5_000],
      ["quality", "Movie.Title.1994.2160p.x264.mp4", 1_000_000],
      ["sparse", "Server 1", 0]
    ] as const;
    for (const [key] of bad) fixture.media(`/media/${key}.mp4`, {
      body: video, contentType: "video/mp4", range: "honor"
    });
    for (const [key] of good) fixture.media(`/media/${key}.mp4`, {
      body: video, contentType: "video/mp4", range: "honor"
    });
    const candidates = [
      ...bad.map(([key, title]) => raw(fixture.url(`/media/${key}.mp4`), title,
        key === "runtime" ? "Movie.Title.1994.mp4" : title)),
      ...good.map(([key, title, size]) => raw(fixture.url(`/media/${key}.mp4`), title,
        key === "sparse" ? "video.mp4" : title, size))
    ];
    fixture.streams = candidates;
    const bridge = await startScenario(fixture);
    try {
      for (const order of [candidates, [...candidates].reverse()]) {
        fixture.streams = order;
        const streams = await publicStreams(bridge.origin);
        expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(good.map(([, title]) => title)));
        for (const stream of streams) await playable(stream, bridge.origin);
      }
      // Weak runtime gets one cached measurement opportunity; this tiny MP4
      // has no supported duration, so its textual contradiction still rejects.
      for (const [key] of bad) expect(fixture.count(`/media/${key}.mp4`)).toBe(key === "runtime" ? 1 : 0);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects completed 428 and ZIP masquerade while ordinary octet-stream media plays", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const failed = fixture.media("/media/failed.mp4", { status: 428 });
    const archive = fixture.media("/media/archive.mkv", { status: 206, contentType: "video/x-matroska",
      body: Buffer.from("504b030400000000", "hex"), range: "honor" });
    const good = fixture.media("/media/good.mp4", { body: video,
      contentType: "application/octet-stream", range: "honor" });
    fixture.streams = [raw(failed, "Failed 1994", "failed.mp4"),
      raw(archive, "Archive 1994", "archive.mkv"), raw(good, "Server 1", "good.mp4")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Server 1"]);
      await playable(streams[0]!, bridge.origin);
      const range = await fetch(streams[0]!.url, { headers: { Range: "bytes=0-3" } });
      expect(range.status).toBe(206);
      expect(Buffer.from(await range.arrayBuffer())).toEqual(video.subarray(0, 4));
      expect(fixture.count("/media/failed.mp4")).toBe(1);
      expect(fixture.count("/media/archive.mkv")).toBe(1);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("never promotes an unprobed known filename when the candidate cap shrinks", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const good = fixture.media("/media/good.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    const unprobed = fixture.media("/media/unprobed.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    fixture.streams = [raw(good, "Movie.Title.1994.720p.mp4", "good.mp4"),
      raw(unprobed, "Movie.Title.1994.1080p.mp4", "unprobed.mp4")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 1_000, maxCandidates: 1, maxConcurrent: 1
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Movie.Title.1994.720p.mp4"]);
      await playable(streams[0]!, bridge.origin);
      expect(fixture.count("/media/unprobed.mp4")).toBe(0);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("does not promote a candidate whose shared probe budget expires after a good source", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const good = fixture.media("/media/fast.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    const slow = fixture.media("/media/slow.mp4", { body: video, contentType: "video/mp4",
      range: "honor", delayMs: 2_000 });
    fixture.streams = [raw(good, "Movie.Title.1994.720p.mp4", "fast.mp4"),
      raw(slow, "Movie.Title.1994.1080p.mp4", "slow.mp4")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 300, maxCandidates: 2, maxConcurrent: 1
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Movie.Title.1994.720p.mp4"]);
      await playable(streams[0]!, bridge.origin);
      expect(fixture.count("/media/slow.mp4")).toBe(1);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps a safe redirect playable while refusing redirected private targets and loops", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const destination = fixture.media("/media/destination.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    const safe = fixture.media("/media/safe.mp4", { redirectTo: destination });
    const privateDestination = fixture.url("/media/private-target.mp4");
    const privateStart = fixture.media("/media/private-start.mp4", { redirectTo: privateDestination });
    const loop = fixture.media("/media/loop.mp4", { redirectTo: fixture.url("/media/loop.mp4") });
    fixture.streams = [raw(safe, "Movie.Title.1994.Safe.mp4", "safe.mp4"),
      raw(privateStart, "Movie.Title.1994.Private.mp4", "private-start.mp4"),
      raw(loop, "Movie.Title.1994.Loop.mp4", "loop.mp4")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      const safeStream = streams.find(({ fixtureLabel }) => fixtureLabel === "Movie.Title.1994.Safe.mp4");
      expect(safeStream).toBeDefined();
      await playable(safeStream!, bridge.origin);
      for (const title of ["Movie.Title.1994.Private.mp4", "Movie.Title.1994.Loop.mp4"]) {
        const broken = streams.find((stream) => stream.fixtureLabel === title);
        if (broken) expect((await fetch(broken.url)).status).toBe(502);
      }
      expect(fixture.count("/media/private-target.mp4")).toBe(0);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Movie.Title.1994.Safe.mp4"]);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("returns a large HLS VOD with valid MAP, first and last local tokens", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const vod = fixture.vod("large", 3_546);
    fixture.streams = [raw(vod.master, "Movie.Title.1994.HLS", "video.m3u8")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 5_000, maxCandidates: 1, maxConcurrent: 1
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams).toHaveLength(1);
      const master = await fetch(streams[0]!.url);
      expect(master.status).toBe(200);
      const mediaUrl = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await master.text())?.[0];
      expect(mediaUrl).toBeTruthy();
      const media = await fetch(`${bridge.origin}${mediaUrl}`);
      expect(media.status).toBe(200);
      const text = await media.text();
      const refs = [...text.matchAll(/\/hls\/[A-Za-z0-9_-]{32}/g)].map(([path]) => `${bridge.origin}${path}`);
      expect(refs).toHaveLength(3_547);
      for (const [url, expected] of [[refs[0]!, "init-media"], [refs[1]!, "segment-0"],
        [refs.at(-1)!, "segment-3545"]] as const) {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(expected);
      }
      expect(fixture.count("/media/large/init.mp4")).toBe(2); // preflight and local playback
    } finally { await bridge.close(); await fixture.close(); }
  }, 20_000);

  it("fails above-capacity HLS rewrite without returning dead tokens while a short VOD remains playable", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const huge = fixture.vod("oversize", MAX_HLS_RESOURCE_ENTRIES);
    const short = fixture.vod("short", 2);
    fixture.streams = [raw(huge.master, "Movie.Title.1994.Large.HLS", "large.m3u8"),
      raw(short.master, "Movie.Title.1994.Short.HLS", "short.m3u8")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 5_000, maxCandidates: 2, maxConcurrent: 2
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams).toHaveLength(2);
      const oversized = streams.find(({ fixtureLabel }) => fixtureLabel.includes("Large"))!;
      const healthy = streams.find(({ fixtureLabel }) => fixtureLabel.includes("Short"))!;
      const failed = await fetch(oversized.url);
      expect(failed.status).toBe(200); // The master itself is within bounds.
      const largeMediaPath = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await failed.text())?.[0];
      expect(largeMediaPath).toBeTruthy();
      const rejected = await fetch(`${bridge.origin}${largeMediaPath}`);
      expect(rejected.status).not.toBe(200);
      expect(await rejected.text()).not.toContain("#EXTM3U");
      const shortMaster = await fetch(healthy.url);
      const shortMediaPath = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await shortMaster.text())?.[0];
      const shortMedia = await fetch(`${bridge.origin}${shortMediaPath}`);
      expect(shortMedia.status).toBe(200);
      expect(await shortMedia.text()).toContain("#EXTM3U");
    } finally { await bridge.close(); await fixture.close(); }
  }, 20_000);

  it("rejects a short complete VOD by playlist duration while a film-length sibling plays", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Example Feature",
      releaseInfo: "2008", runtime: "128 min" } };
    const short = fixture.vod("short-duration", 2, true, { segmentSeconds: 60, playlistType: "VOD" });
    const feature = fixture.vod("feature-duration", 128, true, { segmentSeconds: 60, playlistType: "VOD" });
    fixture.streams = [raw(short.master, "Short clip", "clip.m3u8"),
      raw(feature.master, "Server 1", "feature.m3u8")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 5_000, maxCandidates: 2, maxConcurrent: 2
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Server 1"]);
      expect(fixture.count("/media/short-duration/segment-0.m4s")).toBe(1);
      await playableHls(streams[0]!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps VOD duration variants and HLS playlists without complete VOD evidence", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Example Feature",
      releaseInfo: "2008", runtime: "128 min" } };
    const variants = [123, 130, 137].map((minutes) => ({
      title: `Variant ${minutes}`,
      media: fixture.vod(`variant-${minutes}`, minutes, true, { segmentSeconds: 60, playlistType: "VOD" })
    }));
    const event = fixture.vod("event-duration", 2, true, {
      segmentSeconds: 60, playlistType: "EVENT", endList: false
    });
    const ambiguous = fixture.vod("ambiguous-duration", 2, true, { segmentSeconds: 60 });
    fixture.streams = [...variants.map(({ title, media }) => raw(media.master, title, `${title}.m3u8`)),
      raw(event.master, "Event stream", "event.m3u8"),
      raw(ambiguous.master, "Unspecified playlist", "ambiguous.m3u8")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 5_000, maxCandidates: 5, maxConcurrent: 2
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set([
        "Variant 123", "Variant 130", "Variant 137", "Event stream", "Unspecified playlist"
      ]));
      const eventStream = streams.find(({ fixtureLabel }) => fixtureLabel === "Event stream");
      expect(eventStream).toBeDefined();
      await playableHls(eventStream!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });







  it("keeps eligible presentation mutations while composing strong contradictions with quality metadata", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const good = fixture.media("/media/mutation-good.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    const failed = fixture.media("/media/mutation-failed.mp4", { status: 428 });
    const archive = fixture.media("/media/mutation-archive.mkv", { body: Buffer.from("504b030400000000", "hex"),
      contentType: "video/x-matroska", range: "honor" });
    const target = fixture.media("/media/year-redirect-target.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    const wrongYear = fixture.media("/media/year-redirect.mp4", { redirectTo: target });
    const badCases = [
      { title: "Rejected HTTP", stream: { ...raw(failed, "Movie Title (1994)", "failed.mp4"), name: "4K HEVC" } },
      { title: "Rejected archive", stream: { ...raw(archive, "Movie Title (1994)", "archive.mkv", 9_999_999), name: "4K HEVC" } },
      { title: "Rejected identity", stream: { ...raw(wrongYear, "Movie Title (1995)", "Movie.Title.1994.mp4"), name: "4K HEVC" } }
    ];
    const goodCases = [
      { title: "Movie Title (1994)", stream: raw(good, "Movie Title (1994)", "good.mp4") },
      { title: "MOVIE TITLE (1994)", stream: { ...raw(good, "MOVIE TITLE (1994)", "GOOD.MP4"), name: "1080p HEVC English" } },
      { title: "Localized (1994)", stream: { ...raw(good, "Localized (1994)", "good.mp4"), name: "720p AAC" } }
    ];
    const bridge = await startScenario(fixture);
    try {
      for (const goodCase of goodCases) {
        for (const badCase of badCases) {
          for (const order of [[badCase.stream, goodCase.stream], [goodCase.stream, badCase.stream]]) {
            fixture.streams = order;
            const streams = await publicStreams(bridge.origin);
            expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual([goodCase.title]);
            await playable(streams[0]!, bridge.origin);
          }
        }
      }
      expect(fixture.count("/media/year-redirect-target.mp4")).toBe(0);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects an HLS media reference blocked by URL policy while a sibling plays", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    fixture.media("/media/hls-first.ts", { body: video, contentType: "video/mp2t" });
    const blocked = fixture.media("/media/hls-blocked.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: "#EXTM3U\n#EXTINF:4,\nhls-first.ts\n#EXTINF:4,\nmissing-segment.ts\n#EXT-X-ENDLIST\n" });
    const good = fixture.vod("hls-sibling", 2);
    fixture.streams = [raw(blocked, "Blocked child", "blocked.m3u8"), raw(good.master, "Good HLS", "good.m3u8")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good HLS"]);
      expect(fixture.count("/media/missing-segment.ts")).toBe(0);
      await playableHls(streams[0]!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("recovers across provider stream failure and shared-probe budget exhaustion", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const slow = fixture.media("/media/retry-slow.mp4", { body: video, contentType: "video/mp4",
      range: "honor", delayMs: 200 });
    const good = fixture.media("/media/retry-good.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    fixture.streams = [raw(good, "Good", "good.mp4")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 60, maxCandidates: 1, maxConcurrent: 1
    } });
    try {
      fixture.streamStatus = 503;
      expect(await publicStreams(bridge.origin)).toEqual([]);
      fixture.streamStatus = 200;
      fixture.streams = [raw(slow, "Slow", "slow.mp4")];
      expect(await publicStreams(bridge.origin)).toEqual([]);
      fixture.streams = [raw(good, "Good", "good.mp4")];
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      await playable(streams[0]!, bridge.origin);
      expect(fixture.count("/media/retry-good.mp4")).toBeGreaterThan(0);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps the latest large HLS rewrite playable after a smaller intervening playlist", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const large = fixture.vod("repeat-large", 3_546);
    const small = fixture.vod("repeat-small", 2);
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 5_000, maxCandidates: 1, maxConcurrent: 1
    } });
    try {
      for (const [candidate, title] of [[large.master, "Large"], [small.master, "Small"],
        [large.master, "Large"]] as const) {
        fixture.streams = [raw(candidate, title, `${title}.m3u8`)];
        const streams = await publicStreams(bridge.origin);
        expect(streams.map((stream) => stream.fixtureLabel)).toEqual([title]);
        await playableHls(streams[0]!, bridge.origin);
      }
    } finally { await bridge.close(); await fixture.close(); }
  }, 20_000);

  it("keeps a playable provider sibling through a slow failure and recovery in either provider order", async () => {
    const slow = new DirtyUpstream();
    const healthy = new DirtyUpstream();
    await slow.listen();
    await healthy.listen();
    const meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    slow.meta = meta;
    healthy.meta = meta;
    const badUrl = slow.media("/media/slow-bad.mp4", { status: 428 });
    const goodUrl = healthy.media("/media/provider-good.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    slow.streams = [raw(badUrl, "Bad", "bad.mp4")];
    healthy.streams = [raw(goodUrl, "Good", "good.mp4")];
    try {
      for (const [first, second] of [[slow, healthy], [healthy, slow]] as const) {
        slow.streamDelayMs = 200;
        const bridge = await startScenario(first, { streamProviderTimeoutMs: 80,
          stremioAddonRequestTimeoutMs: 80 }, [second]);
        try {
          const duringFailure = await publicStreams(bridge.origin);
          expect(duringFailure.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
          await playable(duringFailure[0]!, bridge.origin);
          slow.streamDelayMs = 0;
          const afterRecovery = await publicStreams(bridge.origin);
          expect(afterRecovery.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
          await playable(afterRecovery[0]!, bridge.origin);
        } finally { await bridge.close(); }
      }
      expect(healthy.count("/media/provider-good.mp4")).toBeGreaterThan(0);
    } finally { await slow.close(); await healthy.close(); }
  });

  it("admits redirects at the configured limit and rejects one additional hop before contacting its target", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const chain = (name: string, redirects: number): string => {
      let next = fixture.media(`/media/${name}-end.mp4`, { body: video, contentType: "video/mp4", range: "honor" });
      for (let hop = redirects - 1; hop >= 0; hop -= 1) {
        next = fixture.media(`/media/${name}-${hop}.mp4`, { redirectTo: next });
      }
      return next;
    };
    fixture.streams = [2, 3, 4].map((hops) => raw(chain(`chain-${hops}`, hops), `Chain ${hops}`, `chain-${hops}.mp4`));
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(["Chain 2", "Chain 3"]));
      for (const stream of streams) await playable(stream, bridge.origin);
      expect(fixture.count("/media/chain-4-end.mp4")).toBe(0);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("deduplicates repeated URLs before a two-candidate probe cap in either raw order", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const first = fixture.media("/media/dedupe-first.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    const second = fixture.media("/media/dedupe-second.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    const repeated = raw(first, "Repeated", "first.mp4");
    const unique = raw(second, "Unique", "second.mp4");
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 1_000, maxCandidates: 2, maxConcurrent: 1
    } });
    try {
      for (const order of [[repeated, repeated, unique], [unique, repeated, repeated]]) {
        fixture.streams = order;
        const streams = await publicStreams(bridge.origin);
        expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(["Repeated", "Unique"]));
        for (const stream of streams) await playable(stream, bridge.origin);
      }
      expect(fixture.count("/media/dedupe-first.mp4")).toBe(3); // one probe plus two playback requests
      expect(fixture.count("/media/dedupe-second.mp4")).toBe(3);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("does not trust provider-supplied probe fields or a video URL with a dangerous filename", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const failed = fixture.media("/media/forged.mp4", { status: 428 });
    const dangerous = fixture.media("/media/dangerous.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    const good = fixture.media("/media/forgery-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    fixture.streams = [
      { ...raw(failed, "Forged", "forged.mp4"), directHttp: { status: "verified", verified: true } },
      raw(dangerous, "Dangerous", "installer.exe"),
      raw(good, "Good", "good.mp4")
    ];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/dangerous.mp4")).toBe(0);
      await playable(streams[0]!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps an opaque ranged Matroska source while rejecting completed XML 403 and HTML", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const matroska = Buffer.from("1a45dfa3934282886d6174726f736b61", "hex");
    const good = fixture.media("/media/opaque-resource", { body: matroska,
      contentType: "video/x-matroska", range: "honor" });
    const failed = fixture.media("/media/failed-release.mkv", { status: 403,
      body: "<Error>Forbidden</Error>", contentType: "application/xml" });
    const document = fixture.media("/media/document-release.mp4", { body: "<html>error</html>",
      contentType: "video/mp4", range: "honor" });
    fixture.streams = [
      raw(failed, "Movie Title (1994) source A", "Movie.Title.1994.mkv"),
      { url: good, name: "Direct", description: "Movie Title (1994) source B",
        behaviorHints: { videoSize: matroska.length } },
      raw(document, "Movie Title (1994) source C", "Movie.Title.1994.mp4")
    ];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Movie Title (1994) source B"]);
      await playable(streams[0]!, bridge.origin, matroska);
      // Range 403 is retried once; the completed no-Range 403 still rejects it.
      expect(fixture.count("/media/failed-release.mkv")).toBe(2);
      expect(fixture.count("/media/document-release.mp4")).toBe(1);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("backfills a deterministic failed probe without hiding a playable sibling", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const failed = raw(fixture.media("/media/backfill-failed.mp4", { status: 428 }), "Failed", "failed.mp4");
    const good = raw(fixture.media("/media/backfill-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Good", "good.mp4");
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 1_000, maxCandidates: 1, maxConcurrent: 1
    } });
    try {
      for (const order of [[failed, good], [good, failed]]) {
        fixture.streams = order;
        const streams = await publicStreams(bridge.origin);
        expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
        await playable(streams[0]!, bridge.origin);
      }
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("gives a later provider a probe slot before an early provider exhausts the shared budget", async () => {
    const slow = new DirtyUpstream();
    const healthy = new DirtyUpstream();
    await Promise.all([slow.listen(), healthy.listen()]);
    slow.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const early = Array.from({ length: 8 }, (_, index) => raw(slow.media(`/media/fair-slow-${index}.mp4`, {
      body: video, contentType: "video/mp4", range: "honor", delayMs: 1_200
    }), `Slow ${index}`, `slow-${index}.mp4`));
    const good = raw(healthy.media("/media/fair-good.mp4", {
      body: video, contentType: "video/mp4", range: "honor"
    }), "Good", "good.mp4");
    slow.streams = early;
    healthy.streams = [good];
    const bridge = await startScenario(slow, { directHttpProbe: {
      enabled: true, timeoutMs: 600, maxCandidates: 8, maxConcurrent: 2
    } }, [healthy]);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(healthy.count("/media/fair-good.mp4")).toBe(1);
      await playable(streams.find(({ fixtureLabel }) => fixtureLabel === "Good")!, bridge.origin);
    } finally { await bridge.close(); await Promise.all([slow.close(), healthy.close()]); }
  });

  it("releases a slow single-provider probe slot while the shared budget can still verify a later source", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const slow = raw(fixture.media("/media/fair-serial-slow.mp4", {
      body: video, contentType: "video/mp4", range: "honor", delayMs: 1_200
    }), "Slow", "slow.mp4");
    const good = raw(fixture.media("/media/fair-serial-good.mp4", {
      body: video, contentType: "video/mp4", range: "honor"
    }), "Good", "good.mp4");
    fixture.streams = [slow, good];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 600, maxCandidates: 2, maxConcurrent: 1
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/fair-serial-good.mp4")).toBe(1);
      await playable(streams.find(({ fixtureLabel }) => fixtureLabel === "Good")!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps a healthy candidate after 50 explicit identity contradictions", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const good = raw(fixture.media("/media/identity-limit-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Good", "good.mp4");
    const wrong = raw(fixture.url("/media/never.mp4"), "Movie Title (1995)", "wrong.mp4");
    const bridge = await startScenario(fixture);
    try {
      for (const order of [[...Array.from({ length: 50 }, () => wrong), good],
        [good, ...Array.from({ length: 50 }, () => wrong)]]) {
        fixture.streams = order;
        const streams = await publicStreams(bridge.origin);
        expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
        await playable(streams[0]!, bridge.origin);
      }
      expect(fixture.count("/media/never.mp4")).toBe(0);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("keeps a distinct candidate after 50 raw URL duplicates", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const duplicate = raw(fixture.media("/media/limit-duplicate.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Duplicate", "duplicate.mp4");
    const distinct = raw(fixture.media("/media/limit-distinct.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Distinct", "distinct.mp4");
    const bridge = await startScenario(fixture);
    try {
      for (const order of [[...Array.from({ length: 50 }, () => duplicate), distinct],
        [distinct, ...Array.from({ length: 50 }, () => duplicate)]]) {
        fixture.streams = order;
        const streams = await publicStreams(bridge.origin);
        expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(["Duplicate", "Distinct"]));
        for (const stream of streams) await playable(stream, bridge.origin);
      }
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("normalizes beyond 100 unusable raw Stremio objects within the bounded response", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const good = raw(fixture.media("/media/raw-limit-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Good", "good.mp4");
    const unusable = { name: "No transport" };
    const bridge = await startScenario(fixture);
    try {
      for (const order of [[...Array.from({ length: 100 }, () => unusable), good],
        [good, ...Array.from({ length: 100 }, () => unusable)]]) {
        fixture.streams = order;
        const streams = await publicStreams(bridge.origin);
        expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
        await playable(streams[0]!, bridge.origin);
      }
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("excludes an HLS playlist whose required MAP is blocked while a sibling plays", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    fixture.media("/media/map-first.ts", { body: video, contentType: "video/mp2t" });
    fixture.media("/media/map-last.ts", { body: video, contentType: "video/mp2t" });
    const blocked = fixture.media("/media/map-blocked.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: "#EXTM3U\n#EXT-X-MAP:URI=\"missing-map.mp4\"\n#EXTINF:4,\nmap-first.ts\n#EXTINF:4,\nmap-last.ts\n#EXT-X-ENDLIST\n" });
    const good = fixture.vod("map-good", 2);
    fixture.streams = [raw(blocked, "Blocked map", "blocked.m3u8"), raw(good.master, "Good HLS", "good.m3u8")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good HLS"]);
      expect(fixture.count("/media/missing-map.mp4")).toBe(0);
      await playableHls(streams[0]!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("excludes HTML served as 206 video while MP4 and octet-stream siblings play", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const html = fixture.media("/media/document.mp4", { body: "<html><body>not media</body></html>",
      contentType: "video/mp4", range: "honor" });
    const mp4 = fixture.media("/media/document-good.mp4", { body: video, contentType: "video/mp4", range: "honor" });
    const octet = fixture.media("/media/document-octet.mp4", { body: video,
      contentType: "application/octet-stream", range: "honor" });
    fixture.streams = [raw(html, "HTML", "document.mp4"), raw(mp4, "MP4", "good.mp4"),
      raw(octet, "Octet", "octet.mp4")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(["MP4", "Octet"]));
      for (const stream of streams) await playable(stream, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 2: keeps the last usable result at normalized-input boundaries", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const duplicateUrl = fixture.media("/media/boundary-duplicate.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    const goodUrl = fixture.media("/media/boundary-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    const duplicate = raw(duplicateUrl, "Duplicate", "duplicate.mp4");
    const wrongYear = raw(fixture.url("/media/never.mp4"), "Movie Title (1995)", "wrong.mp4");
    const good = raw(goodUrl, "Good", "good.mp4");
    const bridge = await startScenario(fixture);
    try {
      for (const prefix of [Array.from({ length: 99 }, () => ({ name: "No URL" })),
        Array.from({ length: 100 }, () => ({ name: "No URL" })),
        Array.from({ length: 99 }, () => duplicate), Array.from({ length: 99 }, () => wrongYear)]) {
        fixture.streams = [...prefix, good];
        const streams = await publicStreams(bridge.origin);
        expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toContain("Good");
        await playable(streams.find(({ fixtureLabel }) => fixtureLabel === "Good")!, bridge.origin);
      }
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 2: rejects HTML, XML and JSON regardless of MIME or attractive quality", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const documents = [
      ["html-bom", "\uFEFF  <html>Oops", "video/mp4", "honor"],
      ["doctype", " <!doctype html>", "video/mp4", "ignore"],
      ["xml", " <?xml version", "application/octet-stream", "honor"],
      ["json", '{"error":true}', "video/mp4", "honor"]
    ] as const;
    const bad = documents.map(([name, body, contentType, range]) => ({
      ...raw(fixture.media(`/media/${name}.mp4`, { body, contentType, range }), name, `${name}.mp4`),
      name: "4K HEVC"
    }));
    const unknown = raw(fixture.media("/media/unknown-binary.mp4", { body: Buffer.from([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    ]), contentType: "application/octet-stream", range: "honor" }), "Unknown", "unknown.mp4");
    const good = raw(fixture.media("/media/content-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Good", "good.mp4");
    const bridge = await startScenario(fixture);
    try {
      fixture.streams = [...bad, unknown, good];
      const streams = await publicStreams(bridge.origin);
      expect(new Set(streams.map(({ fixtureLabel }) => fixtureLabel))).toEqual(new Set(["Unknown", "Good"]));
      for (const stream of streams) await playable(stream, bridge.origin,
        stream.fixtureLabel === "Good" ? video : Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 2: resolves a relative MAP with query data and rejects a hard-failing MAP", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const map = fixture.media("/media/query-init.mp4", { body: "init-media", contentType: "video/mp4" });
    fixture.allowMediaUrl(`${map}?proof=opaque`);
    fixture.media("/media/query-a.ts", { body: "segment-0", contentType: "video/mp2t" });
    fixture.media("/media/query-b.ts", { body: "segment-1", contentType: "video/mp2t" });
    const playlist = (mapName: string): string => `#EXTM3U\n#EXT-X-MAP:URI="${mapName}"\n`
      + "#EXTINF:4,\nquery-a.ts\n#EXTINF:4,\nquery-b.ts\n#EXT-X-ENDLIST\n";
    const good = fixture.media("/media/query-good.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: playlist("query-init.mp4?proof=opaque") });
    const bad = fixture.media("/media/query-bad.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: playlist("missing-init.mp4") });
    fixture.streams = [raw(bad, "Bad", "bad.m3u8"), raw(good, "Good", "good.m3u8")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/missing-init.mp4")).toBe(0);
      const media = await fetch(streams[0]!.url);
      expect(media.status).toBe(200);
      const localReferences = [...(await media.text()).matchAll(/\/hls\/[A-Za-z0-9_-]{32}/g)]
        .map(([reference]) => new URL(reference, bridge.origin));
      expect(localReferences).toHaveLength(3);
      expect(await (await fetch(localReferences[0]!)).text()).toBe("init-media");
      expect(await (await fetch(localReferences[1]!)).text()).toBe("segment-0");
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 2: bounds replacement after two deterministic failures and retains two healthy sources", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const failed = raw(fixture.media("/media/replacement-428.mp4", { status: 428 }), "Failed", "failed.mp4");
    const archive = raw(fixture.media("/media/replacement-zip.mkv", { status: 206,
      contentType: "video/x-matroska", body: Buffer.from("504b030400000000", "hex"), range: "honor" }),
    "Archive", "archive.mkv");
    const good1 = raw(fixture.media("/media/replacement-one.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Good one", "one.mp4");
    const good2 = raw(fixture.media("/media/replacement-two.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Good two", "two.mp4");
    const beyond = raw(fixture.media("/media/replacement-beyond.mp4", { body: video,
      contentType: "video/mp4", range: "honor" }), "Beyond", "beyond.mp4");
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 1_000, maxCandidates: 2, maxConcurrent: 1
    } });
    try {
      for (const [order, expected, beyondRequests] of [
        [[failed, archive, good1, good2, beyond], ["Good one", "Good two"], 0],
        // Four cached observations leave fresh capacity for the remaining source.
        [[good1, failed, good2, archive, beyond], ["Good one", "Good two", "Beyond"], 1]
      ] as const) {
        fixture.streams = [...order];
        const streams = await publicStreams(bridge.origin);
        expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(expected);
        expect(fixture.count("/media/replacement-beyond.mp4")).toBe(beyondRequests);
        for (const stream of streams) await playable(stream, bridge.origin);
      }
      expect(fixture.count("/media/replacement-beyond.mp4")).toBe(2); // Probe plus playback on the warm request.
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 2: unrelated healthy requests recover after failed MAP and document probes", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const badMap = fixture.media("/media/sequence-map.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: '#EXTM3U\n#EXT-X-MAP:URI="missing-sequence-init.mp4"\n#EXTINF:4,\nsequence-a.ts\n#EXTINF:4,\nsequence-b.ts\n#EXT-X-ENDLIST\n' });
    fixture.media("/media/sequence-a.ts", { body: video, contentType: "video/mp2t" });
    fixture.media("/media/sequence-b.ts", { body: video, contentType: "video/mp2t" });
    const badDocument = fixture.media("/media/sequence-document.mp4", {
      body: "<html>error</html>", contentType: "video/mp4", range: "honor" });
    const good = fixture.media("/media/sequence-good.mp4", { body: video,
      contentType: "video/mp4", range: "honor" });
    const bridge = await startScenario(fixture);
    try {
      for (const [candidate, expected] of [
        [raw(badMap, "Bad MAP", "bad.m3u8"), []],
        [raw(good, "Good", "good.mp4"), ["Good"]],
        [raw(badDocument, "Bad document", "document.mp4"), []],
        [raw(good, "Good", "good.mp4"), ["Good"]]
      ] as const) {
        fixture.streams = [candidate];
        const streams = await publicStreams(bridge.origin);
        expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(expected);
        for (const stream of streams) await playable(stream, bridge.origin);
      }
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects a blocked middle MAP while deduplicating repeated valid MAP changes", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    for (const name of ["first", "middle", "last"]) {
      fixture.media(`/media/${name}-init.mp4`, { body: `init-${name}`, contentType: "video/mp4" });
    }
    for (let index = 0; index < 4; index += 1) {
      fixture.media(`/media/map-segment-${index}.ts`, { body: `segment-${index}`, contentType: "video/mp2t" });
    }
    const playlist = (middle: string): string => '#EXTM3U\n#EXT-X-MAP:URI="first-init.mp4"\n'
      + '#EXTINF:4,\nmap-segment-0.ts\n#EXT-X-MAP:URI="first-init.mp4"\n'
      + `#EXTINF:4,\nmap-segment-1.ts\n#EXT-X-MAP:URI="${middle}"\n`
      + '#EXTINF:4,\nmap-segment-2.ts\n#EXT-X-MAP:URI="last-init.mp4"\n'
      + '#EXTINF:4,\nmap-segment-3.ts\n#EXT-X-ENDLIST\n';
    const bad = fixture.media("/media/map-middle-blocked.m3u8", {
      body: playlist("missing-init.mp4"), contentType: "application/vnd.apple.mpegurl" });
    const good = fixture.media("/media/map-middle-good.m3u8", {
      body: playlist("middle-init.mp4"), contentType: "application/vnd.apple.mpegurl" });
    fixture.streams = [raw(bad, "Blocked middle", "bad.m3u8"), raw(good, "Good", "good.m3u8")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/missing-init.mp4")).toBe(0);
      // The bad source and the healthy source each validate a repeated MAP once.
      expect(fixture.count("/media/first-init.mp4")).toBe(2);
      expect(fixture.count("/media/middle-init.mp4")).toBe(1);
      const media = await fetch(streams[0]!.url);
      expect(media.status).toBe(200);
      const references = [...(await media.text()).matchAll(/\/hls\/[A-Za-z0-9_-]{32}/g)]
        .map(([path]) => new URL(path, bridge.origin));
      expect(references).toHaveLength(8);
      expect(await (await fetch(references[4]!)).text()).toBe("init-middle");
      expect(await (await fetch(references[6]!)).text()).toBe("init-last");
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects a blocked HLS key while preserving valid repeated key and METHOD=NONE playback", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const key = Buffer.alloc(16, 0x37);
    fixture.media("/media/valid.key", { body: key, contentType: "application/octet-stream" });
    for (let index = 0; index < 3; index += 1) {
      fixture.media(`/media/key-segment-${index}.ts`, { body: `segment-${index}`, contentType: "video/mp2t" });
    }
    const playlist = (keyName: string): string => '#EXTM3U\n'
      + `#EXT-X-KEY:METHOD=AES-128,URI="${keyName}",IV=0x0123456789abcdef\n`
      + '#EXTINF:4,\nkey-segment-0.ts\n'
      + `#EXT-X-KEY:METHOD=AES-128,URI="${keyName}",IV=0x0123456789abcdef\n`
      + '#EXTINF:4,\nkey-segment-1.ts\n#EXT-X-KEY:METHOD=NONE\n'
      + '#EXTINF:4,\nkey-segment-2.ts\n#EXT-X-ENDLIST\n';
    const bad = fixture.media("/media/key-blocked.m3u8", { body: playlist("missing.key"),
      contentType: "application/vnd.apple.mpegurl" });
    const good = fixture.media("/media/key-valid.m3u8", { body: playlist("valid.key"),
      contentType: "application/vnd.apple.mpegurl" });
    fixture.streams = [raw(bad, "Blocked key", "blocked.m3u8"), raw(good, "Good", "good.m3u8")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/missing.key")).toBe(0);
      expect(fixture.count("/media/valid.key")).toBe(1);
      const media = await fetch(streams[0]!.url);
      expect(media.status).toBe(200);
      const rewritten = await media.text();
      expect(rewritten).toContain("IV=0x0123456789abcdef");
      expect(rewritten).toContain("#EXT-X-KEY:METHOD=NONE");
      const keyUrl = /#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/.exec(rewritten)?.[1];
      expect(keyUrl).toBeTruthy();
      expect(new URL(keyUrl!, bridge.origin).origin).toBe(bridge.origin);
      expect(Buffer.from(await (await fetch(new URL(keyUrl!, bridge.origin))).arrayBuffer())).toEqual(key);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects split HTML, XML, JSON and ZIP HLS dependencies while preserving split binary", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const documents: Array<[string, Buffer | string]> = [
      ["html", "\uFEFF <html>error</html>"], ["xml", " <?xml version=\"1.0\"?>"],
      ["json", ' {"error":true}'], ["zip", Buffer.from("504b030400000000", "hex")]
    ];
    const streams: Record<string, unknown>[] = [];
    for (const [name, body] of documents) {
      fixture.media(`/media/split-${name}.ts`, { body, contentType: "video/mp2t",
        splitAtBytes: 1, splitDelayMs: 10 });
      streams.push(raw(fixture.media(`/media/split-${name}.m3u8`, {
        body: `#EXTM3U\n#EXTINF:4,\nsplit-${name}.ts\n#EXT-X-ENDLIST\n`,
        contentType: "application/vnd.apple.mpegurl" }), name, `${name}.m3u8`));
    }
    const binary = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    fixture.media("/media/split-binary.ts", { body: binary, contentType: "video/mp2t",
      splitAtBytes: 1, splitDelayMs: 10 });
    streams.push(raw(fixture.media("/media/split-binary.m3u8", {
      body: "#EXTM3U\n#EXTINF:4,\nsplit-binary.ts\n#EXT-X-ENDLIST\n",
      contentType: "application/vnd.apple.mpegurl" }), "Binary", "binary.m3u8"));
    fixture.streams = streams;
    const bridge = await startScenario(fixture);
    try {
      const results = await publicStreams(bridge.origin);
      expect(results.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Binary"]);
      const media = await fetch(results[0]!.url);
      expect(media.status).toBe(200);
      const path = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await media.text())?.[0];
      expect(path).toBeTruthy();
      expect(Buffer.from(await (await fetch(`${bridge.origin}${path}`)).arrayBuffer())).toEqual(binary);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 3: admits 32 distinct MAPs and rejects 33 before dependency requests", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    for (let index = 0; index < 33; index += 1) {
      fixture.media(`/media/cap-init-${index}.mp4`, { body: `init-${index}`, contentType: "video/mp4" });
      fixture.media(`/media/cap-segment-${index}.ts`, { body: `segment-${index}`, contentType: "video/mp2t" });
    }
    const playlist = (count: number): string => `#EXTM3U\n${Array.from({ length: count }, (_, index) =>
      `#EXT-X-MAP:URI="cap-init-${index}.mp4"\n#EXTINF:4,\ncap-segment-${index}.ts\n`).join("")}#EXT-X-ENDLIST\n`;
    const bad = fixture.media("/media/cap-33.m3u8", { body: playlist(33),
      contentType: "application/vnd.apple.mpegurl" });
    const good = fixture.media("/media/cap-32.m3u8", { body: playlist(32),
      contentType: "application/vnd.apple.mpegurl" });
    fixture.streams = [raw(bad, "Over capacity", "bad.m3u8"), raw(good, "Good", "good.m3u8")];
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 4_000, maxCandidates: 8, maxConcurrent: 2
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/cap-init-32.mp4")).toBe(0);
      expect(fixture.count("/media/cap-init-31.mp4")).toBe(1);
      const media = await fetch(streams[0]!.url);
      expect(media.status).toBe(200);
      const refs = [...(await media.text()).matchAll(/\/hls\/[A-Za-z0-9_-]{32}/g)]
        .map(([path]) => new URL(path, bridge.origin));
      expect(refs).toHaveLength(64);
      expect(await (await fetch(refs[0]!)).text()).toBe("init-0");
      expect(await (await fetch(refs[62]!)).text()).toBe("init-31");
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 3: preserves two MAP and KEY changes, query URLs, repetition, and VOD runtime", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title",
      releaseInfo: "1994", runtime: "2 min" } };
    for (const name of ["a", "b"]) {
      const map = fixture.media(`/media/composed-${name}-init.mp4`, {
        body: `init-${name}`, contentType: "video/mp4" });
      const key = fixture.media(`/media/composed-${name}.key`, {
        body: Buffer.alloc(16, name === "a" ? 1 : 2),
        contentType: name === "a" ? "text/plain" : "application/octet-stream" });
      fixture.allowMediaUrl(`${map}?opaque=${name}`);
      fixture.allowMediaUrl(`${key}?opaque=${name}`);
    }
    for (let index = 0; index < 3; index += 1) fixture.media(`/media/composed-${index}.ts`, {
      body: `segment-${index}`, contentType: "video/mp2t" });
    const mediaBody = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n'
      + '#EXT-X-MAP:URI="composed-a-init.mp4?opaque=a"\n'
      + '#EXT-X-KEY:METHOD=AES-128,URI="composed-a.key?opaque=a"\n'
      + '#EXTINF:40,\ncomposed-0.ts\n'
      + '#EXT-X-MAP:URI="composed-b-init.mp4?opaque=b"\n'
      + '#EXT-X-KEY:METHOD=AES-128,URI="composed-b.key?opaque=b"\n'
      + '#EXTINF:40,\ncomposed-1.ts\n'
      + '#EXT-X-MAP:URI="composed-b-init.mp4?opaque=b"\n'
      + '#EXT-X-KEY:METHOD=AES-128,URI="composed-b.key?opaque=b"\n'
      + '#EXTINF:40,\ncomposed-2.ts\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-ENDLIST\n';
    fixture.media("/media/composed-media.m3u8", {
      body: mediaBody, contentType: "application/vnd.apple.mpegurl" });
    const master = fixture.media("/media/composed-master.m3u8", {
      body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\ncomposed-media.m3u8\n',
      contentType: "application/vnd.apple.mpegurl" });
    fixture.streams = [raw(master, "Good", "good.m3u8")];
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      for (const name of ["a", "b"]) {
        expect(fixture.count(`/media/composed-${name}-init.mp4`)).toBe(1);
        expect(fixture.count(`/media/composed-${name}.key`)).toBe(1);
      }
      const masterReply = await fetch(streams[0]!.url);
      const mediaPath = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await masterReply.text())?.[0];
      const mediaReply = await fetch(`${bridge.origin}${mediaPath}`);
      expect(mediaReply.status).toBe(200);
      const rewritten = await mediaReply.text();
      expect(rewritten).toContain("#EXT-X-KEY:METHOD=NONE");
      const keyUrls = [...rewritten.matchAll(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/g)]
        .map((match) => new URL(match[1]!, bridge.origin));
      expect(keyUrls).toHaveLength(3);
      expect(Buffer.from(await (await fetch(keyUrls[0]!)).arrayBuffer())).toEqual(Buffer.alloc(16, 1));
      expect(Buffer.from(await (await fetch(keyUrls[1]!)).arrayBuffer())).toEqual(Buffer.alloc(16, 2));
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 3: rejects unusable dependency redirects, HTTP failures and disguised documents", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const safeTarget = fixture.media("/media/dependency-safe-target.mp4", {
      body: "init-safe", contentType: "video/mp4" });
    fixture.media("/media/dependency-safe-redirect.mp4", { redirectTo: safeTarget });
    fixture.media("/media/dependency-blocked-redirect.mp4", {
      redirectTo: fixture.url("/media/dependency-private.mp4") });
    fixture.media("/media/dependency-403.key", { status: 403 });
    fixture.media("/media/dependency-html.key", { body: "<html>error</html>", contentType: "text/html" });
    fixture.media("/media/dependency-xml.key", { body: "<?xml version=\"1.0\"?>",
      contentType: "application/octet-stream" });
    fixture.media("/media/dependency-json.mp4", { body: '{"error":true}', contentType: "video/mp4" });
    fixture.media("/media/dependency-zip.mp4", { body: Buffer.from("504b030400000000", "hex"),
      contentType: "video/mp4" });
    for (const segment of ["a", "b"]) fixture.media(`/media/dependency-${segment}.ts`, {
      body: `segment-${segment}`, contentType: "video/mp2t" });
    const variants: Array<[string, string, "map" | "key"]> = [
      ["Blocked redirect", "dependency-blocked-redirect.mp4", "map"],
      ["Hard HTTP", "dependency-403.key", "key"],
      ["HTML key", "dependency-html.key", "key"],
      ["XML key", "dependency-xml.key", "key"],
      ["JSON map", "dependency-json.mp4", "map"],
      ["ZIP map", "dependency-zip.mp4", "map"],
      ["Good", "dependency-safe-redirect.mp4", "map"]
    ];
    fixture.streams = variants.map(([title, uri, kind], index) => raw(fixture.media(
      `/media/dependency-playlist-${index}.m3u8`, { contentType: "application/vnd.apple.mpegurl",
        body: `#EXTM3U\n${kind === "map" ? `#EXT-X-MAP:URI="${uri}"`
          : `#EXT-X-KEY:METHOD=AES-128,URI="${uri}"`}\n`
          + '#EXTINF:4,\ndependency-a.ts\n#EXTINF:4,\ndependency-b.ts\n#EXT-X-ENDLIST\n'
      }), title, `${index}.m3u8`));
    const bridge = await startScenario(fixture);
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/dependency-private.mp4")).toBe(0);
      expect(fixture.count("/media/dependency-safe-target.mp4")).toBe(1);
      const playlist = await fetch(streams[0]!.url);
      expect(playlist.status).toBe(200);
      const first = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await playlist.text())?.[0];
      expect(await (await fetch(`${bridge.origin}${first}`)).text()).toBe("init-safe");
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("round 3: dependency deadline does not poison a later healthy request", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    fixture.media("/media/deadline-init.mp4", { body: "init-media",
      contentType: "video/mp4", delayMs: 250 });
    for (const name of ["a", "b"]) fixture.media(`/media/deadline-${name}.ts`, {
      body: video, contentType: "video/mp2t" });
    const slow = fixture.media("/media/deadline-slow.m3u8", {
      body: '#EXTM3U\n#EXT-X-MAP:URI="deadline-init.mp4"\n'
        + '#EXTINF:4,\ndeadline-a.ts\n#EXTINF:4,\ndeadline-b.ts\n#EXT-X-ENDLIST\n',
      contentType: "application/vnd.apple.mpegurl" });
    const good = fixture.media("/media/deadline-good.mp4", {
      body: video, contentType: "video/mp4", range: "honor" });
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 70, maxCandidates: 1, maxConcurrent: 1
    } });
    try {
      fixture.streams = [raw(slow, "Slow", "slow.m3u8")];
      expect(await publicStreams(bridge.origin)).toEqual([]);
      fixture.streams = [raw(good, "Good", "good.mp4")];
      const recovered = await publicStreams(bridge.origin);
      expect(recovered.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      await playable(recovered[0]!, bridge.origin);
    } finally { await bridge.close(); await fixture.close(); }
  });

  it("rejects blocked master session keys, malformed NONE keys, and selected audio renditions", async () => {
    const fixture = new DirtyUpstream();
    await fixture.listen();
    fixture.meta = { meta: { id: movieId, type: "movie", name: "Movie Title", releaseInfo: "1994" } };
    const media = fixture.media("/media/master-selected.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: '#EXTM3U\n#EXTINF:4,\nmaster-first.ts\n#EXTINF:4,\nmaster-last.ts\n#EXT-X-ENDLIST\n' });
    const audio = fixture.media("/media/master-audio.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: '#EXTM3U\n#EXTINF:4,\nmaster-audio.ts\n#EXT-X-ENDLIST\n' });
    fixture.media("/media/master-first.ts", { body: video, contentType: "video/mp2t" });
    fixture.media("/media/master-last.ts", { body: video, contentType: "video/mp2t" });
    fixture.media("/media/master-audio.ts", { body: video, contentType: "audio/mp2t" });
    fixture.media("/media/master-good.key", { body: Buffer.alloc(16, 3), contentType: "application/octet-stream" });
    const master = (extra: string, rendition = audio): string => `#EXTM3U\n${extra}`
      + `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Main",URI="${rendition}"\n`
      + `#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="sound"\n${media}\n`;
    const badSession = fixture.media("/media/master-session-bad.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: master('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="missing-session.key"\n') });
    const badAudio = fixture.media("/media/master-audio-bad.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: master('', fixture.url("/media/missing-audio.m3u8")) });
    const audioRedirect = fixture.media("/media/master-audio-redirect-target.m3u8", {
      redirectTo: fixture.url("/media/missing-audio-target.m3u8") });
    const badAudioRedirect = fixture.media("/media/master-audio-redirect-bad.m3u8", {
      contentType: "application/vnd.apple.mpegurl", body: master('', audioRedirect) });
    const badNone = fixture.media("/media/master-none-bad.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: '#EXTM3U\n#EXT-X-KEY:METHOD=NONE,URI="missing-none.key"\n'
        + '#EXTINF:4,\nmaster-first.ts\n#EXTINF:4,\nmaster-last.ts\n#EXT-X-ENDLIST\n' });
    const good = fixture.media("/media/master-good.m3u8", { contentType: "application/vnd.apple.mpegurl",
      body: master('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="master-good.key"\n') });
    const candidates: Array<[string, string]> = [[badSession, "Bad session"], [badAudio, "Bad audio"],
      [badAudioRedirect, "Bad audio redirect"], [badNone, "Bad NONE"], [good, "Good"]];
    fixture.streams = candidates.map(([url, title]) => raw(url, title, `${title}.m3u8`));
    const bridge = await startScenario(fixture, { directHttpProbe: {
      enabled: true, timeoutMs: 4_000, maxCandidates: 8, maxConcurrent: 2
    } });
    try {
      const streams = await publicStreams(bridge.origin);
      expect(streams.map(({ fixtureLabel }) => fixtureLabel)).toEqual(["Good"]);
      expect(fixture.count("/media/missing-session.key")).toBe(0);
      expect(fixture.count("/media/missing-audio.m3u8")).toBe(0);
      expect(fixture.count("/media/missing-audio-target.m3u8")).toBe(0);
      expect(fixture.count("/media/missing-none.key")).toBe(0);
      const masterReply = await fetch(streams[0]!.url);
      expect(masterReply.status).toBe(200);
      const rewritten = await masterReply.text();
      const audioPath = /#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/.exec(rewritten)?.[1];
      const mediaPath = [...rewritten.matchAll(/\/hls\/[A-Za-z0-9_-]{32}/g)].at(-1)?.[0];
      expect(audioPath).toBeTruthy();
      expect(mediaPath).toBeTruthy();
      const audioPlaylist = await fetch(new URL(audioPath!, bridge.origin));
      expect(audioPlaylist.status).toBe(200);
      const audioSegment = /\/hls\/[A-Za-z0-9_-]{32}/.exec(await audioPlaylist.text())?.[0];
      expect(Buffer.from(await (await fetch(`${bridge.origin}${audioSegment}`)).arrayBuffer())).toEqual(video);
      const mediaPlaylist = await fetch(`${bridge.origin}${mediaPath}`);
      expect(mediaPlaylist.status).toBe(200);
    } finally { await bridge.close(); await fixture.close(); }
  });


});
