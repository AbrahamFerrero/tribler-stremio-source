import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticController } from "../src/diagnostics/controller";
import { diagnosticObserverFactory, observeResolution } from "../src/diagnostics/resolver-observer";
import { projectDiagnosticEvent, type DiagnosticEvent } from "../src/diagnostics/events";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { anonymizeDiagnosticExport } from "../src/diagnostics/private-context";
import { renderDiagnosticHtml, diagnosticReportScript } from "../src/diagnostics/html-report";
import { ExternalUrlPolicy, ExternalUrlPolicyError } from "../src/network/url-policy";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { silentLogger } from "./helpers";

const options = { ttlMs: 300000, resolutions: 10, retainReport: true };
const item: NormalizedMediaItem = { id: "synthetic-id", kind: "movie", title: "Synthetic requested title", externalIds: {} };
const policy = () => new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
const source: NormalizedStreamSource = { providerId: "fixture", type: "https", url: "https://media.example/synthetic.mp4" };

async function rejected(error: unknown, active = true) {
  const c = new DiagnosticController(); if (active) c.start(options, true);
  const registry = new StreamProviderRegistry(1000, silentLogger);
  registry.register({ id: "synthetic_private_provider", name: "Synthetic private name", isEnabled: () => true, resolve: () => { throw error; } });
  const output = await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
  return { c, output };
}
function events(c: DiagnosticController) { return c.report()!.resolutions[0]!.events; }

describe("passive provider failure categories and probed boundary", () => {
  it.each([
    [new ExternalUrlPolicyError("synthetic private route"), "URL_POLICY_REJECTED"],
    [new Error("TimeoutError fetch failed HTTP 503 token synthetic-secret"), "CAUSE_UNDETERMINED"],
    [Object.assign(new Error("Synthetic"), { name: "ExternalUrlPolicyError", code: "ETIMEDOUT" }), "CAUSE_UNDETERMINED"],
    ["https://private.example/synthetic?token=synthetic-secret", "CAUSE_UNDETERMINED"]
  ])("projects only trusted categories from exception case %#", async (error, category) => {
    const { c, output } = await rejected(error); expect(output).toEqual([]);
    expect(c.report()!.version).toBe(4);
    expect(events(c)).toContainEqual({ kind: "PROVIDER_FAILURE", provider: 0, category });
    expect(events(c)).toContainEqual({ kind: "PROVIDER_STATE", provider: 0, status: "FAILED" });
    const privateRead = c.readPrivateReport(); if (privateRead.state !== "AVAILABLE") throw new Error("Missing synthetic context");
    const anonymous = anonymizeDiagnosticExport(privateRead.report), json = JSON.stringify(anonymous);
    for (const secret of ["synthetic_private_provider", "Synthetic private name", item.title, item.id, "synthetic-secret", "private.example", "stack", "headers", "cookie"]) expect(json).not.toContain(secret);
    const dom = diagnosticReportDom(renderDiagnosticHtml(anonymous));
    expect(dom.ids.get("providers-human")!.textContent).toContain(category === "URL_POLICY_REJECTED" ? "Bridge URL policy rejected" : "Failure cause undetermined");
    dom.ids.get("state-filter")!.value = String(category); dom.ids.get("state-filter")!.change();
    expect(dom.ids.get("timeline-body")!.textContent).toContain("PROVIDER_FAILURE");
    dom.ids.get("language")!.value = "es"; dom.ids.get("language")!.change();
    expect(dom.ids.get("providers-human")!.textContent).toContain(category === "URL_POLICY_REJECTED" ? "política URL" : "Causa del fallo no determinada");
  });

  it("does not read hostile exception properties and contains prototype traps only when observing", async () => {
    const getter = vi.fn(() => { throw new Error("Synthetic private accessor"); });
    const hostile = Object.defineProperties({}, { name: { get: getter }, message: { get: getter }, stack: { get: getter }, code: { get: getter }, cause: { get: getter } });
    for (const active of [false, true]) { expect((await rejected(hostile, active)).output).toEqual([]); }
    expect(getter).not.toHaveBeenCalled();
    const prototype = vi.fn(() => { throw new Error("Synthetic private prototype"); });
    const proxy = new Proxy({}, { getPrototypeOf: prototype });
    await rejected(proxy, false); expect(prototype).not.toHaveBeenCalled();
    const { c } = await rejected(proxy); expect(prototype).toHaveBeenCalledOnce();
    expect(events(c)).toContainEqual({ kind: "PROVIDER_FAILURE", provider: 0, category: "CAUSE_UNDETERMINED" });
  });

  it("preserves actual external adapter requests/results ON/OFF and leaves generic response/transport failures undetermined", async () => {
    const run = async (active: boolean) => {
      const c = new DiagnosticController(); if (active) c.start(options);
      const registry = new StreamProviderRegistry(1000, silentLogger), calls: Array<[string, string | undefined, string | undefined]> = [];
      for (const kind of ["results", "empty", "invalid", "transport", "policy"]) {
        registry.register(new ExternalHttpStreamProvider({ id: kind, name: "Synthetic " + kind,
          url: kind === "policy" ? "http://127.0.0.1/synthetic" : `https://provider.example/${kind}`, timeoutMs: 1000, policy: policy(),
          fetchImplementation: (url, init) => {
            calls.push([typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init?.method, typeof init?.body === "string" ? init.body : undefined]);
            if (kind === "transport") return Promise.reject(new Error("Synthetic transport failure"));
            if (kind === "invalid") return Promise.resolve(new Response("synthetic invalid response", { headers: { "Content-Type": "text/html" } }));
            return Promise.resolve(new Response(JSON.stringify({ streams: kind === "empty" ? [] : [source] }), { headers: { "Content-Type": "application/json" } }));
          } }));
      }
      const output = await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
      return { c, calls, output, diagnostics: registry.status() };
    };
    const off = await run(false), on = await run(true);
    expect(on.output).toEqual(off.output); expect(on.output).toHaveLength(1); expect(on.calls).toEqual(off.calls); expect(on.calls).toHaveLength(4);
    expect(on.diagnostics.map(({ id, status, lastError }) => ({ id, status, lastError }))).toEqual(off.diagnostics.map(({ id, status, lastError }) => ({ id, status, lastError })));
    const observed = events(on.c);
    expect(observed).toContainEqual({ kind: "PROVIDER_STATE", provider: 1, status: "RETURNED_ZERO" });
    expect(observed.filter(e => e.kind === "PROVIDER_FAILURE")).toHaveLength(3);
    expect(observed.filter(e => e.kind === "PROVIDER_FAILURE")).toEqual(expect.arrayContaining([
      { kind: "PROVIDER_FAILURE", provider: 4, category: "URL_POLICY_REJECTED" },
      { kind: "PROVIDER_FAILURE", provider: 3, category: "CAUSE_UNDETERMINED" },
      { kind: "PROVIDER_FAILURE", provider: 2, category: "CAUSE_UNDETERMINED" }
    ]));
  });

  it("observes registry deadlines, cancellation, zero, disabled and abandoned work without inventing failures", async () => {
    const c = new DiagnosticController(); c.start(options);
    const registry = new StreamProviderRegistry(20, silentLogger);
    const deadline = vi.fn(() => new Promise<NormalizedStreamSource[]>(() => undefined));
    registry.register({ id: "deadline", name: "Synthetic deadline", isEnabled: () => true, resolve: deadline });
    registry.register({ id: "zero", name: "Synthetic zero", isEnabled: () => true, resolve: () => Promise.resolve([]) });
    registry.register({ id: "disabled", name: "Synthetic disabled", isEnabled: () => false, resolve: () => Promise.reject(new Error("Must not invoke")) });
    const resolver = new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c));
    expect(await resolver.resolve(item)).toEqual([]);
    expect(await resolver.resolve(item)).toEqual([]); c.stop();
    expect(deadline).toHaveBeenCalledOnce();
    const first = c.report()!.resolutions[0]!.events, second = c.report()!.resolutions[1]!.events;
    expect(first).toContainEqual({ kind: "PROVIDER_STATE", provider: 0, status: "TIMED_OUT" });
    expect(first.filter(e => e.kind === "PROVIDER_FAILURE")).toEqual([{ kind: "PROVIDER_FAILURE", provider: 0, category: "REGISTRY_DEADLINE" }]);
    expect(second).toContainEqual({ kind: "PROVIDER_STATE", provider: 0, status: "NOT_OBSERVED" });
    expect(second.some(e => e.kind === "PROVIDER_FAILURE")).toBe(false);
    const cancelled = new DiagnosticController(); cancelled.start(options); const signal = new AbortController();
    const cancelRegistry = new StreamProviderRegistry(1000, silentLogger);
    cancelRegistry.register({ id: "cancel", name: "Synthetic", isEnabled: () => true, resolve: () => { signal.abort(); return new Promise(() => undefined); } });
    const output = await new StreamResolver(cancelRegistry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(cancelled)).resolve(item, signal.signal); cancelled.stop();
    expect(output).toEqual([]); expect(events(cancelled)).toContainEqual({ kind: "PROVIDER_STATE", provider: 0, status: "CANCELLED" });
    expect(events(cancelled).some(e => e.kind === "PROVIDER_FAILURE")).toBe(false);
  });

  it("contains failing failure observers and keeps source results and scheduler eligibility", async () => {
    const registry = new StreamProviderRegistry(1000, silentLogger, 1);
    registry.register({ id: "bad", name: "Synthetic bad", isEnabled: () => true, resolve: () => Promise.reject(new Error("Synthetic")) });
    registry.register({ id: "good", name: "Synthetic good", isEnabled: () => true, resolve: () => Promise.resolve([source]) });
    const configured = vi.fn(), failure = vi.fn(() => { throw new Error("Synthetic observer failure"); });
    const result = await registry.resolveAll(item, undefined, { configured, state: () => undefined, counts: () => undefined, origins: () => undefined, failure });
    expect(result).toEqual([source]); expect(failure).toHaveBeenCalledOnce(); expect(configured).toHaveBeenCalledTimes(2);
    expect(await registry.resolveAll(item)).toEqual([source]);
  });

  it("versions failure evidence strictly and never downgrades when later exclusions/sources arrive", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    const event: DiagnosticEvent = { kind: "PROVIDER_FAILURE", provider: 0, category: "CAUSE_UNDETERMINED" };
    expect(projectDiagnosticEvent(event)).toEqual(event); h.record(event);
    h.record({ kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "PROBE_MISSING" });
    h.record({ kind: "SOURCE", candidate: 0, provider: 0, height: 0, transport: "HTTPS" }); h.finish(); c.stop();
    const report = validateDiagnosticReport(c.report()); expect(report.version).toBe(4);
    for (const version of [1, 2, 3]) expect(() => validateDiagnosticReport({ ...report, version })).toThrow("INVALID_DIAGNOSTIC_REPORT");
    for (const input of [{ ...event, category: "TimeoutError" }, { ...event, message: "Synthetic private" }, { ...event, provider: "arbitrary-id" }, { ...event, url: "https://private.example" }]) expect(projectDiagnosticEvent(input as DiagnosticEvent)).toBeUndefined();
    const getter = vi.fn(() => "CAUSE_UNDETERMINED");
    expect(projectDiagnosticEvent(Object.defineProperty({ ...event }, "category", { get: getter }))).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3] as const)("keeps v%s reports readable without retroactively classifying provider failures", version => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    if (version >= 2) h.record({ kind: "PROVIDER_STATE", provider: 0, status: "FAILED" });
    if (version === 3) h.record({ kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "PROBE_MISSING" });
    h.finish(); c.stop(); const report = validateDiagnosticReport({ ...c.report(), version });
    const html = renderDiagnosticHtml(report), { ids } = diagnosticReportDom(html);
    expect(JSON.parse(/<script id="diagnostic-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!)).toEqual(report);
    if (version >= 2) expect(ids.get("providers-human")!.textContent).toContain("Failure category not captured");
    expect(report.resolutions[0]!.events.some(e => e.kind === "PROVIDER_FAILURE")).toBe(false);
  });

  it.each(["complete", "truncated", "missing", "duplicate"])("explains the probed boundary and only totals complete unique observations: %s", mode => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    h.record({ kind: "SNAPSHOT", stage: "PROBED", count: 3, observed: 3 });
    for (let candidate = 0; candidate < (mode === "missing" ? 2 : 3); candidate++) h.record({ kind: "OBSERVATION", candidate: mode === "duplicate" ? 0 : candidate, stage: "PROBED", identity: "UNCLASSIFIED", probe: candidate === 0 ? "verified" : candidate === 1 ? "budget_exhausted" : "UNOBSERVED" });
    if (mode === "truncated") h.truncate(); h.finish(); c.stop();
    const html = renderDiagnosticHtml(c.report()), { ids } = diagnosticReportDom(html), content = ids.get("funnel-human")!.textContent;
    expect(content).toContain("not necessarily HTTP probes executed or verified transports");
    if (mode === "complete") {
      for (const status of ["Transport verified: 1", "Probe budget exhausted: 1", "Not observed: 1"]) expect(content).toContain(status);
    } else { expect(content).toContain("breakdown unavailable"); expect(content).not.toContain("Transport verified: 1"); }
    ids.get("language")!.value = "es"; ids.get("language")!.change();
    expect(ids.get("funnel-human")!.textContent).toContain("no implica probes HTTP ejecutados ni transportes verificados");
    for (const text of [diagnosticReportScript, /<style>([\s\S]*?)<\/style>/.exec(html)![1]!]) expect(html).toContain(`sha256-${createHash("sha256").update(text).digest("base64")}`);
    expect(html).toContain("connect-src &#39;none&#39;");
  });

  it("marks failure evidence missing when truncation occurs between state and category", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    const observation = observeResolution(h);
    observation.registry!.configured(0, "", "", true); observation.registry!.state(0, "FAILED"); h.truncate();
    observation.registry!.failure!(0, "CAUSE_UNDETERMINED"); observation.finish(false); c.stop();
    expect(events(c).some(e => e.kind === "PROVIDER_FAILURE")).toBe(false);
    expect(diagnosticReportDom(renderDiagnosticHtml(c.report())).ids.get("providers-human")!.textContent).toContain("Failure category not captured");
  });
});
