import { describe, expect, it } from "vitest";
import type { EvaluationCorpus, EvaluationCase } from "../scripts/evaluation-corpus";
import { formatSmokeReport, rotateProviders, sampleSmokeCase, smokeCases, smokeReport, trustedSmokeItem, parseSmokeArgs, providerCounts } from "../scripts/identity-live-smoke-runner";
import { IdentityDiagnostics, formatIdentityDiagnostics, providerFamily } from "../src/qa/identity-diagnostics";
import { RejectedSourceReview } from "../src/qa/rejected-source-review";
import { createStreamResolver, createUrlPolicy } from "../src/streams/factory";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import type { StreamProvider, NormalizedMediaItem } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { silentLogger, testConfig } from "./helpers";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "FAKE_PRIVATE_TITLE", year: 1994,
  runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const entry = { id: "movie-mainstream-01", mediaClass: "movie" as const, cohort: "mainstream" as const, item: movie };
const provider = (streams: Awaited<ReturnType<StreamProvider["resolve"]>>): StreamProvider => ({
  id: "FAKE_PRIVATE_PROVIDER", name: "FAKE_PRIVATE_LABEL", isEnabled: () => true, resolve: () => Promise.resolve(streams) });

async function sample(kind: "empty" | "error" | "timeout" | "torrent" | "unmeasured" | "healthy" | "wrong" | "hls" | "budget" | "exhausted" | "cache") {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  try {
    const path = kind === "hls" ? upstream.vod("short", 2, false, { segmentSeconds: 600, playlistType: "VOD" }).master
      : upstream.media("/media/opaque.mp4", { body: kind === "unmeasured" ? Buffer.from([1]) : mp4Fixture(kind === "wrong" ? 1200 : 6420),
        contentType: "video/mp4", range: "honor", ...(kind === "exhausted" ? { delayMs: 100 } : {}) });
    const signed = path + "?token=FAKE_PRIVATE_QUERY";
    if (kind !== "hls") upstream.allowMediaUrl(signed);
    const second = upstream.media("/media/second.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
    let selected: StreamProvider;
    if (kind === "error") selected = { ...provider([]), resolve: () => Promise.reject(new Error("FAKE_PRIVATE_ERROR")) };
    else if (kind === "timeout") selected = { ...provider([]), timeoutMs: 10,
      resolve: (_item, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("FAKE_PRIVATE_ERROR")), { once: true });
      }) };
    else selected = provider(kind === "empty" ? [] : kind === "torrent" ? [{ providerId: "FAKE_PRIVATE_PROVIDER", type: "magnet",
      magnet: "magnet:?xt=urn:btih:" + "a".repeat(40) }] : [{ providerId: "FAKE_PRIVATE_PROVIDER", type: "http",
      url: kind === "hls" ? path : signed, title: "FAKE_PRIVATE_TITLE", ...(kind === "budget" ? {} : { metadata: { secret: "FAKE_PRIVATE_METADATA" } }) },
    ...(["budget", "exhausted"].includes(kind) ? [{ providerId: "FAKE_PRIVATE_PROVIDER", type: "http" as const, url: second }] : [])]);
    const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
    const transport = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger);
    const config = testConfig();
    const bounded = { ...config, directHttpProbe: { ...config.directHttpProbe, enabled: true, maxCandidates: 1, maxConcurrent: 1,
      timeoutMs: kind === "exhausted" ? 30 : 1000 } };
    const probe = new DirectStreamProbe(transport, bounded.directHttpProbe, silentLogger);
    let row = await sampleSmokeCase(entry, movie, [selected], bounded, policy, transport, silentLogger,
      new AbortController().signal, "QUICK", undefined, probe);
    if (kind === "cache") row = await sampleSmokeCase(entry, movie, [selected], bounded, policy, transport, silentLogger,
      new AbortController().signal, "QUICK", undefined, probe);
    const serialized = JSON.stringify(smokeReport("QUICK", [row], row.elapsedMs)) + formatSmokeReport(smokeReport("QUICK", [row], row.elapsedMs));
    expect(serialized).not.toContain("FAKE_PRIVATE");
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain("magnet:");
    return row.diagnostics!;
  } finally { await upstream.close(); }
}

describe("opt-in identity smoke offline observations", () => {
  it("observes the real factory's empty external HTTP result used by the review CLI", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    let requestObserved = false;
    const endpoint = upstream.media("/media/resolve", { contentType: "application/json", body: '{"streams":[]}',
      observeHeaders: () => { requestObserved = true; } });
    const config = { ...testConfig(), streamProviders: ["external_http"], externalStreamProviderEnabled: true,
      externalStreamProviderUrl: endpoint + "?token=FAKE_PRIVATE_ENDPOINT" };
    const policy = createUrlPolicy(config);
    const transport = new DirectTransport(policy, config.httpPrivacy, silentLogger);
    const review = new RejectedSourceReview(transport, movie);
    try {
      const diagnostic = new IdentityDiagnostics(movie, review);
      const resolver = createStreamResolver([], config, silentLogger, policy, transport, undefined, diagnostic.trace);
      await resolver.resolve(movie);
      const report = diagnostic.report(resolver.directProbeDiagnostics(), 0, resolver.diagnostics());
      // Whitelist scalar fixture evidence only: no URLs, headers, labels or raw errors.
      const evidence = JSON.stringify({ requestObserved, requests: upstream.count("/media/resolve"),
        effectiveTimeoutMs: config.externalStreamProviderTimeoutMs,
        states: resolver.diagnostics().filter(row => row.enabled).map(row => ({ status: row.status,
          latencyMs: row.latencyMs, cancelledOrTimedOut: row.lastError === "Provider timed out or was cancelled" })),
        timeouts: report.providers.timeouts, pending: report.pendingProviderOutcomes });
      expect(evidence).not.toContain("FAKE_PRIVATE");
      expect(report.providers, evidence).toMatchObject({ selected: 1, calls: 1, noResults: 1, errors: 0, timeouts: 0 });
      expect(report.observations).toContain("NO_RAW_SOURCES");
      expect(formatIdentityDiagnostics(report)).not.toContain("FAKE_PRIVATE");
      expect(upstream.count("/media/resolve")).toBe(1);
    } finally { await review.close(); await upstream.close(); }
  });
  it("reports zero sources, provider errors/timeouts and torrent-only output without guessing truth", async () => {
    const empty = await sample("empty");
    expect(empty.providers).toMatchObject({ calls: 1, noResults: 1 });
    expect(empty.observations).toContain("NO_RAW_SOURCES");
    expect(formatIdentityDiagnostics(empty)).toContain("NO_MEASURED_REJECTION");
    expect((await sample("error")).providers.errors).toBe(1);
    expect((await sample("timeout")).providers.timeouts).toBe(1);
    const torrent = await sample("torrent");
    expect(torrent.transports.torrent).toBe(1);
    expect(torrent.probe.starts).toBe(0);
  });
  it("separates verification, measured runtime, real rejection and review eligibility", async () => {
    expect((await sample("unmeasured")).observations).toContain("MP4_WITHOUT_RUNTIME");
    const healthy = await sample("healthy");
    expect(healthy).toMatchObject({ measuredRejections: 0, eligibleReviews: 0, finalDirect: 1,
      finalConfidence: { UNKNOWN: 1, unclassified: 0 }, probe: { mp4Runtime: 1, starts: 1 } });
    const wrong = await sample("wrong");
    expect(wrong).toMatchObject({ measuredRejections: 1, eligibleReviews: 1, finalDirect: 0 });
    const hls = await sample("hls");
    expect(hls).toMatchObject({ measuredRejections: 1, eligibleReviews: 0, measuredWithoutEligibleReview: 1,
      probe: { hlsVodRuntime: 1 } });
  });
  it("reports partial probe sampling separately from actual budget-exhausted status", async () => {
    const report = await sample("budget");
    expect(report).toMatchObject({ probe: { starts: 1, unexaminedDirect: 1, exhausted: 0 }, finalDirect: 1,
      stages: { probed: 2, final: 1 } });
    expect((await sample("exhausted")).probe.exhausted).toBe(1);
    expect((await sample("cache")).probe).toMatchObject({ starts: 0, cacheHits: 1, mp4Runtime: 1 });
  });
  it("aborts a real pending resolution and distinguishes unsampled rows", async () => {
    const policy = new ExternalUrlPolicy();
    const transport = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger);
    const slow: StreamProvider = { ...provider([]), resolve: () => new Promise(() => undefined) };
    const timedOut = await sampleSmokeCase(entry, movie, [slow], testConfig(), policy, transport, silentLogger,
      AbortSignal.timeout(15), "QUICK");
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.diagnostics?.providers.calls).toBe(1);
    const report = smokeReport("QUICK", [timedOut, { caseId: "movie-mainstream-03", cohort: "movie/mainstream",
      status: "not_executed", elapsedMs: 0, diagnostics: null }], 15);
    expect(report.totals).toMatchObject({ timedOut: 1, notExecuted: 1, probeStarts: 0 });
  });
  it("keeps trusted movie runtime separate from exact-episode and provider claims", async () => {
    let calls = 0;
    const lookup = { lookup: () => { calls += 1; return Promise.resolve({ title: "Trusted", runtimeSeconds: 6420 }); } };
    expect((await trustedSmokeItem({ ...movie, runtimeSeconds: 1200 }, lookup)).runtimeSeconds).toBe(6420);
    const exact = { ...movie, kind: "episode" as const, season: 2, episode: 9 };
    expect((await trustedSmokeItem(exact, lookup)).runtimeSeconds).toBeUndefined();
    expect(calls).toBe(1);
    expect((await trustedSmokeItem(movie, { lookup: () => Promise.resolve(undefined) })).runtimeSeconds).toBeUndefined();
  });
  it("requires an explicit corpus path and rejects ambiguous or unsupported flags", () => {
    expect(parseSmokeArgs(["--corpus", "synthetic.json"])).toEqual({ corpusPath: "synthetic.json", mode: "QUICK", json: false });
    expect(parseSmokeArgs(["--json", "--full", "--corpus", "private corpus.json"])).toEqual({
      corpusPath: "private corpus.json", mode: "FULL", json: true });
    for (const args of [[], ["--quick"], ["--corpus"], ["--corpus", "--full"],
      ["--corpus", "a.json", "--corpus", "b.json"], ["--corpus", "a.json", "--quick", "--full"],
      ["--corpus", "a.json", "--json", "--json"], ["--corpus", "a.json", "--unknown"]]) {
      expect(() => parseSmokeArgs(args)).toThrow();
    }
  });
  it("balances arbitrary synthetic cohorts deterministically within the QUICK bound", () => {
    const cases: EvaluationCase[] = (["movie", "series", "anime"] as const).flatMap((mediaClass, mediaIndex) =>
      (["mainstream", "long-tail"] as const).flatMap((cohort, cohortIndex) =>
        Array.from({ length: 3 + mediaIndex + cohortIndex }, (_, index) => ({
          id: `fixture_${mediaIndex}_${cohortIndex}_${index}`, mediaClass, cohort,
          item: mediaClass === "movie" ? movie : { ...movie, kind: "episode" as const, season: 2, episode: index + 1 }
        }))));
    const corpus: EvaluationCorpus = { id: "synthetic-uneven", version: 1, fingerprint: "synthetic", cases };
    const quick = smokeCases(corpus, "QUICK");
    expect(quick).toHaveLength(12);
    expect(smokeCases({ ...corpus, cases: [...corpus.cases].reverse() }, "QUICK").map(row => row.id)).toEqual(quick.map(row => row.id));
    expect(new Set(quick.map(row => row.id)).size).toBe(12);
    for (const mediaClass of ["movie", "series", "anime"]) for (const cohort of ["mainstream", "long-tail"]) {
      expect(quick.filter(row => row.mediaClass === mediaClass && row.cohort === cohort)).toHaveLength(2);
    }
    const full = smokeCases(corpus, "FULL");
    expect(full).toHaveLength(cases.length);
    expect(new Set(full.map(row => row.id))).toEqual(new Set(cases.map(row => row.id)));
    expect(smokeCases({ ...corpus, cases: [...cases].reverse() }, "FULL")).toEqual(full);
    const sparse = { ...corpus, cases: [cases[0]!, ...cases.filter(row => row.mediaClass === "anime").slice(0, 2)] };
    expect(smokeCases(sparse, "QUICK")).toHaveLength(3);
    expect(smokeCases({ ...corpus, cases: cases.filter(row => row.mediaClass === "movie" && row.cohort === "mainstream") }, "QUICK"))
      .toHaveLength(3);
    expect(quick.filter(row => row.item.kind === "episode").length).toBeGreaterThan(0);
    const report = smokeReport("QUICK", sparse.cases.map(row => ({ caseId: row.id, cohort: `${row.mediaClass}/${row.cohort}`,
      status: "not_executed", elapsedMs: 0, diagnostics: null })), 0);
    expect(report.cohorts.map(row => row.cohort)).toEqual(["anime/mainstream", "movie/mainstream"]);
  });
  it("gives catalog a turn alongside external HTTP and addons without changing the configured pool", () => {
    const pool = ["external_http", ...Array.from({ length: 7 }, (_, index) => "stremio-addon-" + index), "catalog_synthetic"]
      .map(id => ({ ...provider([]), id }));
    const original = [...pool];
    const selections = Array.from({ length: 12 }, (_, index) => rotateProviders(pool, index));
    for (const selected of selections) {
      expect(selected).toHaveLength(4);
      expect(new Set(selected.map(row => providerFamily(row.id)))).toEqual(new Set(["external_http", "stremio_addon", "catalog"]));
      expect(new Set(selected.map(row => row.id)).size).toBe(4);
    }
    expect(rotateProviders([...pool].reverse(), 3)).toEqual(selections[3]);
    expect(new Set(selections.flat().map(row => row.id)).size).toBe(9);
    expect(providerCounts(pool)).toMatchObject({ external_http: 1, stremio_addon: 7, catalog: 1 });
    expect(providerCounts([...new Map(selections.flat().map(row => [row.id, row])).values()])).toEqual(providerCounts(pool));
    expect(pool).toEqual(original);
    const wider = [...pool, { ...provider([]), id: "local_json" }, { ...provider([]), id: "synthetic_other" },
      { ...provider([]), id: "catalog_disabled", isEnabled: () => false }];
    const rotation = Array.from({ length: 5 }, (_, index) => rotateProviders(wider, index));
    expect(rotation.every(selected => selected.length === 4 && !selected.some(row => row.id === "catalog_disabled"))).toBe(true);
    expect(rotation.some(selected => !selected.some(row => row.id === "external_http"))).toBe(true);
    expect(new Set(rotation.flat().map(row => providerFamily(row.id))).size).toBe(5);
    expect(rotateProviders([], 0)).toEqual([]);
    expect(rotateProviders([pool[0]!], 5)).toEqual([pool[0]!]);
  });
});
