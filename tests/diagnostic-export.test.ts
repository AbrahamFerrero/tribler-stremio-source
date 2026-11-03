import { diagnosticReportDom as dom } from './diagnostic-dom-harness';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { diagnosticReportFixture } from "./diagnostic-report-fixture";
import { diagnosticTranslations, validateDiagnosticTranslations } from "../src/diagnostics/i18n";
import { renderDiagnosticHtml, diagnosticReportScript, escapeDiagnosticHtml, embedDiagnosticJson } from "../src/diagnostics/html-report";
import { validateDiagnosticReport, serializeDiagnosticReport } from "../src/diagnostics/report-model";
import { writeDiagnosticExport, HTML_REPORT_MAX_BYTES } from "../src/diagnostics/export-file";
import { DIAGNOSTIC_LIMITS as L } from "../src/diagnostics/recorder";
import { DiagnosticController } from "../src/diagnostics/controller";

export function embeddedReport(html: string): unknown {
  return JSON.parse(/<script id="diagnostic-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as unknown;
}

describe("one closed report model and bilingual offline HTML", () => {
  it("keeps JSON and HTML datasets semantically identical and opens in English", () => {
    const report = diagnosticReportFixture(); const json = serializeDiagnosticReport(report); const html = renderDiagnosticHtml(report);
    expect(embeddedReport(html)).toEqual(JSON.parse(json)); expect(validateDiagnosticReport(report)).toEqual(report);
    expect(html).toContain('<html lang="en">'); expect(html).toContain('<option value="en" selected>English</option>');
    expect(html).toContain("Español"); expect(html).toContain(diagnosticTranslations.en.limitation);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(HTML_REPORT_MAX_BYTES);
  });
  it("switches all labels/accessibility offline while preserving data, numbers, IDs, filters and technical codes", () => {
    const report = diagnosticReportFixture(); const html = renderDiagnosticHtml(report); const { document, ids, nodes } = dom(html);
    expect(document.documentElement.lang).toBe("en"); expect(document.title).toBe(diagnosticTranslations.en.title);
    expect(ids.get("summary-body")!.textContent).toContain("[TRUNCATED]");
    expect(ids.get("candidates-body")!.textContent).toContain("7.25");
    expect(ids.get("candidates-body")!.textContent).toContain("[UNKNOWN]");
    expect(ids.get("candidates-body")!.textContent).toContain("[UNCLASSIFIED]");
    const originalData = ids.get("diagnostic-data")!.textContent;
    const filter = ids.get("phase")!; filter.value = "FINAL"; filter.change();
    const stateFilter = ids.get("state-filter")!; stateFilter.value = "verified"; stateFilter.change();
    expect(ids.get("timeline-body")!.children).toHaveLength(1); stateFilter.value = ""; stateFilter.change();
    const filtered = ids.get("timeline-body")!.children.length;
    const language = ids.get("language")!; language.value = "es"; language.change();
    expect(document.documentElement.lang).toBe("es"); expect(document.title).toBe(diagnosticTranslations.es.title);
    expect(language.getAttribute("aria-label")).toBe(diagnosticTranslations.es.language);
    expect(filter.value).toBe("FINAL"); expect(ids.get("timeline-body")!.children).toHaveLength(filtered);
    for (const node of nodes.filter(node => node.attrs.has("data-i18n"))) {
      expect(node.textContent).toBe(diagnosticTranslations.es[node.getAttribute("data-i18n") as keyof typeof diagnosticTranslations.es]);
    }
    for (const node of nodes.filter(node => node.attrs.has("data-aria"))) {
      expect(node.getAttribute("aria-label")).toBe(diagnosticTranslations.es[node.getAttribute("data-aria") as keyof typeof diagnosticTranslations.es]);
    }
    expect(ids.get("gap-list")!.textContent).toContain(diagnosticTranslations.es.INSUFFICIENT_EVIDENCE);
    expect(ids.get("gap-list")!.textContent).toContain("[INSUFFICIENT_EVIDENCE]");
    expect(ids.get("candidates-body")!.textContent).toContain("7.25");
    const button = ids.get("candidates-body")!.children[0]!.children[1]!.children[0]!;
    expect(button.getAttribute("aria-label")).toContain(diagnosticTranslations.es.candidateDetails); button.click();
    expect(ids.get("candidate-filter")!.value).toBe(button.textContent); expect(ids.get("timeline-heading")!.focused).toBe(true);
    language.value = "en"; language.change(); expect(document.documentElement.lang).toBe("en");
    expect(ids.get("diagnostic-data")!.textContent).toBe(originalData); expect(JSON.parse(originalData)).toEqual(report);
  });
  it("covers every translation and rejects missing, empty or extra translations", () => {
    expect(() => validateDiagnosticTranslations()).not.toThrow();
    for (const language of ["en", "es"] as const) {
      for (const key of Object.keys(diagnosticTranslations.en)) expect(diagnosticTranslations[language][key as keyof typeof diagnosticTranslations.en]).not.toBe("");
    }
    const missing: Record<string, Record<string, string>> = structuredClone(diagnosticTranslations); delete missing.es!.title;
    expect(() => validateDiagnosticTranslations(missing)).toThrow("TRANSLATION_INCOMPLETE");
    missing.es!.title = ""; expect(() => validateDiagnosticTranslations(missing)).toThrow("TRANSLATION_INCOMPLETE");
    missing.es!.title = "Informe"; missing.es!.arbitrary = "extra"; expect(() => validateDiagnosticTranslations(missing)).toThrow("TRANSLATION_INCOMPLETE");
  });
  it("escapes script/HTML special characters and rejects prototype, accessor, private and injection payloads before export", () => {
    const payload = '</script><img src=x onerror="private-canary">&\u2028\u2029';
    expect(escapeDiagnosticHtml(payload)).not.toContain("<img");
    expect(embedDiagnosticJson({ payload })).not.toContain("</script>");
    expect(JSON.parse(embedDiagnosticJson({ payload }))).toEqual({ payload });
    for (const input of [
      { ...diagnosticReportFixture(), title: payload }, { ...diagnosticReportFixture(), id: payload },
      { ...diagnosticReportFixture(), state: { toString: () => { throw new Error("private-canary"); } } },
      Object.assign(Object.create({ private: payload }) as object, diagnosticReportFixture()),
      JSON.parse('{"__proto__":{"private":"private-canary"}}') as unknown
    ]) expect(() => renderDiagnosticHtml(input)).toThrow("INVALID_DIAGNOSTIC_REPORT");
    const getter = vi.fn(() => payload); const report = Object.defineProperty(diagnosticReportFixture(), "id", { get: getter });
    expect(() => validateDiagnosticReport(report)).toThrow("INVALID_DIAGNOSTIC_REPORT"); expect(getter).not.toHaveBeenCalled();
    const event = diagnosticReportFixture(); (event.resolutions[0]!.events[0] as unknown as Record<string, unknown>).source = payload;
    expect(() => validateDiagnosticReport(event)).toThrow("INVALID_DIAGNOSTIC_REPORT");
  });
  it("contains no external resource mechanism and pins CSP to its static script and styles", () => {
    const html = renderDiagnosticHtml(diagnosticReportFixture());
    expect(html).not.toMatch(/<(?:img|iframe|link|object|embed)\b|<script[^>]+src=|\son[a-z]+=/i);
    expect(diagnosticReportScript).not.toMatch(/innerHTML|outerHTML|document\.write|\beval\b|\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|localStorage/);
    expect(html).toContain("connect-src &#39;none&#39;"); expect(html).toContain("default-src &#39;none&#39;");
    const sha = createHash("sha256").update(diagnosticReportScript).digest("base64"); expect(html).toContain(`sha256-${sha}`);
  });
  it("validates event/candidate/session bounds, counts and finite scores", () => {
    const invalid = diagnosticReportFixture(); invalid.events++;
    expect(() => validateDiagnosticReport(invalid)).toThrow("INVALID_DIAGNOSTIC_REPORT");
    const score = diagnosticReportFixture(); const rank = score.resolutions[0]!.events.find(e => e.kind === "RANKING")!;
    if (rank.kind === "RANKING") rank.score = Infinity;
    expect(() => validateDiagnosticReport(score)).toThrow("INVALID_DIAGNOSTIC_REPORT");
    const oversized = diagnosticReportFixture(); oversized.resolutions[0]!.events = Array.from({ length: 2049 }, () => ({ kind: "END" as const, outcome: "SUCCEEDED" as const }));
    expect(() => validateDiagnosticReport(oversized)).toThrow("INVALID_DIAGNOSTIC_REPORT");
  });
  it("exports a byte-budget-exhausted real DTO within both format ceilings", () => {
    const c = new DiagnosticController(); c.start({ ttlMs: L.ttlMs, resolutions: 10, retainReport: true });
    const value = 9999.12345678901;
    for (let i = 0; i < 6; i++) {
      const h = c.beginResolution()!;
      for (let e = 0; e < 2048; e++) h.record({ kind: "RANKING", candidate: e % 256, position: e % 256 + 1,
        score: value, availability: value, resolution: value, size: value, codec: value, metadata: value, transport: value });
      h.finish();
    }
    c.stop(); const report = c.report()!; expect(report.state).toBe("TRUNCATED"); expect(report.events).toBeLessThan(8192);
    const json = serializeDiagnosticReport(report); const html = renderDiagnosticHtml(report);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(L.dtoBytes); expect(Buffer.byteLength(html)).toBeLessThanOrEqual(HTML_REPORT_MAX_BYTES);
    expect(embeddedReport(html)).toEqual(JSON.parse(json));
  });
});

describe("explicit safe local export", () => {
  it("supports paths with spaces, refuses overwrite and publishes only one concurrent export without temporary leftovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic export "));
    try {
      const output = join(root, "report with spaces.json"); const content = serializeDiagnosticReport(diagnosticReportFixture());
      const results = await Promise.allSettled([writeDiagnosticExport(output, content, "json"), writeDiagnosticExport(output, content, "json")]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(await readFile(output, "utf8")).toBe(content);
      await expect(writeDiagnosticExport(output, "replacement", "json")).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(await readdir(root)).toEqual(["report with spaces.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects link ancestors, unsafe names and oversize writes, leaving no export on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-links-"));
    try {
      const real = join(root, "real"); await mkdir(real); const alias = join(root, "alias");
      await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(writeDiagnosticExport(join(alias, "report.json"), "{}", "json")).rejects.toMatchObject({ code: "OUTPUT_UNSAFE" });
      await expect(writeDiagnosticExport(alias, "{}", "json")).rejects.toMatchObject({ code: "OUTPUT_UNSAFE" });
      expect(await readdir(real)).toEqual([]);
      await expect(writeDiagnosticExport(join(root, "missing", "report.json"), "{}", "json")).rejects.toMatchObject({ code: "EXPORT_FAILED" });
      await expect(writeDiagnosticExport(join(root, "large.json"), "x".repeat(L.dtoBytes + 1), "json")).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
      await expect(writeDiagnosticExport(join(root, "large.html"), "x".repeat(HTML_REPORT_MAX_BYTES + 1), "html")).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
      for (const name of ["CON.json", "stream.json:private", "trailing."]) await expect(writeDiagnosticExport(join(root, name), "{}", "json")).rejects.toMatchObject({ code: "OUTPUT_UNSAFE" });
      await writeFile(join(root, "unchanged.json"), "original");
      await expect(writeDiagnosticExport(join(root, "unchanged.json"), "new", "json")).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(await readFile(join(root, "unchanged.json"), "utf8")).toBe("original");
      expect((await readdir(root)).sort()).toEqual(["alias", "real", "unchanged.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
