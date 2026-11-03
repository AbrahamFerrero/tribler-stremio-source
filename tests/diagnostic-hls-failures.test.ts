import { describe, expect, it, vi } from "vitest";
import { hlsTraceFixture, type HlsScenario } from "./hls-trace-fixture";
import { projectDiagnosticEvent, type DiagnosticEvent } from "../src/diagnostics/events";
import { DiagnosticController } from "../src/diagnostics/controller";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { validatePrivateReport, anonymizeDiagnosticExport } from "../src/diagnostics/private-context";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { DIAGNOSTIC_LIMITS as L } from "../src/diagnostics/recorder";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";

const cases = [
  ["root-503", "INITIAL_MANIFEST", "HTTP_RESPONSE", 503], ["root-invalid", "INITIAL_MANIFEST", "MANIFEST_INVALID"],
  ["root-empty", "INITIAL_MANIFEST", "EMPTY_BODY"], ["root-large", "INITIAL_MANIFEST", "MANIFEST_TOO_LARGE"],
  ["root-length", "INITIAL_MANIFEST", "MANIFEST_LENGTH_MISMATCH"], ["refs-invalid", "INITIAL_MANIFEST", "CAUSE_UNDETERMINED"],
  ["variant-404", "VARIANT_PLAYLIST", "HTTP_RESPONSE", 404], ["variant-503", "VARIANT_PLAYLIST", "HTTP_RESPONSE", 503],
  ["variant-timeout", "VARIANT_PLAYLIST", "TIMEOUT"], ["variant-network", "VARIANT_PLAYLIST", "CAUSE_UNDETERMINED"],
  ["variant-type", "VARIANT_PLAYLIST", "PLAYLIST_TYPE_MISMATCH"], ["media-404", "MEDIA_RESOURCE", "HTTP_RESPONSE", 404],
  ["media-503", "MEDIA_RESOURCE", "HTTP_RESPONSE", 503], ["media-invalid", "MEDIA_RESOURCE", "RESOURCE_INVALID"],
  ["media-read-error", "MEDIA_RESOURCE", "CAUSE_UNDETERMINED"], ["map-404", "MAP_RESOURCE", "HTTP_RESPONSE", 404],
  ["key-404", "KEY_RESOURCE", "HTTP_RESPONSE", 404], ["audio-503", "AUDIO_PLAYLIST", "HTTP_RESPONSE", 503],
  ["audio-segment-404", "MEDIA_RESOURCE", "HTTP_RESPONSE", 404], ["depth-limit", "VARIANT_PLAYLIST", "PLAYLIST_DEPTH_LIMIT"],
  ["no-media", "INITIAL_MANIFEST", "NO_MEDIA_REFERENCE"], ["no-distinct-media", "INITIAL_MANIFEST", "NO_DISTINCT_MEDIA_REFERENCE"]
] as const;

describe("HLS failure facts and report presentation", () => {
  it.each(cases)("binds %s failure to its observed phase and preserves OFF/anonymous/private results", async (scenario, phase, cause, httpStatus?: number) => {
    const off = await hlsTraceFixture(scenario, "off"); expect(off.result).toHaveLength(1);
    for (const mode of ["anonymous", "private"] as const) {
      const run = await hlsTraceFixture(scenario, mode);
      expect(run.result).toEqual(off.result); expect(run.requests).toEqual(off.requests);
      const report = validateDiagnosticReport(JSON.parse(JSON.stringify(run.c.report())));
      expect(report.version).toBe(7); expect(report.state).toBe("CLOSED");
      const exclusion = report.resolutions[0]!.events.find(e => e.kind === "EXCLUSION" && e.reason === "HLS_NOT_VERIFIED");
      const detail = { hlsPhase: phase, hlsCause: cause, ...(httpStatus !== undefined ? { httpStatus } : {}) };
      expect(exclusion).toMatchObject(detail);
      expect(run.observations[0]!.hlsFailure).toEqual({ phase, cause, ...(httpStatus !== undefined ? { httpStatus } : {}) });
      if (httpStatus === undefined) expect(exclusion).not.toHaveProperty("httpStatus");
      // A child failure must not masquerade as the successfully fetched root response.
      if (phase !== "INITIAL_MANIFEST") expect(run.observations[0]!.responseStatus).toBe(200);
      const html = renderDiagnosticHtml(report), dom = diagnosticReportDom(html);
      dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
      expect(dom.ids.get("source-inspector")!.textContent).toContain("HLS verification failure:");
      expect(dom.ids.get("timeline-body")!.textContent).toContain("HLS verification failure:");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Last observed stage: Admission evaluation");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Pre-probe Identity assessment (preliminary)");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("no later effective Identity classification was observed");
      dom.ids.get("language")!.value = "es"; dom.ids.get("language")!.change();
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Última etapa observada: Evaluación de admisión");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Fallo de verificación HLS:");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("evaluación preliminar");
      expect(JSON.stringify(report)).not.toMatch(/media\.example|private-(?:body|error|query|locator|resource|read)-canary/);
      expect(html).not.toMatch(/media\.example|private-(?:body|error|query|locator|resource|read)-canary/);
      if (mode === "private") {
        const p = run.c.readPrivateReport(); if (p.state !== "AVAILABLE") throw new Error();
        expect(anonymizeDiagnosticExport(validatePrivateReport(p.report))).toEqual(report);
      }
      const before = run.requests.length;
      const cached = await run.probe.probe([{ providerId: "fixture", type: "https", url: "https://media.example/root.m3u8?private-locator-canary" }]);
      expect(cached[0]!.directHttp?.hlsFailure).toEqual(run.observations[0]!.hlsFailure);
      expect(run.requests.length).toBe(before);
    }
  });

  it.each(["success", "root-404", "variant-route", "budget", "cancel"] as HlsScenario[])("retains success, stronger exclusions and cancellation for %s", async scenario => {
    const off = await hlsTraceFixture(scenario, "off");
    const run = await hlsTraceFixture(scenario, "anonymous");
    expect(run.result).toEqual(off.result); expect(run.requests).toEqual(off.requests);
    const report = validateDiagnosticReport(run.c.report()), events = report.resolutions[0]!.events;
    expect(events.some(e => e.kind === "EXCLUSION" && e.reason === "HLS_NOT_VERIFIED")).toBe(false);
    if (scenario === "success") { expect(run.result).toHaveLength(2); expect(run.observations[0]).not.toHaveProperty("hlsFailure"); }
    if (scenario === "root-404" || scenario === "variant-route") {
      expect(events).toContainEqual(expect.objectContaining({ reason: "DETERMINISTIC_PROBE_REJECTION", probeCause: scenario === "root-404" ? "HTTP_CLIENT_ERROR" : "ROUTE_REJECTED" }));
      expect(report.version).toBe(7);
    }
    if (scenario === "variant-route") expect(run.observations[0]!.hlsFailure).toMatchObject({ phase: "VARIANT_PLAYLIST", cause: "ROUTE_REJECTED" });
    if (scenario === "budget") {
      expect(events).toContainEqual(expect.objectContaining({ reason: "PROBE_BUDGET_EXHAUSTED" }));
      expect(run.observations[0]!.hlsFailure).toMatchObject({ cause: "BUDGET_EXHAUSTED" });
    }
    if (scenario === "cancel") {
      expect(run.cancelled).toBe(true); expect(report.state).toBe("TRUNCATED");
      expect(events.some(e => e.kind === "OBSERVATION" && e.stage === "FINAL")).toBe(false);
      expect(events).not.toContainEqual({ kind: "END", outcome: "SUCCEEDED" });
    }
  });

  it("validates closed HLS fields and prevents status attribution to the wrong cause or version", () => {
    const good: DiagnosticEvent = { kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "HLS_NOT_VERIFIED", hlsPhase: "VARIANT_PLAYLIST", hlsCause: "HTTP_RESPONSE", httpStatus: 503 };
    expect(projectDiagnosticEvent(good)).toEqual(good);
    for (const extra of [{ hlsPhase: "private-phase-canary" }, { hlsCause: "private-cause-canary" }, { reason: "DETERMINISTIC_PROBE_REJECTION" },
      { stage: "PROBED" }, { url: "private-url-canary" }, { hlsCause: "TIMEOUT" }, { hlsCause: "CAUSE_UNDETERMINED" },
      ...[undefined, "503", 99, 600, NaN, Infinity, 503.5].map(httpStatus => ({ httpStatus }))]) {
      expect(projectDiagnosticEvent({ ...good, ...extra } as DiagnosticEvent)).toBeUndefined();
    }
    const getter = vi.fn(() => "private-getter-canary");
    expect(projectDiagnosticEvent(Object.defineProperty({ ...good }, "hlsPhase", { get: getter }))).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
    const c = new DiagnosticController(); c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }); const h = c.beginResolution()!;
    h.record(good); h.record({ kind: "EXCLUSION", candidate: 1, stage: "ADMITTED", reason: "DETERMINISTIC_PROBE_REJECTION", probeCause: "HTTP_CLIENT_ERROR", httpStatus: 404 });
    h.record({ kind: "PROVIDER_FAILURE", provider: 0, category: "CAUSE_UNDETERMINED" }); h.finish(); c.stop();
    const report = validateDiagnosticReport(c.report()); expect(report.version).toBe(6);
    for (const version of [1, 2, 3, 4, 5]) expect(() => validateDiagnosticReport({ ...report, version })).toThrow();
    const historical = structuredClone(report); historical.version = 5;
    for (const e of historical.resolutions[0]!.events) if (e.kind === "EXCLUSION" && e.reason === "HLS_NOT_VERIFIED") { delete e.hlsCause; delete e.hlsPhase; delete e.httpStatus; }
    expect(validateDiagnosticReport(historical)).toEqual(historical);
    const dom = diagnosticReportDom(renderDiagnosticHtml(historical)); dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Phase not captured · Not captured; cause undetermined");
  });

  it("does not promote a preliminary UNKNOWN into a missing effective observation", () => {
    const c = new DiagnosticController(); c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }); const h = c.beginResolution()!;
    h.record({ kind: "PRE_PROBE", candidate: 0, decision: "CONTINUE", identity: "UNKNOWN" }); h.finish(); c.stop();
    const dom = diagnosticReportDom(renderDiagnosticHtml(c.report())); dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Observed Identity: Not observed");
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Pre-probe Identity assessment (preliminary): Observed unknown Identity [UNKNOWN]");
  });

  it("keeps new admission with missing HLS evidence explicitly undetermined, without borrowing root HTTP 200", async () => {
    const measured = vi.spyOn(DirectStreamProbe.prototype, "probe").mockImplementation(sources => Promise.resolve(sources.map((s, i) => ({ ...s,
      directHttp: { status: i ? "reachable" as const : "unreachable" as const, verified: false, rangeSupported: false, responseStatus: 200,
        contentType: i ? "video/mp4" : "application/vnd.apple.mpegurl" }
    }))));
    try {
      const run = await hlsTraceFixture("success", "anonymous");
      const report = validateDiagnosticReport(run.c.report());
      const e = report.resolutions[0]!.events.find(e => e.kind === "EXCLUSION" && e.reason === "HLS_NOT_VERIFIED");
      expect(e).toMatchObject({ hlsCause: "CAUSE_UNDETERMINED" });
      expect(e).not.toHaveProperty("hlsPhase"); expect(e).not.toHaveProperty("httpStatus");
      expect(run.requests).toHaveLength(0); expect(report.version).toBe(7);
    } finally { measured.mockRestore(); }
  });

  it("keeps budget truncation and absent cause explicit without a synthetic terminal", () => {
    const c = new DiagnosticController(); c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }); const h = c.beginResolution()!;
    for (let i = 0; i <= L.resolutionEvents; i++) h.record({ kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "HLS_NOT_VERIFIED", hlsCause: "CAUSE_UNDETERMINED" });
    h.record({ kind: "END", outcome: "SUCCEEDED" }); h.finish(); c.stop();
    const r = validateDiagnosticReport(c.report()); expect(r.state).toBe("TRUNCATED"); expect(r.events).toBe(L.resolutionEvents);
    expect(r.resolutions[0]!.events.some(e => e.kind === "END")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(L.dtoBytes);
  });

  it("retains v6 facts at expiry and revokes late writes without manufacturing a successful END", () => {
    let now = 0;
    const c = new DiagnosticController(() => now); c.start({ ttlMs: 1000, resolutions: 1, retainReport: true });
    const h = c.beginResolution()!;
    h.record({ kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "HLS_NOT_VERIFIED", hlsPhase: "MEDIA_RESOURCE", hlsCause: "TIMEOUT" });
    now = 1000;
    expect(h.isActive()).toBe(false);
    const before = validateDiagnosticReport(c.report()); expect(before.version).toBe(6); expect(before.state).toBe("TRUNCATED");
    expect(before.resolutions[0]!.events).toHaveLength(1);
    h.record({ kind: "END", outcome: "SUCCEEDED" }); h.finish();
    expect(c.report()).toEqual(before);
  });
});
