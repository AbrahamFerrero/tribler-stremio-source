import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { IdentityPrecisionEvaluation, assessIdentity } from "../src/streams/identity-precision-evaluation";
import { identityMismatch, measuredRuntimeMismatch, runtimeContradicts } from "../src/streams/identity-qualification";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { fixtureOutboundRequest, silentLogger, type FixtureOutboundRequest } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1987, runtimeSeconds: 107 * 60, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:3", kind: "episode", title: "",
  seriesTitle: "Synthetic Harbour", season: 2, episode: 3, externalIds: { imdb: "tt9999999998" } };
const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
function source(key: string, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource {
  return { providerId: "synthetic", type: "https", url: `https://media.example/${key}.mp4`, ...extra };
}
function resolverFor(sources: NormalizedStreamSource[], item: NormalizedMediaItem = movie, probe?: DirectStreamProbe) {
  const registry = new StreamProviderRegistry(500, silentLogger);
  registry.register({ id: "synthetic", name: "Synthetic fixture", isEnabled: () => true,
    resolve: () => Promise.resolve(sources) });
  const audit = new IdentityPrecisionEvaluation(["synthetic"]);
  return { resolver: new StreamResolver(registry, policy, probe, audit.itemTrace(item)), audit };
}

describe("synthetic shared identity contracts", () => {
  it.each([
    { label: "matching external ID", item: movie, identity: { externalIds: { imdb: "tt9999999999" } }, admitted: true },
    { label: "conflicting external ID", item: movie, identity: { externalIds: { imdb: "tt9999999997" } }, admitted: false },
    { label: "matching movie year", item: movie, identity: { year: 1987 }, admitted: true },
    { label: "conflicting movie year", item: movie, identity: { year: 2004 }, admitted: false },
    { label: "movie versus episode kind", item: movie, identity: { kind: "episode" }, admitted: false },
    { label: "matching episode coordinates", item: episode, identity: { kind: "episode", season: 2, episode: 3 }, admitted: true },
    { label: "wrong season", item: episode, identity: { kind: "episode", season: 3, episode: 3 }, admitted: false },
    { label: "wrong episode", item: episode, identity: { kind: "episode", season: 2, episode: 4 }, admitted: false }
  ])("qualifies $label through the shared resolver", async ({ item, identity, admitted }) => {
    const candidate = source("structured", { metadata: { identity } });
    const { resolver } = resolverFor([candidate], item);
    expect((await resolver.resolve(item)).map((entry) => entry.url)).toEqual(admitted ? [candidate.url] : []);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(admitted ? 0 : 1);
  });

  it.each(["S01E06", "S01.E06", "S01-E06", "S01 E06", "S01_E06"])(
    "preserves all four coordinate decisions for %s", (coordinates) => {
      const candidate = source("episode", { filename: `Synthetic.Harbour.${coordinates}.1080p.mkv` });
      const requested = { ...episode, season: 1, episode: 6 };
      expect(identityMismatch(movie, candidate)).toBe(true);
      expect(identityMismatch(requested, candidate)).toBe(false);
      expect(identityMismatch({ ...requested, season: 2 }, candidate)).toBe(true);
      expect(identityMismatch({ ...requested, episode: 7 }, candidate)).toBe(true);
    });

  it("does not interpret unbounded, malformed, prose-only or ambiguous coordinates as a contradiction", () => {
    for (const coordinates of ["XS01.E06", "S001.E06", "S01.E006", "S01.E06extra", "S01..E06", "S01.E00",
      "S01.E06.S01.E07"]) {
      expect(identityMismatch(movie, source("boundary", { filename: `Synthetic.Harbour.${coordinates}.mkv` }))).toBe(false);
    }
    expect(identityMismatch(movie, source("prose", { title: "A synthetic S01.E06 discussion" }))).toBe(false);
  });

  it.each(["Meridiano Sintetico", "Sintetika Meridiano", "Synthetic Northern Signal", "Server 1", "1080p HEVC", ""])(
    "keeps sparse, localized and ambiguous presentation fail-open: %s", async (title) => {
      const candidate = source("recall", { title, metadata: { identity: { title } } });
      const { resolver } = resolverFor([candidate]);
      expect(await resolver.resolve(movie)).toHaveLength(1);
      expect(resolver.diagnostics()[0]?.identityRejections).toBe(0);
    });

  it("admits unverified transport without making it an identity contradiction", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1 }, silentLogger);
    const { resolver, audit } = resolverFor([source("unverified", { title: "Server 1" })], movie, probe);
    const survivors = await resolver.resolve(movie);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.directHttp).toMatchObject({ verified: false, status: "unreachable" });
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(0);
    expect(audit.report().providers[0]?.stages.final.CONTRADICTION).toBe(0);
  });
});

describe("synthetic runtime contract", () => {
  function measuredProbe(format: "mp4" | "hls", duration: (url: string) => number | undefined, maxCandidates = 1) {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url, headers }) => {
      if (url.endsWith(".ts")) return Promise.resolve(new Response(new Uint8Array([1]),
        { headers: { "Content-Type": "video/mp2t" } }));
      const seconds = duration(url);
      if (format === "hls") return Promise.resolve(new Response(
        seconds === undefined ? "#EXTM3U\n#EXTINF:4,\nsegment.ts\n"
          : `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${seconds / 3},\nfirst.ts\n#EXTINF:${seconds / 3},\nmiddle.ts\n#EXTINF:${seconds / 3},\nlast.ts\n#EXT-X-ENDLIST\n`,
        { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
      const media = seconds === undefined ? Buffer.alloc(128) : mp4Fixture(seconds);
      const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range")!)!;
      const start = Number(match[1]), end = Math.min(Number(match[2]), media.length - 1);
      return Promise.resolve(new Response(Uint8Array.from(media.subarray(start, end + 1)), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${media.length}` } }));
    });
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    return { request, probe: new DirectStreamProbe(transport,
      { enabled: true, timeoutMs: 500, maxCandidates, maxConcurrent: 1 }, silentLogger) };
  }

  it.each([
    ["01:46:00", true], ["00:20:00", false], ["", true]
  ] as const)("qualifies standalone duration %s conservatively", async (duration, admitted) => {
    const candidate = source("duration", { title: `Synthetic Meridian (1987) 1080p${duration ? `\n${duration}` : ""}` });
    const { resolver } = resolverFor([candidate]);
    expect(await resolver.resolve(movie)).toHaveLength(admitted ? 1 : 0);
  });

  describe.each(["mp4", "hls"] as const)("independently measured %s runtime without filename identity", (format) => {
    it.each([
      { item: movie, expected: 107, measured: 106, admitted: true },
      { item: movie, expected: 107, measured: 20, admitted: false },
      { item: movie, expected: 107, measured: 135, admitted: true },
      { item: movie, expected: 71, measured: 90, admitted: true },
      { item: movie, expected: 71, measured: 22, admitted: false },
      { item: episode, expected: 10, measured: 9, admitted: true },
      { item: episode, expected: 10, measured: 12, admitted: true },
      { item: episode, expected: 10, measured: 14, admitted: false },
      { item: episode, expected: 45, measured: 44, admitted: true },
      { item: episode, expected: 45, measured: 50, admitted: true },
      { item: episode, expected: 45, measured: 32, admitted: false },
      { item: episode, expected: 45, measured: 22, admitted: false },
      { item: episode, expected: 22, measured: 21, admitted: true },
      { item: episode, expected: 22, measured: 25, admitted: true },
      { item: episode, expected: 22, measured: 12, admitted: false },
      { item: episode, expected: 22, measured: 50, admitted: false },
      { item: episode, expected: 22, measured: 30, admitted: false },
      { item: episode, expected: 45, measured: 43, admitted: true },
      { item: episode, expected: 60, measured: 48, admitted: true },
      { item: episode, expected: 60, measured: 72, admitted: true },
      { item: episode, expected: 60, measured: 30, admitted: false },
      { item: episode, expected: 60, measured: 90, admitted: false },
      { item: movie, expected: undefined, measured: 20, admitted: true },
      { item: episode, expected: undefined, measured: 50, admitted: true },
      { item: movie, expected: 107, measured: undefined, admitted: true },
      { item: episode, expected: 45, measured: undefined, admitted: true }
    ])("$item.kind expected $expected min / measured $measured min => admitted $admitted", async ({ item, expected, measured, admitted }) => {
      // Episode durations here are explicitly supplied trusted request metadata,
      // never inferred from Cinemeta's series-wide runtime.
      const requested = { ...item };
      if (expected === undefined) delete requested.runtimeSeconds;
      else requested.runtimeSeconds = expected * 60;
      const { probe } = measuredProbe(format, () => measured === undefined ? undefined : measured * 60);
      const candidate = source("opaque", { url: `https://media.example/random-id/master.${format === "hls" ? "m3u8" : "mp4"}`,
        title: "Server 1" });
      const { resolver, audit } = resolverFor([candidate], requested, probe);
      const survivors = await resolver.resolve(requested);
      expect(survivors).toHaveLength(admitted ? 1 : 0);
      expect(resolver.diagnostics()[0]?.identityRejections).toBe(admitted ? 0 : 1);
      expect(audit.report().providers[0]?.stages.probed).toMatchObject({ CONTRADICTION: admitted ? 0 : 1, UNKNOWN: admitted ? 1 : 0 });
      expect(audit.report().providers[0]?.stages.final.CONTRADICTION).toBe(0);
      if (admitted) {
        expect(survivors[0]?.directHttp?.verified).toBe(true);
        expect(survivors[0]?.directHttp?.actualRuntimeSeconds).toBe(measured === undefined ? undefined : measured * 60);
      }
    });
  });

  it("preserves each type's exact tolerance boundaries and fails open on invalid observations", () => {
    for (const [kind, expected, lower, upper] of [
      ["movie", 22 * 60, 12 * 60, 32 * 60], ["movie", 40 * 60, 28 * 60, 52 * 60],
      ["episode", 10 * 60, 7 * 60, 13 * 60], ["episode", 22 * 60, 1056, 1584],
      ["episode", 60 * 60, 48 * 60, 72 * 60]
    ] as const) {
      expect(runtimeContradicts(kind, expected, lower)).toBe(false);
      expect(runtimeContradicts(kind, expected, upper)).toBe(false);
      expect(runtimeContradicts(kind, expected, lower - 1)).toBe(true);
      expect(runtimeContradicts(kind, expected, upper + 1)).toBe(true);
    }
    for (const kind of ["movie", "episode"] as const) {
      for (const invalid of [0, -1, NaN, Infinity]) {
        expect(runtimeContradicts(kind, invalid, 22 * 60)).toBe(false);
        expect(runtimeContradicts(kind, 22 * 60, invalid)).toBe(false);
      }
    }
    expect(runtimeContradicts("series", 45 * 60, 22 * 60)).toBe(false);
  });

  it.each([[10, 14], [22, 12], [22, 30], [45, 32], [60, 45]])(
    "intentionally admits %s -> %s minutes for a movie and rejects it for an exact episode", (expected, measured) => {
      const candidate = source("master", { directHttp: { status: "verified", verified: true, rangeSupported: true,
        runtimeEvidence: "mp4_mvhd", actualRuntimeSeconds: measured * 60 } });
      expect(measuredRuntimeMismatch({ ...movie, runtimeSeconds: expected * 60 }, candidate)).toBe(false);
      expect(measuredRuntimeMismatch({ ...episode, runtimeSeconds: expected * 60 }, candidate)).toBe(true);
    }
  );

  it("requires verified supported runtime evidence, ignoring provider duration claims for episodes", () => {
    const requested = { ...episode, runtimeSeconds: 45 * 60 };
    const candidate = source("master", { title: "Server 1\n00:22:00", directHttp: {
      status: "verified", verified: true, rangeSupported: true, actualRuntimeSeconds: 22 * 60, runtimeEvidence: "mp4_mvhd"
    } });
    expect(identityMismatch(requested, candidate)).toBe(false);
    expect(measuredRuntimeMismatch(requested, candidate)).toBe(true);
    expect(measuredRuntimeMismatch(requested, { ...candidate, directHttp: { ...candidate.directHttp!, verified: false } })).toBe(false);
    const unclassified = { ...candidate.directHttp! };
    delete unclassified.runtimeEvidence;
    expect(measuredRuntimeMismatch(requested, { ...candidate, directHttp: unclassified })).toBe(false);
  });

  it("backfills a measured episode contradiction within existing limits and reuses cached measurements", async () => {
    const requested = { ...episode, runtimeSeconds: 45 * 60 };
    const { probe, request } = measuredProbe("hls", (url) => (url.includes("/first/") ? 22 : 44) * 60);
    const candidates = ["first", "second", "third"].map((path) => source("opaque", {
      url: `https://media.example/${path}/master.m3u8`, title: "Server 1"
    }));
    const { resolver } = resolverFor(candidates, requested, probe);
    expect((await resolver.resolve(requested)).map((entry) => entry.url)).toEqual([candidates[1]!.url]);
    expect(probe.diagnostics().requests).toBe(2);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
    // Cached measurements leave the initial slot free for the third source.
    const warm = await resolver.resolve(requested);
    expect(warm.map(entry => entry.url)).toEqual([candidates[1]!.url, candidates[2]!.url]);
    expect(probe.diagnostics().requests).toBe(3);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
    const starts = request.mock.calls.length;
    expect(await resolver.resolve(requested)).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(starts);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
  });

  it("does not infer runtime from multipart names or filesize", async () => {
    const candidates = ["part002", "part003"].map((part) => source(part, {
      filename: `Synthetic.Meridian.1987.${part}.mkv`, sizeBytes: 1024
    }));
    expect(await resolverFor(candidates).resolver.resolve(movie)).toHaveLength(2);
  });
});

describe("bounded identity properties", () => {
  const good = [
    source("canonical", { filename: "Synthetic.Meridian.1987.1080p.mkv" }),
    source("localized", { filename: "Meridiano.Sintetico.1987.720p.mkv" }),
    source("generic", { title: "Server 1" }),
    source("title-difference", { filename: "Synthetic.Northern.Signal.1987.1080p.mkv" })
  ];
  const bad = [
    source("year", { filename: "Synthetic.Meridian.2004.mkv" }),
    source("episode", { filename: "Synthetic.Harbour.S01.E06.mkv" }),
    source("id", { metadata: { identity: { externalIds: { imdb: "tt9999999997" } } } }),
    source("duration", { title: "Synthetic Meridian (1987)\n00:20:00" })
  ];
  const matrix = [...good, ...bad];
  const survivorSet = (values: NormalizedStreamSource[]) => values.map((value) => value.url).sort();

  it("keeps the survivor set invariant under reversal and a deterministic shuffle", async () => {
    const shuffled = [7, 1, 5, 3, 0, 6, 2, 4].map((index) => matrix[index]!);
    for (const order of [matrix, [...matrix].reverse(), shuffled]) {
      const { resolver } = resolverFor(order);
      expect(survivorSet(await resolver.resolve(movie))).toEqual(survivorSet(good));
    }
  });

  it("preserves every existing decision after duplicate noise and additional strong contradictions", async () => {
    const noise = [...matrix, ...bad, good[2]!, good[2]!,
      source("extra-year", { filename: "Synthetic.Northern.Signal.2055.mkv" }),
      source("extra-kind", { metadata: { identity: { kind: "episode" } } })];
    const baseline = await resolverFor(matrix).resolver.resolve(movie);
    const augmented = await resolverFor(noise).resolver.resolve(movie);
    expect(survivorSet(augmented)).toEqual(survivorSet(baseline));
    expect(survivorSet(augmented)).toEqual(survivorSet(good));
    for (const existing of matrix) {
      expect(augmented.some((candidate) => candidate.url === existing.url)).toBe(!identityMismatch(movie, existing));
    }
  });
});

describe("synthetic audit semantics stay observational", () => {
  it.each([
    { label: "year contradiction", item: movie, candidate: source("year", { filename: "Synthetic.Meridian.2004.mkv" }), assessment: "CONTRADICTION", admitted: false },
    { label: "external-ID contradiction", item: movie, candidate: source("id", { metadata: { identity: { externalIds: { imdb: "tt9999999997" } } } }), assessment: "CONTRADICTION", admitted: false },
    { label: "episode-coordinate contradiction", item: episode, candidate: source("episode", { filename: "Synthetic.Harbour.S02.E04.mkv" }), assessment: "CONTRADICTION", admitted: false },
    { label: "canonical filename", item: movie, candidate: source("canonical", { filename: "Synthetic.Meridian.1987.mkv" }), assessment: "MATCH", admitted: true },
    { label: "generic presentation", item: movie, candidate: source("opaque", { title: "Server 1" }), assessment: "UNKNOWN", admitted: true },
    { label: "title-only disagreement", item: movie, candidate: source("opaque", { title: "Synthetic Northern Signal" }), assessment: "UNKNOWN", admitted: true },
    { label: "independent textual disagreement", item: movie, candidate: source("other", { filename: "Synthetic.Northern.Signal.1987.mkv" }), assessment: "SUSPICIOUS", admitted: true },
    { label: "localized filename", item: movie, candidate: source("localized", { filename: "Meridiano.Sintetico.1987.mkv" }), assessment: "SUSPICIOUS", admitted: true }
  ])("classifies $label without changing production admission", async ({ item, candidate, assessment, admitted }) => {
    expect(assessIdentity(item, candidate)).toBe(assessment);
    const { resolver, audit } = resolverFor([candidate], item);
    expect(await resolver.resolve(item)).toHaveLength(admitted ? 1 : 0);
    expect(audit.report().observationOnly).toBe(true);
    expect(audit.report().providers[0]?.stages.provider).toMatchObject({ [assessment]: 1 });
    expect(audit.report().providers[0]?.stages.final.CONTRADICTION).toBe(0);
  });
});
