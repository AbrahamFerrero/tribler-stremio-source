import { randomUUID } from "node:crypto";
import { DIAGNOSTIC_LIMITS as L, DiagnosticRecorder, type DiagnosticEvent, type ResolutionReport } from "./recorder";
import { PrivateContextLimitError, projectPrivateCandidate, projectPrivateContext, type PrivateCandidateMetadata, type PrivateResolutionContext, type PrivateDiagnosticReport } from "./private-context";

export interface DiagnosticStart { ttlMs: number; resolutions: number; retainReport: boolean }
export interface DiagnosticCapture {
  privateContext?: (context: PrivateResolutionContext) => void;
  privateProvider?: (provider: PrivateResolutionContext["providers"][number]) => void;
  privateCandidate?: (slot: number, metadata: Omit<PrivateCandidateMetadata, "candidateId">) => void;
  record(event: DiagnosticEvent): void;
  finish(interrupted?: boolean): void;
  truncate(): void;
  isActive(): boolean;
}
export interface DiagnosticReport {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  id: string;
  state: "CLOSED" | "TRUNCATED";
  reason: "STOPPED" | "EXPIRED" | "RECORDER_FAILURE";
  reserved: number;
  skippedConcurrent: number;
  events: number;
  resolutions: ResolutionReport[];
}
interface Session {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  context?: Map<string, PrivateResolutionContext>;
  id: string;
  options: DiagnosticStart;
  expiresAt: number;
  reserved: number;
  skippedConcurrent: number;
  events: number;
  bytes: number;
  truncated: boolean;
  active: Set<string>;
  recorders: Map<string, DiagnosticRecorder>;
}

export function validDiagnosticStart(value: unknown): value is DiagnosticStart {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== 3 || keys.some(key => typeof key !== "string" ||
        !["ttlMs", "resolutions", "retainReport"].includes(key) || !("value" in fields[key]!))) return false;
    const ttlMs: unknown = fields.ttlMs!.value;
    const resolutions: unknown = fields.resolutions!.value;
    const retainReport: unknown = fields.retainReport!.value;
    return typeof ttlMs === "number" && Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= L.ttlMs &&
      typeof resolutions === "number" && Number.isInteger(resolutions) && resolutions > 0 && resolutions <= L.resolutions &&
      typeof retainReport === "boolean";
  } catch { return false; }
}

/** In-memory only. Diagnostic handles never control production work. */
export class DiagnosticController {
  private session: Session | undefined;
  private final: { expiresAt: number; report: DiagnosticReport; context?: PrivateDiagnosticReport["context"] } | undefined;
  private reportExpired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly createRecorder: (id: string) => DiagnosticRecorder = id => new DiagnosticRecorder(id)
  ) {}

  start(options: DiagnosticStart, privateContext = false): "STARTED" | "ACTIVE" | "INVALID" {
    this.sweep();
    if (!validDiagnosticStart(options)) return "INVALID";
    if (this.session) return "ACTIVE";
    this.final = undefined;
    this.reportExpired = false;
    this.session = {
      version: 1, ...(privateContext ? { context: new Map() } : {}),
      id: randomUUID(), options: { ttlMs: options.ttlMs, resolutions: options.resolutions, retainReport: options.retainReport },
      expiresAt: this.now() + options.ttlMs,
      reserved: 0, skippedConcurrent: 0, events: 0, bytes: 4096, truncated: false,
      active: new Set(), recorders: new Map()
    };
    this.arm(options.ttlMs);
    return "STARTED";
  }

  status() {
    this.sweep();
    const s = this.session;
    return s ? { state: "ON" as const, id: s.id, remainingMs: Math.max(0, s.expiresAt - this.now()),
      quota: s.options.resolutions, reserved: s.reserved, active: s.active.size,
      skippedConcurrent: s.skippedConcurrent, events: s.events, truncated: s.truncated, reportAvailable: false }
      : { state: "OFF" as const, reportAvailable: this.final !== undefined };
  }

  /** Reserve at entry, before work. No waiting, retries or production budget effects. */
  beginResolution(): DiagnosticCapture | undefined {
    this.sweep();
    const s = this.session;
    if (!s || s.reserved >= s.options.resolutions) return;
    s.reserved++;
    if (s.active.size >= L.concurrent) { s.skippedConcurrent++; s.truncated = true; return; }
    try {
      const id = randomUUID();
      const recorder = this.createRecorder(id);
      s.recorders.set(id, recorder);
      s.active.add(id);
      // Reserve more than the maximum resolution metadata; events accounted separately.
      s.bytes += 256;
      // Handles retain only IDs/controller, never the session, recorder or supplied event.
      return this.handle(s.id, id);
    } catch { this.close("RECORDER_FAILURE"); return; }
  }

  private handle(sessionId: string, id: string): DiagnosticCapture {
    return {
      ...(this.session?.context ? { privateContext: (context: PrivateResolutionContext) => this.captureContext(sessionId, id, context) } : {}),
      ...(this.session?.context ? { privateProvider: (provider: PrivateResolutionContext["providers"][number]) => {
        this.sweep(); const s = this.session;
        if (!s || s.id !== sessionId || !s.active.has(id)) return;
        const context = s.context?.get(id);
        if (context && !privateContextLimited(context)) this.captureContext(sessionId, id, { ...context, providers: [...context.providers, provider] });
      } } : {}),
      ...(this.session?.context ? { privateCandidate: (slot: number, metadata: Omit<PrivateCandidateMetadata, "candidateId">) => {
        this.sweep(); const s = this.session;
        if (!s || s.id !== sessionId || !s.active.has(id)) return;
        const recorder = s.recorders.get(id)!;
        if (recorder.isTruncated()) return;
        const candidateId = recorder.candidateId(slot);
        const context = s.context?.get(id);
        if (!context || privateContextLimited(context) || !candidateId || context.candidates?.some(c => c.candidateId === candidateId)) return;
        try {
          const candidate = projectPrivateCandidate({ candidateId, ...metadata });
          this.captureContext(sessionId, id, { ...context, candidates: [...(context.candidates ?? []), candidate] });
        } catch { this.truncate(sessionId, id); }
      } } : {}),
      record: event => this.capture(sessionId, id, event),
      finish: interrupted => this.finish(sessionId, id, interrupted),
      truncate: () => this.truncate(sessionId, id),
      isActive: () => {
        this.sweep();
        const s = this.session;
        if (!s || s.id !== sessionId || !s.active.has(id)) return false;
        try { return !s.recorders.get(id)!.isTruncated(); }
        catch { this.close("RECORDER_FAILURE"); return false; }
      }
    };
  }

  private capture(sessionId: string, id: string, event: DiagnosticEvent): void {
    this.sweep();
    const s = this.session;
    if (!s || s.id !== sessionId || !s.active.has(id)) return;
    try {
      const recorder = s.recorders.get(id)!;
      let recorded = false;
      recorder.record(event, bytes => {
        if (s.events >= L.sessionEvents || s.bytes + bytes > L.dtoBytes) { s.truncated = true; return false; }
        s.events++; s.bytes += bytes; recorded = true; return true;
      });
      const kind: unknown = Object.getOwnPropertyDescriptor(event, "kind")?.value;
      if (recorded && kind === "DIRECT_MEDIA") s.version = 7;
      else if (recorded && kind === "EXCLUSION" && Object.hasOwn(event, "hlsCause") && s.version < 6) s.version = 6;
      else if (recorded && kind === "EXCLUSION" && Object.hasOwn(event, "probeCause") && s.version < 5) s.version = 5;
      else if (kind === "PROVIDER_FAILURE" && s.version < 4) s.version = 4;
      else if (kind === "EXCLUSION" && s.version < 3) s.version = 3;
      else if (s.version < 2 && typeof kind === "string" && ["REQUEST", "PROVIDER_STATE", "PROVIDER_COUNTS", "SOURCE"].includes(kind)) s.version = 2;
      // Recorder truncation (including invalid input) is visible at session level.
      if (recorder.isTruncated()) s.truncated = true;
    } catch { this.close("RECORDER_FAILURE"); }
  }

  private captureContext(sessionId: string, id: string, context: PrivateResolutionContext): void {
    this.sweep(); const s = this.session;
    if (!s || s.id !== sessionId || !s.context || !s.active.has(id)) return;
    const before = s.context.get(id);
    if (before && privateContextLimited(before)) return;
    const limit = (reason: "CONTEXT_LIMIT" | "REPORT_LIMIT") => {
      // Both codes are no longer than WITHIN_LIMITS: the marker needs no extra budget.
      if (before?.metadataCapture === "WITHIN_LIMITS") {
        s.context!.set(id, { ...before, metadataCapture: reason });
        // Freeze private metadata only. Technical events retain their own unchanged
        // event/byte limits and can still record decisions, FINAL and END.
        s.truncated = true;
      } else this.truncate(sessionId, id); // No pre-accounted omission marker available.
    };
    try {
      if (s.recorders.get(id)!.isTruncated()) return;
      const safe = projectPrivateContext(context);
      const extra = Buffer.byteLength(JSON.stringify(safe)) - (before ? Buffer.byteLength(JSON.stringify(before)) : 0) + (before ? 0 : 64);
      if (s.bytes + Math.max(0, extra) > L.dtoBytes) { limit("REPORT_LIMIT"); return; }
      s.bytes += Math.max(0, extra); s.context.set(id, safe);
    } catch (error) {
      if (error instanceof PrivateContextLimitError) limit("CONTEXT_LIMIT");
      else this.truncate(sessionId, id);
    }
  }

  private truncate(sessionId: string, id: string): void {
    this.sweep();
    const s = this.session;
    if (!s || s.id !== sessionId || !s.active.has(id)) return;
    try { s.recorders.get(id)!.truncate(); s.truncated = true; }
    catch { this.close("RECORDER_FAILURE"); }
  }

  private finish(sessionId: string, id: string, interrupted = false): void {
    this.sweep();
    const s = this.session;
    if (!s || s.id !== sessionId || !s.active.has(id)) return;
    try {
      s.recorders.get(id)!.close(interrupted);
      if (interrupted) s.truncated = true;
      s.active.delete(id);
    }
    catch { this.close("RECORDER_FAILURE"); }
  }

  stop(): void { this.sweep(); this.close("STOPPED"); }

  /** Detached, sanitized DTO; no file/network I/O or retention renewal. */
  report(): DiagnosticReport | undefined {
    this.sweep();
    return this.final ? structuredClone(this.final.report) : undefined;
  }

  readReport(): { state: "AVAILABLE"; report: DiagnosticReport } | { state: "ACTIVE" | "ABSENT" | "EXPIRED" } {
    this.sweep();
    if (this.session) return { state: "ACTIVE" };
    if (this.final) return { state: "AVAILABLE", report: structuredClone(this.final.report) };
    return { state: this.reportExpired ? "EXPIRED" : "ABSENT" };
  }

  readPrivateReport(): { state: "AVAILABLE"; report: PrivateDiagnosticReport } | { state: "ACTIVE" | "ABSENT" | "EXPIRED" } {
    const result = this.readReport();
    if (result.state !== "AVAILABLE") return result;
    if (!this.final?.context) return { state: "ABSENT" };
    return { state: "AVAILABLE", report: { version: 1, privacy: "PRIVATE_LOCAL", report: result.report, context: structuredClone(this.final.context) } };
  }

  private close(reason: DiagnosticReport["reason"]): void {
    const s = this.session;
    if (!s) return;
    this.session = undefined; // Revoke handles before touching the recorder.
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.final = undefined;
    this.reportExpired = false;
    try {
      const resolutions: ResolutionReport[] = [];
      for (const [id, recorder] of s.recorders) {
        recorder.close(s.active.has(id));
        resolutions.push(recorder.snapshot());
      }
      if (s.options.retainReport) {
        const report: DiagnosticReport = { version: s.version, id: s.id,
          state: s.truncated || s.active.size > 0 || reason === "RECORDER_FAILURE" ? "TRUNCATED" : "CLOSED",
          reason, reserved: s.reserved, skippedConcurrent: s.skippedConcurrent, events: s.events, resolutions };
        // Retention starts at the logical deadline, even if the timer was delayed.
        const expiresAt = (reason === "EXPIRED" ? s.expiresAt : this.now()) + L.ttlMs;
        if (expiresAt > this.now()) this.final = { expiresAt, report,
          ...(s.context ? { context: [...s.context].map(([resolutionId, context]) => ({ resolutionId, ...context })) } : {}) };
        else this.reportExpired = true;
      }
    } catch {
      // A failing recorder cannot leak error text or keep capture enabled. Discard all data.
      const expiresAt = (reason === "EXPIRED" ? s.expiresAt : this.now()) + L.ttlMs;
      if (s.options.retainReport && expiresAt > this.now()) this.final = { expiresAt, report: {
        version: 1, id: s.id, state: "TRUNCATED", reason: "RECORDER_FAILURE",
        reserved: s.reserved, skippedConcurrent: s.skippedConcurrent, events: 0, resolutions: []
      } };
      else if (s.options.retainReport) this.reportExpired = true;
    } finally {
      s.recorders.clear(); s.active.clear(); s.context?.clear();
    }
    if (this.final) this.arm(this.final.expiresAt - this.now());
  }

  private sweep(): void {
    if (this.session && this.now() >= this.session.expiresAt) this.close("EXPIRED");
    if (this.final && this.now() >= this.final.expiresAt) {
      this.final = undefined;
      this.reportExpired = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sweep();
      if (this.session) this.arm(this.session.expiresAt - this.now());
      else if (this.final) this.arm(this.final.expiresAt - this.now());
    }, Math.max(1, Math.ceil(delay)));
    this.timer.unref();
  }
}

function privateContextLimited(context: PrivateResolutionContext): boolean {
  return context.metadataCapture === "CONTEXT_LIMIT" || context.metadataCapture === "REPORT_LIMIT";
}
