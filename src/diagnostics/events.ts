import type { DeterministicProbeCause, StreamExclusion, StreamProviderFailureCategory } from "../streams/resolver";
import type { HlsFailureCause, HlsFailurePhase } from "../streams/types";
import { videoNames, mediaMimes, mediaCauses, type DirectMediaEvidence, type DirectMediaSignatureEvidence } from "../streams/direct-media-evidence";

export type DiagnosticStage = "PROVIDER" | "NORMALIZED" | "DEDUPLICATED" | "PROBED" | "ADMITTED" | "FINAL";
export type DiagnosticDecision = "CONTINUE" | "REJECT" | "RETAIN";
export type DiagnosticIdentity = "UNCLASSIFIED" | "UNKNOWN" | "CORROBORATED" | "SUSPICIOUS" | "CONTRADICTION";
export type DiagnosticProbe = "UNOBSERVED" | "verified" | "reachable" | "unreachable" | "timeout" | "budget_exhausted" | "route_rejected" | "unknown";
export type DiagnosticReason = "KIND_CONFLICT" | "EXTERNAL_ID_CONFLICT" | "EPISODE_COORDINATE_CONFLICT" | "MOVIE_YEAR_CONFLICT" | "MEASURED_RUNTIME_CONTRADICTION";
export interface DiagnosticScores {
  score: number; availability: number; resolution: number; size: number;
  codec: number; metadata: number; transport: number;
}
export type DiagnosticEvent =
  | ({ kind: "DIRECT_MEDIA_SIGNATURE"; stage: "ADMITTED"; candidate: number } & DirectMediaSignatureEvidence)
  | ({ kind: "DIRECT_MEDIA"; stage: "ADMITTED"; candidate: number } & DirectMediaEvidence)
  | { kind: "REQUEST"; mediaKind: "movie" | "series" | "episode" | "UNOBSERVED" }
  | { kind: "PROVIDER_STATE"; provider: number; status: "ENABLED" | "DISABLED" | "INVOKED" | "RETURNED_ZERO" | "RETURNED_RESULTS" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "NOT_OBSERVED" }
  | { kind: "PROVIDER_FAILURE"; provider: number; category: StreamProviderFailureCategory }
  | { kind: "PROVIDER_COUNTS"; provider: number; received: number; delivered: number; limited: number }
  | { kind: "SOURCE"; candidate: number; provider: number; transport: "HTTP" | "HTTPS" | "MAGNET" | "TORRENT" | "UNOBSERVED"; height: number }
  | { kind: "STAGE"; stage: DiagnosticStage; count: number }
  | { kind: "CANDIDATE"; candidate: number; decision: DiagnosticDecision }
  | { kind: "SNAPSHOT"; stage: DiagnosticStage; count: number; observed: number }
  | { kind: "OBSERVATION"; stage: DiagnosticStage; candidate: number; identity: DiagnosticIdentity; probe: DiagnosticProbe }
  | { kind: "PRE_PROBE"; candidate: number; decision: "CONTINUE" | "REJECT"; identity: DiagnosticIdentity }
  | { kind: "REJECTION"; candidate: number; stage: "NORMALIZED" | "ADMITTED"; reason: DiagnosticReason; identity: "CONTRADICTION" }
  | { kind: "EXCLUSION"; candidate: number; stage: DiagnosticStage; reason: StreamExclusion["reason"]; probeCause?: DeterministicProbeCause; httpStatus?: number; hlsPhase?: HlsFailurePhase; hlsCause?: HlsFailureCause }
  | { kind: "GAP"; candidate: number; stage: DiagnosticStage; context: "CONTINUITY" | "RANKING" | "IDENTITY_GROUP"; reason: "INSUFFICIENT_EVIDENCE" | "UNOBSERVED" }
  | ({ kind: "RANKING"; candidate: number; position: number } & DiagnosticScores)
  | { kind: "END"; outcome: "SUCCEEDED" | "FAILED" | "CANCELLED" };

const stages = ["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"];
const identities = ["UNCLASSIFIED", "UNKNOWN", "CORROBORATED", "SUSPICIOUS", "CONTRADICTION"];
const probes = ["UNOBSERVED", "verified", "reachable", "unreachable", "timeout", "budget_exhausted", "route_rejected", "unknown"];
const reasons = ["KIND_CONFLICT", "EXTERNAL_ID_CONFLICT", "EPISODE_COORDINATE_CONFLICT", "MOVIE_YEAR_CONFLICT", "MEASURED_RUNTIME_CONTRADICTION"];
export const scoreFields = ["score", "availability", "resolution", "size", "codec", "metadata", "transport"] as const;
function member(value: unknown, allowed: readonly string[]): boolean { return typeof value === "string" && allowed.includes(value); }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max; }

/** A new, flat, validated primitive DTO. Never invoke accessors or retain input. */
export function projectDiagnosticEvent(event: DiagnosticEvent): DiagnosticEvent | undefined {
  if (!event || typeof event !== "object") return;
  const descriptors = Object.getOwnPropertyDescriptors(event);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 12 || keys.some(key => typeof key !== "string" || !("value" in descriptors[key]!))) return;
  const d: Record<string, unknown> = Object.fromEntries(keys.map(key => [key, descriptors[key as string]!.value as unknown]));
  const exact = (...fields: string[]) => keys.length === fields.length && fields.every(key => Object.hasOwn(d, key));
  const slot = () => integer(d.candidate, 0, 255);
  let valid = false;
  switch (d.kind) {
    case "DIRECT_MEDIA_SIGNATURE": valid = exact("kind", "stage", "candidate", "container", "mime", "response", "range", "verified")
      && slot() && d.stage === "ADMITTED" && member(d.container, ["mp4", "matroska"])
      && d.mime === "application/octet-stream" && d.response === 206 && d.range === true && d.verified === true; break;
    case "DIRECT_MEDIA": valid = exact("kind", "stage", "candidate", "filename", "urlName", "mime", "media", "mediaCause", "transport", "response", "range", "verified")
      && slot() && d.stage === "ADMITTED" && member(d.filename, videoNames) && member(d.urlName, videoNames.filter(n => n !== "ABSENT"))
      && member(d.mime, mediaMimes) && member(d.mediaCause, mediaCauses) && member(d.transport, probes) && typeof d.range === "boolean" && typeof d.verified === "boolean"
      && (d.response === 0 || integer(d.response, 100, 599))
      && (d.media === "ADMITTED" && d.mediaCause === "NONE"
        && (!["ABSENT", "NO_EXTENSION", "OTHER"].includes(String(d.filename)) || !["NO_EXTENSION", "OTHER"].includes(String(d.urlName))
          || (String(d.mime).startsWith("video/") || d.mime === "VIDEO_OTHER") && (d.response === 200 || d.response === 206 && d.verified && d.range))
        || d.media === "REJECTED" && d.mediaCause !== "NONE"
        && ["ABSENT", "NO_EXTENSION", "OTHER"].includes(String(d.filename)) && ["NO_EXTENSION", "OTHER"].includes(String(d.urlName))
        && (d.mediaCause === "MIME_ABSENT" ? ["ABSENT", "MALFORMED", "UNOBSERVED"].includes(String(d.mime))
          : d.mediaCause === "MIME_NOT_VIDEO" ? !["ABSENT", "MALFORMED", "UNOBSERVED"].includes(String(d.mime)) && !String(d.mime).startsWith("video/") && d.mime !== "VIDEO_OTHER"
          : d.mediaCause === "RANGE_NOT_VERIFIED" ? (String(d.mime).startsWith("video/") || d.mime === "VIDEO_OTHER") && d.response === 206 && (!d.verified || !d.range)
          : d.mediaCause === "HTTP_RESPONSE_NOT_ACCEPTED" ? (String(d.mime).startsWith("video/") || d.mime === "VIDEO_OTHER") && d.response !== 0 && d.response !== 200 && d.response !== 206
          : d.mediaCause === "EVIDENCE_UNDETERMINED" && d.response === 0
            && (String(d.mime).startsWith("video/") || d.mime === "VIDEO_OTHER" || d.transport === "UNOBSERVED" && d.mime === "UNOBSERVED" && !d.range && !d.verified))); break;
    case "REQUEST": valid = exact("kind", "mediaKind") && member(d.mediaKind, ["movie", "series", "episode", "UNOBSERVED"]); break;
    case "PROVIDER_STATE": valid = exact("kind", "provider", "status") && integer(d.provider, 0, 63) && member(d.status, ["ENABLED", "DISABLED", "INVOKED", "RETURNED_ZERO", "RETURNED_RESULTS", "FAILED", "TIMED_OUT", "CANCELLED", "NOT_OBSERVED"]); break;
    case "PROVIDER_FAILURE": valid = exact("kind", "provider", "category") && integer(d.provider, 0, 63) && member(d.category, ["REGISTRY_DEADLINE", "URL_POLICY_REJECTED", "CAUSE_UNDETERMINED"]); break;
    case "PROVIDER_COUNTS": valid = exact("kind", "provider", "received", "delivered", "limited") && integer(d.provider, 0, 63) && integer(d.received, 0, 0xffffffff) && integer(d.delivered, 0, 100) && integer(d.limited, 0, 0xffffffff) && Number(d.received) - Number(d.delivered) === d.limited; break;
    case "SOURCE": valid = exact("kind", "candidate", "provider", "transport", "height") && slot() && integer(d.provider, -1, 63) && member(d.transport, ["HTTP", "HTTPS", "MAGNET", "TORRENT", "UNOBSERVED"]) && integer(d.height, 0, 8640); break;
    case "STAGE": valid = exact("kind", "stage", "count") && member(d.stage, stages) && integer(d.count, 0, 256); break;
    case "CANDIDATE": valid = exact("kind", "candidate", "decision") && slot() && member(d.decision, ["CONTINUE", "REJECT", "RETAIN"]); break;
    case "SNAPSHOT": valid = exact("kind", "stage", "count", "observed") && member(d.stage, stages) && integer(d.count, 0, 0xffffffff) && integer(d.observed, 0, 256) && Number(d.observed) <= Number(d.count); break;
    case "OBSERVATION": valid = exact("kind", "stage", "candidate", "identity", "probe") && slot() && member(d.stage, stages) && member(d.identity, identities) && member(d.probe, probes); break;
    case "PRE_PROBE": valid = exact("kind", "candidate", "decision", "identity") && slot() && member(d.decision, ["CONTINUE", "REJECT"]) && member(d.identity, ["UNCLASSIFIED", "UNKNOWN", "CONTRADICTION"]); break;
    case "REJECTION": valid = exact("kind", "candidate", "stage", "reason", "identity") && slot() && member(d.stage, ["NORMALIZED", "ADMITTED"]) && member(d.reason, reasons) && d.identity === "CONTRADICTION"; break;
    case "EXCLUSION": valid = exact("kind", "candidate", "stage", "reason", ...["probeCause", "httpStatus", "hlsPhase", "hlsCause"].filter(k => Object.hasOwn(d, k))) && slot()
      && (!Object.hasOwn(d, "probeCause") || (d.stage === "ADMITTED" && d.reason === "DETERMINISTIC_PROBE_REJECTION"
        && member(d.probeCause, ["ROUTE_REJECTED", "ARCHIVE_ZIP", "DOCUMENT_REJECTED", "HTTP_CLIENT_ERROR", "CAUSE_UNDETERMINED"])))
      && (!Object.hasOwn(d, "hlsCause") || (d.stage === "ADMITTED" && d.reason === "HLS_NOT_VERIFIED"
        && member(d.hlsCause, ["HTTP_RESPONSE", "EMPTY_BODY", "MANIFEST_TOO_LARGE", "MANIFEST_LENGTH_MISMATCH", "MANIFEST_INVALID", "PLAYLIST_TYPE_MISMATCH", "PLAYLIST_DEPTH_LIMIT", "NO_MEDIA_REFERENCE", "NO_DISTINCT_MEDIA_REFERENCE", "RESOURCE_INVALID", "TIMEOUT", "ROUTE_REJECTED", "BUDGET_EXHAUSTED", "CAUSE_UNDETERMINED"])
        && (member(d.hlsPhase, ["INITIAL_MANIFEST", "VARIANT_PLAYLIST", "AUDIO_PLAYLIST", "MEDIA_RESOURCE", "MAP_RESOURCE", "KEY_RESOURCE"]) || (d.hlsCause === "CAUSE_UNDETERMINED" && !Object.hasOwn(d, "hlsPhase")))))
      && (!Object.hasOwn(d, "hlsPhase") || Object.hasOwn(d, "hlsCause"))
      && (d.probeCause === "HTTP_CLIENT_ERROR"
        ? integer(d.httpStatus, 400, 499) && ![408, 425, 429].includes(Number(d.httpStatus))
        : d.hlsCause === "HTTP_RESPONSE" ? integer(d.httpStatus, 100, 599) : !Object.hasOwn(d, "httpStatus")) && (
      d.stage === "NORMALIZED" && member(d.reason, ["INVALID_SOURCE", "IDENTITY_REJECTION", "URL_POLICY_REJECTION"]) ||
      d.stage === "DEDUPLICATED" && member(d.reason, ["DUPLICATE", "MISSING_DEDUP_KEY"]) ||
      d.stage === "ADMITTED" && member(d.reason, ["IDENTITY_REJECTION", "PROBE_BUDGET_EXHAUSTED", "DETERMINISTIC_PROBE_REJECTION", "HLS_NOT_VERIFIED", "DIRECT_MEDIA_NOT_VERIFIED", "PROBE_MISSING"]) ||
      d.stage === "FINAL" && d.reason === "PROVIDER_RESULT_LIMIT"); break;
    case "GAP": valid = exact("kind", "candidate", "stage", "context", "reason") && integer(d.candidate, -1, 255) && member(d.stage, stages) && member(d.context, ["CONTINUITY", "RANKING", "IDENTITY_GROUP"]) && member(d.reason, ["INSUFFICIENT_EVIDENCE", "UNOBSERVED"]); break;
    case "RANKING": valid = exact("kind", "candidate", "position", ...scoreFields) && slot() && integer(d.position, 1, 256) && scoreFields.every(key => typeof d[key] === "number" && Number.isFinite(d[key]) && Math.abs(d[key]) <= 10000); break;
    case "END": valid = exact("kind", "outcome") && member(d.outcome, ["SUCCEEDED", "FAILED", "CANCELLED"]); break;
  }
  return valid ? d as unknown as DiagnosticEvent : undefined;
}
