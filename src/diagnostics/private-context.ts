import type { DiagnosticReport } from "./controller";
import { diagnosticId, validateDiagnosticReport } from "./report-model";
import { DIAGNOSTIC_LIMITS as L } from "./recorder";

const labelStates = ["CAPTURED", "ABSENT", "EMPTY", "INVALID_TYPE", "UNREADABLE", "OVER_LIMIT", "WITHHELD"] as const;
export type PrivateLabelState = typeof labelStates[number];
type LabelStatus = Record<"name" | "title" | "identityTitle", PrivateLabelState>;
/** Lexical predicates, not claims about the content. First matching predicate wins. */
export const privateLabelReasons = ["CONTROL", "URL_MARKER", "LOCATOR_CHARACTER", "MARKUP", "SENSITIVE_TERM", "OPAQUE_RUN", "UNSUPPORTED_CHARACTER"] as const;
export type PrivateLabelReason = typeof privateLabelReasons[number];
const sensitiveLabelTerm = new RegExp("\\b(?:" + ["authorization", "bearer", "cookie", "password", "secret", "token", "apikey"]
  .map(term => term.split("").join(" *")).join("|") + "|api[_ -]?key)\\b", "i");
type LabelReasons = Partial<Record<keyof LabelStatus, PrivateLabelReason>>;
export interface PrivateCandidateMetadata {
  /** Optional for historical metadata entries. Contains closed codes only. */
  labelStatus?: LabelStatus;
  /** Sparse; PRIVATE_LOCAL only. Missing on historical WITHHELD fields means unknown. */
  labelReasons?: LabelReasons;
  candidateId: string;
  name: string;
  title: string;
  identityTitle: string;
  season: number | null;
  episode: number | null;
}
export interface PrivateResolutionContext {
  /** A limit is recorded only when the controller actually rejects a context update. */
  metadataCapture?: "WITHIN_LIMITS" | "CONTEXT_LIMIT" | "REPORT_LIMIT";
  candidates?: PrivateCandidateMetadata[];
  title: string;
  /** Optional authoritative series label for fresh episode captures; absent in historical contexts. */
  seriesTitle?: string;
  mediaKind: "movie" | "series" | "episode" | "UNOBSERVED";
  season: number | null;
  episode: number | null;
  providers: Array<{ provider: number; id: string; name: string }>;
}
export interface PrivateDiagnosticReport {
  version: 1;
  privacy: "PRIVATE_LOCAL";
  report: DiagnosticReport;
  context: Array<PrivateResolutionContext & { resolutionId: string }>;
}
export type DiagnosticExport = DiagnosticReport | PrivateDiagnosticReport;

/** Format acceptance is not disclosure authority: callers must still require PRIVATE_LOCAL. */
export function safeContextLabel(input: unknown, max = 160): string {
  if (typeof input !== "string" || !Number.isInteger(max) || max < 0 || input.length > Math.min(max, 160)) return "";
  const text = normalizeLabelFormat(input);
  return labelRejection(text) ? "" : text;
}
/** Bounded input only. Preserve all words; never select a line or truncate hidden content. */
function normalizeLabelFormat(input: string): string {
  return input.replace(/[\t\n\v\f\r\u0085\p{Z}]+/gu, run => /^ +$/.test(run) ? run : " ").replace(/^ +| +$/g, "");
}
/** Separate privacy checks run on the entire formatted value, including every line. */
function labelRejection(input: string): PrivateLabelReason | undefined {
  for (const c of input) if (c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) return "CONTROL";
  // Compatibility folding is for detection only, never for the retained display text.
  const policyText = input.normalize("NFKC");
  const compact = policyText.replace(/\s+/gu, "");
  if (/https?:|file:|ftp:|magnet:|www\./i.test(compact)) return "URL_MARKER";
  if (/[\\/=@]/.test(policyText)) return "LOCATOR_CHARACTER";
  if (/[<>]/.test(policyText)) return "MARKUP";
  if (sensitiveLabelTerm.test(policyText)) return "SENSITIVE_TERM";
  if (/[a-f0-9]{32,}|[a-z0-9_-]{32,}/i.test(policyText)) return "OPAQUE_RUN";
  // Unicode text, punctuation and symbols; exclude invisible formats, lone surrogates,
  // private-use code points and percent-encoded payloads previously outside the allowlist.
  if (!/^[\p{L}\p{N}\p{M}\p{P}\p{S} ]*$/u.test(input) || /%/.test(policyText)) return "UNSUPPORTED_CHARACTER";
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new Error("INVALID_PRIVATE_REPORT");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("INVALID_PRIVATE_REPORT");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(k => !fields[k] || !("value" in fields[k]))) throw new Error("INVALID_PRIVATE_REPORT");
  return Object.fromEntries(keys.map(k => [k, fields[k]!.value]));
}
function array(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) throw new Error("INVALID_PRIVATE_REPORT");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== input.length + 1) throw new Error("INVALID_PRIVATE_REPORT");
  return Array.from({ length: input.length }, (_, i) => {
    const d = fields[String(i)]; if (!d || !("value" in d)) throw new Error("INVALID_PRIVATE_REPORT"); return d.value as unknown;
  });
}
export function projectPrivateCandidate(input: unknown): PrivateCandidateMetadata {
  const hasStatus = !!input && typeof input === "object" && Object.hasOwn(input, "labelStatus");
  const hasReasons = !!input && typeof input === "object" && Object.hasOwn(input, "labelReasons");
  const v = object(input, ["candidateId", "name", "title", "identityTitle", "season", "episode", ...(hasStatus ? ["labelStatus"] : []), ...(hasReasons ? ["labelReasons"] : [])]);
  if (hasStatus) {
    const status = object(v.labelStatus, ["name", "title", "identityTitle"]);
    for (const field of ["name", "title", "identityTitle"] as const) {
      if (!labelStates.includes(status[field] as PrivateLabelState) || (status[field] === "CAPTURED") !== (typeof v[field] === "string" && v[field] !== "")) throw new Error("INVALID_PRIVATE_REPORT");
    }
    v.labelStatus = status;
  }
  if (hasReasons) {
    if (!hasStatus) throw new Error("INVALID_PRIVATE_REPORT");
    // No arbitrary keys, accessors, payloads or explanations may enter the private DTO.
    const fields = ["name", "title", "identityTitle"].filter(k => !!v.labelReasons && typeof v.labelReasons === "object" && Object.hasOwn(v.labelReasons, k));
    const reasons = object(v.labelReasons, fields);
    if (!fields.length || fields.some(k => (v.labelStatus as LabelStatus)[k as keyof LabelStatus] !== "WITHHELD" || !privateLabelReasons.includes(reasons[k] as PrivateLabelReason))) throw new Error("INVALID_PRIVATE_REPORT");
    v.labelReasons = reasons;
  }
  if (!diagnosticId(v.candidateId) || [v.name, v.title, v.identityTitle].some(t => typeof t !== "string" || safeContextLabel(t) !== t) ||
      [v.season, v.episode].some(n => n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100000))) throw new Error("INVALID_PRIVATE_REPORT");
  return v as unknown as PrivateCandidateMetadata;
}
/** Only own data fields; no accessors, descriptions, locators or inferred values. */
export function sourceDeclarations(source: unknown): Omit<PrivateCandidateMetadata, "candidateId"> {
  // Distinguish absent own fields from rejected types/accessors without invoking them.
  const own = (value: unknown, key: string): { value: unknown; state?: "ABSENT" | "UNREADABLE" } => {
    if (!value || typeof value !== "object") return { value: undefined, state: "ABSENT" };
    try {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return !d ? { value: undefined, state: "ABSENT" } : "value" in d ? { value: d.value } : { value: undefined, state: "UNREADABLE" };
    } catch { return { value: undefined, state: "UNREADABLE" }; }
  };
  const label = (d: ReturnType<typeof own>): { text: string; status: PrivateLabelState; reason?: PrivateLabelReason } => {
    if (d.state) return { text: "", status: d.state };
    if (typeof d.value !== "string") return { text: "", status: "INVALID_TYPE" };
    if (d.value.length > 160) return { text: "", status: "OVER_LIMIT" };
    const text = normalizeLabelFormat(d.value);
    const reason = labelRejection(text);
    if (reason) return { text: "", status: "WITHHELD", reason };
    return { text, status: text ? "CAPTURED" : "EMPTY" };
  };
  const metadata = own(source, "metadata");
  const identity = metadata.state ? metadata : own(metadata.value, "identity");
  const identityField = (key: string) => identity.state ? identity : own(identity.value, key);
  const name = label(own(source, "name")), title = label(own(source, "title")), identityTitle = label(identityField("title"));
  const reasons: LabelReasons = {};
  if (name.reason) reasons.name = name.reason;
  if (title.reason) reasons.title = title.reason;
  if (identityTitle.reason) reasons.identityTitle = identityTitle.reason;
  const coordinate = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100000 ? n : null;
  return { name: name.text, title: title.text, identityTitle: identityTitle.text,
    labelStatus: { name: name.status, title: title.status, identityTitle: identityTitle.status },
    ...(Object.keys(reasons).length ? { labelReasons: reasons } : {}),
    season: coordinate(identityField("season").value), episode: coordinate(identityField("episode").value) };
}
export class PrivateContextLimitError extends Error {}

export function projectPrivateContext(input: unknown): PrivateResolutionContext {
  const hasCapture = !!input && typeof input === "object" && Object.hasOwn(input, "metadataCapture");
  const hasCandidates = !!input && typeof input === "object" && Object.hasOwn(input, "candidates");
  const hasSeriesTitle = !!input && typeof input === "object" && Object.hasOwn(input, "seriesTitle");
  const v = object(input, ["title", "mediaKind", "season", "episode", "providers", ...(hasSeriesTitle ? ["seriesTitle"] : []), ...(hasCandidates ? ["candidates"] : []), ...(hasCapture ? ["metadataCapture"] : [])]);
  if (hasCapture && !["WITHIN_LIMITS", "CONTEXT_LIMIT", "REPORT_LIMIT"].includes(v.metadataCapture as string)) throw new Error("INVALID_PRIVATE_REPORT");
  if (hasSeriesTitle && (v.mediaKind !== "episode" || typeof v.seriesTitle !== "string" || safeContextLabel(v.seriesTitle) !== v.seriesTitle)) throw new Error("INVALID_PRIVATE_REPORT");
  if (typeof v.title !== "string" || safeContextLabel(v.title) !== v.title ||
      typeof v.mediaKind !== "string" || !["movie", "series", "episode", "UNOBSERVED"].includes(v.mediaKind) ||
      [v.season, v.episode].some(n => n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 9999))) throw new Error("INVALID_PRIVATE_REPORT");
  const seen = new Set<number>();
  const providers = array(v.providers, 64).map(input => {
    const p = object(input, ["provider", "id", "name"]);
    if (typeof p.provider !== "number" || !Number.isInteger(p.provider) || p.provider < 0 || p.provider >= 64 || seen.has(p.provider) ||
        typeof p.id !== "string" || typeof p.name !== "string" || safeContextLabel(p.id, 96) !== p.id || safeContextLabel(p.name, 96) !== p.name) throw new Error("INVALID_PRIVATE_REPORT");
    seen.add(p.provider); return { provider: p.provider, id: p.id, name: p.name };
  });
  const candidateIds = new Set<string>();
  const candidates = hasCandidates ? array(v.candidates, L.candidates).map(input => {
    const c = projectPrivateCandidate(input);
    if (candidateIds.has(c.candidateId)) throw new Error("INVALID_PRIVATE_REPORT");
    candidateIds.add(c.candidateId); return c;
  }) : undefined;
  const context: PrivateResolutionContext = { title: v.title, mediaKind: v.mediaKind as PrivateResolutionContext["mediaKind"],
    season: v.season as number | null, episode: v.episode as number | null, providers, ...(hasCapture ? { metadataCapture: v.metadataCapture as PrivateResolutionContext["metadataCapture"] & string } : {}), ...(candidates ? { candidates } : {}), ...(hasSeriesTitle ? { seriesTitle: v.seriesTitle as string } : {}) };
  if (Buffer.byteLength(JSON.stringify(context)) > 32768) throw new PrivateContextLimitError("INVALID_PRIVATE_REPORT");
  return context;
}
export function validatePrivateReport(input: unknown): PrivateDiagnosticReport {
  try {
    const v = object(input, ["version", "privacy", "report", "context"]);
    if (v.version !== 1 || v.privacy !== "PRIVATE_LOCAL") throw new Error("INVALID_PRIVATE_REPORT");
    const report = validateDiagnosticReport(v.report); const seen = new Set<string>();
    const context = array(v.context, L.resolutions).map(input => {
      const c = object(input, ["resolutionId", "title", "mediaKind", "season", "episode", "providers", ...(!!input && typeof input === "object" && Object.hasOwn(input, "seriesTitle") ? ["seriesTitle"] : []), ...(!!input && typeof input === "object" && Object.hasOwn(input, "candidates") ? ["candidates"] : []), ...(!!input && typeof input === "object" && Object.hasOwn(input, "metadataCapture") ? ["metadataCapture"] : [])]);
      if (!diagnosticId(c.resolutionId) || seen.has(c.resolutionId) || !report.resolutions.some(r => r.id === c.resolutionId)) throw new Error("INVALID_PRIVATE_REPORT");
      seen.add(c.resolutionId); const { resolutionId, ...fields } = c;
      const safe = projectPrivateContext(fields);
      const resolution = report.resolutions.find(r => r.id === resolutionId)!;
      if (safe.candidates?.some(c => !resolution.events.some(e => e.kind === "SOURCE" && e.candidateId === c.candidateId))) throw new Error("INVALID_PRIVATE_REPORT");
      const requested = resolution.events.find(e => e.kind === "REQUEST");
      if (requested?.kind === "REQUEST" && requested.mediaKind !== safe.mediaKind) throw new Error("INVALID_PRIVATE_REPORT");
      if (safe.providers.some(p => !resolution.events.some(e => e.kind === "PROVIDER_STATE" && e.provider === p.provider))) throw new Error("INVALID_PRIVATE_REPORT");
      return { resolutionId, ...safe };
    });
    const result: PrivateDiagnosticReport = { version: 1, privacy: "PRIVATE_LOCAL", report, context };
    if (Buffer.byteLength(JSON.stringify(result)) > L.dtoBytes) throw new Error("INVALID_PRIVATE_REPORT");
    return result;
  } catch { throw new Error("INVALID_PRIVATE_REPORT"); }
}
export function validateDiagnosticExport(input: unknown): DiagnosticExport {
  const fields = input && typeof input === "object" ? Object.getOwnPropertyDescriptors(input) : {};
  return Object.hasOwn(fields, "privacy") ? validatePrivateReport(input) : validateDiagnosticReport(input);
}
/** Projection from the controlled model: no private context keys can cross this boundary. */
export function anonymizeDiagnosticExport(input: unknown): DiagnosticReport {
  const data = validateDiagnosticExport(input);
  return validateDiagnosticReport("privacy" in data ? data.report : data);
}
