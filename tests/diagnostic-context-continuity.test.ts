import { describe, expect, it, vi } from "vitest";
import { DiagnosticController } from "../src/diagnostics/controller";
import { DIAGNOSTIC_LIMITS as L } from "../src/diagnostics/recorder";
import { observeResolution } from "../src/diagnostics/resolver-observer";
import { sourceDeclarations, validatePrivateReport } from "../src/diagnostics/private-context";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";

const options = { ttlMs: 300000, resolutions: 2, retainReport: true };

function contextExhaustion(c: DiagnosticController) {
  const h = c.beginResolution()!;
  const o = observeResolution(h);
  o.request!({ id: "synthetic", title: "Invented request", kind: "movie", externalIds: {} });
  const title = "Invented release label ".repeat(6).trim();
  const sources = Array.from({ length: 169 }, () => ({ providerId: "fixture", type: "https" as const, title, name: title }));
  o.trace.stage("provider", sources, sources.map(() => Object.freeze({})));
  return { h, o };
}

describe("diagnostic continuity after private context exhaustion", () => {
  it("freezes the omission marker while allowing technical events and revoking late writes", () => {
    const c = new DiagnosticController(); c.start(options, true);
    const { h, o } = contextExhaustion(c);
    expect(h.isActive()).toBe(true);
    // Private callbacks cannot reset the marker or replace stored context afterwards.
    h.privateContext!({ title: "Late replacement", metadataCapture: "WITHIN_LIMITS", mediaKind: "movie", season: null, episode: null, providers: [] });
    h.privateProvider!({ provider: 0, id: "late", name: "Late provider" });
    h.privateCandidate!(168, sourceDeclarations({ title: "Late candidate" }));
    h.record({ kind: "SNAPSHOT", stage: "FINAL", count: 0, observed: 0 });
    o.finish(false); c.stop();
    const r = c.readPrivateReport(); if (r.state !== "AVAILABLE") throw new Error();
    const p = validatePrivateReport(r.report);
    expect(p.report.state).toBe("TRUNCATED");
    expect(p.report.resolutions[0]!.state).toBe("CLOSED");
    expect(p.context[0]!.metadataCapture).toBe("CONTEXT_LIMIT");
    expect(JSON.stringify(p)).not.toContain("Late");
    expect(p.report.resolutions[0]!.events.at(-1)).toEqual({ kind: "END", outcome: "SUCCEEDED" });
    expect(new Set(p.report.resolutions[0]!.events.filter(e => e.kind === "SOURCE").map(e => e.candidateId)).size).toBe(169);
    h.record({ kind: "END", outcome: "FAILED" });
    h.privateContext!({ title: "Late replacement", mediaKind: "movie", season: null, episode: null, providers: [] });
    expect(c.readPrivateReport()).toEqual(r);
  });

  it("still truncates on the technical event limit and never fabricates a terminal event", () => {
    const c = new DiagnosticController(); c.start(options, true);
    const { h, o } = contextExhaustion(c);
    for (let i = 0; i < L.resolutionEvents; i++) h.record({ kind: "STAGE", stage: "NORMALIZED", count: 0 });
    expect(h.isActive()).toBe(false);
    o.finish(false); c.stop();
    const r = c.report()!;
    expect(r.resolutions[0]!.state).toBe("TRUNCATED");
    expect(r.resolutions[0]!.events).toHaveLength(L.resolutionEvents);
    expect(r.resolutions[0]!.events.some(e => e.kind === "END")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(L.dtoBytes);
  });

  it("still revokes the technical continuation at the session deadline", () => {
    let now = 0;
    const c = new DiagnosticController(() => now); c.start({ ...options, ttlMs: 1000 }, true);
    const { h, o } = contextExhaustion(c);
    now = 1000;
    expect(h.isActive()).toBe(false);
    const before = c.readPrivateReport();
    o.finish(false); h.record({ kind: "END", outcome: "SUCCEEDED" });
    expect(c.readPrivateReport()).toEqual(before);
    expect(c.report()!.resolutions[0]!.state).toBe("TRUNCATED");
  });

  it.each(["complete", "missing", "duplicate", "count-mismatch", "truncated"] as const)("renders probe breakdown from resolution-local evidence only: %s", variant => {
    const c = new DiagnosticController(); c.start(options);
    const h = c.beginResolution()!;
    for (const candidate of [0, 1]) h.record({ kind: "SOURCE", candidate, provider: 0, transport: candidate ? "MAGNET" : "HTTPS", height: 0 });
    h.record({ kind: "SNAPSHOT", stage: "PROBED", count: variant === "count-mismatch" ? 3 : 2, observed: 2 });
    h.record({ kind: "OBSERVATION", candidate: 0, stage: "PROBED", identity: "UNKNOWN", probe: "verified" });
    if (variant !== "missing") h.record({ kind: "OBSERVATION", candidate: variant === "duplicate" ? 0 : 1, stage: "PROBED", identity: "UNCLASSIFIED", probe: "UNOBSERVED" });
    if (variant === "truncated") h.truncate();
    h.finish();
    const sibling = c.beginResolution()!; sibling.truncate(); sibling.finish(); c.stop();
    const report = c.report()!; expect(report.state).toBe("TRUNCATED");
    const dom = diagnosticReportDom(renderDiagnosticHtml(report));
    const flow = dom.ids.get("funnel-human")!.textContent;
    if (variant === "complete") {
      expect(flow).toContain("Observed probe states at this boundary (not request counts)");
      expect(flow).not.toContain("Probe-state breakdown unavailable");
    } else expect(flow).toContain("Probe-state breakdown unavailable");
    const filter = dom.ids.get("resolution-filter")!;
    filter.value = report.resolutions[1]!.id; filter.change();
    expect(dom.ids.get("funnel-human")!.textContent).toContain("Probe-state breakdown unavailable");
  });

  it("keeps malformed private updates fail-closed rather than misreporting them as byte limits", () => {
    const c = new DiagnosticController(); c.start(options, true);
    const h = c.beginResolution()!;
    const getter = vi.fn(() => "private canary");
    h.privateContext!(Object.defineProperty({ mediaKind: "movie", season: null, episode: null, providers: [] }, "title", { get: getter }) as never);
    expect(getter).not.toHaveBeenCalled(); expect(h.isActive()).toBe(false);
    h.finish(); c.stop(); expect(c.report()!.resolutions[0]!.state).toBe("TRUNCATED");
  });
});
