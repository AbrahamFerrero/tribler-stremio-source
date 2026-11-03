import { describe, expect, it } from "vitest";
import { DiagnosticController } from "../src/diagnostics/controller";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";

function fixture(truncated = false) {
  const c = new DiagnosticController(); c.start({ ttlMs: 300000, resolutions: 2, retainReport: true });
  for (let r = 0; r < 2; r++) {
    const h = c.beginResolution()!;
    h.record({ kind: "REQUEST", mediaKind: "movie" });
    h.record({ kind: "PROVIDER_STATE", provider: r, status: "RETURNED_RESULTS" });
    h.record({ kind: "PROVIDER_COUNTS", provider: r, received: 3, delivered: 3, limited: 0 });
    h.record({ kind: "SNAPSHOT", stage: "PROVIDER", count: 3, observed: 3 });
    for (let candidate = 0; candidate < 3; candidate++) {
      h.record({ kind: "SOURCE", candidate, provider: r, transport: "HTTPS", height: 1080 });
      h.record({ kind: "OBSERVATION", candidate, stage: "PROVIDER", identity: "UNKNOWN", probe: "UNOBSERVED" });
    }
    h.record({ kind: "REJECTION", candidate: 1, stage: "NORMALIZED", reason: "KIND_CONFLICT", identity: "CONTRADICTION" });
    h.record({ kind: "GAP", candidate: 2, stage: "DEDUPLICATED", context: "CONTINUITY", reason: "INSUFFICIENT_EVIDENCE" });
    h.record({ kind: "OBSERVATION", candidate: 0, stage: "FINAL", identity: "UNKNOWN", probe: "verified" });
    h.record({ kind: "SNAPSHOT", stage: "FINAL", count: 1, observed: 1 });
    h.record({ kind: "RANKING", candidate: 0, position: 1, score: 7, availability: 1, resolution: 1, size: 1, codec: 1, metadata: 1, transport: 2 });
    if (truncated) h.truncate(); h.finish();
  }
  c.stop(); return c.report()!;
}
const view = (truncated = false) => diagnosticReportDom(renderDiagnosticHtml(fixture(truncated)));

describe("US-1507 Trace Workbench", () => {
  it("maps source rows to six stages without filling absent observations", () => {
    const { ids } = view(), rows = ids.get("sources-human")!.children;
    expect(rows).toHaveLength(3); expect(rows[0]!.children).toHaveLength(7);
    expect(rows[0]!.children[1]!.getAttribute("class")).toBe("observed");
    expect(rows[0]!.children[3]!.getAttribute("class")).toBe("unavailable");
    expect(rows[0]!.children[6]!.getAttribute("class")).toBe("observed");
    expect(rows[1]!.children[2]!.textContent).toContain("Explicit rejection: Media kind conflict");
    expect(rows[2]!.children[3]!.getAttribute("class")).toBe("unknown");
    expect(rows[2]!.textContent).not.toContain("Explicit rejection");
  });
  it("keeps global counts independent of outcome filters", () => {
    const { ids } = view(), filter = ids.get("outcome-filter")!;
    const original = ids.get("source-counts")!.textContent.split("Visible")[0];
    for (const value of ["final", "rejected", "unknown"]) {
      filter.value = value; filter.change(); expect(ids.get("sources-human")!.children).toHaveLength(1);
      expect(ids.get("source-counts")!.textContent.split("Visible")[0]).toBe(original);
    }
    filter.value = ""; filter.change(); expect(ids.get("sources-human")!.children).toHaveLength(3);
  });
  it("opens the contextual inspector from source and stage buttons with focus and score components", () => {
    const { ids, document } = view(), rows = ids.get("sources-human")!.children;
    rows[0]!.children[6]!.children[0]!.click();
    expect(document.getElementById("inspector-heading").focused).toBe(true);
    const content = ids.get("source-inspector")!.textContent;
    for (const text of ["Source 1", "Final position after quota: 1", "Technical score: 7", "Availability component: 1", "Transport component: 2"]) expect(content).toContain(text);
    rows[1]!.children[0]!.children[0]!.click();
    expect(ids.get("source-inspector")!.textContent).toContain("Last observed stage: Normalized");
    expect(ids.get("source-inspector")!.textContent).toContain("Explicit contradiction");
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
  });
  it("attributes providers and resets filters and selection between searches even with repeated candidate UUIDs", () => {
    const report = fixture(), a = report.resolutions[0]!, b = report.resolutions[1]!;
    const old = b.events.find(e => "candidateId" in e && e.candidateId !== "UNOBSERVED")!;
    const shared = a.events.find(e => "candidateId" in e && e.candidateId !== "UNOBSERVED")!;
    if ("candidateId" in old && "candidateId" in shared) { const oldId = old.candidateId; for (const e of b.events) if ("candidateId" in e && e.candidateId === oldId) e.candidateId = shared.candidateId; }
    const { ids } = diagnosticReportDom(renderDiagnosticHtml(report));
    ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    ids.get("provider-filter")!.value = "0"; ids.get("provider-filter")!.change();
    ids.get("resolution-filter")!.value = b.id; ids.get("resolution-filter")!.change();
    expect(ids.get("provider-filter")!.value).toBe("");
    expect(ids.get("sources-human")!.children).toHaveLength(3);
    expect(ids.get("sources-human")!.textContent).toContain("Provider 2");
    expect(ids.get("sources-human")!.textContent).not.toContain("Provider 1");
    expect(ids.get("source-inspector")!.textContent).toContain("Select a source");
  });
  it("combines provider, stage and outcome filters", () => {
    const { ids } = view();
    ids.get("phase")!.value = "FINAL"; ids.get("phase")!.change();
    expect(ids.get("sources-human")!.children).toHaveLength(1);
    ids.get("provider-filter")!.value = "1"; ids.get("provider-filter")!.change();
    expect(ids.get("sources-human")!.children).toHaveLength(0);
    expect(ids.get("source-counts")!.textContent).toContain("Observed sources: 3");
  });
  it("preserves positive and rejected cells while marking missing evidence incomplete", () => {
    const { ids } = view(true), rows = ids.get("sources-human")!.children;
    expect(rows[0]!.children[1]!.getAttribute("class")).toBe("observed");
    expect(rows[1]!.children[2]!.getAttribute("class")).toBe("rejected");
    expect(rows[2]!.children[3]!.getAttribute("class")).toBe("incomplete");
  });
  it("switches inspector, matrix and filters to Spanish without changing data or selection", () => {
    const { ids } = view(); const original = ids.get("diagnostic-data")!.textContent;
    ids.get("sources-human")!.children[2]!.children[0]!.children[0]!.click();
    ids.get("language")!.value = "es"; ids.get("language")!.change();
    expect(ids.get("source-inspector")!.textContent).toContain("Fuente 3");
    expect(ids.get("sources-human")!.textContent).toContain("causa desconocida");
    expect(ids.get("outcome-filter")!.textContent).toContain("Fuentes finales");
    expect(ids.get("diagnostic-data")!.textContent).toBe(original);
  });
  it("renders empty reports without creating candidates or inferred zeros for providers", () => {
    const c = new DiagnosticController(); c.start({ ttlMs: 1000, resolutions: 1, retainReport: true }); c.stop();
    const { ids } = diagnosticReportDom(renderDiagnosticHtml(c.report()));
    expect(ids.get("sources-human")!.children).toHaveLength(0);
    expect(ids.get("providers-human")!.children).toHaveLength(0);
    expect(ids.get("source-counts")!.textContent).toContain("Observed sources: 0");
  });
});
