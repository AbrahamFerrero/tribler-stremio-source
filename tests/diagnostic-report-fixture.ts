import { DiagnosticController } from "../src/diagnostics/controller";

export function diagnosticReportFixture() {
  const c = new DiagnosticController(); c.start({ ttlMs: 300000, resolutions: 10, retainReport: true });
  const h = c.beginResolution()!;
  h.record({ kind: "SNAPSHOT", stage: "PROVIDER", count: 2, observed: 2 });
  h.record({ kind: "OBSERVATION", candidate: 0, stage: "PROVIDER", identity: "UNCLASSIFIED", probe: "UNOBSERVED" });
  h.record({ kind: "OBSERVATION", candidate: 1, stage: "PROVIDER", identity: "UNCLASSIFIED", probe: "UNOBSERVED" });
  h.record({ kind: "PRE_PROBE", candidate: 0, decision: "CONTINUE", identity: "UNKNOWN" });
  h.record({ kind: "SNAPSHOT", stage: "FINAL", count: 1, observed: 1 });
  h.record({ kind: "OBSERVATION", candidate: 0, stage: "FINAL", identity: "UNKNOWN", probe: "verified" });
  h.record({ kind: "RANKING", candidate: 0, position: 1, score: 7.25, availability: 1.25, resolution: 1, size: 1, codec: 1, metadata: 1, transport: 2 });
  h.record({ kind: "GAP", candidate: 1, stage: "FINAL", context: "CONTINUITY", reason: "INSUFFICIENT_EVIDENCE" });
  h.record({ kind: "GAP", candidate: -1, stage: "FINAL", context: "IDENTITY_GROUP", reason: "UNOBSERVED" });
  h.record({ kind: "END", outcome: "SUCCEEDED" }); h.truncate(); h.finish(); c.stop();
  return c.report()!;
}
