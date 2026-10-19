import { describe, expect, it } from "vitest";
import { SourceDiversityEvaluation } from "../src/streams/source-diversity-evaluation";
import { KodiSourceQualityEvaluation, type KodiSourceBatch } from "../src/streams/kodi-source-quality-evaluation";
import { ProviderQualityEvaluation } from "../src/streams/provider-quality-evaluation";
import { compareEvaluations } from "../src/streams/evaluation-comparison";
import { caseSegments, type EvaluationCase } from "../scripts/evaluation-corpus";
import type { NormalizedStreamSource } from "../src/streams/types";

const direct = (id: string, name: string): NormalizedStreamSource =>
  ({ providerId: id, type: "https", url: "https://example.org/" + name + "?token=PRIVATE" });
const torrent = (id: string, hash: string, seeds?: number): NormalizedStreamSource =>
  ({ providerId: id, type: "magnet", magnet: "magnet:?xt=urn:btih:" + hash,
    ...(seeds === undefined ? {} : { seeds }) });

describe("F2 v3 instrument", () => {
  it("separates item coverage from identity overlap and counts sole and final ownership", () => {
    const e = new SourceDiversityEvaluation(["a", "b"]);
    const one = e.item(["all"]);
    one.trace.stage("normalized", [direct("a", "one"), direct("a", "two"), direct("b", "three")]);
    one.trace.stage("admitted", [direct("a", "one"), direct("b", "three")]);
    one.trace.stage("final", [direct("b", "three")]);
    one.finish();
    const two = e.item(["all"]);
    two.trace.stage("normalized", [direct("a", "four"), direct("a", "five")]);
    two.trace.stage("admitted", [direct("a", "four")]);
    two.trace.stage("final", [direct("a", "four")]);
    two.finish();
    const report = e.report()[0]!;
    expect(report.sources[0]).toMatchObject({ distinct: 4, coveredItems: 2, soleCoveredItems: 1,
      admittedItems: 2, finalOwnedItems: 1, soleFinalOwnedItems: 1, finalWinnerItems: 1 });
    expect(report.sources[1]).toMatchObject({ distinct: 1, coveredItems: 1, soleCoveredItems: 0,
      admittedItems: 1, finalOwnedItems: 1, soleFinalOwnedItems: 1, finalWinnerItems: 1 });
    expect(report.pairs[0]).toMatchObject({ intersection: 0, union: 5 });
    expect(report.coveragePairs[0]).toMatchObject({ intersection: 1, union: 2,
      aCoveredByB: 0.5, bCoveredByA: 1, finalIntersection: 0, finalUnion: 2 });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|example\.org|magnet:/);
  });

  it("uses strongest same-owner seed evidence for exclusive torrents", () => {
    const e = new SourceDiversityEvaluation(["a", "b"]);
    const item = e.item(["all"]);
    item.trace.stage("normalized", [
      torrent("a", "a".repeat(40), 0), torrent("a", "a".repeat(40), 3),
      torrent("a", "b".repeat(40), 0), torrent("a", "c".repeat(40)),
      torrent("a", "d".repeat(40), 10), torrent("b", "d".repeat(40))
    ]);
    item.finish();
    expect(e.report()[0]!.sources[0]).toMatchObject({ distinct: 4, exclusive: 3,
      torrentPositiveSeedsExclusive: 1, torrentZeroSeedsExclusive: 1,
      torrentUnknownSeedsExclusive: 1, torrentPositiveSeeds: 2 });
  });

  it("emits content pairs separately when exact identities do not overlap", () => {
    const e = new SourceDiversityEvaluation(["a", "b"], 5);
    const item = e.item(["all"]);
    item.trace.stage("normalized", [direct("a", "one"), direct("b", "two")]);
    item.finish();
    expect(e.report()[0]).toMatchObject({ pairs: [], coveragePairs: [
      { a: "a", b: "b", intersection: 1 }
    ] });
  });

  it("does not treat known-zero sole torrent coverage as eligible", () => {
    const e = new SourceDiversityEvaluation(["a", "b"]);
    const item = e.item(["all"]);
    item.trace.stage("normalized", [torrent("a", "a".repeat(40), 0)]);
    item.finish();
    expect(e.report()[0]!.sources[0]).toMatchObject({
      coveredItems: 1, soleCoveredItems: 1, eligibleItems: 0, soleEligibleItems: 0
    });
  });

  it("credits positive and unknown seed evidence despite a dead competitor", () => {
    const e = new SourceDiversityEvaluation(["a", "b"]);
    const first = e.item(["all"]);
    first.trace.stage("normalized", [
      torrent("a", "a".repeat(40), 0), torrent("a", "a".repeat(40), 5),
      torrent("b", "b".repeat(40), 0)
    ]);
    first.finish();
    const second = e.item(["all"]);
    second.trace.stage("normalized", [torrent("a", "c".repeat(40))]);
    second.finish();
    const report = e.report()[0]!;
    expect(report.sources[0]).toMatchObject({
      coveredItems: 2, soleCoveredItems: 1, eligibleItems: 2, soleEligibleItems: 2
    });
    expect(report.sources[1]).toMatchObject({ coveredItems: 1, eligibleItems: 0 });
    expect(report.coveragePairs[0]).toMatchObject({ intersection: 1, union: 2,
      eligibleIntersection: 0, eligibleUnion: 2, eligibleJaccard: 0,
      aEligibleCoveredByB: 0, bEligibleCoveredByA: 0 });
    expect(JSON.stringify(report)).not.toMatch(/magnet:|PRIVATE/);
  });

  it("uses the admitted stage for Direct eligibility", () => {
    const e = new SourceDiversityEvaluation(["a", "b"]);
    const item = e.item(["all"]);
    const accepted = direct("a", "accepted"), rejected = direct("b", "rejected");
    item.trace.stage("normalized", [accepted, rejected]);
    item.trace.stage("probed", [
      { ...accepted, directHttp: { status: "verified", verified: true, rangeSupported: true } },
      { ...rejected, directHttp: { status: "unreachable", verified: false, rangeSupported: false } }
    ]);
    item.trace.stage("admitted", [accepted]);
    item.finish();
    expect(e.report()[0]!.sources).toEqual([
      expect.objectContaining({ id: "a", coveredItems: 1, eligibleItems: 1, soleEligibleItems: 1 }),
      expect.objectContaining({ id: "b", coveredItems: 1, eligibleItems: 0, soleEligibleItems: 0 })
    ]);
  });

  it("emits every positive Kodi content pair while retaining bounded identity pairs", () => {
    const ids = Array.from({ length: 7 }, (_, index) => "kodi-" + index);
    const e = new SourceDiversityEvaluation(ids, 5);
    const item = e.item(["all"]);
    item.trace.stage("normalized", ids.map((id) => direct(id, "shared")));
    item.trace.stage("admitted", [direct("kodi-0", "shared")]);
    item.finish();
    const report = e.report()[0]!;
    expect(report.coveragePairSummary).toEqual({
      totalOverlappingPairs: 21, emittedPairs: 21, truncated: false
    });
    expect(report.coveragePairs).toHaveLength(21);
    expect(report.coveragePairs.every((pair) => pair.intersection === 1 && pair.eligibleIntersection === 1))
      .toBe(true);
    expect(report.pairSummary).toMatchObject({ totalOverlappingPairs: 21, truncated: true });
    expect(report.pairs.length).toBeLessThan(21);
    expect(report.coveragePairs).toEqual(e.report()[0]!.coveragePairs);
  });

  it("counts Kodi item health once per adapter batch and maps synthetic IDs", async () => {
    const e = new KodiSourceQualityEvaluation([{ profileId: "pack", sourceId: "source" }]);
    const counts = (d: number, p: number, z: number, u: number) => ({
      returned: d + p + z + u, direct: d, torrent: p + z + u, positiveSeeds: p,
      zeroSeeds: z, unknownSeeds: u, zeroSeedWouldDrop: z, distinct: 0, exclusive: 0, shared: 0
    });
    for (const [d, p, z, u] of [[0, 1, 0, 0], [0, 0, 1, 0], [0, 1, 1, 0],
      [0, 0, 0, 1], [1, 0, 0, 0]] as const) {
      const batch: KodiSourceBatch = { profileId: "pack", sourceId: "source", status: "ok",
        elapsedMs: 1, candidates: [], counts: counts(d, p, z, u) };
      await e.evaluateItem([batch], () => Promise.resolve());
    }
    const report = { ...e.report(),
      corpus: { id: "fixture", version: 1, fingerprint: "a".repeat(64) } };
    expect(report.sources[0]).toMatchObject({ id: "kodi-0", profileId: "pack", sourceId: "source",
      returnedItems: 5, directItems: 1, positiveSeedTorrentItems: 2, zeroSeedTorrentItems: 2,
      unknownSeedTorrentItems: 1, noPositiveSeedTorrentItems: 2 });
    expect(compareEvaluations(report, report).entries[0]?.id).toBe("pack/source");
    const malformed = { ...report, sources: [{ ...report.sources[0]!, id: "kodi-1" }] };
    expect(() => compareEvaluations(report, malformed)).toThrow("REPORT_INVALID");
  });

  it("adds anime movie and episode structural segments", () => {
    const item = { id: "fixture", title: "PRIVATE", externalIds: {}, kind: "movie" as const };
    const movie = { id: "case", mediaClass: "anime" as const, cohort: "mainstream" as const, item };
    const episode = { ...movie, cohort: "long-tail" as const,
      item: { ...item, kind: "episode" as const } };
    expect(caseSegments(movie as EvaluationCase)).toEqual([
      "all", "anime", "mainstream", "anime/mainstream", "anime/movie", "anime/mainstream/movie"
    ]);
    expect(caseSegments(episode as EvaluationCase)).toEqual([
      "all", "anime", "long-tail", "anime/long-tail", "anime/episode", "anime/long-tail/episode"
    ]);
  });

  it("counts raw stream-shaped objects but excludes garbage", () => {
    const e = new ProviderQualityEvaluation([{ id: "a", name: "A" }]);
    e.rawStreams("a", [{ url: "https://example.org/a" }, { infoHash: "a".repeat(40) },
      null, "garbage", {}, { title: "notice" }]);
    expect(e.report().providers[0]).toMatchObject({ rawReturned: 2, rawDirect: 1 });
  });

  it("validates v3 and rejects mixed versions, corpus mismatch, and impossible counters", () => {
    const diversity = new SourceDiversityEvaluation(["a", "b"]);
    const item = diversity.item(["all", "anime/movie"]);
    item.trace.stage("normalized", [direct("a", "one"), direct("b", "two")]);
    item.finish();
    const base = { kind: "stremio", version: 3, evaluatedItems: 1,
      corpus: { id: "fixture", version: 1, fingerprint: "a".repeat(64) },
      providers: [{ id: "a", rawReturned: 1, rawDirect: 1 },
        { id: "b", rawReturned: 1, rawDirect: 1 }],
      segments: diversity.report(),
      cost: [{ id: "a", evaluations: 1, requests: 1, responses: 1, errors: 0, latency: { count: 1, totalMs: 1, meanMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 } },
        { id: "b", evaluations: 1, requests: 1, responses: 1, errors: 0, latency: { count: 1, totalMs: 1, meanMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 } }] };
    expect(compareEvaluations(base, base)).toMatchObject({ version: 3,
      coveragePairs: [{ ids: ["a", "b"] }] });
    expect(() => compareEvaluations(base, { ...base, version: 2 })).toThrow();
    expect(() => compareEvaluations(base, { ...base, corpus: { ...base.corpus,
      fingerprint: "b".repeat(64) } })).toThrow("REPORT_MISMATCH");
    const invalid = structuredClone(base);
    invalid.segments[0]!.sources[0]!.coveredItems = 2;
    expect(() => compareEvaluations(base, invalid)).toThrow("REPORT_INVALID");
    const changed = structuredClone(base);
    changed.providers[0]!.rawReturned = 2;
    expect(compareEvaluations(base, changed).entries[0]?.delta)
      .toMatchObject({ "quality.rawReturned": 1 });
    expect(JSON.stringify(base)).not.toMatch(/PRIVATE|example\.org|magnet:/);
  });
});
