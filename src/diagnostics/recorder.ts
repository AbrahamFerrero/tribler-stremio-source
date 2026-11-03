import { randomUUID } from "node:crypto";
import { projectDiagnosticEvent, type DiagnosticEvent } from "./events";
export type { DiagnosticEvent, DiagnosticStage, DiagnosticDecision, DiagnosticScores } from "./events";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  ttlMs: 300_000, resolutions: 10, concurrent: 4, candidates: 256,
  resolutionEvents: 2048, sessionEvents: 8192, dtoBytes: 2 * 1024 * 1024
});

type Stored<E> = E extends { candidate: number } ? Omit<E, "candidate"> & { candidateId: string } : E;
export type RecordedEvent = Stored<DiagnosticEvent>;
export interface ResolutionReport {
  id: string;
  state: "OPEN" | "CLOSED" | "TRUNCATED";
  events: RecordedEvent[];
}

export class DiagnosticRecorder {
  private readonly candidates = new Map<number, string>();
  private readonly report: ResolutionReport;
  private closed = false;

  constructor(id: string) { this.report = { id, state: "OPEN", events: [] }; }

  /** Admission is supplied by the session, and runs before any event is stored. */
  record(event: DiagnosticEvent, admit: (bytes: number) => boolean): void {
    if (this.closed || this.report.state === "TRUNCATED") return;
    const data = projectDiagnosticEvent(event);
    let safe: RecordedEvent | undefined;
    if (data && "candidate" in data) {
      const { candidate, ...fields } = data;
      const candidateId = candidate === -1 ? "UNOBSERVED" : this.candidates.get(candidate) ?? randomUUID();
      safe = { ...fields, candidateId };
      if (candidate >= 0) this.candidates.set(candidate, candidateId);
    } else {
      safe = data;
    }
    if (!safe || this.report.events.length >= DIAGNOSTIC_LIMITS.resolutionEvents ||
        !admit(Buffer.byteLength(JSON.stringify(safe)) + 1)) { this.truncate(); return; }
    this.report.events.push(safe);
  }

  candidateId(slot: number): string | undefined { return this.candidates.get(slot); }

  truncate(): void { this.report.state = "TRUNCATED"; }
  isTruncated(): boolean { return this.report.state === "TRUNCATED"; }
  close(interrupted = false): void {
    this.closed = true;
    if (interrupted) this.truncate();
    else if (this.report.state === "OPEN") this.report.state = "CLOSED";
    this.candidates.clear();
  }
  snapshot(): ResolutionReport { return structuredClone(this.report); }
}
