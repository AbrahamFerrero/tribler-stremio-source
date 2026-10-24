import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { getRouter } from "stremio-addon-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import { createStreamResolver } from "../../src/streams/factory";
import { createAddon } from "../../src/addon";
import { createApp } from "../../src/app";
import type { DownloadService } from "../../src/download-service";
import type { OutboundTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { PlaybackManager } from "../../src/playback/manager";
import { DirectStreamProbe } from "../../src/streams/direct-stream-probe";
import { loadStreamRankingPolicy, parseStreamRankingPolicy, type StreamRankingPolicy } from "../../src/streams/ranking-policy";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver, type StreamResolverTrace } from "../../src/streams/resolver";
import { scoreStream, streamScoreComponents } from "../../src/streams/scoring";
import { rankedStreamDescription, streamSummary } from "../../src/streams/presentation";
import type { NormalizedStreamSource } from "../../src/streams/types";
import { fixtureOutboundRequest, silentLogger } from "../helpers";
import request from "../http-client";
import { fixturePrivacySafe } from "../identity-qa/harness";
import { mp4Fixture } from "../mp4-fixture";

const movie = { id: "tt9999999999", kind: "movie" as const, title: "Synthetic Meridian", year: 1994,
  runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const currentPolicy = loadStreamRankingPolicy();
type Source = NormalizedStreamSource;
type Stage = Parameters<StreamResolverTrace["stage"]>[0];
const direct = (id: string, extra: Partial<Source> = {}): Source => ({ providerId: "fixture", type: "https",
  url: `https://media.example/${id}/opaque.mp4`, quality: "1080p", sizeBytes: 2 * 1024 ** 3, ...extra });
const torrent = (hex: string, extra: Partial<Source> = {}): Source => ({ providerId: "fixture", type: "magnet",
  magnet: `magnet:?xt=urn:btih:${hex.repeat(40)}&tr=https://tracker.example/private-tracker`,
  quality: "1080p", seeds: 20, sizeBytes: 2 * 1024 ** 3, ...extra });
const locator = (source: Source) => source.url ?? source.magnet;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Historical final comparator only: reuse the real pipeline and its admitted
// objects, then apply the previous technical order and unchanged provider cap.
// This control does not replace admission, dedupe, probing or identity logic.
function technicalOrder(sources: readonly Source[], policy: StreamRankingPolicy): Source[] {
  return [...sources].sort((a, b) => scoreStream(b, policy) - scoreStream(a, policy)
    || (b.seeds ?? -1) - (a.seeds ?? -1)
    || (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
}
function legacySelection(sources: readonly Source[], policy: StreamRankingPolicy): Source[] {
  const counts = new Map<string, number>();
  return technicalOrder(sources, policy).filter(source => {
    const count = counts.get(source.providerId) ?? 0;
    counts.set(source.providerId, count + 1);
    return count < 50;
  });
}

async function publicRun(input: Source[], legacy = false, policy = currentPolicy, configured = false, details = false) {
  const stages = new Map<Stage, readonly Source[]>();
  const rejections: unknown[] = [];
  const network = vi.fn(fixtureOutboundRequest(({ url, headers }) => {
    if (url.includes("/timeout/")) return Promise.reject(new DOMException("Synthetic timeout", "TimeoutError"));
    if (url.includes("/degraded/")) return Promise.resolve(new Response(null, { status: 503 }));
    if (url.includes("/reachable/")) return Promise.resolve(new Response(new Uint8Array([1]),
      { headers: { "Content-Type": "video/mp4" } }));
    if (url.endsWith(".ts")) return Promise.resolve(new Response(new Uint8Array([1]),
      { headers: { "Content-Type": "video/mp2t" } }));
    if (url.endsWith(".m3u8")) return Promise.resolve(new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:3210\n"
      + "#EXTINF:3210,\nfirst.ts\n#EXTINF:3210,\nsecond.ts\n#EXT-X-ENDLIST\n",
      { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
    const body = Uint8Array.from(mp4Fixture(6420));
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range")!)!;
    const start = Number(range[1]), end = Math.min(Number(range[2]), body.length - 1);
    return Promise.resolve(new Response(body.subarray(start, end + 1), { status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${body.length}` } }));
  }));
  const transport: OutboundTransport = { id: "fixture", request: network,
    diagnostics: () => ({ transport: "fixture", requests: network.mock.calls.length, failures: 0, averageLatencyMs: 0 }) };
  const registry = new StreamProviderRegistry(1000, silentLogger);
  const provider = vi.fn(() => Promise.resolve(input));
  for (const id of new Set(input.map(source => source.providerId))) {
    registry.register({ id, name: "Synthetic", isEnabled: () => true,
      resolve: () => provider().then(sources => sources.filter(source => source.providerId === id)) });
  }
  const probe = new DirectStreamProbe(transport,
    { enabled: true, timeoutMs: 1000, maxCandidates: 100, maxConcurrent: 1 }, silentLogger, () => 1_000_000);
  class PublicResolver extends StreamResolver {
    override async resolve(...args: Parameters<StreamResolver["resolve"]>) {
      const final = await super.resolve(...args);
      return legacy ? legacySelection(stages.get("admitted")!, policy) : final;
    }
  }
  const urlPolicy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
  const trace: StreamResolverTrace = {
    stage: (stage, sources) => { stages.set(stage, sources); }, rejection: event => { rejections.push(event); }
  };
  let resolver: StreamResolver;
  if (configured) {
    const directory = mkdtempSync(join(tmpdir(), "stream-cap-"));
    try {
      const file = join(directory, "streams.json");
      writeFileSync(file, JSON.stringify({ [movie.id]: input }));
      vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
      vi.stubEnv("STREAM_PROVIDERS", "local_json");
      vi.stubEnv("STREAM_PROVIDER_LOCAL_JSON_FILE", file);
      vi.stubEnv("STREAM_PROVIDER_LOCAL_JSON_DIRECTORY", directory);
      vi.stubEnv("DIRECT_HTTP_PROBE_ENABLED", "true");
      vi.stubEnv("DIRECT_HTTP_PROBE_MAX_CANDIDATES", "100");
      vi.stubEnv("DIRECT_HTTP_PROBE_MAX_CONCURRENT", "1");
      resolver = createStreamResolver([], loadConfig(), silentLogger, urlPolicy, transport, undefined, trace);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } else resolver = new PublicResolver(registry, urlPolicy, probe, trace, policy);
  const playback = new PlaybackManager([]);
  const register = vi.spyOn(playback, "register"); // Preserve real opaque token generation/storage.
  const addon = createAddon({} as DownloadService, silentLogger, [], "http://127.0.0.1:7000", undefined,
    resolver, playback, { lookup: () => Promise.resolve(movie) }, { rankingDetails: details, rankingPolicy: policy });
  const server = express().use(getRouter(addon)).listen(0, "127.0.0.1");
  await once(server, "listening");
  let response;
  try {
    response = await request(server).get(`/stream/movie/${movie.id}.json`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(response.status).toBe(200);
  const body = response.body as { streams: { url: string; name: string; title?: string;
    behaviorHints: { notWebReady: boolean } }[]; cacheMaxAge: number };
  const sources = register.mock.calls.map(([source]) => source);
  expect(body.cacheMaxAge).toBe(0);
  expect(body.streams).toHaveLength(sources.length);
  body.streams.forEach((stream, index) => {
    const token = register.mock.results[index]!.value as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(stream.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:7000/source/${token}/stream(?:\\.(?:mp4|m3u8))?$`));
    expect(stream.behaviorHints).toEqual({ notWebReady: false });
    expect(Object.keys(stream).sort()).toEqual((stream.title === undefined
      ? ["url", "name", "behaviorHints"] : ["url", "name", "title", "behaviorHints"]).sort());
  });
  return { body, sources, stages, rejections, network: network.mock.calls.map(([outbound]) => outbound),
    probeResults: await Promise.all(network.mock.results.map(result => (result.value as ReturnType<OutboundTransport["request"]>).then(
      ({ response: res }: { response: Response }) => ({ status: res.status, headers: [...res.headers] }),
      (error: Error) => ({ error: error.name })))), providerCalls: provider.mock.calls.length };
}

describe("US-1402 public identity order (integration)", () => {
  it("P0 independently pins mixed-transport order, technical totals and rounded public F", async () => {
    // Existing synthetic transport runs real MP4/HLS probes; frozen time makes latency 0ms.
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const input = [
      direct("degraded"), torrent("b", { seeds: 31 }),
      direct("hls", { url: "https://media.example/opaque.m3u8" }), direct("verified"),
      torrent("c", { seeds: 100000, quality: "2160p", codec: "HEVC", audio: "en", language: "en" }),
      direct("anchor", { url: "https://media.example/Synthetic.Meridian.1994.mp4", quality: "480p" }),
      direct("concern", { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }),
      torrent("d", { seeds: 2, sizeBytes: 12.5 * 1024 ** 3 })
    ];
    input.push({ ...input[3]!, quality: "480p" });
    // Explicit selection, no production comparator/formatter generates this oracle.
    const order = [5, 4, 3, 2, 1, 7, 0, 6];
    const totals = [187, 228, 217, 202, 154, 63.19925001442312, 9, 230];
    const titles = [
      "#1 · Score 187\nAvail +120 · Res +12 · Size +12 · Codec +0 · Meta +0 · Net +43",
      "English audio\n#2 · Score 228 · Avail +150 · Res +65 · Size +2 · Codec +8 · Meta +3 · Net +0",
      "#3 · Score 217\nAvail +120 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +43",
      "#4 · Score 202\nAvail +120 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +28",
      "#5 · Score 154\nAvail +100 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +0",
      "#6 · Score 63.2\nAvail +31.7 · Res +42 · Size -10.5 · Codec +0 · Meta +0 · Net +0",
      "#7 · Score 9\nAvail -45 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +0",
      "#8 · Score 230\nAvail +120 · Res +65 · Size +2 · Codec +0 · Meta +0 · Net +43"
    ];
    const result = await publicRun(input, false, loadStreamRankingPolicy(), false, true);
    expect(result.sources.map(locator)).toEqual(order.map(i => locator(input[i]!)));
    expect(result.sources.map(getBridgeIdentityState)).toEqual([
      "CORROBORATED", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "SUSPICIOUS"
    ]);
    result.sources.forEach((source, i) => expect(scoreStream(source, currentPolicy)).toBeCloseTo(totals[i]!, 10));
    expect(result.body.streams.map(s => s.title)).toEqual(titles);
    expect(result.sources[2]!.directHttp).toMatchObject({ status: "verified", rangeSupported: true, responseHeaderLatencyMs: 0 });
    expect(result.sources[3]!.directHttp).toMatchObject({ status: "verified", hls: true, rangeSupported: false });
    expect(result.sources[6]!.directHttp).toMatchObject({ status: "unreachable", responseStatus: 503 });
    expect(result.stages.get("deduplicated")).toHaveLength(8);
    expect(result.stages.get("admitted")).toHaveLength(8);
    expect(fixturePrivacySafe(result.body, ["media.example", "tracker.example", "magnet:", "metadata", "Synthetic Meridian", "Synthetic Aurora"]))
      .toBe(true);
  });

  it("opt-in F numbers the final deduplicated, quota-limited identity order without altering the pipeline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const policy = structuredClone(currentPolicy);
    policy.direct.health.verified = 90;
    policy.quality["1080p"] = 45;
    const input = [
      direct("concern", { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }),
      direct("pending", { metadata: { identity: { title: "Synthetic Aurora" } } }),
      ...Array.from({ length: 49 }, (_, i) => direct(`unknown-${i}`, {
        quality: "720p", sizeBytes: (2 + i / 100) * 1024 ** 3,
        title: "synthetic-private-resource", filename: "synthetic-private-filename.mp4",
        metadata: { identityState: "CORROBORATED", token: "synthetic-private-token" },
        requestHeaders: { Referer: "https://origin.example/synthetic-private-secret" }
      })),
      direct("anchor", { url: "https://media.example/Synthetic.Meridian.1994.mp4", quality: "480p" })
    ];
    input.push({ ...input[2]!, quality: "480p" });
    const before = structuredClone(input);
    const baseline = await publicRun(input, false, policy);
    const detailed = await publicRun(input, false, policy, false, true);
    expect(input).toEqual(before);
    expect(detailed.sources).toEqual(baseline.sources);
    expect(detailed.sources).toHaveLength(50);
    expect(detailed.stages.get("admitted")).toHaveLength(52);
    for (const stage of ["normalized", "deduplicated", "probed", "admitted", "final"] as const) {
      expect(detailed.stages.get(stage)).toEqual(baseline.stages.get(stage));
    }
    expect(detailed.network).toEqual(baseline.network);
    expect(detailed.rejections).toEqual(baseline.rejections);
    expect(detailed.probeResults).toEqual(baseline.probeResults);
    expect(getBridgeIdentityState(detailed.sources[0]!)).toBe("CORROBORATED");
    expect(getBridgeIdentityState(detailed.sources[1]!)).toBeUndefined();
    expect(detailed.sources.slice(2).map(getBridgeIdentityState)).toEqual(Array(48).fill("UNKNOWN"));
    detailed.body.streams.forEach((stream, i) => {
      expect(stream.name).toBe(baseline.body.streams[i]!.name);
      expect(stream.title).toBe(rankedStreamDescription(detailed.sources[i]!, i + 1, policy));
      expect(stream.title).toMatch(new RegExp(`^#${i + 1} · Score `));
      expect(stream.behaviorHints).toEqual(baseline.body.streams[i]!.behaviorHints);
    });
    // No quota hides the suspicious entry: its own final position remains correct.
    const all = await publicRun(input.slice(0, 2).concat(input.at(-2)!), false, policy, false, true);
    expect(all.sources.map(getBridgeIdentityState)).toEqual(["CORROBORATED", undefined, "SUSPICIOUS"]);
    expect(all.body.streams[2]!.title).toMatch(/^#3 · Score /);
    expect(all.body.streams[2]!.name).toContain("ID!");
    expect(fixturePrivacySafe(detailed.body, ["synthetic-private-resource", "synthetic-private-filename",
      "synthetic-private-token", "synthetic-private-secret", "media.example", "origin.example", "CORROBORATED"]))
      .toBe(true);
  });

  it("shares startup JSON weights between factory resolution and createApp presentation, independently of the flag", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ranking-details-"));
    try {
      const policy = structuredClone(currentPolicy);
      policy.quality["1080p"] = 45;
      policy.torrent.seedScorePerDoubling = 18;
      policy.torrent.maxSeedScore = 140;
      const policyFile = join(directory, "policy.json"), sourcesFile = join(directory, "sources.json");
      writeFileSync(policyFile, JSON.stringify(policy));
      const input = [torrent("a", { seeds: 31, codec: "HEVC", language: "en", audio: "ja", title: "English subtitles" }),
        torrent("b", { seeds: 2, codec: "HEVC", language: "en", audio: "ja" })];
      writeFileSync(sourcesFile, JSON.stringify({ [movie.id]: input }));
      vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
      vi.stubEnv("STREAM_PROVIDERS", "local_json");
      vi.stubEnv("STREAM_PROVIDER_LOCAL_JSON_FILE", sourcesFile);
      vi.stubEnv("STREAM_PROVIDER_LOCAL_JSON_DIRECTORY", directory);
      vi.stubEnv("STREAM_RANKING_CONFIG_FILE", policyFile);
      vi.stubEnv("STREMIO_MOVIE_METADATA_BASE_URL", "");
      const responses: Array<Array<{ name: string; title?: string; description?: string }>> = [];
      for (const enabled of [false, true]) {
        vi.stubEnv("STREAM_RANKING_DETAILS", String(enabled));
        const config = loadConfig();
        expect(config.streamRankingPolicy).toEqual(policy);
        const { app } = createApp(config, silentLogger, undefined, []);
        const response = await request(app).get(`/stream/movie/${movie.id}.json`);
        expect(response.status).toBe(200);
        const streams = (response.body as { streams: typeof responses[number] }).streams;
        expect(streams).toHaveLength(2);
        responses.push(streams);
      }
      expect(responses[0]![0]!.title).toBe("Japanese audio · English subtitles");
      expect(responses[1]![0]!.title).toBe("Japanese audio · English subtitles\n#1 · Score 158 · Avail +90 · Res +45 · Size +12 · Codec +8 · Meta +3 · Net +0");
      expect(responses[1]![1]!.title).toBe("Japanese audio\n#2 · Score 96.53 · Avail +28.53 · Res +45 · Size +12 · Codec +8 · Meta +3 · Net +0");
      expect(responses[1]!.map(s => s.name)).toEqual(responses[0]!.map(s => s.name));
      expect(responses[1]![0]!.name).toBe(streamSummary({ ...input[0]! }).replace("Tribler ·", "Tribler · ID? ·"));
      expect(responses.flat().every(s => s.description === undefined)).toBe(true);
      const components = streamScoreComponents(input[0]!, loadStreamRankingPolicy(policyFile));
      expect((Object.values(components) as number[]).reduce((a, b) => a + b, 0)).toBe(scoreStream(input[0]!, policy));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("configurable quota: 52 admitted sources retain the top 50 or all 52 through config, factory and loopback HTTP", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const input = [
      direct("concern", { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }),
      direct("unknown", { quality: "720p" }),
      direct("pending", { quality: "1080p", metadata: { identity: { title: "Synthetic Aurora" } } }),
      ...Array.from({ length: 48 }, (_, i) => direct(`candidate-${i}`, {
        quality: i % 2 ? "480p" : "720p", sizeBytes: 2 * 1024 ** 3 + i + 1
      })),
      direct("anchor", { url: "https://media.example/Synthetic.Meridian.1994.mp4", quality: "480p" })
    ];
    vi.stubEnv("STREAM_MAX_RESULTS_PER_PROVIDER", undefined);
    const capped = await publicRun(input, false, currentPolicy, true);
    const reversed = await publicRun([...input].reverse(), false, currentPolicy, true);
    expect(reversed.sources.map(locator)).toEqual(capped.sources.map(locator));
    expect(reversed.stages.get("admitted")).toHaveLength(52);
    vi.stubEnv("STREAM_MAX_RESULTS_PER_PROVIDER", "60");
    const uncapped = await publicRun(input, false, currentPolicy, true);
    const admitted = uncapped.stages.get("admitted")!;
    expect(admitted).toHaveLength(52);
    expect(admitted.slice(0, 3).map(getBridgeIdentityState)).toEqual(["SUSPICIOUS", "UNKNOWN", undefined]);
    expect(getBridgeIdentityState(admitted[51]!)).toBe("CORROBORATED");
    expect(scoreStream(admitted[0]!)).toBeGreaterThan(scoreStream(admitted[2]!));
    expect(scoreStream(admitted[2]!)).toBeGreaterThan(scoreStream(admitted[1]!));
    expect(scoreStream(admitted[1]!)).toBeGreaterThan(scoreStream(admitted[51]!));
    const expected = [admitted[51]!, ...technicalOrder(admitted.slice(1, 51), currentPolicy), admitted[0]!];
    expect(uncapped.sources).toEqual(expected);
    expect(capped.sources).toEqual(expected.slice(0, 50));
    expect(capped.sources.map(locator)).not.toContain(locator(expected[50]!));
    expect(capped.sources.map(locator)).not.toContain(locator(expected[51]!));
    expect(capped.sources[0]).toEqual(admitted[51]);
    expect(capped.sources.indexOf(capped.sources.find(s => locator(s) === locator(input[2]!))!))
      .toBeLessThan(capped.sources.indexOf(capped.sources.find(s => locator(s) === locator(input[1]!))!));
    for (const stage of ["provider", "normalized", "deduplicated", "probed", "admitted"] as const) {
      expect(capped.stages.get(stage)).toHaveLength(52);
      expect(capped.stages.get(stage)).toEqual(uncapped.stages.get(stage));
    }
    expect(capped.rejections).toEqual([]);
    expect(uncapped.rejections).toEqual([]);
    expect(capped.network).toEqual(uncapped.network);
    expect(capped.network).toHaveLength(52);
    expect(capped.probeResults).toEqual(uncapped.probeResults);
    for (const result of [capped, uncapped]) {
      expect(result.body.streams).toHaveLength(result.sources.length);
      result.sources.forEach((source, i) => {
        // A copy carries all technical facts, but not the bridge-owned WeakMap state.
        expect(getBridgeIdentityState({ ...source })).toBeUndefined();
        expect(scoreStream({ ...source })).toBe(scoreStream(source));
        const state = getBridgeIdentityState(source);
        expect(/ID[?!\u2713]/.exec(result.body.streams[i]!.name)?.[0])
          .toBe(state === "CORROBORATED" ? "ID\u2713" : state === "UNKNOWN" ? "ID?" : state === "SUSPICIOUS" ? "ID!" : undefined);
      });
      expect(fixturePrivacySafe(result.body, [...input.map(s => s.url!), "media.example", "metadata", "identityState"]))
        .toBe(true);
    }
    expect(capped.body.streams.map(s => ({ ...s, url: "opaque" })))
      .toEqual(uncapped.body.streams.slice(0, 50).map(s => ({ ...s, url: "opaque" })));
  });

  it("keeps 26 distinct sources from each of two providers in one public ranking", async () => {
    const input = Array.from({ length: 52 }, (_, i) => direct(`multi-${i}`, {
      providerId: i < 26 ? "one" : "two", quality: i % 2 ? "1080p" : "720p"
    }));
    const result = await publicRun(input);
    expect(result.stages.get("admitted")).toHaveLength(52);
    expect(result.sources).toHaveLength(52);
    for (const id of ["one", "two"]) expect(result.sources.filter(s => s.providerId === id)).toHaveLength(26);
    expect(result.sources).toEqual(technicalOrder(result.stages.get("admitted")!, currentPolicy));
    expect(result.sources.slice(0, 26).map(s => s.providerId)).toContain("one");
    expect(result.sources.slice(0, 26).map(s => s.providerId)).toContain("two");
    expect(result.rejections).toEqual([]);
    expect(result.network).toHaveLength(52);
    expect(result.body.streams).toHaveLength(52);
  });

  it("AC-R14-05/06: only order changes through the real public JSON, preserving every admitted attribute", async () => {
    const input = [
      direct("concern", { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }),
      direct("unknown", { quality: "720p", audio: "en", requestHeaders: { Referer: "https://origin.example/synthetic-secret" } }),
      direct("pending", { metadata: { identity: { title: "Synthetic Aurora" } } }),
      direct("anchor", { url: "https://media.example/Synthetic.Meridian.1994.mp4", quality: "480p" }),
      direct("anchor-high", { url: "https://media.example/high/Synthetic.Meridian.1994.mp4", quality: "720p" }),
      direct("signed", { url: "https://media.example/opaque.mp4?token=synthetic-signature",
        title: "synthetic-private-resource", metadata: { trace: "synthetic-stack-trace" } }),
      torrent("a", { seeds: 1 }),
      direct("wrong", { metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } }),
      direct("blocked", { url: "http://127.0.0.1:9999/private-credential" })
    ];
    input.push({ ...input[1]!, quality: "480p" }); // Lower scoring duplicate must stay absent.
    const before = structuredClone(input);
    const old = await publicRun(input, true);
    const now = await publicRun(input);
    expect(input).toEqual(before);
    for (const stage of ["provider", "normalized", "deduplicated", "probed", "admitted"] as const) {
      expect(now.stages.get(stage)).toEqual(old.stages.get(stage));
    }
    expect(now.stages.get("normalized")).toHaveLength(8);
    expect(now.stages.get("deduplicated")).toHaveLength(7);
    expect(now.sources).toHaveLength(7);
    expect(now.rejections).toEqual(old.rejections);
    expect(now.rejections).toHaveLength(1);
    expect(now.rejections[0]).toMatchObject({ identityState: "CONTRADICTION", reason: "EXTERNAL_ID_CONFLICT" });
    expect(now.sources.map(locator)).not.toContain(input[7]!.url);
    expect(now.sources.map(locator)).not.toContain(input[8]!.url);
    expect(now.network).toEqual(old.network);
    expect(now.network).toHaveLength(6);
    expect(now.probeResults).toEqual(old.probeResults);
    expect(now.providerCalls).toBe(1); expect(old.providerCalls).toBe(1);
    expect(now.sources.map(getBridgeIdentityState)).toEqual([
      "CORROBORATED", "CORROBORATED", undefined, "UNKNOWN", "UNKNOWN", "UNKNOWN", "SUSPICIOUS"
    ]);
    expect(now.sources).not.toEqual(old.sources);
    expect(new Set(now.sources.map(locator))).toEqual(new Set(old.sources.map(locator)));
    for (const state of ["CORROBORATED", "UNKNOWN", "SUSPICIOUS", undefined] as const) {
      expect(now.sources.filter(s => getBridgeIdentityState(s) === state))
        .toEqual(old.sources.filter(s => getBridgeIdentityState(s) === state));
    }
    now.sources.forEach((source, index) => {
      expect(source).toBe(now.stages.get("admitted")!.find(s => locator(s) === locator(source)));
      const oldIndex = old.sources.findIndex(s => locator(s) === locator(source));
      const previous = old.body.streams[oldIndex]!;
      const current = now.body.streams[index]!;
      expect({ ...current, url: "opaque" }).toEqual({ ...previous, url: "opaque" });
      expect(source).toEqual(old.sources[oldIndex]);
      const state = getBridgeIdentityState(source);
      const marker = state === "CORROBORATED" ? "ID\u2713" : state === "UNKNOWN" ? "ID?" : "ID!";
      if (state) expect(current.name).toContain(marker);
      else expect(current.name).not.toMatch(/ID[?!\u2713]/);
    });
    expect(now.body.streams.find(s => s.title)?.title).toBe("English audio");
    expect(fixturePrivacySafe(now.body, input.flatMap(s => [s.url ?? "", s.magnet ?? "",
      "synthetic-secret", "synthetic-signature", "synthetic-private-resource", "synthetic-stack-trace",
      "private-credential", "media.example", "tracker.example", "origin.example", "Referer", "Synthetic.Meridian.1994.mp4"]))).toBe(true);
  });

  it("AC-R14-05: public provider quota permits a different selection after identity ordering", async () => {
    const input = Array.from({ length: 50 }, (_, i) => direct(`unknown-${i}`, { quality: "2160p" }));
    input.push(direct("anchor", { url: "https://media.example/Synthetic.Meridian.1994.mp4", quality: "480p" }));
    const old = await publicRun(input, true), now = await publicRun(input);
    expect(now.stages.get("admitted")).toEqual(old.stages.get("admitted"));
    expect(now.network).toEqual(old.network);
    expect(now.probeResults).toEqual(old.probeResults);
    expect(now.sources).toHaveLength(50); expect(old.sources).toHaveLength(50);
    expect(getBridgeIdentityState(now.sources[0]!)).toBe("CORROBORATED");
    expect(old.sources.map(locator)).not.toContain(input[50]!.url);
    expect(now.sources.map(locator)).not.toContain(input[49]!.url);
    expect(now.sources.slice(1)).toEqual(old.sources.slice(0, 49));
    // Equal selection is deliberately not required above the unchanged cap of 50.
  });

  it.each([
    { name: "verified HTTPS versus comparable Tribler", input: [torrent("b"), direct("verified")], order: [1, 0], health: "verified" },
    { name: "practical Tribler versus degraded HTTPS", input: [direct("degraded"), torrent("b")], order: [1, 0], health: "unreachable" },
    { name: "practical Tribler versus timeout HTTPS", input: [direct("timeout"), torrent("b")], order: [1, 0], health: "timeout" },
    { name: "reachable HTTP between strong and weak torrents", input: [torrent("b", { seeds: 1 }),
      direct("reachable", { type: "http", url: "http://media.example/reachable/opaque.mp4" }),
      torrent("c", { seeds: 200 })], order: [2, 1, 0], health: "reachable" },
    { name: "verified HLS versus exceptional torrent", input: [direct("hls", { url: "https://media.example/opaque.m3u8" }),
      torrent("c", { seeds: 100000, quality: "2160p", codec: "HEVC", audio: "en", language: "en" })],
      order: [1, 0], health: "verified" }
  ])("AC-R14-08: $name reaches public JSON in actual technical order", async ({ input, order, health }) => {
    const result = await publicRun(input);
    expect(result.sources.map(locator)).toEqual(order.map(i => locator(input[i]!)));
    expect(result.sources.map(getBridgeIdentityState)).toEqual(input.map(() => "UNKNOWN"));
    expect(result.sources.find(s => s.url)?.directHttp?.status).toBe(health);
    expect(result.sources).toEqual(technicalOrder(result.stages.get("admitted")!, currentPolicy));
    expect(result.body.streams.every(s => s.name.includes("ID?"))).toBe(true);
    if (input[0]!.url?.endsWith(".m3u8")) {
      expect(result.sources[1]!.directHttp).toMatchObject({ hls: true, verified: true });
      // Torrent: seeds 150 + 2160p 65 + size 2 + HEVC 8 + metadata 3 = 228.
      // HLS: verified 120 + 1080p 42 + size 12 + HTTPS/latency 28 = 202.
      expect(result.sources.map(s => scoreStream(s, currentPolicy))).toEqual([228, 202]);
    }
  });

  it("AC-R14-08: an admitted alternative JSON policy applies within, but never across, identity groups", async () => {
    const alternative = structuredClone(currentPolicy);
    alternative.direct.health.verified = 90;
    alternative.torrent.seedScorePerDoubling = 100;
    const configured = parseStreamRankingPolicy(JSON.parse(JSON.stringify(alternative)));
    const input = [torrent("b"), direct("verified"),
      direct("anchor", { url: "https://media.example/Synthetic.Meridian.1994.mp4", quality: "480p" }),
      direct("concern", { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } })];
    for (const policy of [currentPolicy, configured]) {
      const result = await publicRun(input, false, policy);
      expect(result.sources.map(locator)).toEqual((policy === currentPolicy ? [2, 1, 0, 3] : [2, 0, 1, 3]).map(i => locator(input[i]!)));
      expect(result.sources.map(getBridgeIdentityState)).toEqual(["CORROBORATED", "UNKNOWN", "UNKNOWN", "SUSPICIOUS"]);
      expect(result.body.streams.map(s => /ID[?!\u2713]/.exec(s.name)?.[0])).toEqual(["ID\u2713", "ID?", "ID?", "ID!"]);
    }
  });
});
