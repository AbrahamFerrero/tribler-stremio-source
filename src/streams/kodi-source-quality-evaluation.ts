import { ProviderQualityEvaluation } from "./provider-quality-evaluation";
import { EvaluationCost } from "./evaluation-cost";
import { SourceDiversityEvaluation, composeResolverTraces } from "./source-diversity-evaluation";
import type { NormalizedStreamSource } from "./types";

export interface KodiSourceBatch {
  profileId: string;
  sourceId: string;
  status: "ok" | "error";
  elapsedMs: number;
  candidates: NormalizedStreamSource[];
  counts: {
    returned: number; direct: number; torrent: number;
    positiveSeeds: number; unknownSeeds: number; zeroSeeds: number; zeroSeedWouldDrop: number;
    distinct: number; exclusive: number; shared: number;
  };
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,512}$/;
const FIELDS = ["returned", "direct", "torrent", "positiveSeeds", "unknownSeeds", "zeroSeeds",
  "zeroSeedWouldDrop", "distinct", "exclusive", "shared"] as const;
type Counts = KodiSourceBatch["counts"];

export function validateBatches(value: unknown): KodiSourceBatch[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid child response");
  const payload = value as Record<string, unknown>;
  if (payload.ok !== true || !Array.isArray(payload.sources) || payload.sources.length > 512) {
    throw new Error("invalid child response");
  }
  const seen = new Set<string>();
  return payload.sources.map((entry): KodiSourceBatch => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("invalid child source");
    const row = entry as Record<string, unknown>;
    if (typeof row.profileId !== "string" || !SAFE_ID.test(row.profileId)
      || typeof row.sourceId !== "string" || !SAFE_ID.test(row.sourceId)
      || (row.status !== "ok" && row.status !== "error")
      || typeof row.elapsedMs !== "number" || !Number.isFinite(row.elapsedMs)
      || row.elapsedMs < 0 || row.elapsedMs > 600_000
      || !Array.isArray(row.candidates) || row.candidates.length > 100
      || typeof row.counts !== "object" || row.counts === null || Array.isArray(row.counts)) {
      throw new Error("invalid child source");
    }
    const key = `${row.profileId}\0${row.sourceId}`;
    if (seen.has(key)) throw new Error("duplicate child source");
    seen.add(key);
    const raw = row.counts as Record<string, unknown>;
    for (const field of FIELDS) {
      if (!Number.isSafeInteger(raw[field]) || Number(raw[field]) < 0) throw new Error("invalid child counts");
    }
    // Candidate payload stays inside the evaluator and is never copied to a report.
    return { profileId: row.profileId, sourceId: row.sourceId, status: row.status,
      elapsedMs: row.elapsedMs,
      candidates: row.candidates as NormalizedStreamSource[], counts: raw as Counts };
  });
}

export class KodiSourceQualityEvaluation {
  private readonly quality: ProviderQualityEvaluation;
  private readonly diversity: SourceDiversityEvaluation;
  private readonly cost: EvaluationCost;
  private readonly totals: Counts[];
  private readonly keys: string[];
  private items = 0;
  private readonly errors: number[];
  private readonly itemHealth: Record<string, number>[];

  constructor(readonly roster: readonly Pick<KodiSourceBatch, "profileId" | "sourceId">[]) {
    this.keys = roster.map((row) => `${row.profileId}\0${row.sourceId}`);
    if (new Set(this.keys).size !== this.keys.length) throw new Error("duplicate source");
    const ids = roster.map((_, index) => "kodi-" + index);
    this.diversity = new SourceDiversityEvaluation(ids, 5);
    this.cost = new EvaluationCost(ids);
    this.quality = new ProviderQualityEvaluation(roster.map((_, index) => ({
      id: `kodi-${index}`, name: `kodi-${index}`
    })));
    this.totals = roster.map(() => Object.fromEntries(FIELDS.map((field) => [field, 0])) as Counts);
    this.errors = roster.map(() => 0);
    this.itemHealth = roster.map(() => ({ returnedItems: 0, directItems: 0,
      positiveSeedTorrentItems: 0, zeroSeedTorrentItems: 0, unknownSeedTorrentItems: 0,
      noPositiveSeedTorrentItems: 0 }));
  }

  async evaluateItem(
    batches: readonly KodiSourceBatch[],
    resolve: (providers: readonly { id: string; candidates: NormalizedStreamSource[] }[],
      trace: ReturnType<ProviderQualityEvaluation["itemTrace"]>) => Promise<void>,
    segments: readonly string[] = ["all"]
  ): Promise<void> {
    if (batches.length !== this.roster.length
      || batches.some((row, index) => `${row.profileId}\0${row.sourceId}` !== this.keys[index])) {
      throw new Error("source roster changed");
    }
    const providers = batches.map((batch, index) => {
      for (const field of FIELDS) this.totals[index]![field] += batch.counts[field];
      // These are adapter-normalized, per-source batch observations, not raw worker results.
      const health = this.itemHealth[index]!;
      if (batch.counts.returned > 0) health.returnedItems! += 1;
      if (batch.counts.direct > 0) health.directItems! += 1;
      if (batch.counts.positiveSeeds > 0) health.positiveSeedTorrentItems! += 1;
      if (batch.counts.zeroSeeds > 0) health.zeroSeedTorrentItems! += 1;
      if (batch.counts.unknownSeeds > 0) health.unknownSeedTorrentItems! += 1;
      if (batch.counts.torrent > 0 && batch.counts.positiveSeeds === 0)
        health.noPositiveSeedTorrentItems! += 1;
      if (batch.status === "error") this.errors[index]! += 1;
      this.cost.evaluation("kodi-" + index, batch.status, batch.elapsedMs);
      const id = `kodi-${index}`;
      this.quality.rawStreams(id, batch.candidates);
      return { id, candidates: batch.candidates.map((candidate) => ({ ...candidate, providerId: id })) };
    });
    const trace = this.quality.itemTrace();
    const observation = this.diversity.item(segments);
    await resolve(providers, composeResolverTraces(trace, observation.trace));
    this.quality.finishItem(trace);
    observation.finish();
    this.items += 1;
  }

  report() {
    const quality = this.quality.report().providers;
    return {
      version: 3,
      kind: "kodi",
      evaluatedItems: this.items,
      definitions: {
        structural: "Per-item Python deduplication keys retain every source as an owner; counts sum across items.",
        evaluation: "Synthetic providers use StreamResolver and DirectStreamProbe; these are not normal external_http scheduling or production attribution.",
        duplicateAttribution: "Structural shared counts credit all sources; the evaluation funnel credits its deterministic deduplication winner.",
        seeds: "Seed categories and item-health counters describe D2a adapter-normalized batches; zeroSeedWouldDrop uses the current Python registry predicate. Raw invalid and earlier dropped results are unavailable."
      },
      segments: this.diversity.report(),
      cost: this.cost.report().map((row, index) => ({ ...this.roster[index], ...row })),
      sources: this.roster.map((source, index) => {
        const q = quality[index]!;
        return { id: `kodi-${index}`, ...source, ...this.totals[index], ...this.itemHealth[index],
          sourceErrors: this.errors[index], rawReturned: q.rawReturned, rawDirect: q.rawDirect,
          qualifiedDirect: q.qualifiedDirect, dedupedDirect: q.dedupedDirect,
          evalTurns: q.selectedTurns, evalNet: q.networkStarts,
          evalVerified: q.verified, evalUncertain: q.uncertain,
          evalReject: q.deterministicRejects, evalBudget: q.budgetExhausted,
          evalAdmit: q.admittedDirect, evalFinal: q.finalDirect,
          evalItems: q.contributingItems,
          deterministicRejectRate: q.deterministicRejectRate,
          verifiedYield: q.verifiedYield, admittedYield: q.admittedYield,
          finalYield: q.finalYield, contributingShare: q.contributingShare };
      })
    };
  }
}

export function formatKodiSourceQualityTable(report: ReturnType<KodiSourceQualityEvaluation["report"]>): string {
  const headers = ["Profile", "Source", "Cand", "Direct", "Torrent", "Seed+", "Seed?", "Seed0", "Drop0",
    "Exclusive", "Shared", "Errors", "EvalTurns", "V", "U", "R", "Budget", "Admit", "Final", "Items"];
  const rows = report.sources.map((row) => [row.profileId, row.sourceId, row.returned, row.direct,
    row.torrent, row.positiveSeeds, row.unknownSeeds, row.zeroSeeds, row.zeroSeedWouldDrop, row.exclusive, row.shared,
    row.sourceErrors, row.evalTurns, row.evalVerified, row.evalUncertain, row.evalReject, row.evalBudget,
    row.evalAdmit, row.evalFinal, `${row.evalItems}/${report.evaluatedItems}`].map(String));
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  return [headers, ...rows].map((row) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd()).join("\n");
}
