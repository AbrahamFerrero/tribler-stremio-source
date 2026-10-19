import type { NormalizedMediaItem, StreamProvider, NormalizedStreamSource, ProviderDiagnostic } from "../streams/types";
import { getBridgeIdentityState, type StreamResolverTrace } from "../streams/resolver";
import type { DirectStreamProbeDiagnostics } from "../streams/direct-stream-probe";
import type { RejectedSourceReview } from "./rejected-source-review";

export type ProviderFamily = "external_http" | "stremio_addon" | "catalog" | "local_json" | "other";
export function providerFamily(id: string): ProviderFamily {
  return id === "external_http" ? "external_http" : id.startsWith("stremio-addon-") ? "stremio_addon"
    : id.startsWith("catalog_") ? "catalog" : id === "local_json" ? "local_json" : "other";
}
const stages = ["provider", "normalized", "deduplicated", "probed", "admitted", "final"] as const;
export const EMPTY_OBSERVATIONS = ["NO_RAW_SOURCES", "PROVIDER_ERRORS", "PROVIDER_TIMEOUTS", "NO_DIRECT_SOURCES",
  "NO_PROBE_STARTS", "NO_VERIFIED_MP4", "MP4_WITHOUT_RUNTIME", "NO_MEASURED_REJECTION", "MEASURED_REVIEW_UNSUPPORTED",
  "REVIEW_POOL_AT_CAPACITY", "RUNTIME_UNAVAILABLE", "PROBE_DISABLED", "INSUFFICIENT_EVIDENCE"] as const;

/** Scalar observations only. Source objects, provider labels and errors never enter the report. */
export class IdentityDiagnostics {
  private readonly counts = Object.fromEntries(stages.map(stage => [stage, 0])) as Record<typeof stages[number], number>;
  private readonly families = new Map<ProviderFamily, { selected: number; calls: number; errors: number; timeouts: number; noResults: number }>();
  private readonly rawByProvider = new Map<string, number>();
  private starts = 0;
  private measuredRejections = 0;
  private transports = { http: 0, https: 0, torrent: 0 };
  private probes = { verified: 0, uncertain: 0, failed: 0, exhausted: 0, unexaminedDirect: 0,
    verifiedMp4: 0, mp4WithoutRuntime: 0, mp4Runtime: 0, hlsVodRuntime: 0 };
  private finalDirect = 0;
  private confidence = { UNKNOWN: 0, CONTRADICTION: 0, CORROBORATED: 0, SUSPICIOUS: 0, unclassified: 0 };

  constructor(private readonly item: NormalizedMediaItem, private readonly review: RejectedSourceReview) {}

  provider(provider: StreamProvider): StreamProvider {
    const family = providerFamily(provider.id);
    const row = this.families.get(family) ?? { selected: 0, calls: 0, errors: 0, timeouts: 0, noResults: 0 };
    row.selected += 1;
    this.families.set(family, row);
    return { id: provider.id, name: provider.name, ...(provider.type ? { type: provider.type } : {}),
      ...(provider.timeoutMs ? { timeoutMs: provider.timeoutMs } : {}), isEnabled: () => provider.isEnabled(),
      ...(provider.diagnosticDetails ? { diagnosticDetails: () => provider.diagnosticDetails!() } : {}),
      resolve: async (item, context) => {
        row.calls += 1;
        const result = await provider.resolve(item, context);
        if (!result.length) row.noResults += 1;
        return result;
      }
    };
  }

  readonly trace: StreamResolverTrace = {
    stage: (stage, sources, refs) => {
      this.counts[stage] = sources.length;
      this.review.trace.stage(stage, sources, refs);
      if (stage === "provider") for (const source of sources) {
        if (typeof source.providerId === "string") this.rawByProvider.set(source.providerId, (this.rawByProvider.get(source.providerId) ?? 0) + 1);
        if (source.type === "http") this.transports.http += 1;
        else if (source.type === "https") this.transports.https += 1;
        else if (source.type === "torrent" || source.type === "magnet") this.transports.torrent += 1;
      }
      if (stage === "probed") this.observeProbes(sources);
      if (stage === "final") for (const source of sources) {
        if (source.type === "http" || source.type === "https") this.finalDirect += 1;
        const state = getBridgeIdentityState(source);
        if (state) this.confidence[state] += 1;
        else this.confidence.unclassified += 1;
      }
    },
    rejection: event => {
      if (event.stage === "admitted" && event.reason === "MEASURED_RUNTIME_CONTRADICTION") this.measuredRejections += 1;
      this.review.trace.rejection?.(event);
    },
    probeNetworkStart: () => { this.starts += 1; }
  };

  private observeProbes(sources: readonly NormalizedStreamSource[]): void {
    for (const source of sources) {
      if (source.type !== "http" && source.type !== "https") continue;
      const probe = source.directHttp;
      if (!probe) { this.probes.unexaminedDirect += 1; continue; }
      if (probe.status === "budget_exhausted") this.probes.exhausted += 1;
      else if (probe.verified) this.probes.verified += 1;
      else if (probe.status === "unreachable" || probe.status === "route_rejected") this.probes.failed += 1;
      else this.probes.uncertain += 1;
      if (probe.verified && !probe.hls && probe.contentType === "video/mp4") {
        this.probes.verifiedMp4 += 1;
        if (probe.runtimeEvidence !== "mp4_mvhd" || !Number.isFinite(probe.actualRuntimeSeconds) || (probe.actualRuntimeSeconds ?? 0) <= 0) {
          this.probes.mp4WithoutRuntime += 1;
        }
      }
      if (probe.verified && Number.isFinite(probe.actualRuntimeSeconds) && (probe.actualRuntimeSeconds ?? 0) > 0) {
        if (probe.runtimeEvidence === "mp4_mvhd") this.probes.mp4Runtime += 1;
        if (probe.runtimeEvidence === "hls_vod") this.probes.hlsVodRuntime += 1;
      }
    }
  }

  report(probe: DirectStreamProbeDiagnostics | undefined, mediaHttpRequests = 0, diagnostics: readonly ProviderDiagnostic[] = []) {
    const families = [...this.families].map(([family, row]) => ({ family, ...row, errors: 0, timeouts: 0 }));
    if (!families.length) for (const diagnostic of diagnostics.filter(entry => entry.enabled)) {
      const family = providerFamily(diagnostic.id);
      let row = families.find(entry => entry.family === family);
      if (!row) { row = { family, selected: 0, calls: 0, errors: 0, timeouts: 0, noResults: 0 }; families.push(row); }
      row.selected += 1;
      if (diagnostic.status === "ok" || diagnostic.status === "error") row.calls += 1;
      if (diagnostic.status === "ok" && !this.rawByProvider.get(diagnostic.id)) row.noResults += 1;
    }
    for (const diagnostic of diagnostics) {
      const row = families.find(entry => entry.family === providerFamily(diagnostic.id));
      if (!row || diagnostic.status !== "error") continue;
      // This category is created by the registry from its own abort state,
      // never from provider error text; it also covers cancellation.
      if (diagnostic.lastError === "Provider timed out or was cancelled") row.timeouts += 1;
      else row.errors += 1;
    }
    const providers = { selected: 0, calls: 0, errors: 0, timeouts: 0, noResults: 0 };
    for (const row of families) for (const key of Object.keys(providers) as Array<keyof typeof providers>) providers[key] += row[key];
    const eligibleReviews = this.review.summaries().length;
    const exclusions = Math.max(0, this.measuredRejections - eligibleReviews);
    const observations: typeof EMPTY_OBSERVATIONS[number][] = [];
    if (!this.counts.provider) observations.push("NO_RAW_SOURCES");
    if (providers.errors) observations.push("PROVIDER_ERRORS");
    if (providers.timeouts) observations.push("PROVIDER_TIMEOUTS");
    if (!this.transports.http && !this.transports.https) observations.push("NO_DIRECT_SOURCES");
    if (!this.starts) observations.push("NO_PROBE_STARTS");
    if (!this.probes.verifiedMp4) observations.push("NO_VERIFIED_MP4");
    if (this.probes.mp4WithoutRuntime) observations.push("MP4_WITHOUT_RUNTIME");
    if (!this.measuredRejections) observations.push("NO_MEASURED_REJECTION");
    if (exclusions) observations.push("MEASURED_REVIEW_UNSUPPORTED");
    if (eligibleReviews === 16) observations.push("REVIEW_POOL_AT_CAPACITY");
    if (this.item.runtimeSeconds === undefined) observations.push("RUNTIME_UNAVAILABLE");
    if (!probe?.enabled) observations.push("PROBE_DISABLED");
    if (!eligibleReviews) observations.push("INSUFFICIENT_EVIDENCE");
    return { providers, families, stages: { ...this.counts }, transports: { ...this.transports },
      probe: { ...this.probes, starts: this.starts, cacheHits: probe?.cacheHits ?? 0, mediaHttpRequests },
      measuredRejections: this.measuredRejections, eligibleReviews, measuredWithoutEligibleReview: exclusions,
      pendingProviderOutcomes: Math.max(0, providers.calls - diagnostics.filter(entry => entry.status === "ok" || entry.status === "error").length),
      measuredRejectionStates: { CONTRADICTION: this.measuredRejections },
      finalDirect: this.finalDirect, finalConfidence: { ...this.confidence },
      trustedRuntimeAvailable: this.item.runtimeSeconds !== undefined, observations };
  }
}

export type IdentityDiagnosticReport = ReturnType<IdentityDiagnostics["report"]>;

export function formatIdentityDiagnostics(report: IdentityDiagnosticReport): string {
  return `providers selected/calls/errors/timeouts/empty=${report.providers.selected}/${report.providers.calls}/${report.providers.errors}/${report.providers.timeouts}/${report.providers.noResults}\n`
    + `stages raw/normalized/dedup/probed/admitted/final=${stages.map(stage => report.stages[stage]).join("/")}\n`
    + `probe starts/cache/verified/uncertain/failed/exhausted/unexamined=${report.probe.starts}/${report.probe.cacheHits}/${report.probe.verified}/${report.probe.uncertain}/${report.probe.failed}/${report.probe.exhausted}/${report.probe.unexaminedDirect}\n`
    + `measured MP4/HLS=${report.probe.mp4Runtime}/${report.probe.hlsVodRuntime}; measured rejects=${report.measuredRejections}; review eligible/excluded=${report.eligibleReviews}/${report.measuredWithoutEligibleReview}; final direct=${report.finalDirect}\n`
    + `media HTTP attempts=${report.probe.mediaHttpRequests}; final confidence=${JSON.stringify(report.finalConfidence)}\n`
    + `observations (non-exclusive): ${report.observations.join(", ")}`;
}
