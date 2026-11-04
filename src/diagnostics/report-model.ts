import type { DiagnosticReport } from "./controller";
import { projectDiagnosticEvent, type DiagnosticEvent } from "./events";
import { DIAGNOSTIC_LIMITS as L, type RecordedEvent } from "./recorder";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function diagnosticId(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
function fail(): never { throw new Error("INVALID_DIAGNOSTIC_REPORT"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(k => typeof k !== "string" || !("value" in descriptors[k]!))) return fail();
  return Object.fromEntries(keys.map(k => [k, descriptors[k as string]!.value as unknown]));
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = descriptors[String(i)]; if (!d || !("value" in d)) return fail(); return d.value as unknown;
  });
}
function integer(value: unknown, max: number): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max; }

/** Strict trust boundary for CLI/API data. Rebuild the same DTO, never redact free text. */
export function validateDiagnosticReport(input: unknown): DiagnosticReport {
  try {
    const r = record(input);
    exact(r, ["version", "id", "state", "reason", "reserved", "skippedConcurrent", "events", "resolutions"]);
    if ((r.version !== 1 && r.version !== 2 && r.version !== 3 && r.version !== 4 && r.version !== 5 && r.version !== 6 && r.version !== 7 && r.version !== 8) || !diagnosticId(r.id) || typeof r.state !== "string" || !["CLOSED", "TRUNCATED"].includes(r.state) ||
        typeof r.reason !== "string" || !["STOPPED", "EXPIRED", "RECORDER_FAILURE"].includes(r.reason) || !integer(r.reserved, L.resolutions) ||
        !integer(r.skippedConcurrent, r.reserved) || !integer(r.events, L.sessionEvents)) return fail();
    const version = r.version;
    const ids = new Set<string>(); let count = 0; let signatureObserved = false; let truncated = r.skippedConcurrent > 0 || r.reason === "RECORDER_FAILURE";
    const resolutions = array(r.resolutions, r.reserved).map(value => {
      const d = record(value); exact(d, ["id", "state", "events"]);
      if (!diagnosticId(d.id) || ids.has(d.id) || typeof d.state !== "string" || !["CLOSED", "TRUNCATED"].includes(d.state)) return fail();
      ids.add(d.id); if (d.state === "TRUNCATED") truncated = true;
      const candidates = new Map<string, number>();
      const events: RecordedEvent[] = array(d.events, L.resolutionEvents).map(value => {
        const e = record(value);
        let safe: DiagnosticEvent | undefined;
        let candidateId: string | undefined;
        if (Object.hasOwn(e, "candidateId")) {
          const id = e.candidateId;
          if (!(diagnosticId(id) || (e.kind === "GAP" && id === "UNOBSERVED"))) return fail();
          candidateId = id;
          if (id !== "UNOBSERVED" && !candidates.has(id)) candidates.set(id, candidates.size);
          if (candidates.size > L.candidates) return fail();
          const { candidateId: _id, ...fields } = e;
          void _id;
          safe = projectDiagnosticEvent({ ...fields, candidate: id === "UNOBSERVED" ? -1 : candidates.get(id)! } as DiagnosticEvent);
        } else {
          if (Object.hasOwn(e, "candidate")) return fail();
          safe = projectDiagnosticEvent(e as DiagnosticEvent);
        }
        if (!safe || (version < 3 && safe.kind === "EXCLUSION") || (version < 4 && safe.kind === "PROVIDER_FAILURE")
          || (version < 5 && safe.kind === "EXCLUSION" && safe.probeCause !== undefined)
          || (version < 6 && safe.kind === "EXCLUSION" && safe.hlsCause !== undefined)
          || (version < 7 && safe.kind === "DIRECT_MEDIA") || (version < 8 && safe.kind === "DIRECT_MEDIA_SIGNATURE")) return fail();
        if (r.version === 1 && ["REQUEST", "PROVIDER_STATE", "PROVIDER_COUNTS", "SOURCE"].includes(safe.kind)) return fail();
        if (safe.kind === "DIRECT_MEDIA_SIGNATURE") signatureObserved = true;
        count++; if (count > L.sessionEvents) return fail();
        if ("candidate" in safe) {
          if (candidateId === undefined) return fail();
          const { candidate: _candidate, ...fields } = safe;
          void _candidate;
          return { ...fields, candidateId };
        }
        if (candidateId !== undefined) return fail();
        return safe;
      });
      return { id: d.id, state: d.state as "CLOSED" | "TRUNCATED", events };
    });
    if (count !== r.events || (truncated && r.state !== "TRUNCATED") || (version === 8 && !signatureObserved)) return fail();
    const report: DiagnosticReport = { version: r.version, id: r.id, state: r.state as DiagnosticReport["state"],
      reason: r.reason as DiagnosticReport["reason"], reserved: r.reserved, skippedConcurrent: r.skippedConcurrent, events: r.events, resolutions };
    if (Buffer.byteLength(JSON.stringify(report)) > L.dtoBytes) return fail();
    return report;
  } catch { return fail(); }
}

export function serializeDiagnosticReport(input: unknown): string { return JSON.stringify(validateDiagnosticReport(input)); }
