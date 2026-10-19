import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config";
import { createCatalogProviders } from "../src/catalog/factory";
import { DirectTransport } from "../src/network/outbound-transport";
import { fetchWithValidatedRedirects, requestPinned } from "../src/network/url-policy";
import { readLimitedJson } from "../src/network/limited-json";
import { IdentityDiagnostics, providerFamily } from "../src/qa/identity-diagnostics";
import { RejectedSourceReview } from "../src/qa/rejected-source-review";
import { createProviderEndpointPolicy, createStreamResolver, createUrlPolicy } from "../src/streams/factory";
import { identityMismatchReason, normalizeCandidateIdentity, resourceIdentityFromUrl } from "../src/streams/identity-qualification";
import { normalizeStreamSource } from "../src/streams/normalization";
import { streamDeduplicationKey } from "../src/streams/stream-deduplication";
import type { StreamCandidateRef, StreamResolverTrace } from "../src/streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource, ProviderDiagnostic } from "../src/streams/types";
import type { Logger } from "../src/logger";
import type { AppConfig } from "../src/types";
import { loadEvaluationCases, type EvaluationCorpus } from "./evaluation-corpus";
import { smokeCases, withinSmokeDeadline } from "./identity-live-smoke-runner";
import { latencySummary } from "../src/streams/evaluation-cost";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const reasons = ["KIND_CONFLICT", "EXTERNAL_ID_CONFLICT", "EPISODE_COORDINATE_CONFLICT",
  "MOVIE_YEAR_CONFLICT", "TEXTUAL_RUNTIME_CONFLICT", "UNAVAILABLE"] as const;
type Reason = typeof reasons[number];
type Status = "completed" | "failed" | "timed_out" | "not_executed";

export function parseConflictArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!["--corpus", "--out-dir", "--max-cases", "--deadline-ms", "--case-deadline-ms", "--provider-concurrency"].includes(key)
      || values.has(key) || !value || value.startsWith("--")) throw new Error("Invalid arguments");
    values.set(key, value);
  }
  const corpus = values.get("--corpus"), outDir = values.get("--out-dir");
  const maxCases = Number(values.get("--max-cases") ?? 20);
  const deadlineMs = Number(values.get("--deadline-ms") ?? 180_000);
  const caseDeadlineMs = Number(values.get("--case-deadline-ms") ?? 15_000);
  const providerConcurrency = Number(values.get("--provider-concurrency") ?? 2);
  if (!corpus || !outDir || !Number.isSafeInteger(maxCases) || maxCases < 1 || maxCases > 100
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 240_000
    || !Number.isSafeInteger(caseDeadlineMs) || caseDeadlineMs < 1 || caseDeadlineMs > 60_000
    || !Number.isSafeInteger(providerConcurrency) || providerConcurrency < 1 || providerConcurrency > 6) throw new Error("Invalid arguments");
  return { corpus, outDir, maxCases, deadlineMs, caseDeadlineMs, providerConcurrency };
}

/** QA scheduling only: individual provider timeouts and probe limits stay unchanged. */
export function conflictConfig(configured: AppConfig, args: ReturnType<typeof parseConflictArgs>): AppConfig {
  return { ...configured, streamProviderTimeoutMs: Math.min(3000, configured.streamProviderTimeoutMs),
    streamProviderMaxConcurrent: args.providerConcurrency,
    externalStreamProviderTimeoutMs: Math.min(3000, configured.externalStreamProviderTimeoutMs),
    stremioAddonRequestTimeoutMs: Math.min(3000, configured.stremioAddonRequestTimeoutMs),
    directHttpProbe: { ...configured.directHttpProbe, maxCandidates: Math.min(8, configured.directHttpProbe.maxCandidates),
      maxConcurrent: Math.min(2, configured.directHttpProbe.maxConcurrent), timeoutMs: Math.min(3000, configured.directHttpProbe.timeoutMs) } };
}

export function conflictCaseSignal(global: AbortSignal, caseDeadlineMs: number): AbortSignal {
  // The global deadline always wins, even when the last case has less time left.
  return AbortSignal.any([global, AbortSignal.timeout(caseDeadlineMs)]);
}

/** Require an existing directory outside every Git worktree, including ignored directories. */
export function privateConflictDirectory(path: string): string {
  const directory = realpathSync(resolve(path));
  if (!statSync(directory).isDirectory()) throw new Error("Output directory required");
  for (let parent = directory; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw new Error("Output must be outside Git");
    if (parent === dirname(parent)) break;
  }
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (result.error || result.status !== 128) throw new Error("Output must be outside Git");
  return directory;
}

export function conflictPattern(item: NormalizedMediaItem, source: NormalizedStreamSource, reason: Reason) {
  const ids = normalizeCandidateIdentity(source.metadata?.identity)?.externalIds ?? {};
  const comparable = Object.entries(ids).filter(([name]) => Object.hasOwn(item.externalIds, name) && item.externalIds[name]);
  const matching = comparable.length > 0 && comparable.every(([name, id]) => item.externalIds[name] === id);
  const conflicting = comparable.some(([name, id]) => item.externalIds[name] !== id);
  // Resource projection uses the existing rule, without producer title/year/ID claims.
  const resource = { providerId: source.providerId, type: source.type,
    ...(source.url ? { url: source.url } : {}), ...(source.filename ? { filename: source.filename } : {}) };
  const resourceReason = identityMismatchReason(item, resource, { deferTextualRuntime: true });
  const urlFacts = source.url && (source.type === "http" || source.type === "https")
    ? resourceIdentityFromUrl(source.url) : undefined;
  return {
    pattern05: item.kind === "movie" && matching && reason === "MOVIE_YEAR_CONFLICT" && resourceReason === "MOVIE_YEAR_CONFLICT",
    // Intentionally weak screening flag: original URL year only, no title/content/redirect validation.
    pattern34PotentialUrlYear: item.kind === "movie" && conflicting && reason === "EXTERNAL_ID_CONFLICT"
      && item.year !== undefined && urlFacts?.year === item.year && !urlFacts.kind && resourceReason === undefined
  };
}

/** Observe actual resolver decisions; raw identities and dedupe keys never leave memory. */
export class ConflictFrequency {
  private intakeObserved = false;
  private readonly candidates = new Map<StreamCandidateRef, { source: NormalizedStreamSource; key: string }>();
  private readonly rejected = new Set<StreamCandidateRef>();
  private readonly resources = new Set<string>();
  private readonly earlyResources = new Set<string>();
  private readonly pattern05Resources = new Set<string>();
  private readonly pattern34Resources = new Set<string>();
  private readonly families = new Map<ReturnType<typeof providerFamily>, { received: number; normalizable: number; early: number;
    pattern05: number; pattern34PotentialUrlYear: number }>();
  private readonly counts = { received: 0, normalizable: 0, invalidNormalization: 0, missingReferences: 0,
    afterIdentityAndUrlPolicy: 0, early: 0, explicitRejectionEvents: 0, pattern05: 0, pattern34PotentialUrlYear: 0,
    unclassifiedFor05or34: 0, earlyHttp: 0, earlyNonHttp: 0, providersAtRawCeiling: 0 };
  private readonly reasonCounts = Object.fromEntries(reasons.map(reason => [reason, 0])) as Record<Reason, number>;

  constructor(private readonly item: NormalizedMediaItem, private readonly probeEnabled: boolean) {}

  readonly trace: StreamResolverTrace = {
    stage: (stage, sources, refs) => {
      if (stage === "normalized") this.counts.afterIdentityAndUrlPolicy = sources.length;
      if (stage !== "provider") return;
      this.intakeObserved = true;
      this.counts.received = sources.length;
      const perProvider = new Map<string, number>();
      sources.forEach((raw, index) => {
        perProvider.set(raw.providerId, (perProvider.get(raw.providerId) ?? 0) + 1);
        const family = providerFamily(raw.providerId);
        const row = this.families.get(family) ?? { received: 0, normalizable: 0, early: 0, pattern05: 0, pattern34PotentialUrlYear: 0 };
        this.families.set(family, row); row.received += 1;
        const source = normalizeStreamSource(raw, raw.providerId);
        if (!source) { this.counts.invalidNormalization += 1; return; }
        this.counts.normalizable += 1; row.normalizable += 1;
        const key = streamDeduplicationKey(source) ?? `unkeyed-${index}`;
        this.resources.add(key);
        const ref = refs?.[index];
        if (ref) this.candidates.set(ref, { source, key });
        else this.counts.missingReferences += 1;
      });
      this.counts.providersAtRawCeiling = [...perProvider.values()].filter(count => count === 100).length;
    },
    preProbeIdentity: event => {
      if (event.decision !== "REJECT" || this.rejected.has(event.candidate)) return;
      this.rejected.add(event.candidate);
      this.counts.early += 1;
      const entry = this.candidates.get(event.candidate);
      if (!entry) { this.reasonCounts.UNAVAILABLE += 1; this.counts.unclassifiedFor05or34 += 1; return; }
      const { source, key } = entry;
      this.earlyResources.add(key);
      const direct = source.type === "http" || source.type === "https";
      if (direct) this.counts.earlyHttp += 1; else this.counts.earlyNonHttp += 1;
      const reason = identityMismatchReason(this.item, source, { deferTextualRuntime: direct && this.probeEnabled }) ?? "UNAVAILABLE";
      this.reasonCounts[reason] += 1;
      const flags = conflictPattern(this.item, source, reason);
      if (flags.pattern05) this.pattern05Resources.add(key);
      if (flags.pattern34PotentialUrlYear) this.pattern34Resources.add(key);
      const row = this.families.get(providerFamily(source.providerId))!;
      row.early += 1;
      for (const flag of ["pattern05", "pattern34PotentialUrlYear"] as const) if (flags[flag]) {
        this.counts[flag] += 1; row[flag] += 1;
      }
      if (!flags.pattern05 && !flags.pattern34PotentialUrlYear) this.counts.unclassifiedFor05or34 += 1;
    },
    rejection: event => { if (event.stage === "normalized") this.counts.explicitRejectionEvents += 1; }
  };

  report() {
    return { intakeObserved: this.intakeObserved, ...this.counts, distinctCaseResources: this.resources.size,
      duplicateResourceOccurrences: this.counts.normalizable - this.resources.size,
      distinctEarlyCaseResources: this.earlyResources.size,
      distinctPattern05CaseResources: this.pattern05Resources.size,
      distinctPattern34PotentialCaseResources: this.pattern34Resources.size,
      duplicateEarlyResourceOccurrences: this.counts.early - this.earlyResources.size,
      reasons: { ...this.reasonCounts }, families: [...this.families].map(([family, counts]) => ({ family, ...counts })) };
  }
}

type Row = { case: number; status: Status; frequency: ReturnType<ConflictFrequency["report"]> | null;
  diagnostics: ReturnType<IdentityDiagnostics["report"]> | null;
  providerOutcomes?: { selected: number; completed: number; errors: number; timeoutsOrCancelled: number; unavailable: number } };

export function conflictReport(rows: Row[], corpusCases: number) {
  const totals = { received: 0, normalizable: 0, early: 0, pattern05: 0, pattern34PotentialUrlYear: 0,
    distinctCaseResources: 0, distinctEarlyCaseResources: 0, duplicateResourceOccurrences: 0,
    distinctPattern05CaseResources: 0, distinctPattern34PotentialCaseResources: 0,
    duplicateEarlyResourceOccurrences: 0, unclassifiedFor05or34: 0, earlyHttp: 0, earlyNonHttp: 0 };
  for (const row of rows) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += row.frequency?.[key] ?? 0;
  const ratio = (numerator: number, denominator: number) => ({ numerator, denominator,
    percent: denominator ? Math.round(numerator * 10000 / denominator) / 100 : null });
  const families = new Map<ReturnType<typeof providerFamily>, { received: number; normalizable: number; early: number;
    pattern05: number; pattern34PotentialUrlYear: number }>();
  for (const row of rows) for (const { family, ...counts } of row.frequency?.families ?? []) {
    const sum = families.get(family) ?? { received: 0, normalizable: 0, early: 0, pattern05: 0, pattern34PotentialUrlYear: 0 };
    for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += counts[key];
    families.set(family, sum);
  }
  return { kind: "identity-conflict-frequency", version: 1, corpusCases,
    casesNotSelected: corpusCases - rows.length, totals,
    observationCoverage: { casesWithIntake: rows.filter(row => row.frequency?.intakeObserved).length,
      casesWithoutIntake: rows.filter(row => !row.frequency?.intakeObserved).length },
    caseOutcomes: Object.fromEntries((["completed", "failed", "timed_out", "not_executed"] as const)
      .map(status => [status, rows.filter(row => row.status === status).length])),
    providerFamilies: [...families].map(([family, counts]) => ({ family, ...counts,
      earlyOfNormalizable: ratio(counts.early, counts.normalizable) })),
    casesAffected: { early: rows.filter(row => row.frequency?.early).length,
      pattern05: rows.filter(row => row.frequency?.pattern05).length,
      pattern34PotentialUrlYear: rows.filter(row => row.frequency?.pattern34PotentialUrlYear).length },
    rates: { earlyOfNormalizable: ratio(totals.early, totals.normalizable),
      pattern05OfEarly: ratio(totals.pattern05, totals.early), pattern34PotentialOfEarly: ratio(totals.pattern34PotentialUrlYear, totals.early),
      distinctEarlyOfDistinctCaseResources: ratio(totals.distinctEarlyCaseResources, totals.distinctCaseResources) },
    review: { supported: false, maximumReviews: 5, performed: 0, contentTruth: "INSUFFICIENT_EVIDENCE",
      ruleVerdict: null, earlyHttpWithoutVerifiedMp4: totals.earlyHttp, nonHttpExcluded: totals.earlyNonHttp,
      excludedByFormatAlone: null,
      reason: "EXISTING_REVIEW_ONLY_ACCEPTS_POST_PROBE_RUNTIME_REJECTIONS" },
    interpretation: ["OBSERVATIONS_ONLY_NOT_PROVEN_PREMATURE_REJECTIONS", "NO_ID_INDEPENDENCE_OR_CONTENT_TRUTH_INFERRED",
      "PATTERN34_IS_UNVALIDATED_ORIGINAL_URL_YEAR_ONLY_NOT_TITLE_OR_CONTENT",
      "PATTERN05_RESOURCE_FILENAME_OR_URL_YEAR_ONLY_NOT_EXACT_CASE05",
      "EARLY_REJECTS_HAVE_NOT_PASSED_NETWORK_POLICY_OR_MEDIA_VALIDATION",
      "DISTINCT_RESOURCES_ARE_PER_CASE_HTTP_REQUIREMENTS_NOT_DISTINCT_ID_CLAIMS",
      "DENOMINATORS_ONLY_OBSERVED_RESOLVER_INTAKE_CAPPED_AT_100_PER_PROVIDER",
      "DIAGNOSTIC_PROVIDER_CALLS_COUNT_TERMINAL_OUTCOMES_ONLY_USE_PROVIDER_OUTCOMES_FOR_COMPLETENESS",
      "PROBE_REQUESTS_ARE_CANDIDATE_ATTEMPTS_NOT_HTTP_COUNTS",
      "PROVIDER_ERRORS_TIMEOUTS_CANCELLATIONS_AND_UNSELECTED_CASES_ARE_NOT_NEGATIVE_RESULTS",
      "NO_INTAKE_SNAPSHOT_IS_MISSING_EVIDENCE_NOT_ZERO_SOURCES_OR_REJECTIONS",
      "FORMAT_EXCLUSIONS_UNKNOWN_EARLY_REJECTS_NEVER_REACHED_PROBE"], cases: rows };
}

// Exploratory matrix on the same local QA entrypoint. No production defaults are changed.
export type StudyProfile = "A" | "B" | "C" | "D";
export type StudyFamily = "stremio" | "external_http" | "combined";
const STUDY_BUDGET_MS = 12 * 60_000;

export function studyConfig(base: AppConfig, profile: StudyProfile, family: StudyFamily): AppConfig {
  const config = { ...base, streamProviders: base.streamProviders.filter(name =>
    (family !== "external_http" && name === "stremio_addons") || (family !== "stremio" && name === "external_http")) };
  if (profile === "A") return { ...config, streamProviderTimeoutMs: 3000,
    stremioAddonRequestTimeoutMs: 3000, externalStreamProviderTimeoutMs: 3000,
    directHttpProbe: { ...base.directHttpProbe, maxCandidates: 4, timeoutMs: 1500, maxConcurrent: 2 } };
  if (profile === "C") return { ...config, stremioAddonRequestTimeoutMs: 8000, externalStreamProviderTimeoutMs: 20_000 };
  if (profile === "D") return { ...config,
    directHttpProbe: { ...base.directHttpProbe, maxCandidates: 16, timeoutMs: 6000, maxConcurrent: 4 } };
  return config;
}

export function studyLimits(config: AppConfig) {
  return { providerTimeoutMs: config.streamProviderTimeoutMs, providerConcurrency: config.streamProviderMaxConcurrent,
    stremioTimeoutMs: config.stremioAddonRequestTimeoutMs, externalTimeoutMs: config.externalStreamProviderTimeoutMs,
    manifestTtlMs: config.stremioAddonManifestTtlMs, probe: { ...config.directHttpProbe } };
}

export function selectStudyCases(corpus: EvaluationCorpus) {
  const ordered = smokeCases(corpus, "FULL");
  const selected: typeof ordered = [];
  const kinds = new Set<string>();
  for (const entry of ordered) {
    const kind = `${entry.mediaClass}/${entry.item.kind}`;
    if (!kinds.has(kind) && selected.length < 4) { kinds.add(kind); selected.push(entry); }
  }
  for (const entry of ordered) if (selected.length < 4 && !selected.includes(entry)) selected.push(entry);
  return selected;
}

export function studySchedule(cases: number) {
  const jobs: Array<{ case: number; profile: StudyProfile; family: StudyFamily }> = [];
  for (let index = 0; index < Math.min(4, cases); index += 1) {
    const families: StudyFamily[] = index % 2 ? ["external_http", "stremio"] : ["stremio", "external_http"];
    for (const family of [...families, "combined" as const]) jobs.push({ case: index + 1, profile: "B", family });
    const variants: StudyProfile[] = ["A", "C", "D"];
    for (let offset = 0; offset < variants.length; offset += 1) for (const family of families) {
      jobs.push({ case: index + 1, profile: variants[(index + offset) % variants.length]!, family });
    }
  }
  // Optional combined D gets time only after all required comparisons.
  for (let index = 0; index < Math.min(4, cases); index += 1) jobs.push({ case: index + 1, profile: "D", family: "combined" });
  return jobs;
}

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** IDs are read from trusted startup data only, used for equality, and never reported. */
function configuredKodi(): { ids: string[]; workerTimeoutSeconds: number[] } {
  const file = process.env.PYTHON_ADAPTER_KODI_RESOLVERS_FILE;
  if (!file) return { ids: process.env.PYTHON_ADAPTER_KODI_RESOLVER_ENABLED === "true" ? ["kodi_installed"] : [],
    workerTimeoutSeconds: [Number(process.env.PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS ?? 5)].filter(value => Number.isFinite(value) && value > 0) };
  // Adapter launches traditionally resolve this setting from python-adapter-host/.
  const candidates = [...new Set([resolve(file), resolve("python-adapter-host", file)])].filter(path => existsSync(path));
  if (candidates.length !== 1 || statSync(candidates[0]!).size > 65_536) throw new Error("Kodi startup configuration unavailable or ambiguous");
  const value = object(JSON.parse(readFileSync(candidates[0]!, "utf8")));
  if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 32) throw new Error("Invalid Kodi startup configuration");
  const profiles = value.profiles.map(object).filter(profile => profile.enabled === true);
  if (profiles.some(profile => typeof profile.id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(profile.id))) throw new Error("Invalid Kodi IDs");
  return { ids: profiles.map(profile => String(profile.id)),
    workerTimeoutSeconds: profiles.map(profile => positive(profile.workerTimeoutSeconds)).filter((value): value is number => value !== null) };
}

export function assessStudyKodi(healthInput: unknown, resolversInput: unknown, expectedIds: readonly string[]) {
  const health = object(healthInput), resolvers = object(resolversInput);
  const list = Array.isArray(resolvers.resolvers) ? resolvers.resolvers.map(object) : [];
  const matching = list.filter(row => expectedIds.includes(String(row.id)) && row.enabled === true);
  const ready = health.ok === true && health.service === "tribler-stremio-python-adapter"
    && expectedIds.length > 0 && expectedIds.every(id => matching.some(row => row.id === id));
  return { status: ready ? "KODI_ADVERTISED" as const : "KODI_UNAVAILABLE" as const,
    configured: expectedIds.length, matchingEnabled: matching.length,
    resolverTimeoutSeconds: positive(health.resolverTimeoutSeconds), requestTimeoutSeconds: positive(health.requestTimeoutSeconds),
    maxConcurrentResolvers: positive(health.maxConcurrentResolvers),
    // These are service snapshots, not invocation-local outcomes or proof of content correctness.
    outcomes: { ok: matching.filter(row => row.status === "ok").length,
      timeout: matching.filter(row => row.status === "timeout").length,
      resolverError: matching.filter(row => row.status === "resolver_error").length,
      invalidResult: matching.filter(row => row.status === "invalid_result").length,
      neverRun: matching.filter(row => row.status === "never-run").length } };
}
type KodiSnapshot = ReturnType<typeof assessStudyKodi> & { localWorkerTimeoutSeconds: number[] };

async function studyKodi(config: AppConfig, signal: AbortSignal): Promise<KodiSnapshot> {
  let local: ReturnType<typeof configuredKodi> = { ids: [], workerTimeoutSeconds: [] };
  try {
    local = configuredKodi();
    if (!config.streamProviders.includes("external_http") || !config.externalStreamProviderEnabled || !config.externalStreamProviderUrl)
      throw new Error("External host not configured");
    const endpoint = new URL(config.externalStreamProviderUrl);
    // Health inspection is localhost-only and never follows the provider's remote results.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password)
      throw new Error("Not a localhost adapter");
    const read = async (path: string): Promise<unknown> => {
      const url = new URL(path, endpoint).toString();
      const response = await fetchWithValidatedRedirects(url, createProviderEndpointPolicy(config, url), {
        method: "GET", headers: { Accept: "application/json", "Accept-Encoding": "identity" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }, undefined, 0, "same-origin");
      if (!response.ok) { await response.body?.cancel(); throw new Error("Adapter unavailable"); }
      return readLimitedJson(response, 65_536);
    };
    const health = await read("/health"), resolvers = await read("/resolvers");
    return { ...assessStudyKodi(health, resolvers, local.ids), localWorkerTimeoutSeconds: local.workerTimeoutSeconds };
  } catch {
    return { ...assessStudyKodi({}, {}, local.ids), localWorkerTimeoutSeconds: local.workerTimeoutSeconds };
  }
}

const studyStages = ["provider", "normalized", "deduplicated", "probed", "admitted", "final"] as const;
export class StudyObservation {
  private readonly start = performance.now();
  private readonly times = new Map<typeof studyStages[number], number>();
  private readonly stages: Partial<Record<typeof studyStages[number], { candidates: number; httpsDistinct: number; httpsVerified: number }>> = {};
  private readonly frequency: ConflictFrequency;
  private normalizable: number | null = null;
  private probe = { starts: 0, verified: 0, failed: 0, timeout: 0, uncertain: 0, exhausted: 0, unexamined: 0 };
  private startsByFamily = { stremio_addon: 0, external_http: 0, other: 0 };
  constructor(item: NormalizedMediaItem, enabled: boolean) { this.frequency = new ConflictFrequency(item, enabled); }
  readonly trace: StreamResolverTrace = {
    stage: (stage, sources, refs) => {
      this.frequency.trace.stage(stage, sources, refs);
      this.times.set(stage, performance.now() - this.start);
      const https = sources.flatMap(source => {
        // Intake may contain malformed URLs or forged probe fields; use the real normalizer before counting identities.
        const candidate = stage === "provider" ? normalizeStreamSource(source, source.providerId) : source;
        return candidate?.type === "https" && candidate.url ? [candidate] : [];
      });
      const distinct = (values: readonly NormalizedStreamSource[]) => new Set(values.map(streamDeduplicationKey)).size;
      this.stages[stage] = { candidates: sources.length, httpsDistinct: distinct(https),
        httpsVerified: stage === "probed" || stage === "admitted" || stage === "final"
          ? distinct(https.filter(source => source.directHttp?.verified)) : 0 };
      if (stage === "provider") this.normalizable = this.frequency.report().normalizable;
      if (stage === "probed") for (const source of sources) {
        if (source.type !== "https" && source.type !== "http") continue;
        const probe = source.directHttp;
        if (!probe) this.probe.unexamined += 1;
        else if (probe.status === "budget_exhausted") this.probe.exhausted += 1;
        else if (probe.verified) this.probe.verified += 1;
        else if (probe.status === "timeout") this.probe.timeout += 1;
        else if (probe.status === "unreachable" || probe.status === "route_rejected") this.probe.failed += 1;
        else this.probe.uncertain += 1;
      }
    },
    rejection: event => this.frequency.trace.rejection?.(event),
    preProbeIdentity: event => this.frequency.trace.preProbeIdentity?.(event),
    probeNetworkStart: id => {
      this.probe.starts += 1;
      const family = providerFamily(id);
      this.startsByFamily[family === "external_http" || family === "stremio_addon" ? family : "other"] += 1;
    }
  };
  report(diagnostics: readonly ProviderDiagnostic[]) {
    const difference = (end: typeof studyStages[number], start: typeof studyStages[number]) =>
      this.times.has(end) && this.times.has(start) ? this.times.get(end)! - this.times.get(start)! : null;
    const active = diagnostics.filter(row => row.enabled);
    return { observedStages: studyStages.filter(stage => this.times.has(stage)), stages: { ...this.stages },
      normalizable: this.normalizable, probe: { ...this.probe },
      startsByFamily: { ...this.startsByFamily }, identity: this.frequency.report(),
      timing: { providerBatchMs: this.times.get("provider") ?? null, qualificationAndPolicyMs: difference("deduplicated", "provider"),
        probingMs: difference("probed", "deduplicated"), listingMs: this.times.get("final") ?? null, providerQueueMs: null },
      providers: { selected: active.length, ok: active.filter(row => row.status === "ok").length,
        errors: active.filter(row => row.status === "error" && row.lastError !== "Provider timed out or was cancelled").length,
        timeoutsOrCancelled: active.filter(row => row.status === "error" && row.lastError === "Provider timed out or was cancelled").length,
        unobserved: active.filter(row => row.status === "never-run").length,
        // Registry latency starts after acquiring a slot. No queue subtraction is invented.
        responseLatency: latencySummary(active.flatMap(row => row.latencyMs === undefined ? [] : [row.latencyMs])),
        responses: active.map((row, index) => ({ provider: index + 1, family: providerFamily(row.id), status: row.status,
          responseMs: row.latencyMs ?? null, queueMs: null })) } };
  }
}

type StudyJob = ReturnType<typeof studySchedule>[number];
export type StudyRow = StudyJob & { status: Status | "KODI_UNAVAILABLE" | "NOT_CONFIGURED"; elapsedMs: number;
  metrics: ReturnType<StudyObservation["report"]> | null; kodi: KodiSnapshot | null; wallMs?: number; order?: number;
  probeCounters?: { enabled: boolean; candidateAttempts: number; cacheHits: number; verified: number; failures: number } };

export function studySummary(rows: StudyRow[]) {
  const table = (["stremio", "external_http", "combined"] as const).flatMap(family =>
    (["A", "B", "C", "D"] as const).filter(profile => family !== "combined" || profile === "B" || profile === "D").map(profile => {
      const group = rows.filter(row => row.family === family && row.profile === profile);
      const complete = group.filter(row => row.status === "completed" && row.metrics?.stages.final);
      const sum = (get: (metrics: NonNullable<StudyRow["metrics"]>) => number) =>
        complete.length ? complete.reduce((total, row) => total + get(row.metrics!), 0) : null;
      const observed = group.filter(row => row.metrics);
      const sumObserved = (get: (metrics: NonNullable<StudyRow["metrics"]>) => number) =>
        observed.length ? observed.reduce((total, row) => total + get(row.metrics!), 0) : null;
      const baseline = rows.filter(row => row.family === family && row.profile === "B" && row.status === "completed");
      const paired = complete.flatMap(row => {
        const base = baseline.find(base => base.case === row.case && base.metrics?.stages.final);
        return base ? [{ case: row.case, finalHttpsDelta: row.metrics!.stages.final!.httpsDistinct - base.metrics!.stages.final!.httpsDistinct,
          verifiedHttpsDelta: row.metrics!.stages.probed!.httpsVerified - base.metrics!.stages.probed!.httpsVerified,
          listingMsDelta: row.metrics!.timing.listingMs! - base.metrics!.timing.listingMs! }] : [];
      });
      return { family, profile, planned: group.length, completed: complete.length,
        incomplete: group.length - complete.length, kodiUnavailable: group.filter(row => row.status === "KODI_UNAVAILABLE").length,
        kodiTimeoutSnapshots: group.filter(row => row.kodi && row.kodi.outcomes.timeout > 0).length,
        finalHttps: sum(metrics => metrics.stages.final!.httpsDistinct),
        verifiedHttps: sum(metrics => metrics.stages.probed!.httpsVerified), admittedHttps: sum(metrics => metrics.stages.admitted!.httpsDistinct),
        unexamined: sum(metrics => metrics.probe.unexamined), exhausted: sum(metrics => metrics.probe.exhausted),
        providerErrors: sumObserved(metrics => metrics.providers.errors), providerTimeouts: sumObserved(metrics => metrics.providers.timeoutsOrCancelled),
        latency: complete.length ? latencySummary(complete.map(row => row.metrics!.timing.listingMs!)) : null, pairedAgainstB: paired };
    }));
  const restrictive = table.filter(row => row.profile === "A").flatMap(row => row.pairedAgainstB);
  const baseline = rows.filter(row => row.profile === "B" && row.status === "completed");
  return { table,
    observations: { pairsWithFewerFinalHttpsUnderA: restrictive.filter(pair => pair.finalHttpsDelta < 0).length,
      productionCasesWithUnexaminedOrExhausted: baseline.filter(row => row.metrics && (row.metrics.probe.unexamined || row.metrics.probe.exhausted)).length },
    recommendation: !baseline.some(row => row.metrics && row.metrics.providers.ok > 0)
      ? "INSUFFICIENT_EVIDENCE: no completed B observations with a successful provider outcome; inspect availability and incomplete cells."
      : restrictive.some(pair => pair.finalHttpsDelta < 0)
        ? "Restrictive budgets coincide with fewer final HTTPS in paired observations. Use effective B settings for QA; repeat paired cases before changing production."
        : "No demonstrated restrictive-budget source loss in completed pairs. Inspect B unexamined, exhausted and provider outcomes; do not infer incorrect content or relax Identity." };
}

async function studyCell(job: StudyJob, item: NormalizedMediaItem): Promise<StudyRow> {
  const start = performance.now();
  const config = studyConfig(loadConfig(), job.profile, job.family);
  const empty = (status: StudyRow["status"], kodi: KodiSnapshot | null): StudyRow =>
    ({ ...job, status, elapsedMs: performance.now() - start, metrics: null, kodi });
  const signal = new AbortController().signal; // Parent process owns the single global deadline.
  let kodi: KodiSnapshot | null = null;
  if (job.family !== "stremio") {
    kodi = await studyKodi(config, signal);
    if (kodi.status === "KODI_UNAVAILABLE") return empty("KODI_UNAVAILABLE", kodi);
  }
  const policy = createUrlPolicy(config);
  const transport = new DirectTransport(policy, config.httpPrivacy, quiet);
  const observation = new StudyObservation(item, config.directHttpProbe.enabled);
  const resolver = createStreamResolver([], config, quiet, policy, transport, undefined, observation.trace);
  const active = resolver.diagnostics().filter(row => row.enabled);
  if (!active.length || (job.family === "combined" && !active.some(row => row.id.startsWith("stremio-addon-"))))
    return empty("NOT_CONFIGURED", kodi);
  let status: StudyRow["status"] = "completed";
  try { await resolver.resolve(item, signal); } catch { status = "failed"; }
  const metrics = observation.report(resolver.diagnostics());
  if (job.family !== "stremio") kodi = await studyKodi(config, signal);
  if (kodi?.status === "KODI_UNAVAILABLE" || (kodi && !kodi.outcomes.ok && kodi.outcomes.resolverError > 0)) status = "KODI_UNAVAILABLE";
  const probe = resolver.directProbeDiagnostics();
  return { ...job, status, elapsedMs: performance.now() - start, metrics, kodi,
    ...(probe ? { probeCounters: { enabled: probe.enabled, candidateAttempts: probe.requests,
      cacheHits: probe.cacheHits, verified: probe.verified, failures: probe.failures } } : {}) };
}

/** One fixed local child at a time; cold bridge caches and hard cleanup at the global deadline. */
export async function isolatedStudyCell(job: StudyJob, item: NormalizedMediaItem, signal: AbortSignal): Promise<StudyRow> {
  const start = performance.now();
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, __filename, "--study-cell"], {
      cwd: process.cwd(), env: { ...process.env, DOTENV_CONFIG_QUIET: "true" },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0, invalid = false;
    const abort = (): void => { child.kill(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 262_144) { invalid = true; child.kill(); } else chunks.push(chunk);
    });
    child.stderr.resume(); // Never persist environment/configuration/provider error output.
    child.stdin.on("error", () => undefined);
    child.on("error", () => { invalid = true; });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      let row: StudyRow = { ...job, status: signal.aborted ? "timed_out" : "failed", elapsedMs: performance.now() - start, metrics: null, kodi: null };
      if (!invalid && code === 0) {
        try { row = JSON.parse(Buffer.concat(chunks).toString("utf8")) as StudyRow; } catch { /* Safe failed row. */ }
      }
      resolveResult({ ...row, wallMs: performance.now() - start });
    });
    child.stdin.end(JSON.stringify({ job, item })); // Trusted local corpus data, never a command or executable path.
  });
}

function formatStudy(report: ReturnType<typeof studySummary>, rows: StudyRow[]): string {
  const lines = ["# Local HTTPS resolution observations", "", "Counts sum case/resource pairs, not unique content or confirmed losses.", "",
    "| Family | Profile | Complete/planned | Final HTTPS | Verified HTTPS | Admitted HTTPS | Provider errors/timeouts | Kodi unavailable/timeout snapshots | Unexamined/exhausted | Mean listing ms |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const show = (value: number | null | undefined) => value === null || value === undefined ? "N/A" : String(Math.round(value));
  for (const row of report.table) lines.push(`| ${row.family} | ${row.profile} | ${row.completed}/${row.planned} | ${show(row.finalHttps)} | ${show(row.verifiedHttps)} | ${show(row.admittedHttps)} | ${show(row.providerErrors)}/${show(row.providerTimeouts)} | ${row.kodiUnavailable}/${row.kodiTimeoutSnapshots} | ${show(row.unexamined)}/${show(row.exhausted)} | ${show(row.latency?.meanMs)} |`);
  lines.push("", "| Case | Family | Profile | Status | Listing ms | Elapsed ms | Delta listing ms vs B | Delta final HTTPS vs B |", "|---|---|---|---|---:|---:|---:|---:|");
  for (const row of rows) {
    const pair = report.table.find(entry => entry.family === row.family && entry.profile === row.profile)?.pairedAgainstB.find(pair => pair.case === row.case);
    lines.push(`| ${row.case} | ${row.family} | ${row.profile} | ${row.status} | ${show(row.metrics?.timing.listingMs)} | ${show(row.elapsedMs)} | ${show(pair?.listingMsDelta)} | ${show(pair?.finalHttpsDelta)} |`);
  }
  lines.push("", "Observed: " + JSON.stringify(report.observations), "", report.recommendation, "",
    "Verified HTTPS counts refer to the probed snapshot, before final identity/media admission. Kodi timeout snapshots count cells with shared service timeout state, not exact timeout events.", "",
    "Observed associations only. Single pass, remote caches/time/order and incomplete provider outcomes prevent causal claims. See JSON for effective settings, availability, stage counts and limitations.");
  return lines.join("\n") + "\n";
}

async function resolutionStudy(args: readonly string[]): Promise<void> {
  // A separate explicit mode leaves frequency CLI behavior and its existing bounds intact.
  const parsed = parseConflictArgs(args); // Only --corpus and --out-dir are accepted for this fixed study.
  if (args.length !== 4) throw new Error("Study requires corpus and output directory only");
  const output = privateConflictDirectory(parsed.outDir);
  const corpus = loadEvaluationCases(parsed.corpus, "--corpus");
  const selected = selectStudyCases(corpus);
  if (selected.length !== 4) throw new Error("Study requires four cases");
  const config = loadConfig();
  const controller = new AbortController();
  const start = performance.now();
  const timer = setTimeout(() => controller.abort(), STUDY_BUDGET_MS);
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const jobs = studySchedule(selected.length);
  const rows: StudyRow[] = jobs.map(job => ({ ...job, status: "not_executed", elapsedMs: 0, metrics: null, kodi: null }));
  const stem = join(output, `https-resolution-${randomBytes(8).toString("hex")}`);
  const limitations = ["Only four fixed, diverse corpus cases; no content truth or confirmed source loss.",
    "B retains loadConfig values, including disabled probing if configured; only family selection changes.",
    "C uses literal 8000/20000ms; D uses literal 16/6000ms/4. These can be reductions relative to effective B.",
    "All jobs are sequential; each has fresh Node providers/resolver/probe caches, no warm-up or repeats.",
    "B runs first for paired baselines. Other profiles rotate across cases, families alternate. Remote/Python/OS caches and time trends remain uncontrolled.",
    "Provider latency excludes registry queue; providerBatchMs includes queue. Per-provider queue time is unobservable.",
    "Probing interval is deduplicated-to-probed. No exact global HTTP count is available.",
    "Initial Kodi readiness checks only advertised configured resolver IDs. Post-run outcomes are shared service snapshots, not invocation-local guarantees.",
    "Node timeouts do not increase Python resolver/request/worker deadlines. Worker limits come from local startup configuration, not live health.",
    "Raw registry intake capped at 100 per provider. No partial intake is exposed until resolveAll completes.",
    "Counts do not measure cross-profile resource overlap or prove that a missing URL identifies lost correct content.",
    "Timeout/failed/unexamined/exhausted are not incorrect sources or confirmed losses.",
    "The 12-minute cap includes preflight and child startup; unfinished cells remain explicit. No per-case smoke deadline overrides B."];
  const save = (kodi: KodiSnapshot): ReturnType<typeof studySummary> => {
    const summary = studySummary(rows);
    const report = { kind: "https-resolution-exploration", version: 1, budgetMs: STUDY_BUDGET_MS, elapsedMs: performance.now() - start,
      initialKodi: kodi, cases: selected.map((entry, index) => ({ case: index + 1,
        corpusPosition: corpus.cases.indexOf(entry) + 1, mediaClass: entry.mediaClass, kind: entry.item.kind, cohort: entry.cohort })),
      profiles: (["A", "B", "C", "D"] as const).map(profile => ({ profile, ...studyLimits(studyConfig(config, profile, "combined")) })),
      limitations, ...summary, rows };
    writeFileSync(stem + ".json", JSON.stringify(report, null, 2), { mode: 0o600 });
    writeFileSync(stem + ".md", formatStudy(summary, rows), { mode: 0o600 });
    return summary;
  };
  try {
    const kodi = await studyKodi(studyConfig(config, "B", "combined"), controller.signal);
    save(kodi);
    for (const [index, job] of jobs.entries()) {
      let row: StudyRow;
      if (controller.signal.aborted) row = { ...job, status: "not_executed", elapsedMs: 0, metrics: null, kodi: null };
      else if (job.family !== "stremio" && kodi.status === "KODI_UNAVAILABLE")
        row = { ...job, status: "KODI_UNAVAILABLE", elapsedMs: 0, metrics: null, kodi };
      else row = await isolatedStudyCell(job, selected[job.case - 1]!.item, controller.signal);
      rows[index] = { ...row, order: index + 1 }; save(kodi);
      process.stdout.write(`case=${job.case} family=${job.family} profile=${job.profile} status=${row.status}\n`);
    }
    process.stdout.write(formatStudy(save(kodi), rows));
    if (rows.some(row => row.status !== "completed")) process.exitCode = 2;
  } finally {
    clearTimeout(timer); controller.abort();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}

async function main(): Promise<void> {
  // CLI guard below ensures imports/tests cannot load config or invoke real providers.
  const args = parseConflictArgs(process.argv.slice(2));
  const output = privateConflictDirectory(args.outDir);
  const corpus = loadEvaluationCases(args.corpus, "--corpus");
  const config = conflictConfig(loadConfig(), args);
  const policy = createUrlPolicy(config);
  let mediaRequests = 0;
  const transport = new DirectTransport(policy, config.httpPrivacy, quiet, (target, init) => {
    mediaRequests += 1;
    return requestPinned(target, init);
  });
  const catalogs = config.streamProviders.includes("catalog") ? createCatalogProviders(config, policy) : [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.deadlineMs);
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const rows: Row[] = [];
  try {
    for (const [index, entry] of corpus.cases.slice(0, args.maxCases).entries()) {
      if (controller.signal.aborted) { rows.push({ case: index + 1, status: "not_executed", frequency: null, diagnostics: null }); continue; }
      const signal = conflictCaseSignal(controller.signal, args.caseDeadlineMs);
      const requestsBefore = mediaRequests;
      const review = new RejectedSourceReview(transport, entry.item);
      const diagnostic = new IdentityDiagnostics(entry.item, review);
      const frequency = new ConflictFrequency(entry.item, config.directHttpProbe.enabled);
      const trace: StreamResolverTrace = {
        stage: (...args) => { diagnostic.trace.stage(...args); frequency.trace.stage(...args); },
        rejection: event => { diagnostic.trace.rejection?.(event); frequency.trace.rejection?.(event); },
        preProbeIdentity: event => frequency.trace.preProbeIdentity?.(event),
        probeNetworkStart: id => diagnostic.trace.probeNetworkStart?.(id)
      };
      const resolver = createStreamResolver(catalogs, config, quiet, policy, transport, undefined, trace);
      let status: Status = "completed";
      try { await withinSmokeDeadline(() => resolver.resolve(entry.item, signal), signal); if (signal.aborted) status = "timed_out"; }
      catch { status = signal.aborted ? "timed_out" : "failed"; }
      const outcomes = resolver.diagnostics().filter(provider => provider.enabled);
      const unavailable = outcomes.filter(provider => provider.status !== "ok" && provider.status !== "error").length;
      const observed = frequency.report();
      try { rows.push({ case: index + 1, status, frequency: observed.intakeObserved ? observed : null,
        providerOutcomes: { selected: outcomes.length, completed: outcomes.filter(provider => provider.status === "ok").length,
          errors: outcomes.filter(provider => provider.status === "error" && provider.lastError !== "Provider timed out or was cancelled").length,
          timeoutsOrCancelled: outcomes.filter(provider => provider.status === "error" && provider.lastError === "Provider timed out or was cancelled").length,
          unavailable },
        diagnostics: { ...diagnostic.report(resolver.directProbeDiagnostics(), mediaRequests - requestsBefore, outcomes),
          pendingProviderOutcomes: unavailable } }); }
      finally { await review.close(); }
    }
    const report = { ...conflictReport(rows, corpus.cases.length), limits: { deadlineMs: args.deadlineMs,
      maxCases: args.maxCases, caseDeadlineMs: args.caseDeadlineMs, providerConcurrency: config.streamProviderMaxConcurrent,
      probe: config.directHttpProbe, exactGlobalHttpCap: false } };
    // No provider strings, corpus labels, source objects, errors, URLs or reversible IDs are serialized.
    writeFileSync(join(output, `identity-conflict-${randomBytes(8).toString("hex")}.json`), JSON.stringify(report, null, 2),
      { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + "\n");
    if (rows.some(row => row.status === "failed" || row.status === "timed_out" || row.status === "not_executed"
      || row.providerOutcomes?.errors || row.providerOutcomes?.timeoutsOrCancelled || row.providerOutcomes?.unavailable)) process.exitCode = 2;
  } finally {
    clearTimeout(timer); controller.abort();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}

if (require.main === module) {
  void import("dotenv").then(async dotenv => {
    dotenv.config({ quiet: true });
    const args = process.argv.slice(2);
    if (args[0] === "--resolution-study") return resolutionStudy(args.slice(1));
    if (args.length === 1 && args[0] === "--study-cell") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const part = Buffer.from(chunk as Uint8Array);
        size += part.length;
        if (size > 32_768) throw new Error("Study input too large");
        chunks.push(part);
      }
      const { job, item } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { job: StudyJob; item: NormalizedMediaItem };
      if (!["A", "B", "C", "D"].includes(job.profile) || !["stremio", "external_http", "combined"].includes(job.family)
        || !Number.isSafeInteger(job.case) || job.case < 1 || job.case > 4) throw new Error("Invalid study job");
      const row = await studyCell(job, item);
      process.stdout.write(JSON.stringify(row), () => process.exit(0));
      return;
    }
    return main();
  }).catch(() => {
    process.stderr.write("IDENTITY_CONFLICT_QA_FAILED: invalid input, output directory, configuration or unavailable environment.\n");
    process.exitCode = 1;
  });
}
