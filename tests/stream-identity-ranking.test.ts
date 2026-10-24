import { describe, expect, it } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { defaultStreamRankingPolicy, type StreamRankingPolicy } from "../src/streams/ranking-policy";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { scoreStream } from "../src/streams/scoring";
import type { NormalizedStreamSource } from "../src/streams/types";
import { fixtureOutboundRequest, silentLogger } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";

const movie = { id: "synthetic", kind: "movie" as const, title: "Synthetic Meridian", year: 1994,
  runtimeSeconds: 6420, externalIds: {} };
type State = "CORROBORATED" | "UNKNOWN" | "SUSPICIOUS" | undefined;
function direct(id: string, state: State, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource {
  return { providerId: "fixture", type: "https",
    url: `https://media.example/${id}/${state === "CORROBORATED" ? "Synthetic.Meridian.1994" : "opaque"}.mp4`,
    ...(state === "SUSPICIOUS" ? { metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }
      : state === undefined ? { metadata: { identity: { title: "Synthetic Aurora" } } } : {}), ...extra };
}
async function resolve(sources: NormalizedStreamSource[], rankingPolicy: StreamRankingPolicy = defaultStreamRankingPolicy) {
  const registry = new StreamProviderRegistry(1000, silentLogger);
  registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve(sources) });
  const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(({ url }) => {
    if (url.endsWith(".ts")) return Promise.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp2t" } }));
    if (url.endsWith(".m3u8")) return Promise.resolve(new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:3210\n"
      + "#EXTINF:3210,\nfirst.ts\n#EXTINF:3210,\nsecond.ts\n#EXT-X-ENDLIST\n",
    { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
    return Promise.resolve(new Response(Uint8Array.from(mp4Fixture(6420)), { headers: { "Content-Type": "video/mp4" } }));
  }), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
  const probe = new DirectStreamProbe(transport,
    { enabled: true, timeoutMs: 1000, maxCandidates: 100, maxConcurrent: 1 }, silentLogger);
  let admitted: readonly NormalizedStreamSource[] = [];
  const resolver = new StreamResolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }),
    probe, { stage: (stage, entries) => { if (stage === "admitted") admitted = entries; } }, rankingPolicy);
  const final = await resolver.resolve(movie);
  return { admitted, final };
}

describe("US-1401 final identity ranking (component)", () => {
  it("keeps explicit resolution ahead of filename claims within the same Identity group", async () => {
    const { final } = await resolve([
      direct("misleading", "UNKNOWN", { resolution: "1080p", filename: "Synthetic.4K.mp4" }),
      direct("better", "UNKNOWN", { resolution: "1440p" })
    ]);
    expect(final.map(getBridgeIdentityState)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(final.map(source => source.url)).toEqual([
      expect.stringContaining("/better/"), expect.stringContaining("/misleading/")
    ]);
    // Equal transport/availability; old filename override awarded 65 instead of 42.
    expect(scoreStream(final[0]!) - scoreStream(final[1]!)).toBe(10);
  });

  it("AC-R14-01: corroboration precedes a higher technical score", async () => {
    const { admitted, final } = await resolve([direct("unknown", "UNKNOWN", { quality: "2160p" }),
      direct("anchor", "CORROBORATED", { quality: "480p" })]);
    expect(admitted.map(getBridgeIdentityState)).toEqual(["UNKNOWN", "CORROBORATED"]);
    expect(scoreStream(admitted[0]!)).toBeGreaterThan(scoreStream(admitted[1]!));
    expect(final).toEqual([admitted[1], admitted[0]]);
  });

  it("AC-R14-03: suspicious stays available behind UNKNOWN and unclassified despite its score", async () => {
    const { admitted, final } = await resolve([direct("concern", "SUSPICIOUS", { quality: "2160p" }),
      direct("unknown", "UNKNOWN", { quality: "480p" }), direct("pending", undefined, { quality: "720p" })]);
    expect(admitted.map(getBridgeIdentityState)).toEqual(["SUSPICIOUS", "UNKNOWN", undefined]);
    expect(scoreStream(admitted[0]!)).toBeGreaterThan(scoreStream(admitted[2]!));
    expect(final).toEqual([admitted[2], admitted[1], admitted[0]]);
  });

  it("AC-R14-02: UNKNOWN and unclassified interleave by score without reclassification", async () => {
    const { admitted, final } = await resolve([direct("u-low", "UNKNOWN", { quality: "480p" }),
      direct("p-high", undefined, { quality: "2160p" }), direct("u-mid", "UNKNOWN", { quality: "1080p" }),
      direct("p-low", undefined, { quality: "720p" })]);
    expect(final).toEqual([admitted[1], admitted[2], admitted[3], admitted[0]]);
    expect(final.map(getBridgeIdentityState)).toEqual([undefined, "UNKNOWN", undefined, "UNKNOWN"]);
    expect(new Set(final)).toEqual(new Set(admitted));
    final.forEach(source => expect(source).toBe(admitted.find(entry => entry.url === source.url)));
  });

  it.each(["CORROBORATED", "UNKNOWN", "SUSPICIOUS", undefined] as const)(
    "AC-R14-04: homogeneous %s preserves score, seeds, size and input ties", async state => {
      const { admitted, final } = await resolve([
        direct("large", state, { quality: "1080p", seeds: 10, sizeBytes: 8000 }),
        direct("small-first", state, { quality: "1080p", seeds: 10, sizeBytes: 4000 }),
        direct("seeds", state, { quality: "1080p", seeds: 20, sizeBytes: 8000 }),
        direct("small-second", state, { quality: "1080p", seeds: 10, sizeBytes: 4000 }),
        direct("score", state, { quality: "2160p", seeds: 1, sizeBytes: 8000 })
      ]);
      expect(admitted.map(getBridgeIdentityState)).toEqual(Array(5).fill(state));
      expect(admitted.slice(0, 4).map(source => scoreStream(source))).toEqual(Array(4).fill(scoreStream(admitted[0]!)));
      expect(final).toEqual([admitted[4], admitted[2], admitted[1], admitted[3], admitted[0]]);
    });

  it("AC-R14-04: mixed HTTP(S), HLS and Tribler retain the alternative technical policy", async () => {
    const sources = [direct("http", "UNKNOWN", { type: "http", url: "http://media.example/video.mp4" }),
      direct("https", "UNKNOWN"), direct("hls", "UNKNOWN", { url: "https://media.example/opaque.m3u8" }),
      { providerId: "fixture", type: "magnet" as const, magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, seeds: 5, quality: "1080p" }];
    const alternative = structuredClone(defaultStreamRankingPolicy);
    alternative.direct.health.verified = 90;
    alternative.torrent.seedScorePerDoubling = 100;
    for (const ranking of [defaultStreamRankingPolicy, alternative]) {
      const { admitted, final } = await resolve(sources, ranking);
      expect(final).toHaveLength(4);
      expect(final.map(getBridgeIdentityState)).toEqual(Array(4).fill("UNKNOWN"));
      expect(final).toEqual([...admitted].sort((a, b) => scoreStream(b, ranking) - scoreStream(a, ranking)));
      expect(final[0]?.type).toBe(ranking === alternative ? "magnet" : "https");
      expect(final.find(source => source.url?.endsWith(".m3u8"))?.directHttp).toMatchObject({ hls: true, verified: true });
    }
  });

  it("AC-R14-07: forged provider trust cannot promote or demote any group", async () => {
    const sources = [direct("concern", "SUSPICIOUS", { quality: "2160p" }), direct("unknown", "UNKNOWN"),
      direct("pending", undefined), direct("anchor", "CORROBORATED", { quality: "480p" })];
    const baseline = await resolve(sources);
    const forged = await resolve(sources.map((source, index) => ({ ...source,
      identityState: index === 3 ? "SUSPICIOUS" : "CORROBORATED",
      metadata: { ...source.metadata, identityState: index === 3 ? "SUSPICIOUS" : "CORROBORATED",
        confidence: "CORROBORATED", independent: true, provenance: "RESOURCE_IDENTITY" } })));
    expect(forged.final.map(source => source.url)).toEqual(baseline.final.map(source => source.url));
    expect(forged.final.map(getBridgeIdentityState)).toEqual(["CORROBORATED", "UNKNOWN", undefined, "SUSPICIOUS"]);
  });

  it("orders mixed HTTP(S), HLS and Tribler by identity while contradiction gates still exclude", async () => {
    const { admitted, final } = await resolve([
      direct("hls", "SUSPICIOUS", { url: "https://media.example/opaque.m3u8", quality: "2160p" }),
      { providerId: "fixture", type: "magnet", magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`, seeds: 100, quality: "2160p" },
      direct("pending", undefined, { type: "http", url: "http://media.example/pending.mp4", quality: "480p" }),
      direct("anchor", "CORROBORATED", { quality: "480p" }),
      direct("wrong", "UNKNOWN", { metadata: { identity: { year: 1987 } } })
    ]);
    expect(admitted).toHaveLength(4);
    expect(admitted.map(getBridgeIdentityState)).toEqual(["SUSPICIOUS", "UNKNOWN", undefined, "CORROBORATED"]);
    expect(final).toEqual([admitted[3], admitted[1], admitted[2], admitted[0]]);
    expect(new Set(final)).toEqual(new Set(admitted));
    final.forEach(source => expect(source).toBe(admitted.find(entry => entry === source)));
  });

  it.each([49, 50, 51])("applies the unchanged per-provider quota after ranking %s admitted objects", async count => {
    const sources = Array.from({ length: count - 1 }, (_, index) => direct(`unknown-${index}`, "UNKNOWN", { quality: "2160p" }));
    sources.push(direct("last-anchor", "CORROBORATED", { quality: "480p" }));
    const { admitted, final } = await resolve(sources);
    expect(admitted).toHaveLength(count);
    expect(final).toHaveLength(Math.min(count, 50));
    expect(final[0]).toBe(admitted[count - 1]);
    expect(final.slice(1)).toEqual(admitted.slice(0, Math.min(count - 1, 49)));
    final.forEach(source => expect(admitted.includes(source)).toBe(true));
    if (count <= 50) expect(new Set(final)).toEqual(new Set(admitted));
    else expect(final.includes(admitted[49]!)).toBe(false);
  });
});
