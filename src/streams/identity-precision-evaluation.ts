import { identityMismatch, measuredRuntimeMismatch, normalizeCandidateIdentity, videoReleaseNames, mediaResourceBasename } from "./identity-qualification";
import { normalizeStreamSource } from "./normalization";
import type { StreamResolverTrace } from "./resolver";
import type { NormalizedMediaItem, NormalizedStreamSource } from "./types";

export type IdentityAssessment = "MATCH" | "UNKNOWN" | "SUSPICIOUS" | "CONTRADICTION";
export type IdentityReason = "SHARED_IDENTITY_CONTRADICTION" | "MEASURED_RUNTIME_CONTRADICTION"
  | "RESOURCE_TITLE_MATCH" | "RESOURCE_TITLE_DISAGREEMENT" | "STRUCTURED_EXTERNAL_ID_MATCH"
  | "NO_INDEPENDENT_CORROBORATION";
type Stage = Parameters<StreamResolverTrace["stage"]>[0];
type Counts = Record<IdentityAssessment, number>;
const stages: Stage[] = ["provider", "normalized", "deduplicated", "probed", "admitted", "final"];
const zero = (): Counts => ({ MATCH: 0, UNKNOWN: 0, SUSPICIOUS: 0, CONTRADICTION: 0 });
const titleKey = (value: string): string => value.normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function resourceTitle(source: NormalizedStreamSource): string | undefined {
  // Presentation labels can echo the request. Only filename/resource evidence
  // supplies textual corroboration here; diagnostics sanitize text separately.
  let filename = source.filename;
  if (!filename && source.url) {
    filename = mediaResourceBasename(source.url);
  }
  if (!filename || filename.length > 1024) return undefined;
  const names = videoReleaseNames({ providerId: source.providerId, type: source.type, filename });
  const name = names[0];
  if (!name) return undefined;
  const stem = name.replace(/\.[^.]+$/, "").split(
    /[._ -](?:(?:19|20)\d{2}|S\d{1,2}[._ -]?E\d{1,2}|Ep\d{1,3}|\d{3,4}p|BluRay|WEB-DL)(?=$|[._ -])/i
  )[0]!;
  const key = titleKey(stem);
  if (!/\p{L}/u.test(key) || /^(?:video|stream|variant|server|file|opaque|generic|part|master|index)(?: \d+)?$/.test(key)
    || /^[a-f0-9]{16,}$/.test(key)) return undefined;
  return key;
}

/** Diagnostic only: title disagreement never supplies a production rejection. */
function assessmentDetail(item: NormalizedMediaItem, source: NormalizedStreamSource): {
  assessment: IdentityAssessment; reason: IdentityReason;
  requestedTitleKey?: string; resourceTitleKey?: string;
} {
  if (identityMismatch(item, source)) return { assessment: "CONTRADICTION", reason: "SHARED_IDENTITY_CONTRADICTION" };
  if (measuredRuntimeMismatch(item, source)) return { assessment: "CONTRADICTION", reason: "MEASURED_RUNTIME_CONTRADICTION" };
  const requestedTitle = titleKey(item.kind === "episode" ? item.seriesTitle ?? item.title : item.title);
  const independentTitle = resourceTitle(source);
  if (requestedTitle && independentTitle) {
    // Exact normalized text is deliberately observational, including localized titles.
    return requestedTitle === independentTitle
      ? { assessment: "MATCH", reason: "RESOURCE_TITLE_MATCH", requestedTitleKey: requestedTitle, resourceTitleKey: independentTitle }
      : { assessment: "SUSPICIOUS", reason: "RESOURCE_TITLE_DISAGREEMENT", requestedTitleKey: requestedTitle, resourceTitleKey: independentTitle };
  }
  const identity = normalizeCandidateIdentity(source.metadata?.identity);
  for (const [namespace, id] of Object.entries(identity?.externalIds ?? {})) {
    if (Object.hasOwn(item.externalIds, namespace) && item.externalIds[namespace] === id)
      return { assessment: "MATCH", reason: "STRUCTURED_EXTERNAL_ID_MATCH" };
  }
  return { assessment: "UNKNOWN", reason: "NO_INDEPENDENT_CORROBORATION" };
}

export function assessIdentity(item: NormalizedMediaItem, source: NormalizedStreamSource): IdentityAssessment {
  return assessmentDetail(item, source).assessment;
}

/** Diagnostic text is optional: discard the whole value rather than retaining sensitive fragments. */
function safeDisplayText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 160
    || !/^[\p{L}\p{N} ._()'’-]+$/u.test(value)
    || /(?:secret|token|cookie|authorization|password|credential|api[ _-]?key|https?|magnet|localhost|private)/i.test(value)
    || /\b[\p{L}\p{N}_-]+\.(?!mkv\b|mp4\b|webm\b|avi\b|mov\b|m4v\b|ts\b|m2ts\b|m3u8\b)[\p{L}]{2,}\b/iu.test(value)
    || /[a-f0-9]{32,}|[A-Za-z0-9_-]{24,}/i.test(value)) return undefined;
  return value.trim();
}
const boundedNumber = (value: unknown, maximum: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined;
const safeKind = (value: unknown) => value === "movie" || value === "series" || value === "episode" ? value : undefined;
function evidence(item: NormalizedMediaItem, source: NormalizedStreamSource, detail: ReturnType<typeof assessmentDetail>) {
  const structured = normalizeCandidateIdentity(source.metadata?.identity);
  const filename = source.filename || (source.url ? mediaResourceBasename(source.url) : undefined);
  const requestedTitle = safeDisplayText(item.kind === "episode" ? item.seriesTitle ?? item.title : item.title);
  const safeFilename = safeDisplayText(filename);
  const probe = source.directHttp;
  const status = probe && ["verified", "reachable", "unreachable", "timeout", "budget_exhausted", "route_rejected", "unknown"].includes(probe.status)
    ? probe.status : undefined;
  return {
    requested: { title: requestedTitle,
      kind: safeKind(item.kind), year: boundedNumber(item.year, 9999),
      season: boundedNumber(item.season, 100_000), episode: boundedNumber(item.episode, 100_000),
      runtimeSeconds: boundedNumber(item.runtimeSeconds, 36_000) },
    candidate: { presentation: safeDisplayText(source.title), filename: safeFilename,
      resourceTitleOrigin: source.filename ? "filename" : source.url ? "url_basename" : "none" },
    comparison: { requestedTitleKey: requestedTitle ? safeDisplayText(detail.requestedTitleKey) : undefined,
      resourceTitleKey: safeFilename ? safeDisplayText(detail.resourceTitleKey) : undefined },
    structured: { kind: safeKind(structured?.kind), year: boundedNumber(structured?.year, 9999),
      season: boundedNumber(structured?.season, 100_000), episode: boundedNumber(structured?.episode, 100_000) },
    ...(status ? { probe: { status, verified: probe?.verified === true,
      runtimeEvidence: probe?.runtimeEvidence === "hls_vod" || probe?.runtimeEvidence === "mp4_mvhd" ? probe.runtimeEvidence : undefined,
      actualRuntimeSeconds: boundedNumber(probe?.actualRuntimeSeconds, 36_000),
      resources: probe?.resourceIdentities?.slice(0, 3).map((resource) => ({
        kind: safeKind(resource.kind), year: boundedNumber(resource.year, 9999),
        season: boundedNumber(resource.season, 100_000), episode: boundedNumber(resource.episode, 100_000)
      })) } } : {})
  };
}
interface IdentityObservation {
  evaluationIndex: number; candidateIndex: number; providerId: string; stage: Stage;
  assessment: IdentityAssessment; reasons: IdentityReason[];
  evidence: ReturnType<typeof evidence>;
}

/** Evaluation-only traces; optional bounded diagnostics never participate in resolver decisions. */
export class IdentityPrecisionEvaluation {
  private readonly providers = new Map<string, Record<Stage, Counts>>();
  private evaluationIndex = 0;
  private readonly observations: IdentityObservation[] = [];
  private readonly retained = Object.fromEntries(stages.map((stage) => [stage, 0])) as Record<Stage, number>;
  private readonly dropped = Object.fromEntries(stages.map((stage) => [stage, 0])) as Record<Stage, number>;
  private readonly limit: number;

  constructor(ids: readonly string[], private readonly options: { diagnostics?: boolean; maxObservationsPerStage?: number } = {}) {
    this.limit = options.maxObservationsPerStage ?? 1000;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 1000) throw new Error("Invalid identity observation limit");
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid identity audit provider ID");
      this.providers.set(id, Object.fromEntries(stages.map((stage) => [stage, zero()])) as Record<Stage, Counts>);
    }
  }

  itemTrace(item: NormalizedMediaItem): StreamResolverTrace {
    const evaluationIndex = ++this.evaluationIndex;
    return { stage: (stage, sources) => {
      for (const [candidateIndex, candidate] of sources.entries()) {
        const counts = this.providers.get(candidate.providerId)?.[stage];
        if (!counts) continue;
        // Raw providers cannot forge trusted probe runtime evidence.
        const source = stage === "provider" ? normalizeStreamSource(candidate, candidate.providerId) : candidate;
        if (!source) continue;
        const detail = assessmentDetail(item, source);
        counts[detail.assessment] += 1;
        if (this.options.diagnostics) {
          if (this.retained[stage] >= this.limit) this.dropped[stage] += 1;
          else {
            this.retained[stage] += 1;
            this.observations.push({ evaluationIndex, candidateIndex, providerId: candidate.providerId,
              stage, assessment: detail.assessment, reasons: [detail.reason], evidence: evidence(item, source, detail) });
          }
        }
      }
    } };
  }

  report() {
    return { observationOnly: true, providers: [...this.providers].map(([providerId, counts]) => ({
      providerId, stages: Object.fromEntries(stages.map((stage) => [stage, { ...counts[stage] }])) as Record<Stage, Counts>
    })), ...(this.options.diagnostics ? { diagnostics: { version: 1, maxObservationsPerStage: this.limit,
      droppedByStage: { ...this.dropped }, observations: structuredClone(this.observations) } } : {}) };
  }
}
