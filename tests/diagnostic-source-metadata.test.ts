import { describe, expect, it, vi } from "vitest";
import { DiagnosticRecorder, DIAGNOSTIC_LIMITS as L, type DiagnosticEvent } from "../src/diagnostics/recorder";
import { DiagnosticController } from "../src/diagnostics/controller";
import { observeResolution, diagnosticObserverFactory } from "../src/diagnostics/resolver-observer";
import { anonymizeDiagnosticExport, sourceDeclarations, validatePrivateReport, projectPrivateCandidate } from "../src/diagnostics/private-context";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { silentLogger } from "./helpers";
import type { NormalizedStreamSource, NormalizedMediaItem } from "../src/streams/types";

const options = { ttlMs: 300000, resolutions: 10, retainReport: true };
const item: NormalizedMediaItem = { id: "synthetic-request", kind: "movie", title: "Invented requested film", externalIds: {} };
const source = (title: string): NormalizedStreamSource => ({ providerId: "fixture", type: "https", url: "https://media.example/synthetic.mp4", title });
function report(c: DiagnosticController) {
  const r = c.readPrivateReport(); if (r.state !== "AVAILABLE") throw new Error("Missing report");
  return validatePrivateReport(r.report);
}
function resolve(c: DiagnosticController, inputs: NormalizedStreamSource[]) {
  const registry = new StreamProviderRegistry(1000, silentLogger);
  registry.register({ id: "fixture", name: "Fixture provider", isEnabled: () => true, resolve: () => Promise.resolve(inputs) });
  return new StreamResolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item);
}

describe("private source declarations", () => {
  it("preserves raw declarations for pre-normalization exclusions, duplicates and Identity rejection; OFF/ON outputs agree", async () => {
    const inputs = [source("Invented first release"), source("Invented duplicate release"),
      { ...source("Invented invalid source"), url: "" },
      { ...source("Invented wrong episode"), metadata: { identity: { kind: "episode", title: "Invented series", season: 2, episode: 3 } } }];
    const baseline = await resolve(new DiagnosticController(), inputs);
    for (const privateMode of [false, true]) {
      const c = new DiagnosticController(); c.start(options, privateMode);
      expect(await resolve(c, inputs)).toEqual(baseline); c.stop();
      expect(JSON.stringify(c.report())).not.toContain("Invented");
      if (!privateMode) { expect(c.readPrivateReport().state).toBe("ABSENT"); continue; }
      const r = report(c); const metadata = r.context[0]!.candidates!;
      expect(metadata.map(m => m.title)).toEqual(inputs.map(s => s.title));
      for (const [title, reason] of [["Invented duplicate release", "DUPLICATE"], ["Invented invalid source", "INVALID_SOURCE"], ["Invented wrong episode", "KIND_CONFLICT"]]) {
        const candidate = metadata.find(m => m.title === title)!;
        expect(r.report.resolutions[0]!.events).toContainEqual(expect.objectContaining({ candidateId: candidate.candidateId, reason }));
      }
      expect(metadata[3]).toMatchObject({ identityTitle: "Invented series", season: 2, episode: 3 });
      expect(anonymizeDiagnosticExport(r)).toEqual(c.report());
      const dom = diagnosticReportDom(renderDiagnosticHtml(r));
      dom.ids.get("sources-human")!.children[3]!.children[0]!.children[0]!.click();
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Declared title: Invented wrong episode");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Season: 2; Episode: 3");
      expect(dom.ids.get("source-inspector")!.textContent).toContain("Requested title: " + item.title);
      const bad = structuredClone(r); bad.context[0]!.candidates![0]!.candidateId = "00000000-0000-4000-8000-000000000000";
      expect(() => validatePrivateReport(bad)).toThrow("INVALID_PRIVATE_REPORT");
      const historical = structuredClone(r); delete historical.context[0]!.candidates;
      expect(validatePrivateReport(historical)).toEqual(historical);
    }
  });

  it.each(["</script><img src=x onerror=alert(1)>", "https://example.invalid/private", "Bearer synthetic-value", "token: synthetic", "user@example.invalid", "a".repeat(32), "safe ".repeat(33), "Safe\nSecret", "C:\\private", "Safe title " + "x".repeat(1000000)])("withholds entire unsafe value without prefix repair: %#", title => {
    expect(sourceDeclarations({ title, description: "never export description" }).title).toBe("");
    const c = new DiagnosticController(); c.start(options, true);
    const o = observeResolution(c.beginResolution()!); o.request!(item);
    o.trace.stage("provider", [source(title)], [Object.freeze({})]); o.finish(false); c.stop();
    const r = report(c); expect(r.context[0]!.candidates![0]!.title).toBe("");
    expect(JSON.stringify(r)).not.toContain(title); expect(renderDiagnosticHtml(r)).not.toContain(title);
  });

  it("does not invoke accessors or retain arbitrary metadata; isolates concurrent occurrences of the same object", () => {
    const getter = vi.fn(() => "forbidden getter");
    const raw = Object.defineProperty({ ...source("Invented shared release"), description: "forbidden description", metadata: { identity: { season: 4, episode: 6, externalIds: { secret: "forbidden identifier" } } } }, "name", { get: getter });
    expect(sourceDeclarations(raw)).toMatchObject({ name: "", title: raw.title, identityTitle: "", season: 4, episode: 6 });
    const c = new DiagnosticController(); c.start(options, true);
    const a = observeResolution(c.beginResolution()!), b = observeResolution(c.beginResolution()!);
    a.request!(item); b.request!({ ...item, title: "Other invented request" });
    a.trace.stage("provider", [raw, raw], [Object.freeze({}), Object.freeze({})]);
    b.trace.stage("provider", [raw], [Object.freeze({})]); b.finish(false); a.finish(false); c.stop();
    const r = report(c); const ids = r.context.flatMap(c => c.candidates!.map(m => m.candidateId));
    expect(new Set(ids).size).toBe(3); expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/forbidden/);
    const accessor = Object.defineProperty({}, "identity", { get: getter });
    expect(sourceDeclarations({ metadata: accessor }).season).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });

  it("bounds metadata, marks overflow incomplete and revokes late writes", () => {
    const c = new DiagnosticController(); c.start(options, true);
    const h = c.beginResolution()!; const o = observeResolution(h); o.request!(item);
    const safe = "Synthetic release ".repeat(8).trim();
    const inputs = Array.from({ length: 256 }, () => ({ ...source(safe), name: safe, metadata: { identity: { title: safe } } }));
    o.trace.stage("provider", inputs, inputs.map(() => Object.freeze({}))); o.finish(false); c.stop();
    const r = report(c); expect(r.report.state).toBe("TRUNCATED");
    expect(r.context[0]!.metadataCapture).toBe("CONTEXT_LIMIT");
    expect(Buffer.byteLength(JSON.stringify(r.context[0]))).toBeLessThan(32768 + 64);
    expect(r.context[0]!.candidates!.length).toBeLessThan(256);
    const dom = diagnosticReportDom(renderDiagnosticHtml(r));
    dom.ids.get("sources-human")!.children.at(-1)!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Private context byte limit reached");
    h.privateCandidate!(0, sourceDeclarations(source("Late invented title"))); expect(report(c)).toEqual(r);
  });

  it.each([
    [{}, "ABSENT"], [{ title: "" }, "EMPTY"], [{ title: "   " }, "EMPTY"], [{ title: null }, "INVALID_TYPE"],
    [{ title: 3 }, "INVALID_TYPE"], [{ title: "Invented accepted label" }, "CAPTURED"],
    [{ title: "Invented\nlabel" }, "CAPTURED"], [{ title: "https://example.invalid/synthetic" }, "WITHHELD"],
    [{ title: "Safe ".repeat(33) }, "OVER_LIMIT"]
  ])("classifies observer evidence without keeping rejected text: %#", (input, status) => {
    expect(sourceDeclarations(input).labelStatus!.title).toBe(status);
    const getter = vi.fn(() => "unread value");
    expect(sourceDeclarations(Object.defineProperty({}, "title", { get: getter })).labelStatus!.title).toBe("UNREADABLE");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["https", "magnet"] as const)("renders absent, captured and withheld labels on %s occurrences, including duplicates", transport => {
    const c = new DiagnosticController(); c.start(options, true);
    const o = observeResolution(c.beginResolution()!); o.request!(item);
    const inputs: NormalizedStreamSource[] = [
      { providerId: "fixture", type: transport }, source("Invented accepted label"), source("https://example.invalid/synthetic"), source("Safe ".repeat(33))
    ].map(s => ({ ...s, type: transport }));
    o.trace.stage("provider", inputs, inputs.map(() => Object.freeze({}))); o.finish(false); c.stop();
    const r = report(c); const candidates = r.context[0]!.candidates!;
    expect(candidates.map(c => c.labelStatus!.title)).toEqual(["ABSENT", "CAPTURED", "WITHHELD", "OVER_LIMIT"]);
    const dom = diagnosticReportDom(renderDiagnosticHtml(r));
    const messages = ["Field absent at observer boundary", "Invented accepted label", "Whole value withheld by privacy policy", "exceeds private label length limit"];
    for (let i = 0; i < inputs.length; i++) {
      dom.ids.get("sources-human")!.children[i]!.children[0]!.children[0]!.click();
      expect(dom.ids.get("source-inspector")!.textContent).toContain(messages[i]);
    }
    const anonymous = JSON.stringify(anonymizeDiagnosticExport(r));
    expect(anonymous).not.toMatch(/labelStatus|metadataCapture|Invented accepted label|WITHHELD/);
    const historical = structuredClone(r); delete historical.context[0]!.metadataCapture;
    historical.context[0]!.candidates!.forEach(c => { delete c.labelStatus; delete c.labelReasons; });
    expect(validatePrivateReport(historical)).toEqual(historical);
    const oldDom = diagnosticReportDom(renderDiagnosticHtml(historical));
    oldDom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(oldDom.ids.get("source-inspector")!.textContent).toContain("Unavailable, withheld by privacy policy or not captured");
    const declared = candidates[1]!;
    expect(() => projectPrivateCandidate({ ...declared, labelStatus: { ...declared.labelStatus, title: "ABSENT" } })).toThrow("INVALID_PRIVATE_REPORT");
    expect(() => projectPrivateCandidate({ ...declared, labelStatus: { ...declared.labelStatus, name: "arbitrary text" } })).toThrow("INVALID_PRIVATE_REPORT");
    const accessor = vi.fn(() => "CAPTURED");
    expect(() => projectPrivateCandidate({ ...declared, labelStatus: Object.defineProperty({ ...declared.labelStatus }, "title", { get: accessor }) })).toThrow("INVALID_PRIVATE_REPORT");
    expect(accessor).not.toHaveBeenCalled();
  });

  it("identifies a report byte limit only when a private context update is actually denied", () => {
    let admittedEventBytes = 0;
    class MeteredRecorder extends DiagnosticRecorder {
      override record(event: DiagnosticEvent, admit: (bytes: number) => boolean) {
        super.record(event, bytes => { const accepted = admit(bytes); if (accepted) admittedEventBytes += bytes; return accepted; });
      }
    }
    const c = new DiagnosticController(undefined, id => new MeteredRecorder(id)); c.start(options, true);
    const value = 9999.12345678901;
    for (let r = 0; r < 5; r++) {
      const h = c.beginResolution()!; const o = observeResolution(h); o.request!(item);
      for (let i = 0; i < 2000 && admittedEventBytes < L.dtoBytes - 10000; i++) h.record({ kind: "RANKING", candidate: i % 256, position: i % 256 + 1,
        score: value, availability: value, resolution: value, size: value, codec: value, metadata: value, transport: value });
      if (admittedEventBytes >= L.dtoBytes - 10000) {
        expect(c.status().truncated).toBe(false);
        h.privateContext!({ title: item.title, mediaKind: "movie", season: null, episode: null, metadataCapture: "WITHIN_LIMITS",
          providers: Array.from({ length: 64 }, (_, provider) => ({ provider, id: "Safe ".repeat(18).trim(), name: "Safe ".repeat(18).trim() })) });
        o.finish(false); c.stop(); const result = report(c);
        expect(result.context.at(-1)!.metadataCapture).toBe("REPORT_LIMIT");
        expect(result.report.state).toBe("TRUNCATED");
        expect(result.report.resolutions.at(-1)!.state).toBe("CLOSED");
        expect(result.report.resolutions.at(-1)!.events.at(-1)).toEqual({ kind: "END", outcome: "SUCCEEDED" });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(L.dtoBytes);
        return;
      }
      o.finish(false);
    }
    throw new Error("Synthetic byte budget was not reached");
  });

  it("explains a provider failure with no delivered individual candidates", async () => {
    const c = new DiagnosticController(); c.start(options, true);
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true, resolve: () => Promise.reject(new Error("synthetic failure")) });
    await new StreamResolver(registry, new ExternalUrlPolicy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
    const r = report(c); expect(r.context[0]!.candidates).toBeUndefined();
    expect(diagnosticReportDom(renderDiagnosticHtml(r)).ids.get("providers-human")!.textContent).toContain("No candidates delivered: no individual source metadata is available.");
  });
});
