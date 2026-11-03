import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import type { CatalogProvider } from "../../src/catalog/types";
import { DiagnosticController } from "../../src/diagnostics/controller";
import { diagnosticObserverFactory, observeResolution } from "../../src/diagnostics/resolver-observer";
import { DIAGNOSTIC_LIMITS as L, DiagnosticRecorder, type DiagnosticEvent, type RecordedEvent } from "../../src/diagnostics/recorder";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import type { OutboundTransport } from "../../src/network/outbound-transport";
import { DirectStreamProbe } from "../../src/streams/direct-stream-probe";
import { defaultStreamRankingPolicy, type StreamRankingPolicy } from "../../src/streams/ranking-policy";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver, type StreamResolverObservation, type StreamResolverTrace } from "../../src/streams/resolver";
import { scoreStream, streamScoreComponents } from "../../src/streams/scoring";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../../src/streams/types";
import { fixtureOutboundRequest, silentLogger, syntheticAdminToken, testConfig } from "../helpers";
import { mp4Fixture } from "../mp4-fixture";
import { anonymizeDiagnosticExport, validatePrivateReport } from "../../src/diagnostics/private-context";

const movie: NormalizedMediaItem = { id: "private-query-canary", kind: "movie", title: "Synthetic Meridian", year: 1994,
  runtimeSeconds: 6420, externalIds: {} };
const options = { ttlMs: 300000, resolutions: 10, retainReport: true };
const source = (id: string, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource => ({
  providerId: "fixture", type: "https", url: `https://media.example/${id}/opaque.mp4`, ...extra
});
function policy() {
  return new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
}
function harness(input: NormalizedStreamSource[], controller: DiagnosticController, settings: {
  trace?: StreamResolverTrace; maxResults?: number; maxProbes?: number; rankingPolicy?: StreamRankingPolicy;
  observe?: () => StreamResolverObservation | undefined;
} = {}) {
  const provider = vi.fn(() => Promise.resolve(input));
  const registry = new StreamProviderRegistry(1000, silentLogger);
  for (const id of new Set(input.map(s => s.providerId))) registry.register({ id, name: "Synthetic", isEnabled: () => true,
    resolve: async () => (await provider()).filter(s => s.providerId === id) });
  const network = vi.fn(fixtureOutboundRequest(({ url, headers }) => {
    if (url.includes("/failed/")) return Promise.resolve(new Response(null, { status: 404 }));
    if (url.includes("/error/")) return Promise.reject(new Error("private-error-canary"));
    const body = Uint8Array.from(mp4Fixture(url.includes("/runtime-conflict/") ? 1200 : 6420));
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range") ?? "");
    if (!range) return Promise.resolve(new Response(body, { headers: { "Content-Type": "video/mp4" } }));
    const start = Number(range[1]), end = Math.min(Number(range[2]), body.length - 1);
    return Promise.resolve(new Response(body.subarray(start, end + 1), { status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${body.length}` } }));
  }));
  const transport: OutboundTransport = { id: "fixture", request: network,
    diagnostics: () => ({ transport: "fixture", requests: network.mock.calls.length, failures: 0, averageLatencyMs: 0 }) };
  const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 1000, maxCandidates: settings.maxProbes ?? 100, maxConcurrent: 1 }, silentLogger, () => 1_000_000);
  const resolver = new StreamResolver(registry, policy(), probe, settings.trace, settings.rankingPolicy ?? defaultStreamRankingPolicy,
    settings.maxResults ?? 50, settings.observe ?? diagnosticObserverFactory(controller));
  return { resolver, provider, network, probe, registry };
}
function events(c: DiagnosticController): RecordedEvent[] { return c.report()!.resolutions.flatMap(r => r.events); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("US-1502 real resolver diagnostic capture", () => {
  it.each([134, 169])("preserves technical decisions after private context exhaustion with %i synthetic movie candidates", async count => {
    const label = "Invented release label ".repeat(6).trim();
    const input = Array.from({ length: count }, (_, i) => ({ ...source(`continuity-${i}`, {
      providerId: i < 90 ? "fixture-a" : "fixture-b", title: label,
      metadata: { identity: { title: label } }
    }), name: label }));
    input[count - 1] = { ...input[count - 1]!, metadata: { identity: { kind: "episode" } } };
    input[count - 2] = { ...input[count - 2]!, url: input[count - 3]!.url! };
    input[count - 4] = { ...input[count - 4]!, url: "https://media.example/runtime-conflict/opaque.mp4" };
    input[count - 5] = { ...input[count - 5]!, url: "https://media.example/failed/opaque.mp4" };
    const off = harness(input, new DiagnosticController(), { maxProbes: 200 });
    const expected = await off.resolver.resolve(movie);
    for (const privateMode of [false, true]) {
      const c = new DiagnosticController(); c.start(options, privateMode);
      const h = harness(input, c, { maxProbes: 200 });
      const actual = await h.resolver.resolve(movie); c.stop();
      expect(actual).toEqual(expected);
      expect(actual.map(getBridgeIdentityState)).toEqual(expected.map(getBridgeIdentityState));
      expect(h.network.mock.calls.map(([r]) => r.url)).toEqual(off.network.mock.calls.map(([r]) => r.url));
      const technical = c.report()!;
      expect(technical.resolutions[0]!.state).toBe("CLOSED");
      const e = technical.resolutions[0]!.events;
      for (const reason of ["KIND_CONFLICT", "DUPLICATE", "MEASURED_RUNTIME_CONTRADICTION", "DETERMINISTIC_PROBE_REJECTION", "PROVIDER_RESULT_LIMIT"]) {
        expect(e).toContainEqual(expect.objectContaining({ reason }));
      }
      expect(e.filter(x => x.kind === "SNAPSHOT").map(x => x.stage)).toEqual(["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"]);
      expect(e.filter(x => x.kind === "RANKING")).toHaveLength(actual.length);
      expect(e.at(-1)).toEqual({ kind: "END", outcome: "SUCCEEDED" });
      expect(e.length).toBeLessThanOrEqual(L.resolutionEvents);
      expect(JSON.stringify(technical)).not.toContain("Invented");
      if (privateMode) {
        const p = c.readPrivateReport(); if (p.state !== "AVAILABLE") throw new Error();
        const report = validatePrivateReport(p.report);
        expect(report.report.state).toBe("TRUNCATED");
        expect(report.context[0]!.metadataCapture).toBe("CONTEXT_LIMIT");
        expect(report.context[0]!.candidates!.length).toBeLessThan(count);
        expect(new Set(e.filter(x => x.kind === "SOURCE").map(x => x.candidateId)).size).toBe(count);
        expect(anonymizeDiagnosticExport(report)).toEqual(technical);
        expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(L.dtoBytes);
      } else expect(technical.state).toBe("CLOSED");
    }
  });

  it("keeps OFF free of diagnostic references and reserves before provider work when ON", async () => {
    const c = new DiagnosticController(); const h = harness([source("one")], c);
    const freeze = vi.spyOn(Object, "freeze");
    await h.resolver.resolve(movie); expect(freeze).not.toHaveBeenCalled();
    freeze.mockClear(); c.start(options);
    h.provider.mockImplementation(() => {
      expect(c.status()).toMatchObject({ reserved: 1, active: 1 });
      return Promise.resolve([source("one")]);
    });
    await h.resolver.resolve(movie); expect(freeze).toHaveBeenCalled(); freeze.mockRestore();
    expect(c.status().active).toBe(0); c.stop();
    expect(events(c)).toContainEqual({ kind: "END", outcome: "SUCCEEDED" });
  });

  it.each([false, true])("preserves exact candidates, order, identity, dedupe, admission, requests and production probe quota ON/OFF (private=%s)", async privateMode => {
    const duplicate = source("duplicate", { quality: "1080p", title: "Invented duplicate release" });
    const input = [source("anchor", { url: "https://media.example/anchor/Synthetic.Meridian.1994.mp4", quality: "480p" }),
      duplicate, duplicate, source("failed"), source("later"), source("excluded", { metadata: { identity: { externalIds: { imdb: "tt9999999998" } } } })];
    const item = { ...movie, externalIds: { imdb: "tt9999999999" } };
    const run = async (enabled: boolean) => {
      const c = new DiagnosticController(); if (enabled) c.start(options, privateMode);
      const h = harness(input, c, { maxResults: 2, maxProbes: 3 });
      const result = await h.resolver.resolve(item); c.stop();
      return { result, states: result.map(getBridgeIdentityState), requests: h.network.mock.calls.map(([r]) => [r.url, r.method]),
        providers: h.provider.mock.calls.length, diagnostics: h.probe.diagnostics(), c };
    };
    const off = await run(false); const on = await run(true);
    expect(on.result).toEqual(off.result); expect(on.states).toEqual(off.states);
    expect(on.requests).toEqual(off.requests); expect(on.providers).toBe(off.providers);
    expect(on.diagnostics).toEqual(off.diagnostics); expect(on.requests.length).toBeGreaterThan(0);
    const observed = events(on.c);
    expect(observed.filter(e => e.kind === "OBSERVATION" && e.stage === "PROVIDER")).toHaveLength(6);
    const provider = observed.filter(e => e.kind === "OBSERVATION" && e.stage === "PROVIDER");
    expect(new Set(provider.map(e => "candidateId" in e ? e.candidateId : "" )).size).toBe(6);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "REJECTION", reason: "EXTERNAL_ID_CONFLICT", identity: "CONTRADICTION" }),
      expect.objectContaining({ kind: "OBSERVATION", stage: "PROBED", probe: "unreachable" }),
      expect.objectContaining({ kind: "EXCLUSION", stage: "DEDUPLICATED", reason: "DUPLICATE" })
    ]));
  });

  it("observes real Identity states and exact policy scores only on final retained candidates", async () => {
    const input = [source("suspicious", { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }),
      source("unknown", { quality: "720p" }), source("pending", { metadata: { identity: { title: "Synthetic Aurora" } } }),
      source("anchor", { url: "https://media.example/anchor/Synthetic.Meridian.1994.mp4", quality: "480p" }),
      source("runtime-conflict", { title: "Invented rejected runtime release" })];
    const rankingPolicy = structuredClone(defaultStreamRankingPolicy); rankingPolicy.direct.health.verified = 91;
    const c = new DiagnosticController(); c.start(options, true);
    const h = harness(input, c, { rankingPolicy }); const result = await h.resolver.resolve(movie); c.stop();
    expect(result.map(getBridgeIdentityState)).toEqual(["CORROBORATED", "UNKNOWN", undefined, "SUSPICIOUS"]);
    const observed = events(c);
    const privateResult = c.readPrivateReport();
    expect(privateResult.state).toBe("AVAILABLE");
    if (privateResult.state !== "AVAILABLE") throw new Error("Missing private report");
    const runtime = privateResult.report.context[0]!.candidates!.find(m => m.title === "Invented rejected runtime release")!;
    expect(runtime.labelStatus!.title).toBe("CAPTURED");
    expect(observed).toContainEqual(expect.objectContaining({ candidateId: runtime.candidateId, kind: "REJECTION", reason: "MEASURED_RUNTIME_CONTRADICTION" }));
    expect(observed).toContainEqual(expect.objectContaining({ kind: "REJECTION", stage: "ADMITTED", reason: "MEASURED_RUNTIME_CONTRADICTION" }));
    const final = observed.filter(e => e.kind === "OBSERVATION" && e.stage === "FINAL");
    expect(final.map(e => e.kind === "OBSERVATION" ? e.identity : undefined)).toEqual(["CORROBORATED", "UNKNOWN", "UNCLASSIFIED", "SUSPICIOUS"]);
    const ranking = observed.filter(e => e.kind === "RANKING"); expect(ranking).toHaveLength(result.length);
    ranking.forEach((entry, index) => {
      expect(entry).toMatchObject({ kind: "RANKING", position: index + 1, score: scoreStream(result[index]!, rankingPolicy),
        ...streamScoreComponents(result[index]!, rankingPolicy) });
      expect(entry.candidateId).toBe(final[index] && "candidateId" in final[index] ? final[index].candidateId : undefined);
    });
    expect(observed).toContainEqual(expect.objectContaining({ kind: "GAP", context: "IDENTITY_GROUP", reason: "UNOBSERVED" }));
  });

  it("attributes observed quota removals without inventing a pre-quota ranking snapshot", async () => {
    const c = new DiagnosticController(); c.start(options);
    const h = harness([source("first"), source("second"), source("third")], c, { maxResults: 1 });
    const result = await h.resolver.resolve(movie); expect(result).toHaveLength(1); c.stop();
    const observed = events(c);
    expect(observed.filter(e => e.kind === "RANKING")).toHaveLength(1);
    expect(observed.filter(e => e.kind === "EXCLUSION" && e.reason === "PROVIDER_RESULT_LIMIT" && e.stage === "FINAL")).toHaveLength(2);
    expect(observed.filter(e => e.kind === "GAP" && e.context === "CONTINUITY" && e.stage === "FINAL")).toHaveLength(0);
  });

  it("isolates two interleaved invocations on the same shared resolver", async () => {
    const c = new DiagnosticController(); c.start(options);
    const first = deferred<NormalizedStreamSource[]>(); const second = deferred<NormalizedStreamSource[]>();
    const entered = deferred<void>(); let calls = 0;
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => {
      calls++; if (calls === 2) entered.resolve(); return calls === 1 ? first.promise : second.promise;
    } });
    const resolver = new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c));
    const a = resolver.resolve(movie); const b = resolver.resolve({ ...movie, id: "other-private-query" });
    await entered.promise; expect(c.status()).toMatchObject({ active: 2, reserved: 2 });
    second.resolve([source("second")]); const secondResult = await b;
    expect(c.status().active).toBe(1); first.resolve([source("first"), source("first-more")]); const firstResult = await a;
    expect(firstResult).toHaveLength(2); expect(secondResult).toHaveLength(1); c.stop();
    const reports = c.report()!.resolutions; expect(reports).toHaveLength(2);
    expect(reports[0]!.id).not.toBe(reports[1]!.id);
    expect(reports.map(r => r.events.find(e => e.kind === "SNAPSHOT"))).toMatchObject([{ count: 2 }, { count: 1 }]);
    const ids = reports.map(r => new Set(r.events.flatMap(e => "candidateId" in e && e.candidateId !== "UNOBSERVED" ? [e.candidateId] : [])));
    expect([...ids[0]!].some(id => ids[1]!.has(id))).toBe(false);
  });

  it("keeps stage-interleaved callbacks isolated and legacy trace callbacks compatible", async () => {
    const c = new DiagnosticController(); c.start(options);
    const aGate = deferred<void>(); const bGate = deferred<void>(); const both = deferred<void>();
    const p = policy(); const validate = p.validate.bind(p); let waiting = 0;
    vi.spyOn(p, "validate").mockImplementation(async url => {
      waiting++; if (waiting === 2) both.resolve();
      await (url.includes("/a/") ? aGate.promise : bGate.promise); return validate(url);
    });
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true,
      resolve: item => Promise.resolve([source(item.id)]) });
    const legacyStages: string[] = []; const legacyRanking = vi.fn(); const legacyPreProbe = vi.fn();
    const legacy: StreamResolverTrace = {
      stage: (stage, sources, refs) => { legacyStages.push(stage); expect(refs).toHaveLength(sources.length); },
      preProbeIdentity: legacyPreProbe, ranking: legacyRanking
    };
    const resolver = new StreamResolver(registry, p, undefined, legacy, undefined, 50, diagnosticObserverFactory(c));
    const a = resolver.resolve({ ...movie, id: "a" }); const b = resolver.resolve({ ...movie, id: "b" });
    await both.promise; expect(legacyStages).toEqual(["provider", "provider"]);
    bGate.resolve(); await b; aGate.resolve(); await a; c.stop();
    expect(legacyRanking).toHaveBeenCalledTimes(2); expect(legacyPreProbe).toHaveBeenCalledTimes(2);
    const reports = c.report()!.resolutions;
    for (const report of reports) {
      expect(report.events.filter(e => e.kind === "SNAPSHOT").map(e => e.stage)).toEqual(["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"]);
      expect(new Set(report.events.flatMap(e => "candidateId" in e && e.candidateId !== "UNOBSERVED" ? [e.candidateId] : [])).size).toBe(1);
    }
    expect(reports[0]!.events.find(e => e.kind === "RANKING")).not.toMatchObject({ candidateId: (reports[1]!.events.find(e => e.kind === "RANKING") as { candidateId: string }).candidateId });
  });

  it("does not queue production work at diagnostic concurrency or reservation limits", async () => {
    const c = new DiagnosticController(); c.start(options);
    const gate = deferred<NormalizedStreamSource[]>(); const entered = deferred<void>(); let calls = 0;
    const registry = new StreamProviderRegistry(1000, silentLogger, 20);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true,
      resolve: () => { calls++; if (calls === 12) entered.resolve(); return gate.promise; } });
    const resolver = new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c));
    const pending = Array.from({ length: 12 }, () => resolver.resolve(movie));
    await entered.promise; expect(c.status()).toMatchObject({ reserved: 10, active: 4, skippedConcurrent: 6, truncated: true });
    gate.resolve([source("one")]); expect((await Promise.all(pending)).every(result => result.length === 1)).toBe(true);
    expect(calls).toBe(12); expect(c.status().active).toBe(0); c.stop(); expect(c.report()!.resolutions).toHaveLength(4);
  });

  it("keeps production beyond 256 candidates and reports the actual provider count with TRUNCATED", async () => {
    const input = Array.from({ length: 300 }, (_, i) => source(`candidate-${i}`, { providerId: `fixture_${Math.floor(i / 100)}` }));
    const c = new DiagnosticController(); c.start(options);
    const h = harness(input, c, { maxResults: 100, maxProbes: 400 });
    const output = await h.resolver.resolve(movie); expect(output).toHaveLength(300); c.stop();
    expect(c.report()!.state).toBe("TRUNCATED");
    expect(events(c).find(e => e.kind === "SNAPSHOT" && e.stage === "PROVIDER")).toEqual({ kind: "SNAPSHOT", stage: "PROVIDER", count: 300, observed: 256 });
    expect(c.report()!.version).toBe(2);
    expect(events(c).filter(e => e.kind === "OBSERVATION")).toHaveLength(256);
  });

  it.each(["stop", "expiry", "cancel"])("closes safely after %s while provider work is active", async action => {
    let now = 0; const c = new DiagnosticController(() => now); c.start(options);
    const gate = deferred<NormalizedStreamSource[]>(); const entered = deferred<void>();
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => { entered.resolve(); return gate.promise; } });
    const abort = new AbortController();
    const resolver = new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c));
    const pending = resolver.resolve(movie, abort.signal); await entered.promise;
    if (action === "stop") c.stop();
    if (action === "expiry") { now = L.ttlMs; expect(c.status().state).toBe("OFF"); }
    if (action === "cancel") abort.abort(new Error("private-cancellation-error"));
    const before = c.report(); gate.resolve([source("one")]); const output = await pending;
    if (action === "cancel") {
      expect(output).toEqual([]); expect(c.status().active).toBe(0); c.stop();
      expect(events(c)).toContainEqual({ kind: "END", outcome: "CANCELLED" });
    } else { expect(output).toHaveLength(1); expect(c.report()).toEqual(before); }
    expect(c.report()!.state).toBe("TRUNCATED");
    expect(JSON.stringify(c.report())).not.toContain("private-cancellation-error");
  });

  it("contains observer creation/callback/finalization failures and preserves thrown production errors", async () => {
    const input = [source("one"), source("one"), source("runtime-conflict")];
    const baseline = harness(input, new DiagnosticController()); const expected = await baseline.resolver.resolve(movie);
    for (const point of ["factory", "stage", "preProbeIdentity", "rejection", "exclusion", "ranking", "finish"] as const) {
      const c = new DiagnosticController();
      const observe = () => {
        if (point === "factory") throw new Error("private-observer-error");
        return { trace: { stage: () => { if (point === "stage") throw new Error("private-observer-error"); },
          preProbeIdentity: () => { if (point === "preProbeIdentity") throw new Error("private-observer-error"); },
          exclusion: () => { if (point === "exclusion") throw new Error("private-observer-error"); },
          rejection: () => { if (point === "rejection") throw new Error("private-observer-error"); },
          ranking: () => { if (point === "ranking") throw new Error("private-observer-error"); } },
          finish: () => { if (point === "finish") throw new Error("private-observer-error"); } };
      };
      const h = harness(input, c, { observe }); expect(await h.resolver.resolve(movie)).toEqual(expected);
      expect(h.network.mock.calls.map(([r]) => [r.url, r.method])).toEqual(baseline.network.mock.calls.map(([r]) => [r.url, r.method]));
      expect(h.provider).toHaveBeenCalledTimes(1);
    }
    const c = new DiagnosticController(); c.start(options); const h = harness(input, c);
    const failure = new Error("private-production-error"); vi.spyOn(h.registry, "resolveAll").mockRejectedValue(failure);
    await expect(h.resolver.resolve(movie)).rejects.toBe(failure); expect(c.status().active).toBe(0); c.stop();
    expect(events(c)).toContainEqual({ kind: "END", outcome: "FAILED" });
    expect(JSON.stringify(c.report())).not.toContain(failure.message);
  });

  it("contains recorder faults during real resolution and never retains canaries", async () => {
    class Failing extends DiagnosticRecorder { override record(): void { throw new Error("private-recorder-error"); } }
    const failing = new DiagnosticController(undefined, id => new Failing(id)); failing.start(options);
    const h = harness([source("one")], failing); expect(await h.resolver.resolve(movie)).toHaveLength(1);
    expect(failing.status().state).toBe("OFF");
    const c = new DiagnosticController(); c.start(options);
    const privateSource = source("private-url-canary", { providerId: "private-provider-canary", title: "private-title-canary",
      metadata: { private: "private-metadata-canary" }, requestHeaders: { Referer: "https://private.example/private-header-canary" } });
    const other = source("error", { providerId: "private-provider-canary" });
    const torrent: NormalizedStreamSource = { providerId: "private-provider-canary", type: "magnet",
      magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=private-magnet-title-canary&tr=https://tracker.example/private-token-canary" };
    await harness([privateSource, other, torrent], c).resolver.resolve(movie); c.stop();
    const report = JSON.stringify(c.report());
    for (const canary of ["private-url-canary", "private-provider-canary", "private-title-canary", "private-metadata-canary", "private-header-canary", "private-query-canary", "private-error-canary", "private-recorder-error", "private-magnet-title-canary", "private-token-canary", "0123456789abcdef0123456789abcdef01234567"]) expect(report).not.toContain(canary);
    expect(report).not.toContain("https://"); expect(report).not.toContain("providerId");
  });

  it("records explicit ranking gaps rather than coercing non-finite or uncorrelated score values", () => {
    const c = new DiagnosticController(); c.start(options); const observation = observeResolution(c.beginResolution()!);
    const ref = Object.freeze({}); const sources = [source("one")];
    observation.trace.stage("provider", sources, [ref]);
    observation.trace.ranking?.([{ transport: "private-provider", quality: 1, score: Infinity,
      components: { availability: 1, resolution: 1, size: 1, codec: 1, metadata: 1, transport: 1 } }]);
    observation.trace.stage("final", sources, [ref]); observation.finish(false); c.stop();
    expect(events(c).filter(e => e.kind === "RANKING")).toHaveLength(0);
    expect(events(c)).toContainEqual(expect.objectContaining({ kind: "GAP", context: "RANKING", reason: "UNOBSERVED" }));
    expect(JSON.stringify(c.report())).not.toContain("private-provider");

    c.start(options); const unmatched = observeResolution(c.beginResolution()!);
    unmatched.trace.stage("provider", sources, [ref]);
    const valid = { transport: "https", quality: 1, score: 7,
      components: { availability: 1, resolution: 1, size: 1, codec: 1, metadata: 1, transport: 2 } };
    unmatched.trace.ranking?.([valid, valid]);
    unmatched.trace.stage("normalized", sources); // Missing occurrence evidence must stay explicit.
    unmatched.trace.stage("final", sources, [ref]); unmatched.finish(false); c.stop();
    expect(events(c).filter(e => e.kind === "RANKING")).toHaveLength(0);
    expect(events(c)).toContainEqual({ kind: "SNAPSHOT", stage: "NORMALIZED", count: 1, observed: 0 });
    expect(events(c)).toContainEqual(expect.objectContaining({ kind: "GAP", context: "CONTINUITY", reason: "UNOBSERVED" }));
    expect(events(c)).toContainEqual(expect.objectContaining({ kind: "GAP", context: "RANKING", reason: "UNOBSERVED" }));

    c.start(options); const detached = observeResolution(c.beginResolution()!);
    detached.trace.stage("provider", sources, [ref]); detached.trace.ranking?.([valid]);
    valid.score = 999; valid.components.transport = 999;
    detached.trace.stage("final", sources, [ref]); detached.finish(false); c.stop();
    expect(events(c)).toContainEqual(expect.objectContaining({ kind: "RANKING", score: 7, transport: 2 }));
  });

  it("enforces the 2 MiB serialized DTO budget for the enlarged closed numeric schema", () => {
    const c = new DiagnosticController(); c.start(options);
    const value = 9999.12345678901;
    const event: DiagnosticEvent = { kind: "RANKING", candidate: 0, position: 1, score: value, availability: value,
      resolution: value, size: value, codec: value, metadata: value, transport: value };
    for (let r = 0; r < 6; r++) { const capture = c.beginResolution()!; for (let e = 0; e < 2048; e++) capture.record(event); capture.finish(); }
    c.stop(); expect(c.report()!.state).toBe("TRUNCATED");
    expect(c.report()!.events).toBeLessThan(8192); expect(Buffer.byteLength(JSON.stringify(c.report()))).toBeLessThanOrEqual(L.dtoBytes);
  });

  it("preserves public Stremio stream order and playback capability contracts through administrative ON/OFF", async () => {
    const auth = `Bearer ${syntheticAdminToken}`;
    const network = vi.fn(fixtureOutboundRequest(() => Promise.reject(new Error("Unexpected playback network"))));
    const transport: OutboundTransport = { id: "fixture", request: network,
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const direct = vi.fn(() => Promise.resolve([
      { url: "https://media.example/low.mp4", fileName: "low.mp4", size: 1000, height: 480 },
      { url: "https://media.example/high.mp4", fileName: "high.mp4", size: 1000, height: 2160 }
    ]));
    const catalog: CatalogProvider = { definition: { id: "fixture", type: "movie", name: "Synthetic" }, owns: () => true,
      list: () => Promise.resolve([]), get: () => Promise.resolve({ id: "fixture", type: "movie", name: "Synthetic Meridian" }),
      getTorrentSource: () => Promise.resolve(""), supportsTriblerFallback: () => Promise.resolve(false), getDirectStreams: direct };
    const { app } = createApp(testConfig(), silentLogger, undefined, catalog, policy(), transport);
    const get = () => request(app).get("/stream/movie/fixture.json").set("Origin", "https://web.stremio.com").expect(200);
    const off = await get();
    await request(app).post("/diagnostics/start").set("Authorization", auth).send(options).expect(200);
    const on = await get();
    const shape = (body: unknown) => (body as { streams: Array<{ url: string; name: string; title: string; behaviorHints: unknown }> }).streams.map(stream => {
      const url = new URL(stream.url); expect(url.origin).toBe("http://127.0.0.1:7000");
      expect(url.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\//);
      return { name: stream.name, title: stream.title, hints: stream.behaviorHints, filename: url.pathname.split("/").at(-1) };
    });
    expect(shape(on.body)).toEqual(shape(off.body));
    expect(shape(on.body).map(s => s.name)).toEqual([expect.stringContaining("2160p"), expect.stringContaining("480p")]);
    const status = await request(app).get("/diagnostics/status").set("Authorization", auth).expect(200);
    expect(status.body).toMatchObject({ state: "ON", reserved: 1, active: 0 }); expect((status.body as { events: number }).events).toBeGreaterThan(0);
    await request(app).post("/diagnostics/stop").set("Authorization", auth).expect(200);
    expect(direct).toHaveBeenCalledTimes(2); expect(network).not.toHaveBeenCalled();
  });
});
