import { isDeterministicProbeRejection, type StreamResolverTrace } from "./resolver";
import { streamDeduplicationKey } from "./stream-deduplication";
import type { NormalizedStreamSource } from "./types";

export interface DiversityCounts {
  id: string;
  distinct: number; shared: number; exclusive: number;
  overlapShare: number; exclusiveShare: number;
  admittedOwned: number; admittedExclusive: number;
  finalWinner: number; finalOwned: number; finalExclusive: number;
  verifiedDirectOwned: number; uncertainDirectOwned: number; budgetExhaustedDirectOwned: number;
  deterministicRejects: number;
  torrentPositiveSeeds: number; torrentUnknownSeeds: number; torrentZeroSeeds: number;
  torrentPositiveSeedsExclusive: number; torrentUnknownSeedsExclusive: number; torrentZeroSeedsExclusive: number;
  coveredItems: number; soleCoveredItems: number; eligibleItems: number; soleEligibleItems: number; admittedItems: number;
  finalOwnedItems: number; soleFinalOwnedItems: number; finalWinnerItems: number;
}
interface PairCounts {
  a: string; b: string; intersection: number;
  admittedIntersection: number; finalOwnedIntersection: number;
}
interface CoveragePair { a: string; b: string; intersection: number; eligibleIntersection: number; finalIntersection: number }
interface Segment {
  evaluatedItems: number;
  sources: Map<string, DiversityCounts>;
  pairs: Map<string, PairCounts>;
  coveragePairs: Map<string, CoveragePair>;
}
const zero = (id: string): DiversityCounts => ({
  id, distinct: 0, shared: 0, exclusive: 0, overlapShare: 0, exclusiveShare: 0,
  admittedOwned: 0, admittedExclusive: 0, finalWinner: 0, finalOwned: 0, finalExclusive: 0,
  verifiedDirectOwned: 0, uncertainDirectOwned: 0, budgetExhaustedDirectOwned: 0,
  deterministicRejects: 0,
  torrentPositiveSeeds: 0, torrentUnknownSeeds: 0, torrentZeroSeeds: 0,
  torrentPositiveSeedsExclusive: 0, torrentUnknownSeedsExclusive: 0, torrentZeroSeedsExclusive: 0,
  coveredItems: 0, soleCoveredItems: 0, eligibleItems: 0, soleEligibleItems: 0, admittedItems: 0,
  finalOwnedItems: 0, soleFinalOwnedItems: 0, finalWinnerItems: 0
});
const ratio = (part: number, whole: number): number => whole ? Number((part / whole).toFixed(4)) : 0;
const pairKey = (a: string, b: string): string => a < b ? a + "\0" + b : b + "\0" + a;
const torrent = (source: NormalizedStreamSource): boolean =>
  source.type === "magnet" || source.type === "torrent";
const seedEvidenceRank = (source: NormalizedStreamSource): number =>
  source.seeds !== undefined && source.seeds > 0 ? 2 : source.seeds === 0 ? 1 : 0;
const direct = (source: NormalizedStreamSource): boolean =>
  source.type === "http" || source.type === "https";

export function composeResolverTraces(...traces: StreamResolverTrace[]): StreamResolverTrace {
  return {
    stage: (stage, sources, refs) => { for (const trace of traces) trace.stage(stage, sources, refs); },
    ...(traces.some(trace => trace.rejection !== undefined)
      ? { rejection: (event: Parameters<NonNullable<StreamResolverTrace["rejection"]>>[0]) => {
        for (const trace of traces) trace.rejection?.(event);
      } } : {}),
    ...(traces.some(trace => trace.preProbeIdentity !== undefined)
      ? { preProbeIdentity: (event: Parameters<NonNullable<StreamResolverTrace["preProbeIdentity"]>>[0]) => {
        for (const trace of traces) trace.preProbeIdentity?.(event);
      } } : {}),
    probeNetworkStart: (id) => { for (const trace of traces) trace.probeNetworkStart?.(id); },
    ranking: (candidates) => { for (const trace of traces) trace.ranking?.(candidates); }
  };
}

/** Counts in each item are credited to all original normalized owners, before cross-provider dedupe. */
export class SourceDiversityEvaluation {
  private readonly segments = new Map<string, Segment>();
  constructor(private readonly ids: readonly string[], private readonly maxPairsPerSource = Infinity) {
    if (new Set(ids).size !== ids.length) throw new Error("duplicate diversity source");
  }

  item(segmentIds: readonly string[]): { trace: StreamResolverTrace; finish: () => void } {
    const normalized = new Map<string, Map<string, NormalizedStreamSource>>();
    const probed = new Map<string, NormalizedStreamSource>();
    const admitted = new Set<string>();
    const final = new Map<string, string>();
    const trace: StreamResolverTrace = {
      stage: (stage, sources) => {
        if (stage === "normalized") {
          for (const source of sources) {
            const key = streamDeduplicationKey(source);
            if (!key) continue;
            let owners = normalized.get(key);
            if (!owners) { owners = new Map(); normalized.set(key, owners); }
            const previous = owners.get(source.providerId);
            if (!previous || (torrent(source) && seedEvidenceRank(source) > seedEvidenceRank(previous)))
              owners.set(source.providerId, source);
          }
        } else if (stage === "probed" || stage === "admitted" || stage === "final") {
          for (const source of sources) {
            const key = streamDeduplicationKey(source);
            if (!key) continue;
            if (stage === "probed") probed.set(key, source);
            else if (stage === "admitted") admitted.add(key);
            else final.set(key, source.providerId);
          }
        }
      }
    };
    return { trace, finish: () => {
      for (const segmentId of new Set(segmentIds)) {
        let segment = this.segments.get(segmentId);
        if (!segment) {
          segment = { evaluatedItems: 0, sources: new Map(this.ids.map((id) => [id, zero(id)])),
            pairs: new Map(), coveragePairs: new Map() };
          this.segments.set(segmentId, segment);
        }
        segment.evaluatedItems += 1;
        const covered = new Set<string>(), eligible = new Set<string>(), admittedOwners = new Set<string>();
        const finalOwners = new Set<string>(), finalWinners = new Set<string>();
        for (const [key, owners] of normalized) {
          const ownerIds = [...owners.keys()].filter((id) => segment.sources.has(id)).sort();
          if (!ownerIds.length) continue;
          const winner = probed.get(key);
          for (const id of ownerIds) {
            const row = segment.sources.get(id)!;
            covered.add(id);
            if (admitted.has(key)) admittedOwners.add(id);
            if (final.has(key)) finalOwners.add(id);
            if (final.get(key) === id) finalWinners.add(id);
            row.distinct += 1;
            if (ownerIds.length === 1) row.exclusive += 1;
            else row.shared += 1;
            if (admitted.has(key)) {
              row.admittedOwned += 1;
              if (ownerIds.length === 1) row.admittedExclusive += 1;
            }
            if (final.has(key)) {
              row.finalOwned += 1;
              if (ownerIds.length === 1) row.finalExclusive += 1;
              if (final.get(key) === id) row.finalWinner += 1;
            }
            if (winner && direct(winner) && winner.directHttp) {
              if (winner.directHttp.status === "budget_exhausted") row.budgetExhaustedDirectOwned += 1;
              else if (isDeterministicProbeRejection(winner)) row.deterministicRejects += 1;
              else if (winner.directHttp.verified) row.verifiedDirectOwned += 1;
              else row.uncertainDirectOwned += 1;
            }
            const original = owners.get(id)!;
            if ((torrent(original) && original.seeds !== 0)
              || (direct(original) && admitted.has(key))) eligible.add(id);
            if (torrent(original)) {
              if (original.seeds !== undefined && original.seeds > 0) {
                row.torrentPositiveSeeds += 1;
                if (ownerIds.length === 1) row.torrentPositiveSeedsExclusive += 1;
              } else if (original.seeds === 0) {
                row.torrentZeroSeeds += 1;
                if (ownerIds.length === 1) row.torrentZeroSeedsExclusive += 1;
              } else {
                row.torrentUnknownSeeds += 1;
                if (ownerIds.length === 1) row.torrentUnknownSeedsExclusive += 1;
              }
            }
          }
          for (let i = 0; i < ownerIds.length; i++) for (let j = i + 1; j < ownerIds.length; j++) {
            const a = ownerIds[i]!, b = ownerIds[j]!, pairId = pairKey(a, b);
            let pair = segment.pairs.get(pairId);
            if (!pair) { pair = { a, b, intersection: 0, admittedIntersection: 0, finalOwnedIntersection: 0 };
              segment.pairs.set(pairId, pair); }
            pair.intersection += 1;
            if (admitted.has(key)) pair.admittedIntersection += 1;
            if (final.has(key)) pair.finalOwnedIntersection += 1;
          }
        }
        for (const id of covered) {
          const row = segment.sources.get(id)!;
          row.coveredItems += 1;
          if (covered.size === 1) row.soleCoveredItems += 1;
          if (eligible.has(id)) {
            row.eligibleItems += 1;
            if (eligible.size === 1) row.soleEligibleItems += 1;
          }
          if (admittedOwners.has(id)) row.admittedItems += 1;
          if (finalOwners.has(id)) row.finalOwnedItems += 1;
          if (finalOwners.size === 1 && finalOwners.has(id)) row.soleFinalOwnedItems += 1;
          if (finalWinners.has(id)) row.finalWinnerItems += 1;
        }
        const coveredIds = [...covered].sort();
        for (let i = 0; i < coveredIds.length; i++) for (let j = i + 1; j < coveredIds.length; j++) {
          const a = coveredIds[i]!, b = coveredIds[j]!, id = pairKey(a, b);
          let pair = segment.coveragePairs.get(id);
          if (!pair) { pair = { a, b, intersection: 0, eligibleIntersection: 0, finalIntersection: 0 };
            segment.coveragePairs.set(id, pair); }
          pair.intersection += 1;
          if (eligible.has(a) && eligible.has(b)) pair.eligibleIntersection += 1;
          if (finalOwners.has(a) && finalOwners.has(b)) pair.finalIntersection += 1;
        }
      }
      normalized.clear(); probed.clear(); admitted.clear(); final.clear();
    } };
  }

  report() {
    return [...this.segments].map(([id, segment]) => {
      const sources = [...segment.sources.values()].map((row) => ({
        ...row, overlapShare: ratio(row.shared, row.distinct),
        exclusiveShare: ratio(row.exclusive, row.distinct)
      }));
      const sortedIds = [...this.ids].sort();
      const allPairs = this.maxPairsPerSource === Infinity
        ? sortedIds.flatMap((a, index) => sortedIds.slice(index + 1).map((b) =>
          segment.pairs.get(pairKey(a, b)) ?? { a, b, intersection: 0,
            admittedIntersection: 0, finalOwnedIntersection: 0 }))
        : [...segment.pairs.values()];
      const pairRows = allPairs.map((pair) => {
        const aDistinct = segment.sources.get(pair.a)?.distinct ?? 0;
        const bDistinct = segment.sources.get(pair.b)?.distinct ?? 0;
        const union = aDistinct + bDistinct - pair.intersection;
        return { ...pair, union, jaccard: ratio(pair.intersection, union),
          aCoveredByB: ratio(pair.intersection, aDistinct),
          bCoveredByA: ratio(pair.intersection, bDistinct) };
      }).sort((left, right) => right.intersection - left.intersection
        || left.a.localeCompare(right.a) || left.b.localeCompare(right.b));
      const quotas = new Map<string, number>();
      const pairs = pairRows.filter((pair) => {
        if ((quotas.get(pair.a) ?? 0) >= this.maxPairsPerSource
          || (quotas.get(pair.b) ?? 0) >= this.maxPairsPerSource) return false;
        quotas.set(pair.a, (quotas.get(pair.a) ?? 0) + 1);
        quotas.set(pair.b, (quotas.get(pair.b) ?? 0) + 1);
        return true;
      });
      const allCoveragePairs = this.maxPairsPerSource === Infinity
        ? sortedIds.flatMap((a, index) => sortedIds.slice(index + 1).map((b) =>
          segment.coveragePairs.get(pairKey(a, b)) ?? {
            a, b, intersection: 0, eligibleIntersection: 0, finalIntersection: 0
          }))
        : [...segment.coveragePairs.values()];
      const coverageRows = allCoveragePairs.map((pair) => {
        const a = segment.sources.get(pair.a)!, b = segment.sources.get(pair.b)!;
        const union = a.coveredItems + b.coveredItems - pair.intersection;
        const eligibleUnion = a.eligibleItems + b.eligibleItems - pair.eligibleIntersection;
        const finalUnion = a.finalOwnedItems + b.finalOwnedItems - pair.finalIntersection;
        return { ...pair, union, jaccard: ratio(pair.intersection, union),
          aCoveredByB: ratio(pair.intersection, a.coveredItems),
          bCoveredByA: ratio(pair.intersection, b.coveredItems),
          eligibleUnion, eligibleJaccard: ratio(pair.eligibleIntersection, eligibleUnion),
          aEligibleCoveredByB: ratio(pair.eligibleIntersection, a.eligibleItems),
          bEligibleCoveredByA: ratio(pair.eligibleIntersection, b.eligibleItems),
          finalUnion, finalJaccard: ratio(pair.finalIntersection, finalUnion),
          aFinalCoveredByB: ratio(pair.finalIntersection, a.finalOwnedItems),
          bFinalCoveredByA: ratio(pair.finalIntersection, b.finalOwnedItems) };
      }).sort((left, right) => right.intersection - left.intersection
        || left.a.localeCompare(right.a) || left.b.localeCompare(right.b));
      // Content co-coverage is complete even when identity pairs use a Kodi quota.
      const coveragePairs = coverageRows;
      return { id, evaluatedItems: segment.evaluatedItems, sources, pairs,
        pairSummary: { totalOverlappingPairs: segment.pairs.size, emittedPairs: pairs.length,
          truncated: pairs.length < pairRows.length }, coveragePairs,
        coveragePairSummary: { totalOverlappingPairs: segment.coveragePairs.size,
          emittedPairs: coveragePairs.length, truncated: false } };
    });
  }
}
