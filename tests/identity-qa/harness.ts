import express from "express";
import request from "../http-client";
import { getRouter } from "stremio-addon-sdk";
import { vi } from "vitest";
import { createApp } from "../../src/app";
import * as resolverFactory from "../../src/streams/factory";
import { createAddon } from "../../src/addon";
import type { DownloadService } from "../../src/download-service";
import type { MovieMetadataLookup } from "../../src/metadata/movie-metadata";
import type { Logger } from "../../src/logger";
import { DirectTransport, OutboundRedirectError, type OutboundTransport, type PinnedRequest } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy, ExternalUrlPolicyError } from "../../src/network/url-policy";
import { DirectHttpPlaybackBackend } from "../../src/playback/backends";
import { PlaybackManager } from "../../src/playback/manager";
import { DirectStreamProbe, type DirectStreamProbeOptions } from "../../src/streams/direct-stream-probe";
import { assessIdentity, IdentityPrecisionEvaluation } from "../../src/streams/identity-precision-evaluation";
import { normalizeStreamSource } from "../../src/streams/normalization";
import { streamDeduplicationKey } from "../../src/streams/stream-deduplication";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver, type StreamResolverTrace, type StreamCandidateRef, type StreamRejection, type PreProbeIdentityDecision } from "../../src/streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../../src/streams/types";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { silentLogger, testConfig } from "../helpers";
import { RejectedSourceReview } from "../../src/qa/rejected-source-review";

export type IdentityState = "UNKNOWN" | "CORROBORATED" | "SUSPICIOUS" | "CONTRADICTION";
export type DisappearanceDomain = "NONE" | "IDENTITY" | "URL_POLICY" | "TRANSPORT" | "MEDIA_QUALIFICATION"
  | "DEDUPE" | "PROBE_BUDGET" | "PROVIDER_QUOTA" | "NOT_OBSERVABLE";
export type DimensionValue = string | number | boolean;
export type Dimensions = Readonly<Record<string, DimensionValue>>;
export type Mode = "STRICT" | "BASELINE";
export interface KnownViolation {
  caseId: string;
  dimension: string;
  expected: DimensionValue;
  observed: DimensionValue;
  reason: string;
}
export interface Verdict {
  passed: boolean;
  failures: Array<{ dimension: string; expected: DimensionValue; observed: DimensionValue }>;
  known: string[];
  progress: string[];
}

/** Comparison only: no identity parsing/oracle, and no baseline writing. */
export function adjudicate(caseId: string, expected: Dimensions, observed: Dimensions,
  mode: Mode, baseline: readonly KnownViolation[]): Verdict {
  const result: Verdict = { passed: true, failures: [], known: [], progress: [] };
  const entries = baseline.filter(entry => entry.caseId === caseId);
  if (new Set(entries.map(entry => entry.dimension)).size !== entries.length) throw new Error("Duplicate baseline dimension");
  if (entries.some(entry => expected[entry.dimension] !== entry.expected)) throw new Error("Stale baseline contract");
  for (const [dimension, target] of Object.entries(expected)) {
    // Missing instrumentation is never an explicit production observation/baseline match.
    if (!Object.hasOwn(observed, dimension) || observed[dimension] === undefined || observed[dimension] === null) {
      result.failures.push({ dimension, expected: target, observed: "MISSING_OBSERVATION" });
      continue;
    }
    const actual = observed[dimension];
    const known = entries.find(entry => entry.dimension === dimension);
    if (actual === target) {
      if (known) result.progress.push(dimension);
    } else if (mode === "BASELINE" && known?.observed === actual) {
      result.known.push(dimension);
    } else {
      result.failures.push({ dimension, expected: target, observed: actual });
    }
  }
  result.passed = result.failures.length === 0;
  return result;
}

export function pilotMode(): Mode {
  const value = process.env.IDENTITY_QA_MODE ?? "BASELINE";
  if (value !== "BASELINE" && value !== "STRICT") throw new Error("Unsupported Identity QA mode");
  return value;
}

type Stage = Parameters<StreamResolverTrace["stage"]>[0];
const stageNames = ["provider", "normalized", "deduplicated", "probed", "admitted", "final"] as const;
interface PublicStream { url: string; name?: string; title?: string }
export interface PipelineObservation {
  dimensions: Dimensions;
  legacyAssessment: string;
  stages: Record<Stage, number>;
  origins: Array<{ id: string; disappearance: DisappearanceDomain;
    candidateStages: Record<Stage, "CONTINUE" | "REJECT" | "NOT_OBSERVABLE" | "NOT_REACHED"> }>;
  candidates: Array<{ id: string; resource: string; dimensions: Dimensions }>;
  probeRequests: number;
}
interface ObservationOptions {
  /** A/B control: disable optional identity events without changing the route. */
  identityTrace?: boolean;
  /** Existing production configuration; small caps exercise bounded composition. */
  probeOptions?: Partial<DirectStreamProbeOptions>;
  /** Existing socket boundary substitution for deterministic clock/TLS component checks. */
  pinnedRequest?: PinnedRequest;
  fixtureUrls?: readonly string[];
  /** Assertions only, in memory. Never supplies/replaces report observations. */
  inspect?: (context: {
    snapshots: ReadonlyMap<Stage, readonly NormalizedStreamSource[]>;
    publicSources: readonly { source: NormalizedStreamSource; stream: PublicStream }[];
    playback: PlaybackManager;
    transport: OutboundTransport;
    ranking: Parameters<NonNullable<StreamResolverTrace["ranking"]>>[0];
    review: RejectedSourceReview;
    preProbeDecisions: readonly PreProbeIdentityDecision[];
    rejections: readonly StreamRejection[];
  }) => void | Promise<void>;
  /** Test selection only; never emitted, never a production candidate identifier. */
  target?: Pick<NormalizedStreamSource, "providerId" | "url" | "requestHeaders">;
  log?: Logger;
  /** In-memory capture of the real logger's console output; never returned. */
  logOutput?: readonly string[];
  canaries?: readonly string[];
  /** Actual fixture-sensitive values, not a global secret-pattern dictionary. */
  sensitiveValues?: readonly string[];
}

const pipelineDimensions = [
  "identityState", "publicIdentityState", "preProbeIdentityState", "disposition", "admittedResources",
  "disappearanceDomain", "probe", "measuredSeconds", "validatedEffectiveYear", "validatedEffectiveSeason",
  "validatedEffectiveEpisode", "originsRejectedBeforeDedupe", "resourcePublicStreams", "rejectionStage",
  "rejectionReason", "effectiveIdentityFacts", "publicPrivacy", "observerPrivacy", "logPrivacy", "representativeUnmerged",
  "identityRejections", "transportSummaryCorrect", "preProbeDecision", "laterStagesNotReached",
  "confidenceRankingNeutral", "rejectReviewAvailable", "providerDiagnosticsPrivacy", "providersPrivacy",
  "tracePrivacy", "reporterPrivacy"
] as const;
const witnessDimensions = ["requestIdActuallyCopied", "requestPresentationActuallyCopied", "trustedRuntimeActuallyReceived"] as const;
const dimensionNames = new Set<string>([...pipelineDimensions, ...witnessDimensions]);
const scalarEnums = new Set([
  "UNKNOWN", "CORROBORATED", "SUSPICIOUS", "CONTRADICTION", "NOT_OBSERVABLE", "NOT_REACHED",
  "MISSING_OBSERVATION", "ABSENT", "ADMIT", "REJECT", "NONE", "IDENTITY", "URL_POLICY", "TRANSPORT",
  "MEDIA_QUALIFICATION", "DEDUPE", "PROBE_BUDGET", "PROVIDER_QUOTA", "VERIFIED", "verified", "reachable",
  "unreachable", "timeout", "budget_exhausted", "route_rejected", "unknown", "provider", "normalized",
  "deduplicated", "probed", "admitted", "final", "MATCH", "CONTINUE", "MEASURED_RUNTIME_CONTRADICTION",
  "EPISODE_COORDINATE_CONFLICT", "KIND_CONFLICT", "EXTERNAL_ID_CONFLICT", "MOVIE_YEAR_CONFLICT"
]);

/** Witnesses cannot replace ANY pipeline observation (even one newly added later). */
export function withWitnesses(observed: Dimensions, witnesses: Dimensions): Dimensions {
  for (const key of Object.keys(witnesses)) {
    if (Object.hasOwn(observed, key) || !witnessDimensions.includes(key as typeof witnessDimensions[number])) {
      throw new Error("Auxiliary dimension is reserved or unsupported");
    }
  }
  return { ...observed, ...witnesses };
}

/** AC-ID-070: second token in bridge-owned name summary only, never title/filename. */
export function publicIdentityState(stream: Pick<PublicStream, "name" | "title"> | undefined): string {
  if (!stream) return "ABSENT";
  const match = /^(?:HTTPS?\u2713?|Tribler) · ID([?!\u2713])(?: · (?:\d{3,4}p|\d+(?:\.\d)?(?:MB|GB)|\d+\.\ds|\d+ seeds?))*$/.exec(stream.name ?? "");
  return match?.[1] === "?" ? "UNKNOWN" : match?.[1] === "!" ? "SUSPICIOUS"
    : match?.[1] === "\u2713" ? "CORROBORATED" : "NOT_OBSERVABLE";
}

/** Entire bridge-owned public name, without removing forbidden components.
 * Identity presence is checked separately; plain HTTP is valid without probe.
 */
export function compactTransportSummaryCorrect(name: string, protocol: "http" | "https", verified: boolean): boolean {
  const parts = name.split(" · ");
  const expected = protocol.toUpperCase() + (verified ? "\u2713" : "");
  if (publicTransportToken(name) !== expected || parts[0] !== expected) return false;
  return parts.slice(1).every((part, index) => (index === 0 && /^ID[?!\u2713]$/.test(part))
    || /^(?:\d{3,4}p|\d+MB|\d+\.\dGB|\d+\.\ds|\d+ seeds?)$/.test(part));
}

/** Recognize the actual transport token without making its surrounding text valid. */
export function publicTransportToken(name: string): string | undefined {
  const tokens = name.split(" · ").filter(part => /^HTTPS?\u2713?$/.test(part));
  return tokens.length === 1 ? tokens[0] : undefined;
}

/** Fixture-scoped substring isolation, including embedded/encoded values.
 * A clean result means absence of these actual values, not universal privacy.
 */
export function fixturePrivacySafe(value: unknown, sensitiveValues: readonly string[]): boolean {
  const needles = [...new Set(sensitiveValues.filter(Boolean).flatMap(text =>
    [text, encodeURIComponent(text), encodeURI(text)]))];
  const inspect = (item: unknown): boolean => {
    if (typeof item === "string") {
      let text = item;
      for (let pass = 0; pass < 3; pass += 1) {
        if (needles.some(needle => text.includes(needle))) return false;
        try { const decoded = decodeURIComponent(text); if (decoded === text) break; text = decoded; }
        catch { break; }
      }
      return true;
    }
    if (Array.isArray(item)) return item.every(inspect);
    return typeof item !== "object" || item === null || Object.values(item).every(inspect);
  };
  return inspect(value);
}

function safeValue(value: unknown): DimensionValue {
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string" && scalarEnums.has(value)) return value;
  throw new Error("Unsafe report scalar");
}
function safeDimensions(values: Dimensions): Dimensions {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (!dimensionNames.has(key)) throw new Error("Unsafe report dimension");
    return [key, safeValue(value)];
  }));
}

/** Closed output schema: validates everything before writing a single byte. */
export function serializeComparison(caseId: string, expected: Dimensions, observation: PipelineObservation, verdict: Verdict): string {
  if (!/^(?:\d{2}(?:[ab]|-(?:negative|recall|clean|independent))?|guardrail)$/.test(caseId)) {
    throw new Error("Unsafe report case identifier");
  }
  const dimension = (key: string): string => {
    if (!dimensionNames.has(key)) throw new Error("Unsafe report dimension");
    return key;
  };
  return "IDENTITY_QA " + JSON.stringify({
    caseId, expected: safeDimensions(expected), observed: safeDimensions(observation.dimensions),
    legacyAssessment: safeValue(observation.legacyAssessment),
    stages: Object.fromEntries(stageNames.map(stage => [stage, safeValue(observation.stages[stage])])),
    origins: observation.origins.map((origin, index) => ({
      id: "origin-" + (index + 1), disappearance: safeValue(origin.disappearance),
      candidateStages: Object.fromEntries(stageNames.map(stage => [stage, safeValue(origin.candidateStages[stage])]))
    })),
    candidates: observation.candidates.map((candidate, index) => {
      if (candidate.resource !== "NOT_OBSERVABLE" && !/^resource-\d+$/.test(candidate.resource)) {
        throw new Error("Unsafe report resource identifier");
      }
      return { id: "candidate-" + (index + 1), resource: candidate.resource, dimensions: safeDimensions(candidate.dimensions) };
    }),
    probeRequests: safeValue(observation.probeRequests),
    verdict: {
      passed: safeValue(verdict.passed),
      failures: verdict.failures.map(failure => ({
        dimension: dimension(failure.dimension), expected: safeValue(failure.expected), observed: safeValue(failure.observed)
      })),
      known: verdict.known.map(dimension), progress: verdict.progress.map(dimension)
    }
  }) + "\n";
}

/** Real resolver/protected sockets/public addon route; raw locators never leave this helper. */
export async function observePipeline(item: NormalizedMediaItem, upstream: DirtyUpstream,
  providers: readonly StreamProvider[], options: ObservationOptions = {}): Promise<PipelineObservation> {
  const log = options.log ?? silentLogger;
  const policy = new ExternalUrlPolicy({
    blockedEndpoints: [{ hostname: "127.0.0.1", port: "7000" }, { hostname: "127.0.0.1", port: "9999" }],
    allowedLoopbackUrls: upstream.allowedMediaUrls().concat(options.pinnedRequest ? [...(options.fixtureUrls ?? [])] : [])
  });
  const realTransport = new DirectTransport(policy, testConfig().httpPrivacy, log, options.pinnedRequest);
  const observedLocators = new Set<string>();
  // Observe actual boundary exceptions; delegate every request/security check unchanged.
  const transportErrors = new Map<string, DisappearanceDomain>();
  const transport: OutboundTransport = {
    id: realTransport.id, diagnostics: () => realTransport.diagnostics(),
    request: async (input, signal) => {
      observedLocators.add(input.url);
      try { const result = await realTransport.request(input, signal); observedLocators.add(result.effectiveUrl); return result; }
      catch (error) {
        const key = streamDeduplicationKey({ providerId: "boundary", type: "http", url: input.url,
          ...(input.sourceHeaders ? { requestHeaders: input.sourceHeaders } : {}) });
        if (key) transportErrors.set(key, error instanceof ExternalUrlPolicyError ? "URL_POLICY"
          : error instanceof OutboundRedirectError ? "TRANSPORT" : "NOT_OBSERVABLE");
        throw error;
      }
    }
  };
  const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 1000, maxCandidates: 8, maxConcurrent: 1,
    ...options.probeOptions }, log);
  const registry = new StreamProviderRegistry(1000, log);
  for (const provider of providers) registry.register(provider);
  const snapshots = new Map<Stage, readonly NormalizedStreamSource[]>();
  let providerRefs: readonly StreamCandidateRef[] | undefined;
  const candidateRefs = new WeakMap<NormalizedStreamSource, StreamCandidateRef>();
  const rejections = new Map<StreamCandidateRef, StreamRejection>();
  const preProbeDecisions = new Map<StreamCandidateRef, PreProbeIdentityDecision>();
  const review = new RejectedSourceReview(transport, item);
  try {
  const evaluation = new IdentityPrecisionEvaluation(providers.map(provider => provider.id), { diagnostics: true });
  const evaluationTrace = evaluation.itemTrace(item);
  let ranking: Parameters<NonNullable<StreamResolverTrace["ranking"]>>[0] = [];
  const resolver = new StreamResolver(registry, policy, probe, {
    ranking: entries => { ranking = entries; },
    stage: (stage, sources, refs) => {
      snapshots.set(stage, sources); evaluationTrace.stage(stage, sources);
      if (stage === "provider") providerRefs = refs;
      review.trace.stage(stage, sources, refs);
      if (refs) sources.forEach((source, index) => { candidateRefs.set(source, refs[index]!); });
    },
    ...(options.identityTrace === false ? {} : {
    preProbeIdentity: (event: PreProbeIdentityDecision) => { preProbeDecisions.set(event.candidate, event); },
    rejection: (event: StreamRejection) => {
      if (rejections.has(event.candidate)) throw new Error("Duplicate candidate rejection event");
      rejections.set(event.candidate, event);
      review.trace.rejection?.(event);
    } })
  });
  const playback = new PlaybackManager([new DirectHttpPlaybackBackend(transport)]);
  // Trusted request metadata is a substituted boundary, never candidate/effective evidence.
  const metadata: MovieMetadataLookup = {
    lookup: () => Promise.resolve({ title: item.title, ...(item.year !== undefined ? { year: item.year } : {}),
      ...(item.runtimeSeconds !== undefined ? { runtimeSeconds: item.runtimeSeconds } : {}) }),
    lookupSeries: () => Promise.resolve({ title: item.seriesTitle ?? item.title,
      ...(item.year !== undefined ? { year: item.year } : {}) })
  };
  const addon = createAddon({} as DownloadService, log, [], "http://127.0.0.1:7000", undefined, resolver, playback, metadata);
  const response = await request(express().use(getRouter(addon)))
    .get("/stream/" + (item.kind === "episode" ? "series" : "movie") + "/" + item.id + ".json");
  if (response.status !== 200) throw new Error("Synthetic public stream route failed");
  const streams = (response.body as { streams: PublicStream[] }).streams;
  if (!Array.isArray(streams)) throw new Error("Synthetic public stream schema failed");

  const publicSources: Array<{ source: NormalizedStreamSource; stream: PublicStream }> = [];
  for (const stream of streams) {
    const url = new URL(stream.url);
    const token = /^\/source\/([A-Za-z0-9_-]{32})\//.exec(url.pathname)?.[1];
    if (url.origin !== "http://127.0.0.1:7000" || !token) throw new Error("Public playback handle is not opaque localhost");
    const prepared = await playback.prepare(token);
    if (prepared.kind !== "direct" || !prepared.source) throw new Error("Unexpected synthetic backend");
    publicSources.push({ source: prepared.source, stream });
  }
  await options.inspect?.({ snapshots, publicSources, playback, transport, ranking, review,
    preProbeDecisions: [...preProbeDecisions.values()], rejections: [...rejections.values()] });
  const stages = Object.fromEntries(stageNames.map(stage => [stage, snapshots.get(stage)?.length ?? 0])) as Record<Stage, number>;
  const raw = snapshots.get("provider") ?? [];
  // Keys stay in memory; use EXACT production normalization/dedupe request equivalence.
  const keyOf = (source: NormalizedStreamSource): string | undefined => {
    const normalized = normalizeStreamSource(source, source.providerId);
    return normalized ? streamDeduplicationKey(normalized) : undefined;
  };
  const resourceKeys = [...new Set(raw.map(keyOf).filter((key): key is string => key !== undefined))];
  const candidateObservations = raw.map((candidate, index) => {
    const key = keyOf(candidate);
    const same = (source: NormalizedStreamSource): boolean =>
      key !== undefined && source.providerId === candidate.providerId && keyOf(source) === key;
    const ref = providerRefs?.[index];
    const unique = ref !== undefined || (key !== undefined && raw.filter(same).length === 1);
    const at = (stage: Stage): NormalizedStreamSource | undefined => {
      const matching = snapshots.get(stage)?.filter(source => ref ? candidateRefs.get(source) === ref : same(source)) ?? [];
      return unique && matching.length === 1 ? matching[0] : undefined;
    };
    const publicMatches = unique ? publicSources.filter(entry => ref ? candidateRefs.get(entry.source) === ref : same(entry.source)) : [];
    const publicStream = publicMatches.length === 1 ? publicMatches[0]!.stream : undefined;
    const probedSource = at("probed");
    const preProbe = ref && preProbeDecisions.get(ref);
    const rejection = ref && rejections.get(ref);
    const probed = probedSource?.directHttp;
    const errorDomain = key ? transportErrors.get(key) : undefined;
    const domain: DisappearanceDomain = publicStream ? "NONE" : rejection || preProbe?.decision === "REJECT" || (probedSource && getBridgeIdentityState(probedSource) === "CONTRADICTION") ? "IDENTITY"
      : unique && at("normalized") && !at("deduplicated") ? "DEDUPE"
      : unique && probed?.status === "route_rejected" && errorDomain ? errorDomain
      : unique && at("admitted") && !at("final") ? "PROVIDER_QUOTA"
      : unique && probe.diagnostics().enabled && at("deduplicated") && !at("admitted")
        && (!probed || probed.status === "budget_exhausted") ? "PROBE_BUDGET" : "NOT_OBSERVABLE";
    let lost = false;
    const candidateStages = Object.fromEntries(stageNames.map(stage => {
      const present = unique && (stage === "provider" || at(stage) !== undefined);
      const state = present ? "CONTINUE" : rejection?.stage === stage ? "REJECT" : lost ? "NOT_REACHED" : "NOT_OBSERVABLE";
      if (!present) lost = true;
      return [stage, state];
    })) as Record<Stage, "CONTINUE" | "REJECT" | "NOT_OBSERVABLE" | "NOT_REACHED">;
    const reachedProbe = at("probed") !== undefined;
    const facts = probed?.resourceIdentities ?? [];
    const fact = (name: "year" | "season" | "episode"): DimensionValue => {
      const values = [...new Set(facts.map(resource => resource[name]).filter(value => value !== undefined))];
      return values.length === 1 ? values[0]! : reachedProbe ? "NOT_OBSERVABLE" : unique ? "NOT_REACHED" : "NOT_OBSERVABLE";
    };
    const resourcePublicStreams = key === undefined ? "NOT_OBSERVABLE"
      : publicSources.filter(entry => keyOf(entry.source) === key).length;
    const dimensions: Dimensions = {
      // Read bridge-owned decisions; absence stays unclassified, never inferred
      // from transport, disappearance or the legacy evaluator.
      identityState: rejection?.identityState ?? (probedSource && getBridgeIdentityState(probedSource)) ?? "NOT_OBSERVABLE",
      preProbeIdentityState: preProbe?.identityState ?? "NOT_OBSERVABLE",
      publicIdentityState: !unique || publicMatches.length > 1 ? "NOT_OBSERVABLE" : publicIdentityState(publicStream),
      disposition: publicStream ? "ADMIT" : ["IDENTITY", "URL_POLICY", "TRANSPORT"].includes(domain) ? "REJECT" : "NOT_OBSERVABLE",
      disappearanceDomain: domain,
      probe: !unique ? "NOT_OBSERVABLE" : probed?.verified ? "VERIFIED" : probed?.status ?? (reachedProbe ? "NOT_OBSERVABLE" : "NOT_REACHED"),
      measuredSeconds: probed?.actualRuntimeSeconds ?? (reachedProbe ? "NOT_OBSERVABLE" : unique ? "NOT_REACHED" : "NOT_OBSERVABLE"),
      validatedEffectiveYear: fact("year"), validatedEffectiveSeason: fact("season"), validatedEffectiveEpisode: fact("episode"),
      resourcePublicStreams,
      rejectionStage: rejection?.stage ?? (domain === "IDENTITY" ? at("probed") ? "admitted" : "normalized" : "NOT_OBSERVABLE"),
      // Legacy evaluation reasons are observational, not a resolver reason code.
      rejectionReason: rejection?.reason ?? "NOT_OBSERVABLE", effectiveIdentityFacts: reachedProbe ? facts.length : unique ? "NOT_REACHED" : "NOT_OBSERVABLE",
      preProbeDecision: preProbe?.decision ?? "NOT_OBSERVABLE",
      laterStagesNotReached: unique ? ["deduplicated", "probed", "admitted", "final"].every(stage =>
        candidateStages[stage as Stage] === "NOT_REACHED") : "NOT_OBSERVABLE",
      confidenceRankingNeutral: "NOT_OBSERVABLE", // No refined confidence can be correlated to a score.
      rejectReviewAvailable: ref && review.idFor(ref) ? true : "NOT_OBSERVABLE",
      transportSummaryCorrect: publicStream ? compactTransportSummaryCorrect(publicStream.name ?? "",
        candidate.type === "https" ? "https" : "http", Boolean(probed?.verified)) : "NOT_OBSERVABLE"
    };
    return { raw: candidate, key, final: at("final"), dimensions,
      origin: { id: "origin-" + (index + 1), disappearance: domain, candidateStages },
      id: "candidate-" + (index + 1), resource: key === undefined ? "NOT_OBSERVABLE" : "resource-" + (resourceKeys.indexOf(key) + 1) };
  });
  const targetKey = options.target ? keyOf({ ...options.target, type: "http" }) : undefined;
  const selected = options.target
    ? candidateObservations.filter(candidate => candidate.raw.providerId === options.target!.providerId && candidate.key === targetKey)
    : resourceKeys.length === 1 ? candidateObservations.slice(0, 1) : [];
  const target = selected.length === 1 ? selected[0] : undefined;
  const unavailable = Object.fromEntries(pipelineDimensions.map(dimension => [dimension, "NOT_OBSERVABLE"]));
  const canaries = options.canaries ?? [];
  const privacyRequested = canaries.length > 0 || (options.sensitiveValues?.length ?? 0) > 0;
  const sensitive = new Set([...canaries, ...(options.sensitiveValues ?? []), ...observedLocators]);
  for (const source of raw) {
    for (const locator of [source.url, source.magnet, source.infoHash]) if (locator) sensitive.add(locator);
    for (const [name, value] of Object.entries(source.requestHeaders ?? {})) {
      if (value && !["Accept", "User-Agent"].includes(name)) sensitive.add(value);
    }
  }
  for (const locator of [...sensitive]) {
    try { const url = new URL(locator); sensitive.add(url.origin + url.pathname);
      for (const value of url.searchParams.values()) if (value) sensitive.add(value);
      if (url.hash.length > 1) sensitive.add(url.hash.slice(1));
    } catch { /* Non-locator fixture values are already retained. */ }
  }
  const safe = (value: unknown): boolean => fixturePrivacySafe(value, [...sensitive]);
  let providersPrivacy: DimensionValue = "NOT_OBSERVABLE";
  if (privacyRequested) {
    // Substitute only the app's resolver factory with the SAME already-run real
    // resolver. Exercise the real /providers handler; no alternate/debug route.
    const factorySpy = vi.spyOn(resolverFactory, "createStreamResolver").mockReturnValue(resolver);
    try {
      const { app } = createApp(testConfig(), log, undefined, [], policy, transport);
      const providerResponse = await request(app).get("/providers");
      if (providerResponse.status !== 200) throw new Error("Synthetic providers route failed");
      providersPrivacy = safe(providerResponse.body);
    } finally { factorySpy.mockRestore(); }
  }
  const observation: PipelineObservation = {
    dimensions: {
      ...(target?.dimensions ?? unavailable),
      admittedResources: streams.length, // GLOBAL, never an individual candidate disposition.
      identityRejections: registry.status().reduce((sum, entry) => sum + (entry.identityRejections ?? 0), 0),
      originsRejectedBeforeDedupe: candidateObservations.filter(candidate => candidate.origin.disappearance === "IDENTITY")
        .filter(candidate => candidate.origin.candidateStages.normalized !== "CONTINUE").length,
      representativeUnmerged: (snapshots.get("final") ?? []).every(source => raw.some(candidate => {
        const normalized = normalizeStreamSource(candidate, candidate.providerId);
        return normalized && source.providerId === normalized.providerId && keyOf(source) === keyOf(normalized)
          && JSON.stringify(source.metadata) === JSON.stringify(normalized.metadata);
      })),
      ...(privacyRequested ? { publicPrivacy: safe(response.body), observerPrivacy: safe(evaluation.report()),
        providerDiagnosticsPrivacy: safe(resolver.diagnostics()), providersPrivacy,
        logPrivacy: options.logOutput ? safe(options.logOutput) : "NOT_OBSERVABLE" } : {})
    },
    legacyAssessment: target?.final ? assessIdentity(item, target.final) : "NOT_REACHED", stages,
    origins: candidateObservations.map(candidate => candidate.origin),
    candidates: candidateObservations.map(candidate => ({ id: candidate.id, resource: candidate.resource, dimensions: candidate.dimensions })),
    probeRequests: probe.diagnostics().requests
  };
  if (privacyRequested) {
    // Available emitted QA trace only; raw transient stage snapshots are not a
    // sanitized product trace and are deliberately never serialized.
    const tracePrivacy = safe({ preProbeDecisions: [...preProbeDecisions.values()], rejections: [...rejections.values()], stages: observation.stages, origins: observation.origins, candidates: observation.candidates });
    const reporterPrivacy = safe(serializeComparison("guardrail", {}, observation,
      { passed: true, failures: [], known: [], progress: [] }));
    observation.dimensions = { ...observation.dimensions, tracePrivacy, reporterPrivacy };
  }
  return observation;
  } finally { await review.close(); }
}
