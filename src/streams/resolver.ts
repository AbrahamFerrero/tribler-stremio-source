import type { Logger } from "../logger";
import { validSeedCount } from "./seed-count";
import { ExternalUrlPolicy } from "../network/url-policy";
import { hasKnownDirectVideoName, normalizeStreamSource } from "./normalization";
import { streamDeduplicationKey } from "./stream-deduplication";
import { canClassifyAdmittedUnknown, canObservePreProbeMovieResourceYearConflict, effectiveEpisodeIdentityState, effectiveMovieIdentityState, identityMismatch, identityMismatchReason, measuredRuntimeMismatch, normalizeCandidateIdentity, sparseCandidateIdentityState } from "./identity-qualification";
import { effectiveStreamSize, streamHeight } from "./details";
import { DirectStreamProbe, isHlsCandidate } from "./direct-stream-probe";
import type { DirectStreamProbeDiagnostics } from "./direct-stream-probe";
import { scoreStream, streamScoreComponents, type StreamScoreComponents } from "./scoring";
import { defaultStreamRankingPolicy, type StreamRankingPolicy } from "./ranking-policy";
import type { BridgeIdentityState, NormalizedMediaItem, NormalizedStreamSource, ProviderDiagnostic, StreamProvider } from "./types";

const MAX_RAW_RESULTS_PER_PROVIDER = 100;

// Weak keys retain no candidates beyond their existing in-process lifetime.
// No setter or provider-controlled field is exposed; normalization creates new keys.
const bridgeIdentityStates = new WeakMap<NormalizedStreamSource, BridgeIdentityState>();

export function getBridgeIdentityState(source: NormalizedStreamSource): BridgeIdentityState | undefined {
  return bridgeIdentityStates.get(source);
}

function identityRankingGroup(source: NormalizedStreamSource): number {
  const state = getBridgeIdentityState(source);
  return state === "CORROBORATED" ? 0 : state === "SUSPICIOUS" ? 2 : 1;
}

/** Empty, immutable object used only for in-process reference equality. */
export type StreamCandidateRef = Readonly<object>;

export type PreProbeRejectionReason = "KIND_CONFLICT" | "EXTERNAL_ID_CONFLICT" | "EPISODE_COORDINATE_CONFLICT" | "MOVIE_YEAR_CONFLICT";

export type StreamRejection = {
  /** Opaque reference scoped to this resolve call; contains no source values. */
  candidate: StreamCandidateRef;
  identityState: "CONTRADICTION";
} & ({ stage: "admitted"; reason: "MEASURED_RUNTIME_CONTRADICTION" }
  | { stage: "normalized"; reason: PreProbeRejectionReason });

export interface PreProbeIdentityDecision {
  candidate: StreamCandidateRef;
  stage: "normalized";
  decision: "CONTINUE" | "REJECT";
  /** Absence is unclassified. CONTINUE is not an admission decision. */
  identityState?: "UNKNOWN" | "CONTRADICTION";
}

/** Optional in-memory instrumentation; no automatic logging or public API. */
export interface StreamResolverTrace {
  /** Optional call-local references align with sources at every snapshot. */
  stage(stage: "provider" | "normalized" | "deduplicated" | "probed" | "admitted" | "final", sources: readonly NormalizedStreamSource[],
    candidateRefs?: readonly StreamCandidateRef[]): void;
  rejection?(event: StreamRejection): void;
  preProbeIdentity?(event: PreProbeIdentityDecision): void;
  probeNetworkStart?(providerId: string): void;
  ranking?(candidates: readonly {
    transport: string; health?: string; responseHeaderLatencyMs?: number; seeds?: number; quality: number;
    score: number; components: StreamScoreComponents; providerId?: string;
  }[]): void;
}

function isDirect(source: NormalizedStreamSource): source is NormalizedStreamSource & { url: string } {
  return (source.type === "http" || source.type === "https") && Boolean(source.url);
}

function isVideoMedia(source: NormalizedStreamSource): boolean {
  return source.directHttp?.contentType?.startsWith("video/") ?? false;
}

function isVerifiedHls(source: NormalizedStreamSource): boolean {
  const probe = source.directHttp;
  return probe?.hls === true && probe.verified && probe.responseStatus === 200;
}

export function isDeterministicProbeRejection(source: NormalizedStreamSource): boolean {
  if (!isDirect(source)) return false;
  const probe = source.directHttp;
  if (!probe) return false;
  if (probe.status === "route_rejected" || probe.archiveFormat === "zip" || probe.documentFormat) return true;
  const responseStatus = probe.responseStatus;
  return probe.status === "unreachable" && responseStatus !== undefined
    && responseStatus >= 400 && responseStatus < 500 && ![408, 425, 429].includes(responseStatus);
}

/**
 * Direct URLs with a recognised video name retain the historic admission
 * path. Opaque URLs are fail-closed: the existing probe must have observed
 * video media in either a complete 200 response or a valid byte-range 206.
 */
function admitDirectMedia(source: NormalizedStreamSource): boolean {
  // A completed client error is stronger evidence than a video filename.
  // Request timeout, Too Early and rate limiting remain transient like 5xx.
  const probe = source.directHttp;
  if (isDirect(source) && probe?.status === "budget_exhausted") return false;
  if (isDeterministicProbeRejection(source)) return false;
  // A video-looking URL cannot override an explicitly failed HLS media-path probe.
  if (isDirect(source) && isHlsCandidate(source.url, source.directHttp?.contentType)) return isVerifiedHls(source);
  if (!isDirect(source) || hasKnownDirectVideoName(source)) return true;
  if (isVerifiedHls(source)) return true;
  if (!probe || !isVideoMedia(source)) return false;
  return probe.responseStatus === 200 || (probe.responseStatus === 206 && probe.verified && probe.rangeSupported);
}

export class StreamProviderRegistry {
  private readonly providers = new Map<string, StreamProvider>();
  private readonly diagnostics = new Map<string, ProviderDiagnostic>();
  private readonly enabledOverrides = new Map<string, boolean>();
  // Aborted in-process code cannot be forcibly stopped. Do not multiply its
  // outstanding work on retry; healthy providers still receive scheduler turns.
  private readonly abandonedProviders = new Map<StreamProvider, Set<Promise<NormalizedStreamSource[]>>>();
  private runningProviders = 0;
  private readonly providerWaiters: Array<() => void> = [];

  constructor(private readonly timeoutMs: number, private readonly log: Logger, private readonly maxConcurrent = 8) {}

  private details(provider: StreamProvider): Pick<ProviderDiagnostic, "type" | "supports" | "streamCapabilities"> {
    return {
      ...(provider.type ? { type: provider.type } : {}),
      ...(provider.diagnosticDetails?.() ?? {})
    };
  }

  register(provider: StreamProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate stream provider id: ${provider.id}`);
    this.providers.set(provider.id, provider);
    this.diagnostics.set(provider.id, {
      id: provider.id, name: provider.name, enabled: provider.isEnabled(),
      status: provider.isEnabled() ? "never-run" : "disabled", ...this.details(provider)
    });
  }

  active(): StreamProvider[] {
    return [...this.providers.values()].filter((provider) =>
      (this.enabledOverrides.get(provider.id) ?? provider.isEnabled())
    );
  }

  setEnabled(id: string, enabled: boolean): void {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown stream provider: ${id}`);
    this.enabledOverrides.set(id, enabled);
    this.diagnostics.set(id, {
      id, name: provider.name, enabled, status: enabled ? "never-run" : "disabled", ...this.details(provider)
    });
  }

  status(): ProviderDiagnostic[] {
    return [...this.diagnostics.values()].map((entry) => {
      const provider = this.providers.get(entry.id);
      return provider ? {
        ...entry,
        enabled: this.enabledOverrides.get(provider.id) ?? provider.isEnabled(),
        ...this.details(provider)
      } : { ...entry };
    });
  }

  recordIdentityRejections(counts: ReadonlyMap<string, number>): void {
    for (const [id, diagnostic] of this.diagnostics) {
      this.diagnostics.set(id, { ...diagnostic, identityRejections: counts.get(id) ?? 0 });
    }
  }

  private async acquireProviderSlot(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.runningProviders < this.maxConcurrent) {
      this.runningProviders += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const acquired = (): void => {
        signal?.removeEventListener("abort", cancelled);
        resolve(true);
      };
      const cancelled = (): void => {
        const index = this.providerWaiters.indexOf(acquired);
        if (index >= 0) this.providerWaiters.splice(index, 1);
        resolve(false);
      };
      this.providerWaiters.push(acquired);
      signal?.addEventListener("abort", cancelled, { once: true });
    });
  }

  private releaseProviderSlot(): void {
    const next = this.providerWaiters.shift();
    if (next) next();
    else this.runningProviders -= 1;
  }

  async resolveAll(item: NormalizedMediaItem, signal?: AbortSignal): Promise<NormalizedStreamSource[]> {
    const providers = this.active();
    const resolveProvider = async (provider: StreamProvider): Promise<NormalizedStreamSource[]> => {
      if (this.abandonedProviders.has(provider)) return [];
      if (!await this.acquireProviderSlot(signal)) return [];
      try {
      if (signal?.aborted || this.abandonedProviders.has(provider)) return [];
      const started = Date.now();
      const timeout = AbortSignal.timeout(provider.timeoutMs ?? this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        let settled = false;
        const execution = Promise.resolve().then(() => {
          if (combined.aborted) throw new Error("Provider timed out or was cancelled");
          return provider.resolve(item, { signal: combined });
        });
        const completed = (): void => {
          settled = true;
          const pending = this.abandonedProviders.get(provider);
          pending?.delete(execution);
          if (pending?.size === 0) this.abandonedProviders.delete(provider);
        };
        void execution.then(completed, completed);
        let aborted!: () => void;
        let streams: NormalizedStreamSource[];
        try {
          streams = await new Promise<NormalizedStreamSource[]>((resolve, reject) => {
            aborted = (): void => reject(new Error("Provider timed out or was cancelled"));
            combined.addEventListener("abort", aborted, { once: true });
            if (combined.aborted) aborted();
            void execution.then(resolve, reject);
          });
        } finally {
          combined.removeEventListener("abort", aborted);
          if (combined.aborted && !settled) {
            const pending = this.abandonedProviders.get(provider) ?? new Set();
            pending.add(execution);
            this.abandonedProviders.set(provider, pending);
          }
        }
        this.diagnostics.set(provider.id, {
          id: provider.id, name: provider.name, enabled: true, status: "ok", latencyMs: Date.now() - started,
          ...this.details(provider)
        });
        // A raw safety ceiling remains; the useful-result quota is applied
        // after identity qualification and per-provider deduplication.
        return streams.slice(0, MAX_RAW_RESULTS_PER_PROVIDER);
      } catch {
        // Classify from bridge-owned cancellation state, never provider error text.
        const message = combined.aborted
          ? "Provider timed out or was cancelled"
          : "Provider failed";
        this.diagnostics.set(provider.id, {
          id: provider.id, name: provider.name, enabled: provider.isEnabled(), status: "error",
          ...this.details(provider),
          latencyMs: Date.now() - started, lastError: message
        });
        this.log.warn("Stream provider failed", { provider: provider.id, error: message });
        return [];
      }
      } finally {
        this.releaseProviderSlot();
      }
    };
    return (await Promise.all(providers.map(resolveProvider))).flat();
  }
}

export class StreamResolver {
  constructor(
    private readonly registry: StreamProviderRegistry,
    private readonly policy: ExternalUrlPolicy,
    private readonly directProbe?: DirectStreamProbe,
    private readonly trace?: StreamResolverTrace,
    private readonly rankingPolicy: StreamRankingPolicy = defaultStreamRankingPolicy,
    private readonly maxResultsPerProvider = 50
  ) {}

  diagnostics(): ProviderDiagnostic[] { return this.registry.status(); }

  directProbeDiagnostics(): DirectStreamProbeDiagnostics | undefined {
    return this.directProbe?.diagnostics();
  }

  async resolve(item: NormalizedMediaItem, signal?: AbortSignal): Promise<NormalizedStreamSource[]> {
    const raw = await this.registry.resolveAll(item, signal);
    const references = this.trace?.rejection || this.trace?.preProbeIdentity
      ? new WeakMap<NormalizedStreamSource, StreamCandidateRef>() : undefined;
    const refsFor = (sources: readonly NormalizedStreamSource[]): readonly StreamCandidateRef[] | undefined =>
      references ? sources.map(source => references.get(source)!) : undefined;
    // One reference per intake occurrence, even if a provider repeats the same object.
    const rawRefs = references ? raw.map(() => Object.freeze({})) : undefined;
    this.trace?.stage("provider", raw, rawRefs);
    const probeEnabled = this.directProbe?.diagnostics().enabled ?? false;
    const valid: NormalizedStreamSource[] = [];
    const identityRejections = new Map<string, number>();
    // A selected copy cannot erase pending identity claims on an equivalent
    // resource. These transient keys use existing request equivalence only;
    // no evidence is merged and dedupe/admission remain unchanged.
    const pendingIdentityResources = new Set<string>();
    // Preserve a qualified title concern even if dedupe selects a neutral copy.
    // This records a state, never merges producer fields or counts votes.
    const titleConcernResources = new Set<string>();
    // Structured claims on any equivalent origin need provenance/composition
    // work before this resource-only slice can assign positive confidence.
    const claimedIdentityResources = new Set<string>();
    // Observation only: a later equivalent ID claim must not make a pending
    // composition dispute look like a standalone decisive year rejection.
    const preProbeYearIdResources = new Set<string>();
    if (references) for (const candidate of raw) {
      const source = normalizeStreamSource(candidate, candidate.providerId);
      if (!source || !normalizeCandidateIdentity(source.metadata?.identity)?.externalIds) continue;
      const key = streamDeduplicationKey(source);
      if (key) preProbeYearIdResources.add(key);
    }
    // Call-local decisions only: providers cannot declare their own probe priority.
    const deferredRuntimeSources = new WeakSet<NormalizedStreamSource>();
    for (const [index, candidate] of raw.entries()) {
      const source = normalizeStreamSource(candidate, candidate.providerId);
      if (!source) continue;
      const candidateRef = rawRefs?.[index];
      if (candidateRef) references?.set(source, candidateRef);
      if (source.metadata?.identity) {
        const key = streamDeduplicationKey(source);
        if (key) claimedIdentityResources.add(key);
      }
      const sparseState = sparseCandidateIdentityState(item, source);
      if (!sparseState) {
        const key = streamDeduplicationKey(source);
        if (key) pendingIdentityResources.add(key);
      } else if (sparseState === "SUSPICIOUS") {
        const key = streamDeduplicationKey(source);
        if (key) titleConcernResources.add(key);
      }
      // Give weak runtime text a bounded measurement opportunity; all other conflicts remain decisive.
      const deferTextualRuntime = isDirect(source) && probeEnabled;
      const mismatch = identityMismatchReason(item, source, { deferTextualRuntime });
      // Observe existing hard rejection decisions without authenticating claims
      // or changing qualification. Producer-year disputes and weak text remain unclassified.
      const observedReason = mismatch === "KIND_CONFLICT" || mismatch === "EPISODE_COORDINATE_CONFLICT"
        || mismatch === "EXTERNAL_ID_CONFLICT"
        ? mismatch : mismatch === "MOVIE_YEAR_CONFLICT" && candidateRef
          && !preProbeYearIdResources.has(streamDeduplicationKey(source)!)
          && canObservePreProbeMovieResourceYearConflict(item, source) ? mismatch : undefined;
      if (candidateRef) {
        this.trace?.preProbeIdentity?.({ candidate: candidateRef, stage: "normalized",
          decision: mismatch ? "REJECT" : "CONTINUE",
          ...(observedReason ? { identityState: "CONTRADICTION" as const }
            : !mismatch && canClassifyAdmittedUnknown(item, source) ? { identityState: "UNKNOWN" as const } : {}) });
        if (observedReason) this.trace?.rejection?.({ candidate: candidateRef, stage: "normalized",
          reason: observedReason, identityState: "CONTRADICTION" });
      }
      if (mismatch) {
        identityRejections.set(source.providerId, (identityRejections.get(source.providerId) ?? 0) + 1);
        continue;
      }
      if (deferTextualRuntime && identityMismatch(item, source)) deferredRuntimeSources.add(source);
      if ((source.type === "http" || source.type === "https" || source.type === "torrent") && source.url) {
        try { await this.policy.validate(source.url); } catch { continue; }
      }
      valid.push(source);
    }
    this.registry.recordIdentityRejections(identityRejections);
    this.trace?.stage("normalized", valid, refsFor(valid));
    const providerDistinct = new Map<string, Map<string, NormalizedStreamSource>>();
    for (const source of valid) {
      const key = streamDeduplicationKey(source);
      if (!key) continue;
      let distinct = providerDistinct.get(source.providerId);
      if (!distinct) {
        distinct = new Map();
        providerDistinct.set(source.providerId, distinct);
      }
      const previous = distinct.get(key);
      if (previous) {
        if (scoreStream(source, this.rankingPolicy) > scoreStream(previous, this.rankingPolicy)) distinct.set(key, source);
      } else {
        distinct.set(key, source);
      }
    }
    const deduplicated = new Map<string, NormalizedStreamSource>();
    for (const distinct of providerDistinct.values()) {
      for (const [key, source] of distinct) {
        const previous = deduplicated.get(key);
        if (!previous || scoreStream(source, this.rankingPolicy) > scoreStream(previous, this.rankingPolicy)) {
          deduplicated.set(key, source);
        }
      }
    }
    const deduplicatedSources = [...deduplicated.values()];
    this.trace?.stage("deduplicated", deduplicatedSources, refsFor(deduplicatedSources));
    const networkStart = this.trace?.probeNetworkStart?.bind(this.trace);
    const probed = await this.directProbe?.probe(deduplicatedSources, signal,
      (source) => isDeterministicProbeRejection(source) || measuredRuntimeMismatch(item, source) || identityMismatch(item, source),
      networkStart, source => deferredRuntimeSources.has(source))
      ?? deduplicatedSources;
    // The probe preserves input positions while replacing sources with measured copies.
    if (references) probed.forEach((source, index) => references.set(source, references.get(deduplicatedSources[index]!)!));
    const candidateRefs = refsFor(probed);
    this.trace?.stage("probed", probed, candidateRefs);
    const admitted = probed
      // A probe cap must not turn later direct URLs into unexamined playback tokens.
      .filter((source, index) => {
        const measuredMismatch = measuredRuntimeMismatch(item, source);
        if (measuredMismatch || identityMismatch(item, source)) {
          identityRejections.set(source.providerId, (identityRejections.get(source.providerId) ?? 0) + 1);
          if (measuredMismatch || source.directHttp?.movieResource || source.directHttp?.episodeResource) bridgeIdentityStates.set(source, "CONTRADICTION");
          if (measuredMismatch && candidateRefs) {
            this.trace?.rejection?.({ candidate: candidateRefs[index]!, stage: "admitted", reason: "MEASURED_RUNTIME_CONTRADICTION",
              identityState: "CONTRADICTION" });
          }
          return false;
        }
        const admitted = (!probeEnabled || !isDirect(source) || source.directHttp !== undefined)
          && admitDirectMedia(source);
        const key = admitted ? streamDeduplicationKey(source) : undefined;
        const effectiveState = admitted && key && !claimedIdentityResources.has(key)
          ? effectiveMovieIdentityState(item, source) ?? effectiveEpisodeIdentityState(item, source) : undefined;
        if (effectiveState) {
          bridgeIdentityStates.set(source, effectiveState);
        } else if (admitted && key && !pendingIdentityResources.has(key)) {
          const state = sparseCandidateIdentityState(item, source);
          if (state) bridgeIdentityStates.set(source, titleConcernResources.has(key) ? "SUSPICIOUS" : state);
        } else if (!admitted && source.directHttp?.status === "route_rejected") {
          // A blocked route supplies no effective identity. Preserve only a
          // qualified sparse UNKNOWN; route failure grants no identity verdict.
          const blockedKey = streamDeduplicationKey(source);
          if (blockedKey && !pendingIdentityResources.has(blockedKey)
            && !claimedIdentityResources.has(blockedKey) && !titleConcernResources.has(blockedKey)
            && canClassifyAdmittedUnknown(item, source)) bridgeIdentityStates.set(source, "UNKNOWN");
        }
        return admitted;
      });
    this.registry.recordIdentityRejections(identityRejections);
    this.trace?.stage("admitted", admitted, refsFor(admitted));
    const ranked = admitted
      .map((source, index) => ({ source, index }))
      .sort((left, right) => {
        const identityDifference = identityRankingGroup(left.source) - identityRankingGroup(right.source);
        if (identityDifference !== 0) return identityDifference;
        const scoreDifference = scoreStream(right.source, this.rankingPolicy) - scoreStream(left.source, this.rankingPolicy);
        if (scoreDifference !== 0) return scoreDifference;
        const seedDifference = (validSeedCount(right.source.seeds) ?? -1) - (validSeedCount(left.source.seeds) ?? -1);
        if (seedDifference !== 0) return seedDifference;
        const sizeDifference = (effectiveStreamSize(left.source) ?? Number.POSITIVE_INFINITY)
          - (effectiveStreamSize(right.source) ?? Number.POSITIVE_INFINITY);
        if (sizeDifference !== 0) return sizeDifference;
        return left.index - right.index;
      })
      .map(({ source }) => source);
    const providerCounts = new Map<string, number>();
    const final = ranked.filter((source) => {
      const count = providerCounts.get(source.providerId) ?? 0;
      if (count >= this.maxResultsPerProvider) return false;
      providerCounts.set(source.providerId, count + 1);
      return true;
    });
    this.trace?.ranking?.(final.map((source) => ({
      transport: source.type,
      ...(source.directHttp ? { health: source.directHttp.status } : {}),
      ...(source.directHttp?.responseHeaderLatencyMs !== undefined ? { responseHeaderLatencyMs: source.directHttp.responseHeaderLatencyMs } : {}),
      ...(source.seeds !== undefined ? { seeds: source.seeds } : {}),
      quality: streamHeight(source),
      score: scoreStream(source, this.rankingPolicy),
      components: streamScoreComponents(source, this.rankingPolicy),
      ...(/^[A-Za-z0-9_-]{1,64}$/.test(source.providerId) ? { providerId: source.providerId } : {})
    })));
    this.trace?.stage("final", final, refsFor(final));
    return final;
  }
}
