// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { assessIdentity, IdentityPrecisionEvaluation } from "../src/streams/identity-precision-evaluation";
import { identityMismatch } from "../src/streams/identity-qualification";
import { composeResolverTraces } from "../src/streams/source-diversity-evaluation";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { fixtureOutboundRequest, silentLogger, type FixtureOutboundRequest } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";

const movie: NormalizedMediaItem = { id: "tt9900102", kind: "movie", title: "The Velnor",
  year: 1984, runtimeSeconds: 107 * 60, externalIds: { imdb: "tt9900102" } };
const source = (extras: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource => ({
  providerId: "fixture", type: "https", url: "https://media.example/video.mp4", ...extras
});

describe("observation-only identity precision", () => {
  it("preserves inputs, admission, ordering, output and probe backfill with audit absent or enabled", async () => {
    const requested: NormalizedMediaItem = { id: "synthetic-movie", kind: "movie", title: "Synthetic Meridian",
      year: 1987, runtimeSeconds: 107 * 60, externalIds: {} };
    async function run(mode: "absent" | "aggregate" | "diagnostic") {
      const candidates = [source({ url: "https://media.example/short.mp4", title: "Server 1" }),
        source({ url: "https://media.example/close.mp4", filename: "Synthetic.Meridian.1987.mp4" }),
        source({ url: "https://media.example/localized.mp4", filename: "Meridiano.Sintetico.1987.mp4" })];
      const sibling = [{ ...candidates[1]!, providerId: "second" },
        { providerId: "second", type: "torrent" as const, infoHash: "a".repeat(40), seeds: 10 }];
      const before = structuredClone({ requested, candidates, sibling });
      const registry = new StreamProviderRegistry(500, silentLogger);
      const providers = [vi.fn(() => Promise.resolve(candidates)), vi.fn(() => Promise.resolve(sibling))];
      for (const [index, id] of ["fixture", "second"].entries()) registry.register({ id, name: id,
        isEnabled: () => true, resolve: providers[index]! });
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url, headers }) => {
        const bytes = mp4Fixture((url.includes("short") ? 20 : 106) * 60);
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range")!)!;
        const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
        return Promise.resolve(new Response(Uint8Array.from(bytes.subarray(start, end + 1)), { status: 206,
          headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${bytes.length}` } }));
      });
      const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
      const probe = new DirectStreamProbe(transport,
        { enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1 }, silentLogger, () => 10);
      const stages: Array<{ stage: string; sources: NormalizedStreamSource[] }> = [];
      const trace = { stage: (stage: string, sources: NormalizedStreamSource[]) => {
        stages.push({ stage, sources: structuredClone(sources) });
      } };
      const audit = mode === "absent" ? undefined
        : new IdentityPrecisionEvaluation(["fixture", "second"], { diagnostics: mode === "diagnostic" });
      const resolver = new StreamResolver(registry, new ExternalUrlPolicy({
        resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
      }), probe, audit ? composeResolverTraces(trace, audit.itemTrace(requested)) : trace);
      const output = await resolver.resolve(requested);
      expect({ requested, candidates, sibling }).toEqual(before);
      expect(providers.map((provider) => provider.mock.calls.length)).toEqual([1, 1]);
      expect(probe.diagnostics().requests).toBe(2);
      expect(output.some((candidate) => candidate.url?.includes("close.mp4"))).toBe(true);
      expect(output.some((candidate) => candidate.url?.includes("short.mp4"))).toBe(false);
      return { output, stages, probes: probe.diagnostics(),
        requests: request.mock.calls.map(([entry]) => entry) };
    }
    const baseline = await run("absent");
    expect(await run("aggregate")).toEqual(baseline);
    expect(await run("diagnostic")).toEqual(baseline);
  });

  it("explains all assessments without changing the existing aggregate counters", () => {
    const candidates = [
      source({ filename: "The.Velnor.1984.mkv" }),
      source({ filename: "O Vigia de Nuvora 1984.mkv" }),
      source({ title: "The Velnor (1984)" }),
      source({ metadata: { identity: { externalIds: { imdb: "tt9999999" }, year: 1999 } } }),
      source({ metadata: { identity: { externalIds: { imdb: "tt9900102" } } } }),
      source({ directHttp: { status: "verified", verified: true, rangeSupported: true,
        actualRuntimeSeconds: 1200, runtimeEvidence: "mp4_mvhd" } })
    ];
    const plain = new IdentityPrecisionEvaluation(["fixture"]);
    const diagnostic = new IdentityPrecisionEvaluation(["fixture"], { diagnostics: true });
    plain.itemTrace(movie).stage("final", candidates);
    diagnostic.itemTrace(movie).stage("final", candidates);
    expect(diagnostic.report().providers).toEqual(plain.report().providers);
    expect(diagnostic.report().diagnostics?.observations.map((row) => [row.assessment, row.reasons[0]])).toEqual([
      ["MATCH", "RESOURCE_TITLE_MATCH"], ["SUSPICIOUS", "RESOURCE_TITLE_DISAGREEMENT"],
      ["UNKNOWN", "NO_INDEPENDENT_CORROBORATION"], ["CONTRADICTION", "SHARED_IDENTITY_CONTRADICTION"],
      ["MATCH", "STRUCTURED_EXTERNAL_ID_MATCH"], ["CONTRADICTION", "MEASURED_RUNTIME_CONTRADICTION"]
    ]);
    expect(diagnostic.report().diagnostics?.observations[1]).toMatchObject({
      evaluationIndex: 1, candidateIndex: 1, providerId: "fixture", stage: "final",
      evidence: { requested: { title: "The Velnor", year: 1984, kind: "movie" },
        candidate: { filename: "O Vigia de Nuvora 1984.mkv", resourceTitleOrigin: "filename" },
        comparison: { requestedTitleKey: "the velnor", resourceTitleKey: "o vigia de nuvora" } }
    });
    expect(diagnostic.report().diagnostics?.observations[5]?.evidence.probe).toMatchObject({
      status: "verified", actualRuntimeSeconds: 1200, runtimeEvidence: "mp4_mvhd"
    });
    expect(plain.report()).not.toHaveProperty("diagnostics");
  });

  it("bounds observations by stage without losing counters or the final stage", () => {
    const audit = new IdentityPrecisionEvaluation(["fixture"], { diagnostics: true, maxObservationsPerStage: 1 });
    const first = audit.itemTrace(movie);
    first.stage("provider", [source(), source()]);
    first.stage("final", [source()]);
    audit.itemTrace(movie).stage("final", [source()]);
    expect(audit.report().providers[0]?.stages.final.UNKNOWN).toBe(2);
    expect(audit.report().diagnostics?.observations).toHaveLength(2);
    expect(audit.report().diagnostics?.droppedByStage).toMatchObject({ provider: 1, final: 1 });
    const returned = audit.report();
    returned.diagnostics!.observations[0]!.reasons.length = 0;
    expect(audit.report().diagnostics?.observations[0]?.reasons).toHaveLength(1);
    expect(() => new IdentityPrecisionEvaluation(["fixture"], { maxObservationsPerStage: 1001 })).toThrow(/limit/);
  });

  it("leaves SUSPICIOUS admission identical when diagnostics are enabled", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "fixture", name: "fixture", isEnabled: () => true,
      resolve: () => Promise.resolve([source({ filename: "O Vigia de Nuvora 1984.mkv" })]) });
    const policy = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    const plain = new IdentityPrecisionEvaluation(["fixture"]);
    const diagnostic = new IdentityPrecisionEvaluation(["fixture"], { diagnostics: true });
    const before = await new StreamResolver(registry, policy, undefined, plain.itemTrace(movie)).resolve(movie);
    const after = await new StreamResolver(registry, policy, undefined, diagnostic.itemTrace(movie)).resolve(movie);
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(diagnostic.report().providers).toEqual(plain.report().providers);
    expect(diagnostic.report().diagnostics?.observations.find((row) => row.stage === "final")).toMatchObject({
      assessment: "SUSPICIOUS", reasons: ["RESOURCE_TITLE_DISAGREEMENT"]
    });
  });

  it("discards sensitive text and metadata, and never trusts raw provider probe evidence", () => {
    const audit = new IdentityPrecisionEvaluation(["fixture"], { diagnostics: true });
    const candidate = source({ url: "https://sensitive.example/SECRET_NAME.mp4?token=SECRET_QUERY",
      title: "Cookie SECRET_COOKIE Authorization SECRET_AUTH", filename: "C:\\private\\SECRET_FILENAME.mp4",
      magnet: "magnet:?xt=SECRET_MAGNET", infoHash: "a".repeat(40),
      requestHeaders: { Referer: "https://private.example/SECRET_HEADER" },
      metadata: { password: "SECRET_PASSWORD", identity: { year: 1984, externalIds: { imdb: "tt9900102" } } },
      directHttp: { status: "verified", verified: true, rangeSupported: true,
        actualRuntimeSeconds: 1200, runtimeEvidence: "mp4_mvhd" } });
    const trace = audit.itemTrace(movie);
    trace.stage("provider", [candidate]);
    trace.stage("final", [candidate, source({ title: "sensitive.unusualtld", filename: "b".repeat(40) + ".mp4" }),
      source({ url: "https://sensitive.example/SECRET_NAME.mp4?token=SECRET_QUERY" })]);
    const report = audit.report();
    expect(report.diagnostics?.observations[0]?.evidence).not.toHaveProperty("probe");
    const serialized = JSON.stringify(report);
    for (const forbidden of ["SECRET", "https:", "magnet:", "sensitive.example", "sensitive.unusualtld", "private", "token", "Cookie",
      "Authorization", "Referer", "requestHeaders", "password", "tt9900102", "a".repeat(40), "b".repeat(40)])
      expect(serialized).not.toContain(forbidden);
  });

  it("keeps an episode's resource-title disagreement observational while year hard rejection is deferred", () => {
    const requested: NormalizedMediaItem = { id: "synthetic:1:1", kind: "episode", title: "Synthetic Sleeping Grove",
      year: 1998, season: 1, episode: 1, externalIds: {} };
    const echo = source({ title: "Synthetic Sleeping Grove (1998) S01E01" });
    expect(assessIdentity(requested, echo)).toBe("UNKNOWN");
    for (const candidate of [
      { ...echo, filename: "Synthetic.Northern.Grove.2020.Ep1.mp4" },
      { ...echo, url: "https://media.example/resource/Synthetic.Northern.Grove.2020.Ep1.mp4" }
    ]) {
      expect(assessIdentity(requested, candidate)).toBe("SUSPICIOUS");
      expect(identityMismatch(requested, candidate)).toBe(false);
      const withoutYear = { ...requested };
      delete withoutYear.year;
      expect(assessIdentity(withoutYear, candidate)).toBe("SUSPICIOUS");
      expect(identityMismatch(withoutYear, candidate)).toBe(false);
    }
  });

  it("uses shared strong contradictions and only independent corroboration for MATCH", () => {
    expect(assessIdentity(movie, source({ filename: "The.Velnor.1984.mkv" }))).toBe("MATCH");
    expect(assessIdentity(movie, source({ title: "The Velnor (1984)" }))).toBe("UNKNOWN");
    expect(assessIdentity(movie, source({ title: "Unrelated Movie" }))).toBe("UNKNOWN");
    expect(assessIdentity(movie, source({ metadata: { identity: { externalIds: { imdb: "tt9900102" } } } }))).toBe("MATCH");
    expect(assessIdentity(movie, source({ metadata: { identity: { externalIds: { imdb: "tt9999999" } } } }))).toBe("CONTRADICTION");
    expect(assessIdentity(movie, source({ filename: "Other.Movie.1999.mkv" }))).toBe("CONTRADICTION");
    const localized = source({ filename: "O.Vigia.de.Nuvora.1984.mkv" });
    expect(assessIdentity(movie, localized)).toBe("SUSPICIOUS");
    expect(identityMismatch(movie, localized)).toBe(false);
  });

  it("applies identical shared filtering to all normalized provider families while observing title ambiguity", async () => {
    const ids = ["stremio-addon-fixture", "external_http", "other-direct"];
    const registry = new StreamProviderRegistry(100, silentLogger);
    const requested: NormalizedMediaItem = { id: "tt9900104", kind: "movie", title: "Neravelle",
      year: 1968, externalIds: { imdb: "tt9900104" } };
    for (const id of ids) registry.register({ id, name: id, isEnabled: () => true,
      resolve: () => Promise.resolve([
        source({ providerId: id, url: `https://media.example/${id}/wrong.mp4`, filename: "The.Neravelle.1999.mp4" }),
        source({ providerId: id, url: `https://media.example/${id}/episode.mp4`, filename: "Trails.and.Neravelles.S01.E06.mp4" }),
        source({ providerId: id, url: `https://media.example/${id}/generic.mp4`, title: "Unrelated Movie" })
      ]) });
    const audit = new IdentityPrecisionEvaluation(ids);
    const trace = composeResolverTraces(audit.itemTrace(requested));
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }), undefined, trace);
    const result = await resolver.resolve(requested);
    expect(result.map((candidate) => candidate.providerId).sort()).toEqual([...ids].sort());
    expect(resolver.diagnostics().map((row) => row.identityRejections)).toEqual([2, 2, 2]);
    for (const row of audit.report().providers) {
      expect(row.stages.provider).toEqual({ MATCH: 0, UNKNOWN: 1, SUSPICIOUS: 0, CONTRADICTION: 2 });
      expect(row.stages.final).toEqual({ MATCH: 0, UNKNOWN: 1, SUSPICIOUS: 0, CONTRADICTION: 0 });
    }
  });

  it("retains aggregate enums only and ignores provider-supplied probe evidence", () => {
    const audit = new IdentityPrecisionEvaluation(["fixture"]);
    const privateCandidate = source({ title: "SECRET_PRESENTATION", filename: "C:\\private\\SECRET_FILENAME.mp4",
      url: "https://media.example/SECRET_PATH.mp4?token=SECRET_QUERY", magnet: "magnet:?xt=SECRET_MAGNET",
      requestHeaders: { Referer: "https://private.example/SECRET_HEADER" },
      metadata: { cookie: "SECRET_COOKIE" }, directHttp: { status: "verified", verified: true,
        rangeSupported: true, actualRuntimeSeconds: 20 * 60, runtimeEvidence: "mp4_mvhd" } });
    audit.itemTrace(movie).stage("provider", [privateCandidate]);
    const report = audit.report();
    expect(report.providers[0]?.stages.provider.CONTRADICTION).toBe(0);
    const serialized = JSON.stringify(report);
    for (const forbidden of ["SECRET", "https:", "magnet:", "private", "token", "tt9900102", "Velnor"])
      expect(serialized).not.toContain(forbidden);
    expect(() => new IdentityPrecisionEvaluation(["https://private.example/token"])).toThrow(/provider ID/);
  });
});
