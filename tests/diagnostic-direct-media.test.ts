import { describe, expect, it, vi } from "vitest";
import { directMediaFixture, scenarios } from "./direct-media-trace-fixture";
import { DiagnosticController } from "../src/diagnostics/controller";
import { projectDiagnosticEvent, type DiagnosticEvent } from "../src/diagnostics/events";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { anonymizeDiagnosticExport } from "../src/diagnostics/private-context";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { DIAGNOSTIC_LIMITS as L } from "../src/diagnostics/recorder";



describe("direct video diagnostic evidence", () => {
  it.each(scenarios)("observes %s without changing output, order or network", async (_name, scenario, admitted, cause, mime) => {
    const off = await directMediaFixture(scenario, "off");
    expect(off.result).toHaveLength(admitted ? 1 : 0);
    for (const mode of ["anonymous", "private"] as const) {
      const run = await directMediaFixture(scenario, mode);
      expect(run.result).toEqual(off.result); expect(run.requests).toEqual(off.requests); expect(run.cancellations).toEqual(off.cancellations);
      expect(run.cancelled).toBe(off.cancelled); expect(run.diagnostics).toEqual(off.diagnostics);
      const report = validateDiagnosticReport(run.c.report()); expect(report.version).toBe(7);
      const events = report.resolutions[0]!.events;
      const e = events.find(e => e.kind === "DIRECT_MEDIA");
      expect(e).toMatchObject({ mime, mediaCause: cause, media: admitted ? "ADMITTED" : "REJECTED" });
      if (_name.startsWith("206 octet")) expect(e).toMatchObject({ transport: "verified", verified: true, range: true, response: 206, filename: "ABSENT", urlName: "NO_EXTENSION" });
      if (_name === "structured filename") expect(e).toMatchObject({ filename: "mkv", urlName: "NO_EXTENSION" });
      if (_name === "recognized URL") expect(e).toMatchObject({ filename: "ABSENT", urlName: "mkv" });
      expect(events.some(e => e.kind === "EXCLUSION" && e.reason === "DIRECT_MEDIA_NOT_VERIFIED")).toBe(!admitted);
      const exported = mode === "private" ? run.c.readPrivateReport() : undefined;
      const privateData = exported?.state === "AVAILABLE" ? exported.report : report;
      const html = renderDiagnosticHtml(privateData);
      for (const data of [JSON.stringify(report), html, JSON.stringify(anonymizeDiagnosticExport(privateData))]) {
        for (const secret of ["media.example", "path-private-canary", "opaque-private-canary", "query-private-canary", "filename-private-canary", "mime-private-canary", "exception-private-canary", "signature="]) expect(data).not.toContain(secret);
      }
      const dom = diagnosticReportDom(html); dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Direct video admission evidence");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Transport verification is separate");
      expect(dom.ids.get("timeline-body")!.textContent).toContain("Direct video admission condition");
      dom.ids.get("language")!.value = "es"; dom.ids.get("language")!.change();
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Evidencia de admisión de vídeo directo");
      expect(dom.ids.get("timeline-body")!.textContent).toContain("Condición de admisión de vídeo directo");
    }
  });

  it.each(["budget", "cancel"] as const)("preserves %s without manufacturing direct admission evidence", async condition => {
    const off = await directMediaFixture({ [condition]: true }, "off");
    for (const mode of ["anonymous", "private"] as const) {
      const run = await directMediaFixture({ [condition]: true }, mode);
      expect(run.result).toEqual(off.result); expect(run.requests).toEqual(off.requests); expect(run.cancellations).toEqual(off.cancellations); expect(run.cancelled).toBe(off.cancelled);
      expect(validateDiagnosticReport(run.c.report()).resolutions[0]!.events.some(e => e.kind === "DIRECT_MEDIA")).toBe(false);
    }
  });
});

const good: DiagnosticEvent = { kind: "DIRECT_MEDIA", candidate: 0, stage: "ADMITTED", filename: "ABSENT", urlName: "NO_EXTENSION", mime: "application/octet-stream", media: "REJECTED", mediaCause: "MIME_NOT_VIDEO", transport: "verified", verified: true, range: true, response: 206 };
describe("v7 contract and trace completeness", () => {
  it("rejects arbitrary payloads, accessors, incompatible facts and unknown codes", () => {
    expect(projectDiagnosticEvent(good)).toEqual(good);
    for (const patch of [{ stage: "PROBED" }, { filename: "private.mkv" }, { urlName: "/private" }, { mime: "video/secret" }, { mediaCause: "invented" }, { response: 999 }, { range: 1 }, { media: "ADMITTED" }, { mediaCause: "MIME_ABSENT" }, { mediaCause: "RANGE_NOT_VERIFIED" }, { path: "/private" }, { reason: "HLS_NOT_VERIFIED" }]) expect(projectDiagnosticEvent({ ...good, ...patch } as DiagnosticEvent)).toBeUndefined();
    const get = vi.fn(() => "video/mp4");
    expect(projectDiagnosticEvent(Object.defineProperty({ ...good }, "mime", { get }))).toBeUndefined(); expect(get).not.toHaveBeenCalled();
  });

  it("upgrades only recorded evidence, preserves v1-v6, and never downgrades v7", () => {
    const c = new DiagnosticController(); c.start({ ttlMs: 1000, resolutions: 1, retainReport: true }); const h = c.beginResolution()!;
    h.record(good); h.record({ kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "HLS_NOT_VERIFIED", hlsCause: "CAUSE_UNDETERMINED" });
    h.record({ kind: "PROVIDER_FAILURE", provider: 0, category: "CAUSE_UNDETERMINED" }); h.finish(); c.stop();
    const report = validateDiagnosticReport(c.report()); expect(report.version).toBe(7);
    for (const version of [1, 2, 3, 4, 5, 6]) expect(() => validateDiagnosticReport({ ...report, version })).toThrow();
    for (const version of [1, 2, 3, 4, 5, 6] as const) {
      const historical = { ...report, version, events: 0, resolutions: report.resolutions.map(r => ({ ...r, events: [] })) };
      expect(validateDiagnosticReport(historical)).toEqual(historical);
    }
    const invalid = new DiagnosticController(); invalid.start({ ttlMs: 1000, resolutions: 1, retainReport: true }); const x = invalid.beginResolution()!;
    x.record({ ...good, mime: "private" } as unknown as DiagnosticEvent); x.finish(); invalid.stop(); expect(validateDiagnosticReport(invalid.report()).version).toBe(1);
  });

  it("separates limited private context, global truncation, and a closed source trace in EN/ES", async () => {
    const run = await directMediaFixture({ mime: "application/octet-stream" }, "private");
    const result = run.c.readPrivateReport(); if (result.state !== "AVAILABLE") throw Error("fixture");
    const data = result.report; data.report.state = "TRUNCATED"; data.context[0]!.metadataCapture = "CONTEXT_LIMIT";
    const dom = diagnosticReportDom(renderDiagnosticHtml(data)); dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    let text = dom.ids.get("source-inspector")!.textContent;
    expect(text).toContain("Terminal decision observed"); expect(text).toContain("Global session incomplete"); expect(text).toContain("Private context byte limit reached"); expect(text).not.toContain("Technical trace of this resolution is incomplete"); expect(text).not.toContain("Capture truncated");
    dom.ids.get("language")!.value = "es"; dom.ids.get("language")!.change(); text = dom.ids.get("source-inspector")!.textContent;
    expect(text).toContain("Decisión terminal observada"); expect(text).toContain("Sesión global incompleta");
    data.report.resolutions[0]!.state = "TRUNCATED";
    const partial = diagnosticReportDom(renderDiagnosticHtml(data)); partial.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(partial.ids.get("source-inspector")!.textContent).toContain("Technical trace of this resolution is incomplete"); expect(partial.ids.get("source-inspector")!.textContent).not.toContain("Terminal decision observed");
  });

  it("does not invent historical MIME or a terminal for missing observations", async () => {
    const run = await directMediaFixture({}, "anonymous"); const r = validateDiagnosticReport(run.c.report());
    r.version = 6; r.resolutions[0]!.events = r.resolutions[0]!.events.filter(e => e.kind !== "DIRECT_MEDIA"); r.events--;
    const dom = diagnosticReportDom(renderDiagnosticHtml(r)); dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Direct video admission detail not captured");
    r.resolutions[0]!.state = "TRUNCATED"; r.state = "TRUNCATED"; r.resolutions[0]!.events = r.resolutions[0]!.events.filter(e => e.kind !== "EXCLUSION" && e.kind !== "END"); r.events = r.resolutions[0]!.events.length;
    const partial = diagnosticReportDom(renderDiagnosticHtml(r)); partial.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(partial.ids.get("source-inspector")!.textContent).not.toContain("Terminal decision observed");
  });

  it("keeps byte/event limits, does not upgrade dropped details or manufacture END", () => {
    const c = new DiagnosticController(); c.start({ ttlMs: 1000, resolutions: 1, retainReport: true }); const h = c.beginResolution()!;
    for (let i = 0; i < L.resolutionEvents; i++) h.record({ kind: "STAGE", stage: "PROVIDER", count: 1 });
    h.record(good); h.record({ kind: "END", outcome: "SUCCEEDED" }); h.finish(); c.stop();
    const r = validateDiagnosticReport(c.report()); expect(r.version).toBe(1); expect(r.state).toBe("TRUNCATED"); expect(r.events).toBe(L.resolutionEvents);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(L.dtoBytes);
  });

  it("retains v7 at expiry while revoking late writes", () => {
    let now = 0; const c = new DiagnosticController(() => now); c.start({ ttlMs: 1000, resolutions: 1, retainReport: true });
    const h = c.beginResolution()!; h.record(good); now = 1000; expect(h.isActive()).toBe(false);
    const before = validateDiagnosticReport(c.report()); expect(before.version).toBe(7); expect(before.state).toBe("TRUNCATED");
    h.record({ kind: "END", outcome: "SUCCEEDED" }); h.finish(); expect(c.report()).toEqual(before);
  });

  it("records undetermined evidence only when the real input lacks it", async () => {
    const mock = vi.spyOn(DirectStreamProbe.prototype, "probe").mockImplementation(sources => Promise.resolve(sources.map(s => ({ ...s, directHttp: { status: "unknown", verified: false, rangeSupported: false, contentType: "video/mp4" } }))));
    try { const run = await directMediaFixture({}, "anonymous"); expect(validateDiagnosticReport(run.c.report()).resolutions[0]!.events).toContainEqual(expect.objectContaining({ kind: "DIRECT_MEDIA", mediaCause: "EVIDENCE_UNDETERMINED" })); }
    finally { mock.mockRestore(); }
  });
});
