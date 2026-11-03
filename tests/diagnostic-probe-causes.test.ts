import { describe, expect, it, vi } from "vitest";
import { deterministicProbeRejectionEvidence, isDeterministicProbeRejection, StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { DirectHttpProbeMetadata, NormalizedStreamSource } from "../src/streams/types";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { ExternalUrlPolicy, ExternalUrlPolicyError } from "../src/network/url-policy";
import { DiagnosticController } from "../src/diagnostics/controller";
import { diagnosticObserverFactory } from "../src/diagnostics/resolver-observer";
import { projectDiagnosticEvent, type DiagnosticEvent } from "../src/diagnostics/events";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { anonymizeDiagnosticExport, validatePrivateReport } from "../src/diagnostics/private-context";
import { DIAGNOSTIC_LIMITS as L } from "../src/diagnostics/recorder";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { fixtureOutboundRequest, silentLogger } from "./helpers";

const metadata = (extra: Partial<DirectHttpProbeMetadata> = {}): DirectHttpProbeMetadata => ({ status: "unreachable", verified: false, rangeSupported: false, ...extra });
const source = (probe?: DirectHttpProbeMetadata): NormalizedStreamSource => ({ providerId: "fixture", type: "https", url: "https://media.example/synthetic.mp4", ...(probe ? { directHttp: probe } : {}) });
const event: DiagnosticEvent = { kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "DETERMINISTIC_PROBE_REJECTION", probeCause: "HTTP_CLIENT_ERROR", httpStatus: 404 };
const options = { ttlMs: 300000, resolutions: 1, retainReport: true };
type Scenario = number | "route" | "zip" | "document" | "network" | "timeout";

async function run(scenario: Scenario, mode: "off" | "anonymous" | "private") {
  const c = new DiagnosticController(); if (mode !== "off") c.start(options, mode === "private");
  const input = [source(), { ...source(), url: "https://media.example/healthy.mp4" }];
  const registry = new StreamProviderRegistry(1000, silentLogger);
  registry.register({ id: "fixture", name: "Synthetic provider", isEnabled: () => true, resolve: () => Promise.resolve(input) });
  const network = vi.fn(fixtureOutboundRequest(({ url }) => {
    if (url.includes("healthy")) return Promise.resolve(new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "Content-Type": "video/mp4" } }));
    if (scenario === "route") return Promise.reject(new ExternalUrlPolicyError("private-error-canary"));
    if (scenario === "network") return Promise.reject(new Error("private-error-canary"));
    if (scenario === "timeout") return Promise.reject(new DOMException("private-error-canary", "TimeoutError"));
    if (scenario === "zip") return Promise.resolve(new Response(new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0]), { headers: { "Content-Type": "application/zip" } }));
    if (scenario === "document") return Promise.resolve(new Response("<html>private-body-canary</html>", { headers: { "Content-Type": "text/html" } }));
    return Promise.resolve(new Response(null, { status: scenario }));
  }));
  const probe = new DirectStreamProbe({ id: "fixture", request: network,
    diagnostics: () => ({ transport: "fixture", requests: network.mock.calls.length, failures: 0, averageLatencyMs: 0 }) },
  { enabled: true, timeoutMs: 1000, maxCandidates: 2, maxConcurrent: 1 }, silentLogger, () => 1000);
  const resolver = new StreamResolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), probe,
    undefined, undefined, 50, diagnosticObserverFactory(c));
  const result = await resolver.resolve({ id: "synthetic-request-canary", kind: "movie", title: "Synthetic requested title", externalIds: {} });
  c.stop();
  return { c, result, requests: network.mock.calls.map(([r]) => [r.url, new Headers(r.headers).get("range")]) };
}

describe("deterministic probe rejection evidence", () => {
  it("preserves the historical boolean for every HTTP status and probe state", () => {
    const historical = (s: NormalizedStreamSource) => {
      if (!((s.type === "http" || s.type === "https") && s.url) || !s.directHttp) return false;
      const p = s.directHttp;
      if (p.status === "route_rejected" || p.archiveFormat === "zip" || p.documentFormat) return true;
      return p.status === "unreachable" && p.responseStatus !== undefined && p.responseStatus >= 400 && p.responseStatus < 500 && ![408, 425, 429].includes(p.responseStatus);
    };
    for (const status of ["verified", "reachable", "unreachable", "timeout", "budget_exhausted", "route_rejected", "unknown"] as const) {
      for (const responseStatus of [undefined, NaN, Infinity, 401.5, ...Array.from({ length: 600 }, (_, i) => i)]) {
        const s = source(metadata({ status, ...(responseStatus !== undefined ? { responseStatus } : {}) }));
        expect(isDeterministicProbeRejection(s)).toBe(historical(s));
        if (status === "unreachable" && responseStatus !== undefined && Number.isInteger(responseStatus) && responseStatus >= 400 && responseStatus < 500 && ![408, 425, 429].includes(responseStatus)) {
          expect(deterministicProbeRejectionEvidence(s)).toEqual({ cause: "HTTP_CLIENT_ERROR", httpStatus: responseStatus });
        }
      }
    }
    expect(deterministicProbeRejectionEvidence(source(metadata({ responseStatus: 401.5 })))).toEqual({ cause: "CAUSE_UNDETERMINED" });
    expect(deterministicProbeRejectionEvidence(source())).toBeUndefined();
    expect(deterministicProbeRejectionEvidence({ ...source(metadata({ responseStatus: 404 })), type: "magnet" })).toBeUndefined();
    expect(deterministicProbeRejectionEvidence({ ...source(metadata({ responseStatus: 404 })), url: "" })).toBeUndefined();
  });

  it("uses explicit route, ZIP, document, HTTP precedence without exporting document or error payloads", () => {
    const p = metadata({ status: "route_rejected", archiveFormat: "zip", documentFormat: "html", responseStatus: 404 });
    expect(deterministicProbeRejectionEvidence(source(p))).toEqual({ cause: "ROUTE_REJECTED" });
    p.status = "unreachable"; expect(deterministicProbeRejectionEvidence(source(p))).toEqual({ cause: "ARCHIVE_ZIP" });
    delete p.archiveFormat; expect(deterministicProbeRejectionEvidence(source(p))).toEqual({ cause: "DOCUMENT_REJECTED" });
    delete p.documentFormat; expect(deterministicProbeRejectionEvidence(source(p))).toEqual({ cause: "HTTP_CLIENT_ERROR", httpStatus: 404 });
    for (const documentFormat of ["html", "xml", "json"] as const) expect(deterministicProbeRejectionEvidence(source(metadata({ documentFormat })))).toEqual({ cause: "DOCUMENT_REJECTED" });
  });

  it.each([401, 403, 404, 410, 418, 428, 499, "route", "zip", "document"] as const)("binds cause to real admission, JSON and HTML without changing requests or survivors: %s", async scenario => {
    const baseline = await run(scenario, "off");
    expect(baseline.result).toHaveLength(1);
    for (const mode of ["anonymous", "private"] as const) {
      const actual = await run(scenario, mode);
      expect(actual.result).toEqual(baseline.result); expect(actual.requests).toEqual(baseline.requests);
      const r = validateDiagnosticReport(JSON.parse(JSON.stringify(actual.c.report())));
      expect(r.version).toBe(7); expect(r.state).toBe("CLOSED");
      const e = r.resolutions[0]!.events.find(e => e.kind === "EXCLUSION" && e.reason === "DETERMINISTIC_PROBE_REJECTION");
      const cause = typeof scenario === "number" ? "HTTP_CLIENT_ERROR" : scenario === "route" ? "ROUTE_REJECTED" : scenario === "zip" ? "ARCHIVE_ZIP" : "DOCUMENT_REJECTED";
      expect(e).toMatchObject({ probeCause: cause });
      if (typeof scenario === "number") expect(e).toHaveProperty("httpStatus", scenario); else expect(e).not.toHaveProperty("httpStatus");
      expect(JSON.stringify(r)).not.toMatch(/media\.example|synthetic\.mp4|private-error-canary|private-body-canary|synthetic-request-canary/);
      const dom = diagnosticReportDom(renderDiagnosticHtml(r));
      dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Observed cause:");
      expect(dom.ids.get("timeline-body")!.textContent).toContain("Observed cause:");
      if (scenario === 404) {
        for (const id of ["source-inspector", "timeline-body"]) expect(dom.ids.get(id)!.textContent).toContain("HTTP 404 — Resource not found");
        dom.ids.get("language")!.value = "es"; dom.ids.get("language")!.change();
        expect(dom.ids.get("source-inspector")!.textContent).toContain("HTTP 404 — Recurso no encontrado");
      }
      if (mode === "private") {
        const p = actual.c.readPrivateReport(); if (p.state !== "AVAILABLE") throw new Error();
        expect(anonymizeDiagnosticExport(validatePrivateReport(p.report))).toEqual(r);
        expect(JSON.stringify(p.report)).not.toMatch(/media\.example|private-error-canary|private-body-canary/);
      }
    }
  });

  it.each([408, 425, 429, 500, 503, "network", "timeout"] as const)("does not relabel transient evidence as deterministic: %s", async scenario => {
    const baseline = await run(scenario, "off"), actual = await run(scenario, "anonymous");
    expect(actual.result).toEqual(baseline.result); expect(actual.result).toHaveLength(2);
    expect(actual.requests).toEqual(baseline.requests);
    expect(actual.c.report()!.resolutions[0]!.events.some(e => e.kind === "EXCLUSION" && e.reason === "DETERMINISTIC_PROBE_REJECTION")).toBe(false);
  });

  it("rejects malformed detail/stage/reason pairs, arbitrary payloads, extra fields and accessors", () => {
    expect(projectDiagnosticEvent(event)).toEqual(event);
    const bad = [
      { probeCause: "https://private.invalid/canary" }, { probeCause: "ARCHIVE_ZIP", httpStatus: 404 },
      { stage: "FINAL" }, { reason: "PROBE_BUDGET_EXHAUSTED" }, { url: "private-url-canary" }, { headers: "private-header-canary" },
      ...[undefined, "404", 401.5, NaN, Infinity, 399, 500, 408, 425, 429].map(httpStatus => ({ httpStatus }))
    ];
    for (const fields of bad) expect(projectDiagnosticEvent({ ...event, ...fields } as DiagnosticEvent)).toBeUndefined();
    const getter = vi.fn(() => "private-getter-canary");
    expect(projectDiagnosticEvent(Object.defineProperty({ ...event }, "probeCause", { get: getter }))).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    h.record({ ...event, httpStatus: "private-status-canary" } as unknown as DiagnosticEvent); h.finish(); c.stop();
    expect(c.report()!.state).toBe("TRUNCATED"); expect(c.report()!.events).toBe(0);
    expect(c.report()!.version).not.toBe(5);
  });

  it("records only the winning admission condition when budget, measured Identity or missing probes take precedence", async () => {
    const c = new DiagnosticController(); c.start(options);
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true, resolve: () => Promise.resolve(
      Array.from({ length: 4 }, (_, i) => ({ ...source(), url: `https://media.example/precedence-${i}.mp4` }))
    ) });
    const network = vi.fn(fixtureOutboundRequest(() => Promise.reject(new Error("must-not-request"))));
    const probe = new DirectStreamProbe({ id: "fixture", request: network,
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
    { enabled: true, timeoutMs: 1000, maxCandidates: 4, maxConcurrent: 1 }, silentLogger);
    const measured = vi.spyOn(probe, "probe").mockImplementation(sources => Promise.resolve(sources.map((s, i) => ({ ...s,
      ...(i === 3 ? {} : { directHttp: i === 0 ? metadata({ status: "budget_exhausted", archiveFormat: "zip" })
        : i === 1 ? metadata({ status: "verified", verified: true, archiveFormat: "zip", actualRuntimeSeconds: 1200, runtimeEvidence: "mp4_mvhd" })
          : metadata({ responseStatus: 404, documentFormat: "html" }) }) }))));
    try {
      const resolver = new StreamResolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), probe,
        undefined, undefined, 50, diagnosticObserverFactory(c));
      expect(await resolver.resolve({ id: "synthetic", kind: "movie", title: "Synthetic", runtimeSeconds: 7200, externalIds: {} })).toEqual([]);
      c.stop(); const events = validateDiagnosticReport(c.report()).resolutions[0]!.events;
      for (const reason of ["PROBE_BUDGET_EXHAUSTED", "MEASURED_RUNTIME_CONTRADICTION", "PROBE_MISSING"]) {
        const e = events.find(e => (e.kind === "EXCLUSION" || e.kind === "REJECTION") && e.reason === reason);
        expect(e).toBeDefined(); expect(e).not.toHaveProperty("probeCause");
      }
      const deterministic = events.filter(e => e.kind === "EXCLUSION" && e.reason === "DETERMINISTIC_PROBE_REJECTION");
      expect(deterministic).toHaveLength(1); expect(deterministic[0]).toMatchObject({ probeCause: "DOCUMENT_REJECTED" });
      expect(deterministic[0]).not.toHaveProperty("httpStatus"); expect(network).not.toHaveBeenCalled();
    } finally { measured.mockRestore(); c.stop(); }
  });

  it.each([false, true])("versions details monotonically and preserves historical unknown causes; truncated=%s", truncated => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    h.record(event); h.record({ kind: "PROVIDER_FAILURE", provider: 0, category: "CAUSE_UNDETERMINED" });
    if (truncated) h.truncate();
    h.record({ kind: "END", outcome: "SUCCEEDED" }); h.finish(); c.stop();
    const r = validateDiagnosticReport(c.report()); expect(r.version).toBe(5);
    expect(r.resolutions[0]!.events.some(e => e.kind === "END")).toBe(!truncated);
    for (const version of [1, 2, 3, 4]) expect(() => validateDiagnosticReport({ ...r, version })).toThrow();
    const historical = structuredClone(r); historical.version = 4;
    for (const e of historical.resolutions[0]!.events) if (e.kind === "EXCLUSION") { delete e.probeCause; delete e.httpStatus; }
    expect(validateDiagnosticReport(historical)).toEqual(historical);
    const dom = diagnosticReportDom(renderDiagnosticHtml(historical));
    dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Not captured; cause undetermined");
  });

  it("charges added detail bytes within the unchanged event and byte limits", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    for (let i = 0; i <= L.resolutionEvents; i++) h.record(event);
    h.record({ kind: "END", outcome: "SUCCEEDED" }); h.finish(); c.stop();
    const r = validateDiagnosticReport(c.report());
    expect(r.state).toBe("TRUNCATED"); expect(r.events).toBe(L.resolutionEvents);
    expect(r.resolutions[0]!.events.some(e => e.kind === "END")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(L.dtoBytes);
  });
});
