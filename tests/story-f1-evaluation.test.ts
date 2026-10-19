import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { silentLogger } from "./helpers";
import { loadEvaluationCases, caseSegments } from "../scripts/evaluation-corpus";
import { latencySummary, EvaluationCost } from "../src/streams/evaluation-cost";
import { compareEvaluations, readEvaluationReport } from "../src/streams/evaluation-comparison";
import { SourceDiversityEvaluation } from "../src/streams/source-diversity-evaluation";
import { streamDeduplicationKey } from "../src/streams/stream-deduplication";
import type { NormalizedStreamSource } from "../src/streams/types";

const direct = (id: string, name: string): NormalizedStreamSource =>
  ({ providerId: id, type: "https", url: "https://media.example/" + name + ".mp4?token=PRIVATE" });
const torrent = (id: string, hash: string, seeds?: number): NormalizedStreamSource =>
  ({ providerId: id, type: "magnet", magnet: "magnet:?xt=urn:btih:" + hash,
    ...(seeds === undefined ? {} : { seeds }) });

describe("F1 identity and diversity", () => {
  it("preserves exact resolver URL and torrent key semantics", () => {
    expect(streamDeduplicationKey(direct("a", "one"))).toBe(streamDeduplicationKey(direct("b", "one")));
    expect(streamDeduplicationKey({ ...direct("a", "one"), url: "https://media.example/one.mp4?token=OTHER" }))
      .not.toBe(streamDeduplicationKey(direct("a", "one")));
    expect(streamDeduplicationKey({ ...torrent("a", "a".repeat(40), 1), fileIndex: 2, filename: "Movie.MKV" }))
      .toBe(streamDeduplicationKey({ ...torrent("b", "a".repeat(40)), fileIndex: 2, filename: "movie.mkv" }));
    expect(streamDeduplicationKey({ ...torrent("b", "a".repeat(40)), fileIndex: 3 }))
      .not.toBe(streamDeduplicationKey(torrent("a", "a".repeat(40))));
  });

  it("keeps real resolver cross-provider deduplication exact, including URL queries", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "a", name: "A", isEnabled: () => true, resolve: () => Promise.resolve([
      direct("a", "shared"), direct("a", "shared")
    ]) });
    registry.register({ id: "b", name: "B", isEnabled: () => true, resolve: () => Promise.resolve([
      direct("b", "shared"), { ...direct("b", "shared"),
        url: "https://media.example/shared.mp4?token=DIFFERENT" }
    ]) });
    const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([
      { address: "93.184.216.34", family: 4 }
    ]) });
    const result = await new StreamResolver(registry, policy).resolve({
      id: "tt1234567", kind: "movie", title: "Fixture", externalIds: { imdb: "tt1234567" }
    });
    expect(result).toHaveLength(2);
    expect(result.map((source) => source.url)).toEqual([
      "https://media.example/shared.mp4?token=PRIVATE",
      "https://media.example/shared.mp4?token=DIFFERENT"
    ]);
  });
  it("credits original owners, actual final winner, useful overlap, and seed evidence separately", () => {
    const evaluation = new SourceDiversityEvaluation(["a", "b"]);
    const sharedA = direct("a", "shared"), sharedB = direct("b", "shared");
    const uniqueA = torrent("a", "a".repeat(40), 5);
    const uniqueB = torrent("b", "b".repeat(40));
    const observation = evaluation.item(["all", "movie", "mainstream", "movie/mainstream"]);
    observation.trace.stage("normalized", [sharedA, sharedB, uniqueA, uniqueB]);
    observation.trace.stage("probed", [
      { ...sharedB, directHttp: { status: "verified", verified: true, rangeSupported: true } },
      uniqueA, uniqueB
    ]);
    observation.trace.stage("admitted", [sharedB, uniqueA]);
    observation.trace.stage("final", [sharedB, uniqueA]);
    observation.finish();
    const all = evaluation.report().find((segment) => segment.id === "all")!;
    expect(all.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a", distinct: 2, shared: 1, exclusive: 1,
        admittedOwned: 2, admittedExclusive: 1, finalWinner: 1, finalOwned: 2,
        finalExclusive: 1, verifiedDirectOwned: 1, torrentPositiveSeeds: 1 }),
      expect.objectContaining({ id: "b", distinct: 2, shared: 1, exclusive: 1,
        admittedOwned: 1, admittedExclusive: 0, finalWinner: 1, finalOwned: 1,
        finalExclusive: 0, verifiedDirectOwned: 1, torrentUnknownSeeds: 1 })
    ]));
    expect(all.pairs[0]).toMatchObject({ intersection: 1, union: 3, jaccard: 0.3333,
      aCoveredByB: 0.5, bCoveredByA: 0.5, admittedIntersection: 1, finalOwnedIntersection: 1 });
    expect(evaluation.report().map((segment) => segment.id)).toEqual([
      "all", "movie", "mainstream", "movie/mainstream"
    ]);
    expect(JSON.stringify(evaluation.report())).not.toContain("PRIVATE");
    expect(JSON.stringify(evaluation.report())).not.toContain("magnet:");
  });

  it("aggregates all six media-class/cohort combinations without raw observations", () => {
    const evaluation = new SourceDiversityEvaluation(["a"]);
    for (const mediaClass of ["movie", "series", "anime"]) {
      for (const cohort of ["mainstream", "long-tail"]) {
        const observation = evaluation.item(["all", mediaClass, cohort, mediaClass + "/" + cohort]);
        observation.trace.stage("normalized", [direct("a", mediaClass + cohort)]);
        observation.finish();
      }
    }
    const segments = evaluation.report();
    expect(segments).toHaveLength(12);
    expect(segments.find((row) => row.id === "all")).toMatchObject({
      evaluatedItems: 6, sources: [{ id: "a", distinct: 6 }]
    });
    expect(segments.find((row) => row.id === "movie/mainstream")).toMatchObject({
      evaluatedItems: 1, sources: [{ id: "a", distinct: 1 }]
    });
  });

  it("credits shared budget exhaustion to every owner without other Direct health buckets", () => {
    const evaluation = new SourceDiversityEvaluation(["a", "b"]);
    const observation = evaluation.item(["all"]);
    const shared = direct("a", "budget");
    observation.trace.stage("normalized", [shared, { ...shared, providerId: "b" }]);
    observation.trace.stage("probed", [{
      ...shared, directHttp: { status: "budget_exhausted", verified: false, rangeSupported: false }
    }]);
    observation.finish();
    for (const row of evaluation.report()[0]!.sources) {
      expect(row).toMatchObject({ distinct: 1, shared: 1, budgetExhaustedDirectOwned: 1,
        uncertainDirectOwned: 0, deterministicRejects: 0, verifiedDirectOwned: 0 });
    }
  });

  it.each([
    { seeds: [0, 15], bucket: "torrentPositiveSeeds" },
    { seeds: [15, 0], bucket: "torrentPositiveSeeds" },
    { seeds: [undefined, 0], bucket: "torrentZeroSeeds" },
    { seeds: [0, undefined], bucket: "torrentZeroSeeds" },
    { seeds: [undefined, undefined], bucket: "torrentUnknownSeeds" }
  ] as const)("aggregates same-owner torrent seed evidence independent of order: $seeds", ({ seeds, bucket }) => {
    const evaluation = new SourceDiversityEvaluation(["a", "b"]);
    const observation = evaluation.item(["all"]);
    const hash = "a".repeat(40);
    observation.trace.stage("normalized", [
      torrent("a", hash, seeds[0]), torrent("a", hash, seeds[1]), torrent("b", hash)
    ]);
    observation.finish();
    const row = evaluation.report()[0]!.sources.find((entry) => entry.id === "a")!;
    expect(row).toMatchObject({ distinct: 1, shared: 1, exclusive: 0,
      torrentPositiveSeeds: bucket === "torrentPositiveSeeds" ? 1 : 0,
      torrentZeroSeeds: bucket === "torrentZeroSeeds" ? 1 : 0,
      torrentUnknownSeeds: bucket === "torrentUnknownSeeds" ? 1 : 0 });
  });

  it("uses zero ratios for empty source and pair denominators", () => {
    const evaluation = new SourceDiversityEvaluation(["a", "b"]);
    evaluation.item(["all"]).finish();
    const report = evaluation.report()[0]!;
    expect(report.sources).toEqual([
      expect.objectContaining({ id: "a", distinct: 0, overlapShare: 0, exclusiveShare: 0 }),
      expect.objectContaining({ id: "b", distinct: 0, overlapShare: 0, exclusiveShare: 0 })
    ]);
    expect(report.pairs[0]).toMatchObject({
      intersection: 0, union: 0, jaccard: 0, aCoveredByB: 0, bCoveredByA: 0
    });
    expect(report.pairSummary).toEqual({ totalOverlappingPairs: 0, emittedPairs: 1, truncated: false });
  });

  it("emits no zero-overlap filler pair for two bounded Kodi sources", () => {
    const evaluation = new SourceDiversityEvaluation(["kodi-0", "kodi-1"], 5);
    evaluation.item(["all"]).finish();
    expect(evaluation.report()[0]).toMatchObject({
      pairs: [], pairSummary: { totalOverlappingPairs: 0, emittedPairs: 0, truncated: false }
    });
  });

  it("emits only real overlaps for small bounded Kodi rosters", () => {
    const evaluation = new SourceDiversityEvaluation(["kodi-0", "kodi-1", "kodi-2"], 5);
    const observation = evaluation.item(["all"]);
    observation.trace.stage("normalized", [
      direct("kodi-0", "shared"), direct("kodi-1", "shared"), direct("kodi-2", "unique")
    ]);
    observation.finish();
    expect(evaluation.report()[0]).toMatchObject({
      pairs: [{ a: "kodi-0", b: "kodi-1", intersection: 1 }],
      pairSummary: { totalOverlappingPairs: 1, emittedPairs: 1, truncated: false }
    });
  });

  it("bounds Kodi pair output deterministically", () => {
    const ids = Array.from({ length: 30 }, (_, index) => "kodi-" + index);
    const evaluation = new SourceDiversityEvaluation(ids, 5);
    const observation = evaluation.item(["all"]);
    observation.trace.stage("normalized", ids.map((id) => direct(id, "shared")));
    observation.finish();
    const report = evaluation.report()[0]!;
    expect(report.pairSummary).toMatchObject({ totalOverlappingPairs: 435, truncated: true });
    expect(report.pairs.length).toBeLessThanOrEqual(75);
    for (const id of ids) {
      expect(report.pairs.filter((pair) => pair.a === id || pair.b === id).length).toBeLessThanOrEqual(5);
    }
    expect(report.pairs[0]).toMatchObject({ a: "kodi-0", b: "kodi-1" });
    expect(report.pairs).toEqual(evaluation.report()[0]!.pairs);
  });
});

describe("F1 corpus and cost", () => {
  function file(value: unknown): { path: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "f1-corpus-"));
    const path = join(directory, "input.json");
    writeFileSync(path, JSON.stringify(value));
    return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  }
  const corpus = { version: 1, id: "fixture-v1", cases: [{
    id: "movie-01", mediaClass: "movie", cohort: "mainstream",
    item: { type: "movie", videoId: "tt1234567" }
  }] };
  it("validates corpus, segments, duplicate cases, and stable changing fingerprints", () => {
    const first = file(corpus), same = file({ id: "fixture-v1", cases: corpus.cases, version: 1 });
    const changed = file({ ...corpus, cases: [{ ...corpus.cases[0],
      item: { type: "movie", videoId: "tt7654321" } }] });
    const duplicate = file({ ...corpus, cases: [corpus.cases[0], corpus.cases[0]] });
    try {
      const loaded = loadEvaluationCases(first.path, "--corpus");
      expect(caseSegments(loaded.cases[0]!)).toEqual(["all", "movie", "mainstream", "movie/mainstream"]);
      expect(loadEvaluationCases(same.path, "--corpus").fingerprint).toBe(loaded.fingerprint);
      expect(loadEvaluationCases(changed.path, "--corpus").fingerprint).not.toBe(loaded.fingerprint);
      expect(() => loadEvaluationCases(duplicate.path, "--corpus")).toThrow();
    } finally { first.cleanup(); same.cleanup(); changed.cleanup(); duplicate.cleanup(); }
  });
  it("keeps legacy flat input with only all/manual segment", () => {
    const flat = file([{ type: "movie", videoId: "tt1234567" }]);
    try { expect(caseSegments(loadEvaluationCases(flat.path, "--input").cases[0]!)).toEqual(["all"]); }
    finally { flat.cleanup(); }
  });
  it("uses nearest-rank percentiles and retains counts without request IDs", () => {
    expect(latencySummary([1, 2, 3, 4, 5])).toMatchObject({ count: 5, totalMs: 15,
      meanMs: 3, p50Ms: 3, p95Ms: 5, maxMs: 5 });
    expect(latencySummary([])).toMatchObject({ count: 0, p50Ms: 0, p95Ms: 0 });
    const cost = new EvaluationCost(["provider"]);
    cost.request("provider"); cost.response("provider"); cost.evaluation("provider", "ok", 12);
    cost.evaluation("provider", "error", 20);
    expect(cost.report()[0]).toMatchObject({ evaluations: 2, requests: 1, responses: 1,
      errors: 1, latency: { p50Ms: 12, p95Ms: 20 } });
  });
});

describe("F1 offline comparison", () => {
  const base = { kind: "stremio", version: 2, evaluatedItems: 1,
    corpus: { id: "fixture-v1", version: 1, fingerprint: "a".repeat(64) },
    providers: [{ id: "a", rawDirect: 2, qualifiedDirect: 2 },
      { id: "removed", rawDirect: 1, qualifiedDirect: 1 }],
    segments: [{ id: "all", evaluatedItems: 1, sources: [{ id: "a", distinct: 2 }, { id: "removed", distinct: 1 }],
      pairs: [{ a: "a", b: "removed", intersection: 1 }] }],
    cost: [{ id: "a", evaluations: 1, requests: 2 }] };
  it("accepts combined class/cohort segment labels", () => {
    const extended = { ...base, segments: [...base.segments, {
      id: "movie/mainstream", evaluatedItems: 1, sources: [{ id: "a", distinct: 2 }], pairs: []
    }] };
    const candidate = { ...extended, segments: [extended.segments[0], {
      id: "movie/mainstream", evaluatedItems: 1,
      sources: [{ id: "a", distinct: 3 }], pairs: []
    }] };
    expect(compareEvaluations(extended, candidate).segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "movie/mainstream", entries: [
        { id: "a", delta: { "diversity.distinct": 1 } }
      ] })
    ]));
  });
  it("rejects malformed metrics and compares bounded local reports without network or mutation", () => {
    expect(() => compareEvaluations(base, { ...base,
      providers: [{ id: "a", rawDirect: 2, qualifiedDirect: "invalid" }] })).toThrow("REPORT_INVALID");
    const directory = mkdtempSync(join(tmpdir(), "f1-comparison-"));
    const path = join(directory, "report.json");
    const contents = JSON.stringify(base);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      writeFileSync(path, contents);
      expect(compareEvaluations(readEvaluationReport(path), readEvaluationReport(path)).added).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compares the owned budget bucket as a separate diversity delta", () => {
    const baseline = { ...base, segments: [{ ...base.segments[0],
      sources: [{ id: "a", distinct: 2, budgetExhaustedDirectOwned: 0 },
        { id: "removed", distinct: 1 }] }] };
    const candidate = { ...base, segments: [{ ...base.segments[0],
      sources: [{ id: "a", distinct: 2, budgetExhaustedDirectOwned: 1 },
        { id: "removed", distinct: 1 }] }] };
    expect(compareEvaluations(baseline, candidate).entries[0]?.delta)
      .toMatchObject({ "diversity.budgetExhaustedDirectOwned": 1 });
  });

  it("prints factual text by default and unchanged comparison JSON with --json", () => {
    const directory = mkdtempSync(join(tmpdir(), "f1-compare-cli-"));
    const baseline = join(directory, "baseline.json");
    const candidate = join(directory, "candidate.json");
    const run = (...extra: string[]) => spawnSync(process.execPath, [
      join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      join(process.cwd(), "scripts", "compare-evaluations.ts"),
      "--baseline", baseline, "--candidate", candidate, ...extra
    ], { cwd: process.cwd(), encoding: "utf8" });
    try {
      writeFileSync(baseline, JSON.stringify(base));
      writeFileSync(candidate, JSON.stringify(base));
      const plain = run();
      const machine = run("--json");
      expect(plain.status).toBe(0);
      expect(machine.status).toBe(0);
      expect(plain.stdout).toContain("Evaluator: stremio");
      expect(plain.stdout).toContain("Added: none");
      expect(plain.stdout).toContain("Overall deltas:\n  none");
      expect(plain.stdout).not.toContain("recommend");
      expect(JSON.parse(machine.stdout)).toEqual(compareEvaluations(base, base));
      expect(plain.stdout).not.toBe(machine.stdout);
      expect(readFileSync(baseline, "utf8")).toBe(JSON.stringify(base));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects mismatched fingerprints", () => {
    expect(() => compareEvaluations(base, { ...base, corpus: { ...base.corpus,
      fingerprint: "b".repeat(64) } })).toThrow("REPORT_MISMATCH");
  });
  it("compares overlap metrics for aligned pairs", () => {
    const candidate = { ...base,
      segments: [{ id: "all", evaluatedItems: 1, sources: [{ id: "a", distinct: 2 }, { id: "removed", distinct: 2 }],
        pairs: [{ a: "a", b: "removed", intersection: 2 }] }] };
    expect(compareEvaluations(base, candidate).pairs).toEqual([{
      ids: ["a", "removed"], delta: { intersection: 1 }
    }]);
  });
  it("reports roster changes and factual quality, diversity, and cost deltas", () => {
    const candidate = { ...base,
      providers: [{ id: "a", rawDirect: 3, qualifiedDirect: 3 },
        { id: "added", rawDirect: 2, qualifiedDirect: 2 }],
      segments: [{ id: "all", evaluatedItems: 1, sources: [{ id: "a", distinct: 4 }, { id: "added", distinct: 2 }],
        pairs: [{ a: "a", b: "added", intersection: 1 }] }],
      cost: [{ id: "a", evaluations: 1, requests: 3 }] };
    const result = compareEvaluations(base, candidate);
    expect(result).toMatchObject({ added: ["added"], removed: ["removed"],
      entries: [{ id: "a", delta: { "quality.qualifiedDirect": 1,
        "diversity.distinct": 2, "cost.requests": 1 } }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
