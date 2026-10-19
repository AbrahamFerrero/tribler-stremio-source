import { readFileSync } from "node:fs";

const SAFE_ID = /^[A-Za-z0-9_.-]{1,512}$/;
const HEX = /^[0-9a-f]{64}$/;
export const EVALUATION_REPORT_MAX_BYTES = 32_000_000;
const SEGMENT_ID = /^(all|movie|series|anime|mainstream|long-tail|(movie|series|anime)\/(mainstream|long-tail)|anime\/(movie|episode)|(anime)\/(mainstream|long-tail)\/(movie|episode))$/;
type Row = Record<string, unknown>;
interface Report {
  kind: "stremio" | "kodi";
  version: 2 | 3;
  evaluatedItems: number;
  corpus: { id: string; version: 1; fingerprint: string };
  providers?: Row[];
  sources?: Row[];
  segments: Row[];
  cost: Row[];
}
function object(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("REPORT_INVALID");
  return value as Row;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("REPORT_INVALID");
  return Number(value);
}
function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error("REPORT_INVALID");
  return value;
}
function validate(value: unknown): Report {
  const row = object(value);
  if ((row.kind !== "stremio" && row.kind !== "kodi") || (row.version !== 2 && row.version !== 3)
    || !Array.isArray(row.segments) || !Array.isArray(row.cost)) throw new Error("REPORT_INVALID");
  if (count(row.evaluatedItems) > 100) throw new Error("REPORT_INVALID");
  const corpus = object(row.corpus);
  if (!SAFE_ID.test(safeId(corpus.id)) || corpus.version !== 1
    || typeof corpus.fingerprint !== "string" || !HEX.test(corpus.fingerprint)) throw new Error("REPORT_INVALID");
  const roster = row.kind === "stremio" ? row.providers : row.sources;
  if (!Array.isArray(roster) || roster.length > 512 || row.segments.length > 18
    || row.cost.length > 512) throw new Error("REPORT_INVALID");
  const known = new Set<string>();
  for (const entry of roster) {
    const item = object(entry);
    const id = row.kind === "stremio" ? safeId(item.id)
      : safeId(item.profileId) + "/" + safeId(item.sourceId);
    if (row.version === 3 && row.kind === "kodi" && item.id !== "kodi-" + known.size) throw new Error("REPORT_INVALID");
    if (known.has(id)) throw new Error("REPORT_INVALID");
    known.add(id);
    count(row.kind === "stremio" ? item.rawDirect : item.returned);
    if (row.version === 3) requireMetrics(item, row.kind === "stremio" ? STREMIO_REQUIRED : KODI_REQUIRED);
    validateMetrics(item, QUALITY_METRICS);
  }
  const knownSourceIds = row.kind === "stremio" ? known
    : new Set((roster as Row[]).map((entry) => safeId(object(entry).id)));
  const segmentIds = new Set<string>();
  for (const entry of row.segments) {
    const segment = object(entry);
    if (typeof segment.id !== "string" || !SEGMENT_ID.test(segment.id)
      || segmentIds.has(segment.id)) throw new Error("REPORT_INVALID");
    segmentIds.add(segment.id);
    count(segment.evaluatedItems);
    if (!Array.isArray(segment.sources) || segment.sources.length > 512
      || (row.version === 3 && segment.sources.length !== roster.length)
      || !Array.isArray(segment.pairs) || segment.pairs.length > 3000
      || (row.version === 3 && (!Array.isArray(segment.coveragePairs)
        || segment.coveragePairs.length > roster.length * (roster.length - 1) / 2)))
      throw new Error("REPORT_INVALID");
    const sourceIds = new Set<string>();
    for (const source of segment.sources) {
      const sourceRow = object(source);
      const sourceId = safeId(sourceRow.id);
      if (sourceIds.has(sourceId)) throw new Error("REPORT_INVALID");
      sourceIds.add(sourceId);
      if (row.version === 3) requireMetrics(sourceRow, DIVERSITY_METRICS);
      if (row.version === 3 && (count(sourceRow.coveredItems) > count(segment.evaluatedItems)
        || count(sourceRow.soleCoveredItems) > count(sourceRow.coveredItems)
        || count(sourceRow.eligibleItems) > count(sourceRow.coveredItems)
        || count(sourceRow.soleEligibleItems) > count(sourceRow.eligibleItems)
        || count(sourceRow.admittedItems) > count(sourceRow.coveredItems)
        || count(sourceRow.finalOwnedItems) > count(sourceRow.admittedItems)
        || count(sourceRow.soleFinalOwnedItems) > count(sourceRow.finalOwnedItems)
        || count(sourceRow.finalWinnerItems) > count(sourceRow.finalOwnedItems)
        || count(sourceRow.torrentPositiveSeedsExclusive) > count(sourceRow.torrentPositiveSeeds)
        || count(sourceRow.torrentZeroSeedsExclusive) > count(sourceRow.torrentZeroSeeds)
        || count(sourceRow.torrentUnknownSeedsExclusive) > count(sourceRow.torrentUnknownSeeds)
        || count(sourceRow.torrentPositiveSeedsExclusive) + count(sourceRow.torrentZeroSeedsExclusive)
          + count(sourceRow.torrentUnknownSeedsExclusive) > count(sourceRow.exclusive)))
        throw new Error("REPORT_INVALID");
      validateMetrics(sourceRow, DIVERSITY_METRICS);
    }
    if (row.version === 3 && (sourceIds.size !== roster.length
      || [...sourceIds].some((id) => !knownSourceIds.has(id))))
      throw new Error("REPORT_INVALID");
    const sources = new Map((segment.sources as Row[]).map((entry) => {
      const source = object(entry); return [safeId(source.id), source];
    }));
    if (row.version === 3) {
      validatePairs(segment.pairs, sources, PAIR_METRICS, "distinct", "");
      validatePairs(segment.coveragePairs as unknown[], sources, COVERAGE_PAIR_METRICS, "coveredItems", "final");
      const coverage = segment.coveragePairs as Row[];
      const summary = object(segment.coveragePairSummary);
      const positive = coverage.filter((pair) => count(object(pair).intersection) > 0).length;
      if (count(summary.totalOverlappingPairs) !== positive
        || count(summary.emittedPairs) !== coverage.length || summary.truncated !== false
        || (row.kind === "kodi" && positive !== coverage.length)
        || (row.kind === "stremio" && coverage.length !== roster.length * (roster.length - 1) / 2))
        throw new Error("REPORT_INVALID");
    } else for (const pair of segment.pairs) {
      const pairRow = object(pair), a = safeId(pairRow.a), b = safeId(pairRow.b);
      if (a === b) throw new Error("REPORT_INVALID");
      count(pairRow.intersection); validateMetrics(pairRow, PAIR_METRICS);
    }
  }
  if (!segmentIds.has("all")) throw new Error("REPORT_INVALID");
  const costIds = new Set<string>();
  if (row.version === 3 && row.cost.length !== roster.length) throw new Error("REPORT_INVALID");
  for (const entry of row.cost) {
    const cost = object(entry);
    if (row.version === 3) requireMetrics(cost, COST_METRICS);
    if (row.kind === "kodi") {
      safeId(cost.profileId); safeId(cost.sourceId);
    } else safeId(cost.id);
    if (row.version === 3) {
      const id = row.kind === "stremio" ? safeId(cost.id)
        : safeId(cost.profileId) + "/" + safeId(cost.sourceId);
      if (!known.has(id) || costIds.has(id)) throw new Error("REPORT_INVALID");
      costIds.add(id);
      if (cost.latency === undefined) throw new Error("REPORT_INVALID");
      requireMetrics(object(cost.latency), LATENCY_METRICS);
    }
    validateMetrics(cost, COST_METRICS);
    if (cost.latency !== undefined) validateMetrics(object(cost.latency), LATENCY_METRICS);
  }
  return row as unknown as Report;
}
export function readEvaluationReport(path: string): Report {
  const raw = readFileSync(path);
  if (raw.length > EVALUATION_REPORT_MAX_BYTES) throw new Error("REPORT_INVALID");
  return validate(JSON.parse(raw.toString("utf8")) as unknown);
}
function rosterKey(report: Report, row: Row): string {
  return report.kind === "stremio" ? safeId(row.id)
    : safeId(row.profileId) + "/" + safeId(row.sourceId);
}
function mapping(report: Report): Map<string, string> {
  if (report.kind === "stremio") return new Map((report.providers ?? []).map((row) =>
    [safeId(row.id), safeId(row.id)]));
  return new Map((report.sources ?? []).map((row, index) =>
    [report.version === 3 ? safeId(row.id) : "kodi-" + index, rosterKey(report, row)]));
}
const QUALITY_METRICS = new Set([
  "rawReturned", "rawDirect", "qualifiedDirect", "dedupedDirect", "selectedTurns", "networkStarts",
  "verified", "uncertain", "deterministicRejects", "budgetExhausted", "admittedDirect",
  "finalDirect", "contributingItems", "deterministicRejectRate", "verifiedYield",
  "admittedYield", "finalYield", "contributingShare",
  "returned", "direct", "torrent", "positiveSeeds", "unknownSeeds", "zeroSeeds",
  "zeroSeedWouldDrop", "distinct", "shared", "exclusive", "sourceErrors",
  "evalTurns", "evalNet", "evalVerified", "evalUncertain", "evalReject", "evalBudget",
  "evalAdmit", "evalFinal", "evalItems",
  "returnedItems", "directItems", "positiveSeedTorrentItems", "zeroSeedTorrentItems",
  "unknownSeedTorrentItems", "noPositiveSeedTorrentItems"
]);
const DIVERSITY_METRICS = new Set([
  "distinct", "shared", "exclusive", "overlapShare", "exclusiveShare",
  "admittedOwned", "admittedExclusive", "finalWinner", "finalOwned", "finalExclusive",
  "verifiedDirectOwned", "uncertainDirectOwned", "budgetExhaustedDirectOwned", "deterministicRejects",
  "torrentPositiveSeeds", "torrentUnknownSeeds", "torrentZeroSeeds",
  "torrentPositiveSeedsExclusive", "torrentUnknownSeedsExclusive", "torrentZeroSeedsExclusive",
  "coveredItems", "soleCoveredItems", "eligibleItems", "soleEligibleItems",
  "admittedItems", "finalOwnedItems",
  "soleFinalOwnedItems", "finalWinnerItems"
]);
const STREMIO_REQUIRED = new Set(["rawReturned", "rawDirect"]);
const KODI_REQUIRED = new Set(["returned", "sourceErrors", "returnedItems", "directItems",
  "positiveSeedTorrentItems", "zeroSeedTorrentItems", "unknownSeedTorrentItems",
  "noPositiveSeedTorrentItems"]);
const COVERAGE_PAIR_METRICS = new Set(["intersection", "union", "jaccard",
  "aCoveredByB", "bCoveredByA", "eligibleIntersection", "eligibleUnion",
  "eligibleJaccard", "aEligibleCoveredByB", "bEligibleCoveredByA",
  "finalIntersection", "finalUnion",
  "finalJaccard", "aFinalCoveredByB", "bFinalCoveredByA"]);
const COST_METRICS = new Set(["evaluations", "requests", "responses", "errors"]);
const LATENCY_METRICS = new Set(["count", "totalMs", "meanMs", "p50Ms", "p95Ms", "maxMs"]);
const PAIR_METRICS = new Set(["intersection", "union", "jaccard", "aCoveredByB", "bCoveredByA",
  "admittedIntersection", "finalOwnedIntersection"]);
function requireMetrics(row: Row, required: ReadonlySet<string>): void {
  for (const key of required) if (!(key in row)) throw new Error("REPORT_INVALID");
}
function validatePairs(entries: unknown[], sources: Map<string, Row>,
  fields: ReadonlySet<string>, denominator: string, finalPrefix: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const pair = object(entry), a = safeId(pair.a), b = safeId(pair.b);
    const left = sources.get(a), right = sources.get(b);
    if (!left || !right || a >= b || seen.has(a + "\0" + b)) throw new Error("REPORT_INVALID");
    seen.add(a + "\0" + b);
    requireMetrics(pair, fields); validateMetrics(pair, fields);
    const intersection = count(pair.intersection), union = count(pair.union);
    const aCount = count(left[denominator]), bCount = count(right[denominator]);
    if (intersection > aCount || intersection > bCount || union !== aCount + bCount - intersection)
      throw new Error("REPORT_INVALID");
    for (const key of ["jaccard", "aCoveredByB", "bCoveredByA"])
      if (Number(pair[key]) > 1) throw new Error("REPORT_INVALID");
    if (fields === COVERAGE_PAIR_METRICS) {
      const eligibleIntersection = count(pair.eligibleIntersection);
      const aEligible = count(left.eligibleItems), bEligible = count(right.eligibleItems);
      if (eligibleIntersection > intersection
        || eligibleIntersection > aEligible || eligibleIntersection > bEligible
        || count(pair.eligibleUnion) !== aEligible + bEligible - eligibleIntersection)
        throw new Error("REPORT_INVALID");
      for (const key of ["eligibleJaccard", "aEligibleCoveredByB", "bEligibleCoveredByA"])
        if (Number(pair[key]) > 1) throw new Error("REPORT_INVALID");
    }
    if (finalPrefix) {
      const finalIntersection = count(pair.finalIntersection);
      const aFinal = count(left.finalOwnedItems), bFinal = count(right.finalOwnedItems);
      if (finalIntersection > aFinal || finalIntersection > bFinal
        || count(pair.finalUnion) !== aFinal + bFinal - finalIntersection) throw new Error("REPORT_INVALID");
      for (const key of ["finalJaccard", "aFinalCoveredByB", "bFinalCoveredByA"])
        if (Number(pair[key]) > 1) throw new Error("REPORT_INVALID");
    }
  }
}
const RATIOS = new Set(["overlapShare", "exclusiveShare", "jaccard", "aCoveredByB",
  "bCoveredByA", "eligibleJaccard", "aEligibleCoveredByB", "bEligibleCoveredByA", "finalJaccard", "aFinalCoveredByB", "bFinalCoveredByA",
  "deterministicRejectRate", "verifiedYield", "admittedYield", "finalYield", "contributingShare"]);
function validateMetrics(row: Row, allowed: ReadonlySet<string>): void {
  for (const key of allowed) {
    if (!(key in row)) continue;
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0
      || (RATIOS.has(key) && value > 1)
      || (!RATIOS.has(key) && allowed !== LATENCY_METRICS && !Number.isSafeInteger(value))
      || (allowed === LATENCY_METRICS && key === "count" && !Number.isSafeInteger(value)))
      throw new Error("REPORT_INVALID");
  }
}

function metrics(value: Row, prefix: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const allowed = prefix === "quality." ? QUALITY_METRICS : prefix === "diversity." ? DIVERSITY_METRICS
      : prefix === "cost." ? COST_METRICS : prefix === "cost.latency." ? LATENCY_METRICS
        : prefix === "coverage." ? COVERAGE_PAIR_METRICS : PAIR_METRICS;
    if (allowed.has(key) && typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
      result[prefix + key] = entry;
    else if (key === "latency" && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      Object.assign(result, metrics(entry as Row, prefix + "latency."));
    }
  }
  return result;
}
function rows(report: Report): Map<string, Record<string, number>> {
  const roster = report.kind === "stremio" ? report.providers! : report.sources!;
  const results = new Map<string, Record<string, number>>();
  const ids = mapping(report);
  for (const row of roster) results.set(rosterKey(report, row), metrics(row, "quality."));
  const all = report.segments.find((segment) => segment.id === "all");
  if (!all) throw new Error("REPORT_INVALID");
  for (const source of all.sources as Row[]) {
    const id = ids.get(safeId(source.id));
    if (id && results.has(id)) Object.assign(results.get(id)!, metrics(source, "diversity."));
  }
  for (const cost of report.cost) {
    const id = report.kind === "stremio" ? safeId(cost.id) : rosterKey(report, cost);
    if (results.has(id)) Object.assign(results.get(id)!, metrics(cost, "cost."));
  }
  return results;
}
function pairRows(report: Report, segmentId = "all", coverage = false): Map<string, Record<string, number>> {
  const ids = mapping(report);
  const segment = report.segments.find((entry) => entry.id === segmentId);
  if (!segment) throw new Error("REPORT_INVALID");
  const result = new Map<string, Record<string, number>>();
  for (const pair of (coverage ? segment.coveragePairs ?? [] : segment.pairs) as Row[]) {
    const a = ids.get(safeId(pair.a)), b = ids.get(safeId(pair.b));
    if (a && b) {
      const counts = metrics(pair, coverage ? "coverage." : "");
      if (a > b) {
        const prefix = coverage ? "coverage." : "";
        const covered = counts[prefix + "aCoveredByB"];
        counts[prefix + "aCoveredByB"] = counts[prefix + "bCoveredByA"] ?? 0;
        counts[prefix + "bCoveredByA"] = covered ?? 0;
        if (coverage) {
          const eligibleCovered = counts["coverage.aEligibleCoveredByB"];
          counts["coverage.aEligibleCoveredByB"] = counts["coverage.bEligibleCoveredByA"] ?? 0;
          counts["coverage.bEligibleCoveredByA"] = eligibleCovered ?? 0;
          const finalCovered = counts["coverage.aFinalCoveredByB"];
          counts["coverage.aFinalCoveredByB"] = counts["coverage.bFinalCoveredByA"] ?? 0;
          counts["coverage.bFinalCoveredByA"] = finalCovered ?? 0;
        }
      }
      result.set([a, b].sort().join("|"), counts);
    }
  }
  return result;
}
function segmentRows(report: Report, segmentId: string): Map<string, Record<string, number>> {
  const segment = report.segments.find((entry) => entry.id === segmentId);
  if (!segment) throw new Error("REPORT_INVALID");
  const ids = mapping(report);
  const result = new Map<string, Record<string, number>>();
  for (const source of segment.sources as Row[]) {
    const id = ids.get(safeId(source.id));
    if (id) result.set(id, metrics(source, "diversity."));
  }
  return result;
}
function delta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(Object.keys(before).filter((key) => key in after).sort().map((key) =>
    [key, Number((after[key]! - before[key]!).toFixed(4))]));
}
export function compareEvaluations(baseline: unknown, candidate: unknown) {
  const before = validate(baseline), after = validate(candidate);
  if (before.version !== after.version || before.kind !== after.kind || before.corpus.id !== after.corpus.id
    || before.corpus.version !== after.corpus.version
    || before.corpus.fingerprint !== after.corpus.fingerprint) throw new Error("REPORT_MISMATCH");
  const left = rows(before), right = rows(after);
  const baselinePairs = pairRows(before), candidatePairs = pairRows(after);
  const baselineCoverage = pairRows(before, "all", true), candidateCoverage = pairRows(after, "all", true);
  return {
    kind: before.kind, version: before.version, corpus: before.corpus,
    added: [...right.keys()].filter((id) => !left.has(id)).sort(),
    removed: [...left.keys()].filter((id) => !right.has(id)).sort(),
    entries: [...left.keys()].filter((id) => right.has(id)).sort().map((id) =>
      ({ id, delta: delta(left.get(id)!, right.get(id)!) })),
    pairs: [...baselinePairs.keys()].filter((id) => candidatePairs.has(id)).sort().map((id) =>
      ({ ids: id.split("|"), delta: delta(baselinePairs.get(id)!, candidatePairs.get(id)!) })),
    coveragePairs: [...baselineCoverage.keys()].filter((id) => candidateCoverage.has(id)).sort().map((id) =>
      ({ ids: id.split("|"), delta: delta(baselineCoverage.get(id)!, candidateCoverage.get(id)!) })),
    segments: before.segments.map((segment) => segment.id as string)
      .filter((id) => after.segments.some((candidateSegment) => candidateSegment.id === id))
      .map((id) => {
        const leftRows = segmentRows(before, id), rightRows = segmentRows(after, id);
        const leftPairs = pairRows(before, id), rightPairs = pairRows(after, id);
        const leftCoverage = pairRows(before, id, true), rightCoverage = pairRows(after, id, true);
        return { id,
          entries: [...leftRows.keys()].filter((key) => rightRows.has(key)).sort().map((key) =>
            ({ id: key, delta: delta(leftRows.get(key)!, rightRows.get(key)!) })),
          pairs: [...leftPairs.keys()].filter((key) => rightPairs.has(key)).sort().map((key) =>
            ({ ids: key.split("|"), delta: delta(leftPairs.get(key)!, rightPairs.get(key)!) })),
          coveragePairs: [...leftCoverage.keys()].filter((key) => rightCoverage.has(key)).sort().map((key) =>
            ({ ids: key.split("|"), delta: delta(leftCoverage.get(key)!, rightCoverage.get(key)!) }))
        };
      })
  };
}

function formatDeltas(delta: Record<string, number>): string {
  const changes = Object.entries(delta).filter(([, value]) => value !== 0);
  return changes.length ? changes.map(([name, value]) =>
    name + " " + (value > 0 ? "+" : "") + value).join(", ") : "no numeric change";
}

export function formatEvaluationComparison(report: ReturnType<typeof compareEvaluations>): string {
  const changed = (delta: Record<string, number>): boolean => Object.values(delta).some((value) => value !== 0);
  const lines = [
    "Evaluator: " + report.kind,
    "Corpus: " + report.corpus.id + " v" + report.corpus.version + " (" + report.corpus.fingerprint + ")",
    "Added: " + (report.added.join(", ") || "none"),
    "Removed: " + (report.removed.join(", ") || "none"),
    "Overall deltas:"
  ];
  const overall = [
    ...report.entries.filter((entry) => changed(entry.delta))
      .map((entry) => "  " + entry.id + ": " + formatDeltas(entry.delta)),
    ...report.coveragePairs.filter((pair) => changed(pair.delta))
      .map((pair) => "  coverage pair " + pair.ids.join(" / ") + ": " + formatDeltas(pair.delta)),
    ...report.pairs.filter((pair) => changed(pair.delta))
      .map((pair) => "  pair " + pair.ids.join(" / ") + ": " + formatDeltas(pair.delta))
  ];
  lines.push(...(overall.length ? overall : ["  none"]), "Segment deltas:");
  let changedSegments = 0;
  for (const segment of report.segments) {
    const entries = segment.entries.filter((entry) => changed(entry.delta));
    const pairs = segment.pairs.filter((pair) => changed(pair.delta));
    const coveragePairs = segment.coveragePairs.filter((pair) => changed(pair.delta));
    if (!entries.length && !pairs.length && !coveragePairs.length) continue;
    changedSegments += 1;
    lines.push("  " + segment.id + ":");
    for (const entry of entries) lines.push("    " + entry.id + ": " + formatDeltas(entry.delta));
    for (const pair of pairs)
      lines.push("    pair " + pair.ids.join(" / ") + ": " + formatDeltas(pair.delta));
    for (const pair of coveragePairs)
      lines.push("    coverage pair " + pair.ids.join(" / ") + ": " + formatDeltas(pair.delta));
  }
  if (!changedSegments) lines.push("  none");
  return lines.join("\n");
}
