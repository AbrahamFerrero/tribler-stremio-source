import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticController } from "../src/diagnostics/controller";
import { DiagnosticRecorder } from "../src/diagnostics/recorder";
import { observeResolution, diagnosticObserverFactory } from "../src/diagnostics/resolver-observer";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { validatePrivateReport, anonymizeDiagnosticExport, safeContextLabel, projectPrivateContext } from "../src/diagnostics/private-context";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { silentLogger } from "./helpers";

const options = { ttlMs: 300000, resolutions: 10, retainReport: true };
const item: NormalizedMediaItem = { id: "private-query-canary", kind: "movie", title: "Private context movie canary", externalIds: {} };
const policy = () => new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
const source = (name: string, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource => ({
  providerId: "untrusted-claimed-origin", type: "https", url: `https://media.example/${name}.mp4`, resolution: "1080p", ...extra
});
function privateReport(c: DiagnosticController) {
  const result = c.readPrivateReport(); if (result.state !== "AVAILABLE") throw new Error("Missing private fixture report");
  return validatePrivateReport(result.report);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

describe("US-1506 bounded context and registry evidence", () => {
  it("captures content/provider context only after explicit opt-in; normal output remains anonymous with closed v7 technical facts", async () => {
    for (const privateMode of [false, true]) {
      const c = new DiagnosticController(); c.start(options, privateMode);
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register({ id: "private_provider_canary", name: "Private provider name canary", isEnabled: () => true, resolve: () => Promise.resolve([source("private-source-locator-canary")]) });
      const result = await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item);
      c.stop(); expect(result).toHaveLength(1);
      const anonymous = validateDiagnosticReport(c.report()); expect(anonymous.version).toBe(7);
      const json = JSON.stringify(anonymous);
      for (const value of [item.title, item.id, "private_provider_canary", "Private provider name canary", "private-source-locator-canary", "untrusted-claimed-origin"]) expect(json).not.toContain(value);
      const origin = anonymous.resolutions[0]!.events.find(e => e.kind === "SOURCE"); expect(origin).toMatchObject({ provider: 0, transport: "HTTPS", height: 1080 });
      if (privateMode) {
        const report = privateReport(c); expect(report.context[0]).toMatchObject({ title: item.title, providers: [{ provider: 0, id: "private_provider_canary", name: "Private provider name canary" }] });
        expect(anonymizeDiagnosticExport(report)).toEqual(anonymous); expect(JSON.stringify(report)).not.toContain(item.id);
      } else expect(c.readPrivateReport()).toEqual({ state: "ABSENT" });
    }
  });

  it("distinguishes zero, disabled, failed, timeout and cancelled using bridge-owned state, without logging private identities", async () => {
    const c = new DiagnosticController(); c.start(options, true); const warn = vi.fn();
    const registry = new StreamProviderRegistry(25, { ...silentLogger, warn });
    const disabled = vi.fn(() => Promise.resolve([]));
    registry.register({ id: "provider_zero_canary", name: "Zero", isEnabled: () => true, resolve: () => Promise.resolve([]) });
    registry.register({ id: "provider_disabled_canary", name: "Disabled", isEnabled: () => false, resolve: disabled });
    registry.register({ id: "provider_failed_canary", name: "Failed", isEnabled: () => true, resolve: () => Promise.reject(new Error("private-error-canary")) });
    registry.register({ id: "provider_deadline_canary", name: "Deadline", isEnabled: () => true, resolve: () => new Promise(() => undefined) });
    await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
    const events = c.report()!.resolutions[0]!.events;
    const statuses = (provider: number) => events.filter(e => e.kind === "PROVIDER_STATE" && e.provider === provider).map(e => e.kind === "PROVIDER_STATE" ? e.status : "");
    expect(statuses(0)).toEqual(["ENABLED", "INVOKED", "RETURNED_ZERO"]);
    expect(statuses(1)).toEqual(["DISABLED"]); expect(disabled).not.toHaveBeenCalled();
    expect(statuses(2)).toEqual(["ENABLED", "INVOKED", "FAILED"]);
    expect(statuses(3)).toEqual(["ENABLED", "INVOKED", "TIMED_OUT"]);
    expect(events.find(e => e.kind === "PROVIDER_COUNTS" && e.provider === 0)).toMatchObject({ received: 0, delivered: 0, limited: 0 });
    expect(events.some(e => e.kind === "PROVIDER_COUNTS" && e.provider === 1)).toBe(false);
    for (const canary of ["provider_zero_canary", "provider_disabled_canary", "provider_failed_canary", "provider_deadline_canary", "private-error-canary"]) expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    c.start(options, true);
    await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
    const skipped = c.report()!.resolutions[0]!.events.filter(e => e.kind === "PROVIDER_STATE" && e.provider === 3);
    expect(skipped.map(e => e.kind === "PROVIDER_STATE" ? e.status : "")).toEqual(["ENABLED", "NOT_OBSERVED"]);
    expect(c.report()!.resolutions[0]!.events.some(e => e.kind === "PROVIDER_COUNTS" && e.provider === 3)).toBe(false);
    const cancelled = new DiagnosticController(); cancelled.start(options);
    const registry2 = new StreamProviderRegistry(1000, silentLogger); const entered = deferred<void>();
    registry2.register({ id: "cancel", name: "Cancel", isEnabled: () => true, resolve: () => { entered.resolve(); return new Promise(() => undefined); } });
    const abort = new AbortController(); const work = new StreamResolver(registry2, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(cancelled)).resolve(item, abort.signal);
    await entered.promise; abort.abort(); await work; cancelled.stop();
    expect(cancelled.report()!.resolutions[0]!.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "PROVIDER_STATE", status: "CANCELLED" })]));
  });

  it("keeps interleaved searches and provider origin/counts independent on one shared registry", async () => {
    const c = new DiagnosticController(); c.start(options, true); const registry = new StreamProviderRegistry(1000, silentLogger);
    const a = deferred<NormalizedStreamSource[]>(), b = deferred<NormalizedStreamSource[]>();
    registry.register({ id: "registered_alpha", name: "Alpha", isEnabled: () => true, resolve: media => media.title === "Search Alpha" ? a.promise : b.promise });
    registry.register({ id: "registered_beta", name: "Beta", isEnabled: () => true, resolve: () => Promise.resolve([source("beta")]) });
    const resolver = new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c));
    const first = resolver.resolve({ ...item, title: "Search Alpha" }); const second = resolver.resolve({ ...item, title: "Search Beta" });
    b.resolve([]); expect(await second).toHaveLength(1); a.resolve([source("alpha1"), source("alpha2")]); expect(await first).toHaveLength(3); c.stop();
    const report = privateReport(c);
    const counts = (title: string) => {
      const context = report.context.find(c => c.title === title)!;
      return report.report.resolutions.find(r => r.id === context.resolutionId)!.events.filter(e => e.kind === "PROVIDER_COUNTS");
    };
    expect(counts("Search Alpha")).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 0, received: 2 }), expect.objectContaining({ provider: 1, received: 1 })]));
    expect(counts("Search Beta")).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 0, received: 0 }), expect.objectContaining({ provider: 1, received: 1 })]));
    expect(new Set(report.report.resolutions.flatMap(r => r.events.filter(e => e.kind === "SOURCE").map(e => "candidateId" in e ? e.candidateId : ""))).size).toBe(4);
    const view = diagnosticReportDom(renderDiagnosticHtml(report));
    expect(view.ids.get("search-human")!.textContent).toContain("Search Alpha");
    expect(view.ids.get("search-human")!.textContent).not.toContain("Search Beta");
    const beta = report.context.find(c => c.title === "Search Beta")!.resolutionId;
    view.ids.get("resolution-filter")!.value = beta; view.ids.get("resolution-filter")!.change();
    expect(view.ids.get("search-human")!.textContent).toContain("Search Beta");
    expect(view.ids.get("search-human")!.textContent).not.toContain("Search Alpha");
    expect(view.ids.get("sources-human")!.children).toHaveLength(1);
    for (const id of ["search-human", "providers-human", "sources-human", "candidate-filter"]) expect(view.ids.get(id)!.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/);
  });

  it("records pre/post intake counts without changing production limits", async () => {
    const c = new DiagnosticController(); c.start(options);
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "many", name: "Many", isEnabled: () => true, resolve: () => Promise.resolve(Array.from({ length: 120 }, (_, i) => source(String(i)))) });
    const resolver = new StreamResolver(registry, policy(), undefined, undefined, undefined, 100, diagnosticObserverFactory(c));
    expect(await resolver.resolve(item)).toHaveLength(100); c.stop();
    expect(c.report()!.resolutions[0]!.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "PROVIDER_COUNTS", received: 120, delivered: 100, limited: 20 })]));
  });

  it("preserves identity rejection, observed deduplication and final source provenance", async () => {
    const c = new DiagnosticController(); c.start(options, true); const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "alpha", name: "Alpha", isEnabled: () => true, resolve: () => Promise.resolve([
      source("shared"), source("wrong-kind", { metadata: { identity: { kind: "episode", season: 1, episode: 1 } } })]) });
    registry.register({ id: "beta", name: "Beta", isEnabled: () => true, resolve: () => Promise.resolve([source("shared")]) });
    expect(await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item)).toHaveLength(1); c.stop();
    const report = privateReport(c), events = report.report.resolutions[0]!.events;
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "REJECTION", reason: "KIND_CONFLICT" }), expect.objectContaining({ kind: "EXCLUSION", stage: "DEDUPLICATED", reason: "DUPLICATE" })]));
    const rejected = events.find(e => e.kind === "REJECTION")!; expect(events.find(e => e.kind === "SOURCE" && "candidateId" in rejected && e.candidateId === rejected.candidateId)).toMatchObject({ provider: 0 });
    const html = renderDiagnosticHtml(report); const privateDom = diagnosticReportDom(html);
    expect(privateDom.ids.get("search-human")!.textContent).toContain(item.title);
    expect(privateDom.ids.get("providers-human")!.textContent).toContain("Alpha (alpha)");
    expect(privateDom.ids.get("sources-human")!.textContent).toContain("Source 1 · HTTPS · 1080p");
    expect(privateDom.ids.get("sources-human")!.textContent).toContain("Selected for final resolver output");
    expect(privateDom.ids.get("rejections-human")!.textContent).toContain("Media kind conflict");
    const rejectedCard = privateDom.ids.get("sources-human")!.children.find(c => c.textContent.includes("Media kind conflict"))!;
    rejectedCard.children[0]!.children[0]!.click();
    expect(privateDom.ids.get("source-inspector")!.textContent).toContain("Explicit contradiction");
    expect(privateDom.ids.get("source-inspector")!.textContent).toContain("Last observed stage: Normalized");
    expect(privateDom.ids.get("technical")!.getAttribute("open")).toBeNull();
    const anonymous = anonymizeDiagnosticExport(report), publicDom = diagnosticReportDom(renderDiagnosticHtml(anonymous));
    expect(publicDom.ids.get("search-human")!.textContent).not.toContain(item.title);
    expect(publicDom.ids.get("providers-human")!.textContent).not.toContain("Alpha"); expect(publicDom.ids.get("providers-human")!.textContent).toContain("Provider 1");
    privateDom.ids.get("language")!.value = "es"; privateDom.ids.get("language")!.change();
    expect(privateDom.document.documentElement.lang).toBe("es"); expect(privateDom.ids.get("sources-human")!.textContent).toContain("Fuente 1");
    expect(privateDom.ids.get("rejections-human")!.textContent).toContain("Conflicto de tipo de contenido");
  });

  it("revokes context on finish/stop/expiry/restart and never extends retention", () => {
    vi.useFakeTimers(); const c = new DiagnosticController(Date.now); c.start({ ...options, ttlMs: 1000 }, true);
    const capture = c.beginResolution()!; const observation = observeResolution(capture);
    observation.request!(item); observation.finish(false);
    capture.privateContext!({ title: "late title", mediaKind: "movie", season: null, episode: null, providers: [] });
    vi.advanceTimersByTime(1000); const report = privateReport(c); expect(report.context[0]!.title).toBe(item.title);
    capture.privateContext!({ title: "after stop", mediaKind: "movie", season: null, episode: null, providers: [] }); expect(privateReport(c)).toEqual(report);
    vi.advanceTimersByTime(300000); expect(c.readPrivateReport()).toEqual({ state: "EXPIRED" });
    c.start(options); const next = c.beginResolution()!; next.record({ kind: "END", outcome: "SUCCEEDED" }); next.finish(); c.stop();
    expect(c.readPrivateReport()).toEqual({ state: "ABSENT" }); expect(JSON.stringify(c.report())).not.toContain(item.title);
  });

  it("contains recorder failures, caps providers/context and preserves production", async () => {
    class Broken extends DiagnosticRecorder { override record() { throw new Error("private-recorder-canary"); } }
    const broken = new DiagnosticController(undefined, id => new Broken(id)); broken.start(options, true);
    const registry = new StreamProviderRegistry(1000, silentLogger); registry.register({ id: "healthy", name: "Healthy", isEnabled: () => true, resolve: () => Promise.resolve([source("healthy")]) });
    expect(await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(broken)).resolve(item)).toHaveLength(1);
    expect(broken.status().state).toBe("OFF"); expect(JSON.stringify(broken.readPrivateReport())).not.toContain(item.title);
    const c = new DiagnosticController(); c.start(options, true); const many = new StreamProviderRegistry(1000, silentLogger);
    for (let i = 0; i < 70; i++) many.register({ id: "p" + i, name: "Provider " + i, isEnabled: () => true, resolve: () => Promise.resolve([]) });
    expect(await new StreamResolver(many, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item)).toEqual([]); c.stop();
    expect(c.report()!.state).toBe("TRUNCATED"); expect(privateReport(c).context[0]!.providers.length).toBeLessThanOrEqual(64);
  });

  it("accounts private context inside the shared byte budget and exports overflow as incomplete", () => {
    const c = new DiagnosticController(); c.start(options, true);
    const value = 9999.12345678901;
    for (let r = 0; r < 6; r++) {
      const h = c.beginResolution()!;
      h.record({ kind: "REQUEST", mediaKind: "movie" });
      h.privateContext!({ title: "Private context budget film", mediaKind: "movie", season: null, episode: null, providers: [] });
      for (let p = 0; p < 64 && h.isActive(); p++) {
        h.record({ kind: "PROVIDER_STATE", provider: p, status: "ENABLED" });
        h.privateProvider!({ provider: p, id: "P " + "safe ".repeat(15).trim(), name: "Name " + "safe ".repeat(15).trim() });
      }
      for (let i = 0; i < 2048; i++) h.record({ kind: "RANKING", candidate: i % 256, position: i % 256 + 1,
        score: value, availability: value, resolution: value, size: value, codec: value, metadata: value, transport: value });
      h.finish();
    }
    c.stop(); const report = privateReport(c);
    expect(report.report.state).toBe("TRUNCATED"); expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(renderDiagnosticHtml(report))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(JSON.stringify(anonymizeDiagnosticExport(report))).not.toContain("Private context budget film");
  });

  it.each(["https://private.example/secret", "magnet:?xt=urn:btih:" + "a".repeat(40), "Bearer " + "b".repeat(64), "Cookie: secret", "C:\\Users\\person\\file", "/home/person/private", "<script>alert(1)</script>", "x".repeat(161), "0123456789abcdef0123456789abcdef01234567"])("rejects forbidden private context: case %#", value => {
    expect(safeContextLabel(value)).toBe("");
    expect(() => projectPrivateContext({ title: value, mediaKind: "movie", season: null, episode: null, providers: [] })).toThrow("INVALID_PRIVATE_REPORT");
  });

  it("rejects context accessors/extras and explicit v2 events in legacy v1 envelopes", async () => {
    const getter = vi.fn(() => "private-canary"); const c = new DiagnosticController(); c.start(options, true);
    const registry = new StreamProviderRegistry(1000, silentLogger); registry.register({ id: "p", name: "P", isEnabled: () => true, resolve: () => Promise.resolve([source("p")]) });
    await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
    const report = privateReport(c); const invalid = structuredClone(report);
    Object.defineProperty(invalid.context[0], "title", { get: getter }); expect(() => validatePrivateReport(invalid)).toThrow("INVALID_PRIVATE_REPORT"); expect(getter).not.toHaveBeenCalled();
    expect(() => validateDiagnosticReport(report)).toThrow("INVALID_DIAGNOSTIC_REPORT");
    expect(() => validateDiagnosticReport({ ...report.report, version: 1 })).toThrow("INVALID_DIAGNOSTIC_REPORT");
    expect(() => validatePrivateReport({ ...report, context: [{ ...report.context[0], url: "private-canary" }] })).toThrow("INVALID_PRIVATE_REPORT");
  });

  it("bounds source descriptor work before scanning text and never invokes descriptor accessors", () => {
    const getter = vi.fn(() => "private-source-title-canary"); const c = new DiagnosticController(); c.start(options);
    const observation = observeResolution(c.beginResolution()!);
    const input = Object.defineProperty(source("bounded", { resolution: "x".repeat(1000000) }), "title", { get: getter });
    observation.trace.stage("provider", [input], [Object.freeze({})]); observation.finish(false); c.stop();
    expect(getter).not.toHaveBeenCalled(); expect(c.report()!.resolutions[0]!.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "SOURCE", height: 0 })]));
    expect(JSON.stringify(c.report())).not.toContain("private-source-title-canary");
  });
});
