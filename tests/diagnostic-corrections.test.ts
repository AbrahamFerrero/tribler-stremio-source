import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticController } from "../src/diagnostics/controller";
import { observeResolution, diagnosticObserverFactory } from "../src/diagnostics/resolver-observer";
import { projectDiagnosticEvent, type DiagnosticEvent } from "../src/diagnostics/events";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { anonymizeDiagnosticExport, projectPrivateContext, validatePrivateReport } from "../src/diagnostics/private-context";
import { renderDiagnosticHtml, diagnosticReportScript } from "../src/diagnostics/html-report";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { fixtureOutboundRequest, silentLogger } from "./helpers";

const options = { ttlMs: 300000, resolutions: 10, retainReport: true };
const movie: NormalizedMediaItem = { id: "synthetic-request", kind: "movie", title: "Synthetic Meridian", externalIds: {} };
const source = (name: string, quality = "720p"): NormalizedStreamSource => ({ providerId: "fixture", type: "https", url: `https://media.example/${name}`, quality });
const policy = () => new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
function privateReport(c: DiagnosticController) {
  const result = c.readPrivateReport(); if (result.state !== "AVAILABLE") throw new Error("Missing synthetic private report");
  return validatePrivateReport(result.report);
}

describe("US-1507 title, causal exclusions and stage evidence", () => {
  it.each(["Synthetic series canary", undefined])("uses existing series metadata (%s) privately without changing the media item", async seriesTitle => {
    const c = new DiagnosticController(); c.start(options, true);
    const item: NormalizedMediaItem = { ...movie, id: "tt9999999999:2:3", kind: "episode", title: "", season: 2, episode: 3, ...(seriesTitle ? { seriesTitle } : {}) };
    const before = structuredClone(item), received: NormalizedMediaItem[] = [];
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: item => { received.push(structuredClone(item)); return Promise.resolve([]); } });
    await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(item); c.stop();
    expect(item).toEqual(before); expect(received).toEqual([before]);
    const report = privateReport(c);
    expect(report.context[0]).toMatchObject({ title: "", seriesTitle: seriesTitle ?? "", season: 2, episode: 3 });
    const dom = diagnosticReportDom(renderDiagnosticHtml(report)), search = dom.ids.get("search-human")!.textContent;
    expect(search).toContain(seriesTitle ?? "Requested title not observed");
    expect(search).toContain("Series title"); expect(search).toContain("Episode title unavailable"); expect(search).toContain("Season: 2; Episode: 3");
    dom.ids.get("language")!.value = "es"; dom.ids.get("language")!.change();
    expect(dom.ids.get("search-human")!.textContent).toContain("Título de la serie");
    const anonymous = JSON.stringify(anonymizeDiagnosticExport(report));
    for (const privateValue of ["seriesTitle", item.id, "Synthetic series canary"]) expect(anonymous).not.toContain(privateValue);
    expect(renderDiagnosticHtml(anonymizeDiagnosticExport(report))).not.toContain("Synthetic series canary");
  });

  it("validates optional series context strictly while retaining historical context", () => {
    const old = { title: "Synthetic title", mediaKind: "episode", season: 1, episode: 2, providers: [] };
    expect(projectPrivateContext(old)).toEqual(old);
    for (const seriesTitle of [undefined, null, 1, "https://private.example/title", "token hidden", "<script>"]) {
      expect(() => projectPrivateContext({ ...old, seriesTitle })).toThrow("INVALID_PRIVATE_REPORT");
    }
    expect(() => projectPrivateContext({ ...old, seriesTitle: "Synthetic", unexpected: true })).toThrow();
    expect(() => projectPrivateContext({ ...old, mediaKind: "movie", seriesTitle: "Synthetic" })).toThrow();
  });

  it("separates actual probe admission causes from unreachable observations and preserves ON/OFF output and networking", async () => {
    const run = async (on: boolean) => {
      const c = new DiagnosticController(); if (on) c.start(options);
      const registry = new StreamProviderRegistry(1000, silentLogger), calls: string[] = [];
      const input = [source("404.mp4"), source("unreachable.mp4"), source("budget-a.mp4"), source("budget-b.mp4"), source("budget-c.mp4")];
      registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve(input) });
      const request = fixtureOutboundRequest(({ url }) => {
        calls.push(url);
        return url.includes("404") ? Promise.resolve(new Response(null, { status: 404 })) : Promise.reject(new Error("Synthetic transport failure"));
      });
      const probe = new DirectStreamProbe({ id: "fixture", request, diagnostics: () => ({ transport: "fixture", requests: calls.length, failures: 0, averageLatencyMs: 0 }) },
        { enabled: true, timeoutMs: 1000, maxCandidates: 1, maxConcurrent: 1 }, silentLogger);
      const output = await new StreamResolver(registry, policy(), probe, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(movie); c.stop();
      return { output, calls, c };
    };
    const off = await run(false), on = await run(true);
    expect(on.output).toEqual(off.output); expect(on.calls).toEqual(off.calls);
    const report = validateDiagnosticReport(on.c.report()); expect(report.version).toBe(7);
    const events = report.resolutions[0]!.events;
    const unreachable = events.find(e => e.kind === "OBSERVATION" && e.stage === "FINAL" && e.probe === "unreachable"); expect(unreachable).toBeDefined();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "EXCLUSION", stage: "ADMITTED", reason: "DETERMINISTIC_PROBE_REJECTION" }),
      expect.objectContaining({ kind: "EXCLUSION", stage: "ADMITTED", reason: "PROBE_MISSING" })
    ]));
    for (const stage of ["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"]) {
      const snapshot = events.find(e => e.kind === "SNAPSHOT" && e.stage === stage);
      const observations = events.filter(e => e.kind === "OBSERVATION" && e.stage === stage);
      expect(snapshot).toMatchObject({ count: observations.length, observed: observations.length });
      const dom = diagnosticReportDom(renderDiagnosticHtml(report));
      const column = ["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"].indexOf(stage) + 1;
      expect(dom.ids.get("sources-human")!.children.filter(row => row.children[column]!.getAttribute("class") === "observed")).toHaveLength(observations.length);
    }
    expect(events.filter(e => e.kind === "GAP" && e.context === "CONTINUITY")).toHaveLength(0);
    const dom = diagnosticReportDom(renderDiagnosticHtml(report));
    expect(dom.ids.get("rejections-human")!.children.length).toBe(2);
    expect(dom.ids.get("rejections-human")!.textContent).toContain("probe observation");
    dom.ids.get("sources-human")!.children.at(-1)!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Not observed");
  });

  it("records budget exhaustion only when the real probe deadline causes admission rejection", async () => {
    vi.useFakeTimers();
    try {
      const c = new DiagnosticController(); c.start(options);
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true,
        resolve: () => Promise.resolve([source("first.mp4"), source("second.mp4"), source("third.mp4")]) });
      const request = fixtureOutboundRequest((_request, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Synthetic deadline")), { once: true });
      }));
      const probe = new DirectStreamProbe({ id: "fixture", request, diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
        { enabled: true, timeoutMs: 50, maxCandidates: 3, maxConcurrent: 1 }, silentLogger);
      const pending = new StreamResolver(registry, policy(), probe, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(movie);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toEqual([]); c.stop();
      const events = c.report()!.resolutions[0]!.events;
      expect(events.filter(e => e.kind === "OBSERVATION" && e.stage === "PROBED" && e.probe === "budget_exhausted")).toHaveLength(3);
      expect(events.filter(e => e.kind === "EXCLUSION" && e.stage === "ADMITTED" && e.reason === "PROBE_BUDGET_EXHAUSTED")).toHaveLength(3);
      expect(events.filter(e => e.kind === "GAP" && e.context === "CONTINUITY")).toHaveLength(0);
      const { ids } = diagnosticReportDom(renderDiagnosticHtml(c.report()));
      expect(ids.get("rejections-human")!.children).toHaveLength(1);
      expect(ids.get("rejections-human")!.textContent).toContain("exhausted (Admission evaluation): 3");
      ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
      expect(ids.get("source-inspector")!.textContent).toContain("Probe budget exhausted");
    } finally { vi.useRealTimers(); }
  });

  it.each(["unreachable", "budget_exhausted"] as const)("keeps %s as last evidence without inventing an exclusion", status => {
    const c = new DiagnosticController(); c.start(options); const o = observeResolution(c.beginResolution()!);
    const ref = Object.freeze({}), s = source("synthetic.mp4");
    o.trace.stage("provider", [s], [ref]);
    o.trace.stage("probed", [{ ...s, directHttp: { status, verified: false, rangeSupported: false } }], [ref]);
    o.trace.stage("admitted", [], []); o.finish(false); c.stop();
    const report = c.report()!; expect(report.version).toBe(2);
    const events = report.resolutions[0]!.events;
    expect(events.some(e => e.kind === "EXCLUSION" || e.kind === "REJECTION")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: "GAP", stage: "ADMITTED", reason: "INSUFFICIENT_EVIDENCE" }));
    const { ids } = diagnosticReportDom(renderDiagnosticHtml(report)); ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(ids.get("source-inspector")!.textContent).toContain("Last available observation (cause unknown): After probes");
  });

  it("observes pre-normalization discards at their actual decision point without certifying survival", async () => {
    const c = new DiagnosticController(); c.start(options);
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve([
      { providerId: "fixture", type: "https" },
      { ...source("blocked.mp4"), url: "http://127.0.0.1/private.mp4", type: "http" },
      { ...source("wrong-kind.mp4"), metadata: { identity: { kind: "episode", season: 1, episode: 1 } } },
      source("retained.mp4")
    ]) });
    expect(await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(movie)).toHaveLength(1); c.stop();
    const report = c.report()!, events = report.resolutions[0]!.events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "EXCLUSION", stage: "NORMALIZED", reason: "INVALID_SOURCE" }),
      expect.objectContaining({ kind: "EXCLUSION", stage: "NORMALIZED", reason: "URL_POLICY_REJECTION" }),
      expect.objectContaining({ kind: "REJECTION", stage: "NORMALIZED", reason: "KIND_CONFLICT" }),
      { kind: "SNAPSHOT", stage: "NORMALIZED", count: 1, observed: 1 }
    ]));
    const { ids } = diagnosticReportDom(renderDiagnosticHtml(report)), rows = ids.get("sources-human")!.children;
    expect(rows.slice(0, 3).map(row => row.children[2]!.getAttribute("class"))).toEqual(["rejected", "rejected", "rejected"]);
    expect(rows[3]!.children[2]!.getAttribute("class")).toBe("observed");
    rows[1]!.children[0]!.children[0]!.click();
    expect(ids.get("source-inspector")!.textContent).toContain("Stages observed: Provider intake");
    expect(ids.get("source-inspector")!.textContent).not.toContain("Stages observed: Provider intake → Normalized");
  });

  it("records which deduplication occurrence was actually discarded when higher scores replace prior winners", async () => {
    const c = new DiagnosticController(); c.start(options); const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "first", name: "First", isEnabled: () => true, resolve: () => Promise.resolve([source("same.mp4", "480p"), source("same.mp4", "1080p")]) });
    registry.register({ id: "second", name: "Second", isEnabled: () => true, resolve: () => Promise.resolve([{ ...source("same.mp4", "2160p"), providerId: "second" }]) });
    const output = await new StreamResolver(registry, policy(), undefined, undefined, undefined, 50, diagnosticObserverFactory(c)).resolve(movie); c.stop();
    expect(output).toHaveLength(1); expect(output[0]!.quality).toBe("2160p");
    const events = c.report()!.resolutions[0]!.events, discarded = events.filter(e => e.kind === "EXCLUSION"); expect(discarded).toHaveLength(2);
    const intake = events.filter(e => e.kind === "OBSERVATION" && e.stage === "PROVIDER");
    expect(discarded.map(e => "candidateId" in e ? e.candidateId : "")).toEqual(intake.slice(0, 2).map(e => "candidateId" in e ? e.candidateId : ""));
  });

  it("keeps missing deduplication attribution uncertain and never derives survival from a snapshot or PRE_PROBE", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    for (let candidate = 0; candidate < 3; candidate++) {
      h.record({ kind: "OBSERVATION", candidate, stage: "PROVIDER", identity: "UNCLASSIFIED", probe: "UNOBSERVED" });
      h.record({ kind: "PRE_PROBE", candidate, decision: candidate === 0 ? "REJECT" : "CONTINUE", identity: "UNCLASSIFIED" });
    }
    h.record({ kind: "SNAPSHOT", stage: "NORMALIZED", count: 2, observed: 2 });
    h.record({ kind: "GAP", candidate: 1, stage: "DEDUPLICATED", context: "CONTINUITY", reason: "INSUFFICIENT_EVIDENCE" });
    h.finish(); c.stop();
    const report = c.report()!;
    for (const version of [1, 2] as const) {
      expect(validateDiagnosticReport({ ...report, version }).version).toBe(version);
      const { ids } = diagnosticReportDom(renderDiagnosticHtml({ ...report, version })), rows = ids.get("sources-human")!.children;
      expect(rows[0]!.children[2]!.getAttribute("class")).toBe("rejected");
      expect(rows[1]!.children[2]!.getAttribute("class")).toBe("unavailable");
      expect(rows[1]!.children[3]!.getAttribute("class")).toBe("unknown");
      expect(rows[2]!.children[2]!.getAttribute("class")).toBe("unavailable");
    }
    const truncated = { ...report, state: "TRUNCATED" };
    expect(diagnosticReportDom(renderDiagnosticHtml(truncated)).ids.get("sources-human")!.children[1]!.children[3]!.getAttribute("class")).toBe("unknown");
  });

  it("reconciles a complete synthetic 22-to-13 funnel with nine explicit exclusions and no unknown losses", async () => {
    const registry = new StreamProviderRegistry(1000, silentLogger);
    const retained = Array.from({ length: 13 }, (_, i) => source(`retained-${i}.mp4`));
    const input = [...retained, { ...retained[0]! },
      ...Array.from({ length: 4 }, (_, i) => source(`budget-${i}.mp4`)),
      ...Array.from({ length: 3 }, (_, i) => source(`rejected-${i}.mp4`)), source("unverified")];
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve(input) });
    const probe = new DirectStreamProbe({ id: "fixture", request: () => Promise.reject(new Error("Unexpected synthetic network request")),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { enabled: true, timeoutMs: 1000, maxCandidates: 100, maxConcurrent: 1 }, silentLogger);
    // Controlled probe boundary; actual resolver admission/deduplication and recorder run unchanged.
    const measured = vi.spyOn(probe, "probe").mockImplementation(sources => Promise.resolve(sources.map(s => ({ ...s,
      directHttp: s.url!.includes("budget-") ? { status: "budget_exhausted", verified: false, rangeSupported: false }
        : s.url!.includes("rejected-") ? { status: "unreachable", verified: false, rangeSupported: false, responseStatus: 404 }
        : s.url!.endsWith("unverified") ? { status: "reachable", verified: false, rangeSupported: false, responseStatus: 200, contentType: "application/octet-stream" }
        : { status: "verified", verified: true, rangeSupported: true, responseStatus: 206, contentType: "video/mp4" }
    }))));
    try {
      const c = new DiagnosticController(), resolver = new StreamResolver(registry, policy(), probe, undefined, undefined, 50, diagnosticObserverFactory(c));
      const off = await resolver.resolve(movie); c.start(options); const on = await resolver.resolve(movie); c.stop();
      expect(on).toEqual(off); expect(on).toHaveLength(13); expect(measured).toHaveBeenCalledTimes(2);
      const report = validateDiagnosticReport(c.report()), events = report.resolutions[0]!.events;
      expect(report).toMatchObject({ version: 7, state: "CLOSED" });
      const stages = ["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"] as const;
      const counts = [22, 22, 21, 21, 13, 13], html = renderDiagnosticHtml(report);
      const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
      for (const content of [style, diagnosticReportScript]) {
        expect(html).toContain(`sha256-${createHash("sha256").update(content).digest("base64")}`);
      }
      expect(html).toContain("connect-src &#39;none&#39;");
      expect(html).not.toMatch(/unsafe-inline|unsafe-eval|<script[^>]+src=/);
      const { ids } = diagnosticReportDom(html);
      const rows = ids.get("sources-human")!.children;
      for (const [index, stage] of stages.entries()) {
        const seen = events.flatMap(e => e.kind === "OBSERVATION" && e.stage === stage ? [e.candidateId] : []);
        expect(events.find(e => e.kind === "SNAPSHOT" && e.stage === stage)).toMatchObject({ count: counts[index], observed: counts[index] });
        expect(new Set(seen).size).toBe(counts[index]);
        expect(rows.filter(row => row.children[index + 1]!.getAttribute("class") === "observed")).toHaveLength(counts[index]!);
        if (index > 0) {
          const previousStage = stages[index - 1]!;
          const previous = events.flatMap(e => e.kind === "OBSERVATION" && e.stage === previousStage ? [e.candidateId] : []);
          const lost = previous.filter(id => !seen.includes(id));
          const discarded = events.flatMap(e => e.kind === "EXCLUSION" && e.stage === stage ? [e.candidateId] : []);
          expect(new Set(discarded)).toEqual(new Set(lost));
        }
      }
      const exclusions = events.filter(e => e.kind === "EXCLUSION"); expect(exclusions).toHaveLength(9);
      for (const [reason, count] of [["DUPLICATE", 1], ["PROBE_BUDGET_EXHAUSTED", 4], ["DETERMINISTIC_PROBE_REJECTION", 3], ["DIRECT_MEDIA_NOT_VERIFIED", 1]]) {
        expect(exclusions.filter(e => e.reason === reason)).toHaveLength(Number(count));
      }
      expect(events.some(e => e.kind === "GAP" && e.context === "CONTINUITY")).toBe(false);
      expect(ids.get("rejections-human")!.children).toHaveLength(4);
      expect(ids.get("source-counts")!.textContent).toContain("Explicitly rejected: 9");
      for (const [value, count] of [["final", 13], ["rejected", 9], ["unknown", 0], ["", 22]] as const) {
        ids.get("outcome-filter")!.value = value; ids.get("outcome-filter")!.change();
        expect(ids.get("sources-human")!.children).toHaveLength(count);
      }
      rows[14]!.children[0]!.children[0]!.click();
      expect(ids.get("source-inspector")!.textContent).toContain("Admission rejected because probe budget was exhausted");
      ids.get("language")!.value = "es"; ids.get("language")!.change();
      expect(ids.get("source-counts")!.textContent).toContain("Rechazadas explícitamente: 9");
    } finally { measured.mockRestore(); }
  });

  it("strictly versions and validates minimal exclusion events, rejecting wrong stage/reason pairs and private fields", () => {
    const event: DiagnosticEvent = { kind: "EXCLUSION", candidate: 0, stage: "ADMITTED", reason: "PROBE_BUDGET_EXHAUSTED" };
    expect(projectDiagnosticEvent(event)).toEqual(event);
    for (const bad of [{ ...event, title: "Private" }, { ...event, reason: "unreachable" }, { ...event, stage: "PROVIDER" }, { ...event, stage: "NORMALIZED" }, { ...event, identity: "CONTRADICTION" }]) expect(projectDiagnosticEvent(bad as DiagnosticEvent)).toBeUndefined();
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    h.record(event); h.record({ kind: "REQUEST", mediaKind: "movie" }); h.finish(); c.stop();
    const report = c.report()!; expect(report.version).toBe(3); expect(validateDiagnosticReport(report)).toEqual(report);
    for (const version of [1, 2]) expect(() => validateDiagnosticReport({ ...report, version })).toThrow("INVALID_DIAGNOSTIC_REPORT");
  });
});
