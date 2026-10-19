import type { AppConfig } from "../src/types";
import type { OutboundTransport } from "../src/network/outbound-transport";
import type { ExternalUrlPolicy } from "../src/network/url-policy";
import type { MovieMetadataLookup } from "../src/metadata/movie-metadata";
import type { NormalizedMediaItem, StreamProvider } from "../src/streams/types";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { Logger } from "../src/logger";
import { RejectedSourceReview } from "../src/qa/rejected-source-review";
import { IdentityDiagnostics, type IdentityDiagnosticReport } from "../src/qa/identity-diagnostics";
import { providerFamily, type ProviderFamily } from "../src/qa/identity-diagnostics";
import type { EvaluationCorpus, EvaluationCase } from "./evaluation-corpus";

export type SmokeMode = "QUICK" | "FULL";
export const SMOKE_LIMITS = { QUICK: { deadlineMs: 90_000, slots: 4 }, FULL: { deadlineMs: 180_000, slots: 8 } } as const;

export function parseSmokeArgs(args: readonly string[]): { corpusPath: string; mode: SmokeMode; json: boolean } {
  let corpusPath: string | undefined;
  let mode: SmokeMode | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--corpus" && corpusPath === undefined) {
      const path = args[++index];
      if (!path || path.startsWith("--")) throw new Error("Corpus path required");
      corpusPath = path;
    } else if ((arg === "--quick" || arg === "--full") && mode === undefined) {
      mode = arg === "--full" ? "FULL" : "QUICK";
    } else if (arg === "--json" && !json) json = true;
    else throw new Error("Invalid arguments");
  }
  if (corpusPath === undefined) throw new Error("Corpus path required");
  return { corpusPath, mode: mode ?? "QUICK", json };
}

export async function withinSmokeDeadline<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Smoke deadline reached");
  let aborted = (): void => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(new Error("Smoke deadline reached"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try { return await Promise.race([action(), deadline]); }
  finally { signal.removeEventListener("abort", aborted); }
}

export function smokeCases(corpus: EvaluationCorpus, mode: SmokeMode): EvaluationCase[] {
  const cohorts = [...new Set(corpus.cases.map(entry => `${entry.mediaClass}/${entry.cohort}`))].sort();
  const groups = cohorts.map(cohort => corpus.cases.filter(entry => `${entry.mediaClass}/${entry.cohort}` === cohort)
    .sort((a, b) => a.id.localeCompare(b.id)));
  const selected: EvaluationCase[] = [];
  const limit = mode === "QUICK" ? Math.min(12, corpus.cases.length) : corpus.cases.length;
  // Round-robin populated cohorts, then sorted case IDs; no dependency on corpus identity or input order.
  for (let round = 0; selected.length < limit; round += 1) {
    for (const group of groups) {
      if (group[round] && selected.length < limit) selected.push(group[round]!);
    }
  }
  return selected;
}

export function rotateProviders(providers: readonly StreamProvider[], index: number): StreamProvider[] {
  const enabled = providers.filter(provider => provider.isEnabled()).sort((a, b) => a.id.localeCompare(b.id));
  const families = [...new Set(enabled.map(provider => providerFamily(provider.id)))].sort();
  const groups = families.map((_, offset) => enabled.filter(provider =>
    providerFamily(provider.id) === families[(index + offset) % families.length]));
  const chosen: StreamProvider[] = [];
  const limit = Math.min(4, enabled.length);
  // Each family gets a turn before any family gets another slot. Rotate both family and member order.
  for (let round = 0; chosen.length < limit; round += 1) {
    for (const group of groups) {
      if (round < group.length && chosen.length < limit) chosen.push(group[(index + round) % group.length]!);
    }
  }
  return chosen;
}

export function providerCounts(providers: readonly StreamProvider[]): Record<ProviderFamily, number> {
  const counts = { external_http: 0, stremio_addon: 0, catalog: 0, local_json: 0, other: 0 };
  for (const provider of new Map(providers.filter(provider => provider.isEnabled()).map(provider => [provider.id, provider])).values()) {
    counts[providerFamily(provider.id)] += 1;
  }
  return counts;
}

export async function trustedSmokeItem(item: NormalizedMediaItem, metadata: MovieMetadataLookup): Promise<NormalizedMediaItem> {
  const { runtimeSeconds: ignored, ...base } = item;
  void ignored;
  if (base.kind !== "movie" || !base.externalIds.imdb) return base;
  const trusted = await metadata.lookup(base.externalIds.imdb);
  return { ...base, ...(trusted ?? {}) }; // Series-wide duration is never requested or substituted.
}

export interface SmokeRow {
  caseId: string;
  cohort: string;
  status: "completed" | "timed_out" | "failed" | "not_executed";
  elapsedMs: number;
  diagnostics: IdentityDiagnosticReport | null;
}

export async function sampleSmokeCase(entry: EvaluationCase, item: NormalizedMediaItem, providers: readonly StreamProvider[],
  config: AppConfig, policy: ExternalUrlPolicy, transport: OutboundTransport, log: Logger, signal: AbortSignal,
  mode: SmokeMode, mediaRequests: () => number = () => 0, sharedProbe?: DirectStreamProbe): Promise<SmokeRow> {
  const start = Date.now();
  const before = mediaRequests();
  const review = new RejectedSourceReview(transport, item);
  const diagnostic = new IdentityDiagnostics(item, review);
  const registry = new StreamProviderRegistry(Math.min(3000, config.streamProviderTimeoutMs), log,
    Math.min(2, config.streamProviderMaxConcurrent));
  for (const provider of providers) {
    const observed = diagnostic.provider(provider);
    registry.register({ ...observed, timeoutMs: Math.min(3000, observed.timeoutMs ?? config.streamProviderTimeoutMs) });
  }
  const probe = sharedProbe ?? new DirectStreamProbe(transport, { ...config.directHttpProbe,
    maxCandidates: Math.min(SMOKE_LIMITS[mode].slots, config.directHttpProbe.maxCandidates),
    maxConcurrent: Math.min(2, config.directHttpProbe.maxConcurrent),
    timeoutMs: Math.min(mode === "QUICK" ? 1500 : 3000, config.directHttpProbe.timeoutMs) }, log);
  const resolver = new StreamResolver(registry, policy, probe, diagnostic.trace, config.streamRankingPolicy);
  const cacheBefore = probe.diagnostics().cacheHits;
  let status: SmokeRow["status"] = "completed";
  try { await withinSmokeDeadline(() => resolver.resolve(item, signal), signal); if (signal.aborted) status = "timed_out"; }
  catch { status = signal.aborted ? "timed_out" : "failed"; }
  try {
    return { caseId: entry.id, cohort: `${entry.mediaClass}/${entry.cohort}`, status, elapsedMs: Date.now() - start,
      diagnostics: diagnostic.report({ ...probe.diagnostics(), cacheHits: probe.diagnostics().cacheHits - cacheBefore }, mediaRequests() - before, registry.status()) };
  } finally { await review.close(); }
}

export function smokeTotals(rows: readonly SmokeRow[]) {
  const totals = { cases: rows.length, completed: 0, timedOut: 0, failed: 0, notExecuted: 0,
    providerCalls: 0, providerErrors: 0, providerTimeouts: 0, pendingProviderOutcomes: 0, noResults: 0, probeStarts: 0, cacheHits: 0,
    mediaHttpRequests: 0, verifiedMedia: 0, uncertainMedia: 0, failedMedia: 0, exhausted: 0, unexaminedDirect: 0,
    http: 0, https: 0, torrent: 0, mp4Runtime: 0, hlsRuntime: 0,
    measuredRejections: 0, eligibleReviews: 0, excludedReviews: 0, finalDirect: 0, runtimeAvailableCases: 0,
    stages: { provider: 0, normalized: 0, deduplicated: 0, probed: 0, admitted: 0, final: 0 },
    finalConfidence: { UNKNOWN: 0, CONTRADICTION: 0, CORROBORATED: 0, SUSPICIOUS: 0, unclassified: 0 } };
  for (const row of rows) {
    if (row.status === "completed") totals.completed += 1;
    else if (row.status === "timed_out") totals.timedOut += 1;
    else if (row.status === "failed") totals.failed += 1;
    else totals.notExecuted += 1;
    const d = row.diagnostics;
    if (!d) continue;
    totals.providerCalls += d.providers.calls; totals.providerErrors += d.providers.errors;
    totals.providerTimeouts += d.providers.timeouts; totals.noResults += d.providers.noResults;
    totals.pendingProviderOutcomes += d.pendingProviderOutcomes;
    totals.probeStarts += d.probe.starts; totals.cacheHits += d.probe.cacheHits;
    totals.mediaHttpRequests += d.probe.mediaHttpRequests; totals.verifiedMedia += d.probe.verified;
    totals.uncertainMedia += d.probe.uncertain; totals.failedMedia += d.probe.failed;
    totals.http += d.transports.http; totals.https += d.transports.https; totals.torrent += d.transports.torrent;
    totals.exhausted += d.probe.exhausted; totals.unexaminedDirect += d.probe.unexaminedDirect;
    totals.mp4Runtime += d.probe.mp4Runtime; totals.hlsRuntime += d.probe.hlsVodRuntime;
    totals.measuredRejections += d.measuredRejections; totals.eligibleReviews += d.eligibleReviews;
    totals.excludedReviews += d.measuredWithoutEligibleReview; totals.finalDirect += d.finalDirect;
    if (d.trustedRuntimeAvailable) totals.runtimeAvailableCases += 1;
    for (const stage of Object.keys(totals.stages) as Array<keyof typeof totals.stages>) totals.stages[stage] += d.stages[stage];
    for (const state of Object.keys(totals.finalConfidence) as Array<keyof typeof totals.finalConfidence>) totals.finalConfidence[state] += d.finalConfidence[state];
  }
  return totals;
}

export function smokeReport(mode: SmokeMode, rows: SmokeRow[], elapsedMs: number,
  selection?: { configuredEnabled: Record<ProviderFamily, number>; selectedDistinct: Record<ProviderFamily, number> }) {
  const families = new Map<string, { selected: number; calls: number; errors: number; timeouts: number; noResults: number }>();
  for (const row of rows) for (const entry of row.diagnostics?.families ?? []) {
    const sum = families.get(entry.family) ?? { selected: 0, calls: 0, errors: 0, timeouts: 0, noResults: 0 };
    for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += entry[key];
    families.set(entry.family, sum);
  }
  return { kind: "identity-live-observation", version: 1, mode, deadlineMs: SMOKE_LIMITS[mode].deadlineMs, elapsedMs,
    limits: { initialProbeSlotsPerCase: SMOKE_LIMITS[mode].slots, providerResolutionsPerCase: 4, providerConcurrency: 2,
      exactGlobalHttpCap: false }, totals: smokeTotals(rows),
    cohorts: [...new Set(rows.map(row => row.cohort))].sort()
      .map(cohort => ({ cohort, ...smokeTotals(rows.filter(row => row.cohort === cohort)) })),
    providerFamilies: [...families].map(([family, counts]) => ({ family, ...counts })),
    ...(selection ? { providerSelection: selection } : {}), cases: rows };
}

export function formatSmokeReport(report: ReturnType<typeof smokeReport>): string {
  const lines = ["Identity observations; no content truth inferred.", `${report.mode}: ${report.elapsedMs}/${report.deadlineMs} ms`,
    "case                         cohort             status        calls err/tmo raw/norm/dedup/probed/adm/final starts mp4/hls reject/review finalDirect"];
  for (const row of report.cases) {
    const d = row.diagnostics;
    lines.push(`${row.caseId.padEnd(28)} ${row.cohort.padEnd(18)} ${row.status.padEnd(13)} ${d ?
      `${d.providers.calls} ${d.providers.errors}/${d.providers.timeouts} ${Object.values(d.stages).join("/")} ${d.probe.starts} ${d.probe.mp4Runtime}/${d.probe.hlsVodRuntime} ${d.measuredRejections}/${d.eligibleReviews} ${d.finalDirect}` : "not sampled"}`);
    if (d) lines.push(`  http/https/torrent=${d.transports.http}/${d.transports.https}/${d.transports.torrent}; probe V/U/F/X/unexamined=${d.probe.verified}/${d.probe.uncertain}/${d.probe.failed}/${d.probe.exhausted}/${d.probe.unexaminedDirect}; cache=${d.probe.cacheHits}; confidence=${JSON.stringify(d.finalConfidence)}; observations=${d.observations.join(",")}`);
  }
  lines.push("Totals: " + JSON.stringify(report.totals));
  lines.push("cohort             completed/timedOut/failed/notExecuted calls errors/timeouts starts verified direct rejects/reviews");
  for (const cohort of report.cohorts) lines.push(`${cohort.cohort.padEnd(18)} ${cohort.completed}/${cohort.timedOut}/${cohort.failed}/${cohort.notExecuted} ${cohort.providerCalls} ${cohort.providerErrors}/${cohort.providerTimeouts} ${cohort.probeStarts} ${cohort.verifiedMedia} ${cohort.finalDirect} ${cohort.measuredRejections}/${cohort.eligibleReviews}`);
  lines.push("Provider families: " + JSON.stringify(report.providerFamilies));
  if (report.providerSelection) lines.push("Provider selection (configured is not reachable): " + JSON.stringify(report.providerSelection));
  lines.push("Probe slots/starts are not exact HTTP counts. Media HTTP attempts are counted separately; provider/metadata/manifest requests have no exact global cap.");
  return lines.join("\n");
}
