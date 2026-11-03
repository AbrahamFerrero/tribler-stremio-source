import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DiagnosticController } from "../src/diagnostics/controller";
import { observeResolution } from "../src/diagnostics/resolver-observer";
import { safeContextLabel, sourceDeclarations, projectPrivateCandidate, validatePrivateReport, anonymizeDiagnosticExport, type PrivateLabelReason } from "../src/diagnostics/private-context";
import { privateLabelCounts } from "../src/diagnostics/private-label-counts";
import { renderDiagnosticHtml } from "../src/diagnostics/html-report";
import { diagnosticReportDom } from "./diagnostic-dom-harness";
import { parseDiagnosticCommand } from "../src/diagnostics/cli";

// All inputs invented. Examples belong only in synthetic QA, never in runtime reason DTOs.
const cases: Array<[string, PrivateLabelReason | "CAPTURED" | "OVER_LIMIT" | "EMPTY"]> = [
  ["Nebula Orchard", "CAPTURED"], ["Nebula Orchard - S02E04", "CAPTURED"],
  ["Nebula.Orchard.S02E04.1080p.WEB-DL.x265.ES", "CAPTURED"],
  ["Nebula_Orchard-S02E04-720p_HEVC_DUAL", "OPAQUE_RUN"],
  ["Nebula Orchard [1080p] [ES]", "CAPTURED"],
  ["Nebula Orchard 1080p x264 AAC Spanish WEB-DL", "CAPTURED"],
  ["Tokenization of an invented language", "CAPTURED"],
  ["Jardín de Órbita 東京 항해 مرفأ", "CAPTURED"], ["Cafe\u0301 Orbital", "CAPTURED"],
  ["The pilot visits an invented moon.", "CAPTURED"],
  ["The pilot\nvisits an invented moon.", "CAPTURED"],
  ["Nebula’s orbit & dawn: Part 2!", "CAPTURED"], ["Nebula — Dawn", "CAPTURED"],
  ["Nebula 🚀", "CAPTURED"], ["Nebula \u202e Dawn", "UNSUPPORTED_CHARACTER"],
  ["Nebula\u0085Dawn", "CAPTURED"], ["Nebula\u007fDawn", "CONTROL"],
  ["https://example.invalid/synthetic", "URL_MARKER"], ["www.example.invalid", "URL_MARKER"],
  ["file:synthetic", "URL_MARKER"], ["ftp:synthetic", "URL_MARKER"], ["magnet:synthetic", "URL_MARKER"],
  ["example.invalid", "CAPTURED"], ["profile: A synthetic voyage", "URL_MARKER"],
  ["C:\\invented\\film", "LOCATOR_CHARACTER"], ["/invented/film", "LOCATOR_CHARACTER"],
  ["\\\\invented\\share", "LOCATOR_CHARACTER"], ["user@example.invalid", "LOCATOR_CHARACTER"],
  ["key=synthetic", "LOCATOR_CHARACTER"], ["Nebula / Dawn", "LOCATOR_CHARACTER"],
  ["Bearer synthetic", "SENSITIVE_TERM"], ["The Secret Orchard", "SENSITIVE_TERM"],
  ["Cookie Comet", "SENSITIVE_TERM"], ["api_key synthetic", "SENSITIVE_TERM"],
  ["authorization synthetic", "SENSITIVE_TERM"], ["password synthetic", "SENSITIVE_TERM"],
  ["token synthetic", "SENSITIVE_TERM"], ["api-key synthetic", "SENSITIVE_TERM"], ["api key synthetic", "SENSITIVE_TERM"],
  ["<b>invented</b>", "LOCATOR_CHARACTER"], ["<invented>", "MARKUP"],
  ["0123456789abcdef0123456789abcdef", "OPAQUE_RUN"], ["q".repeat(32), "OPAQUE_RUN"],
  ["abcdefghijklmnopqrstuvwxyzABCDEF", "OPAQUE_RUN"], ["q".repeat(31), "CAPTURED"],
  ["Invented\tSecret https://example.invalid", "URL_MARKER"],
  ["https: Secret <invented>", "URL_MARKER"], ["Secret <invented>", "MARKUP"],
  ["Secret " + "q".repeat(32), "SENSITIVE_TERM"], ["q".repeat(32) + "[]", "OPAQUE_RUN"],
  ["<invented>\n", "MARKUP"], ["safe ".repeat(33), "OVER_LIMIT"],
  ["https:" + "x".repeat(160), "OVER_LIMIT"], ["x".repeat(1000000), "OVER_LIMIT"],
  ["", "EMPTY"], ["   ", "EMPTY"], ["  Nebula Orchard  ", "CAPTURED"]
];

function capture(titles: string[]) {
  const c = new DiagnosticController(); c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }, true);
  const o = observeResolution(c.beginResolution()!);
  o.request!({ id: "synthetic", kind: "movie", title: "Invented request", externalIds: {} });
  const sources = titles.map(title => ({ providerId: "synthetic", type: "https" as const, title }));
  o.trace.stage("provider", sources, sources.map(() => Object.freeze({})));
  o.finish(false); c.stop();
  const r = c.readPrivateReport(); if (r.state !== "AVAILABLE") throw new Error();
  return validatePrivateReport(r.report);
}

describe("private label rejection predicates", () => {
  it("accepts the documented private smoke commands without starting capture or contacting a service", () => {
    expect(parseDiagnosticCommand(["start", "--mode", "private", "--next", "1", "--ttl", "60", "--retain"])).toMatchObject({ operation: "start", mode: "private", next: 1, ttl: 60, retain: true });
    expect(parseDiagnosticCommand(["stop"])).toMatchObject({ operation: "stop" });
    expect(parseDiagnosticCommand(["export", "--mode", "private", "--format", "json", "--output", ".cache/private-reasons-new.json"])).toMatchObject({ operation: "export", mode: "private", format: "json" });
  });
  it.each(cases.map(([value, expected], index) => ({ value, expected, index })))("classifies synthetic QA case $index", ({ value, expected }) => {
    const m = sourceDeclarations({ title: value, name: value, metadata: { identity: { title: value } } });
    const reason = ["CAPTURED", "OVER_LIMIT", "EMPTY"].includes(expected) ? undefined : expected;
    expect(m.labelStatus!.title).toBe(reason ? "WITHHELD" : expected);
    for (const field of ["name", "title", "identityTitle"] as const) {
      expect(m.labelReasons?.[field]).toBe(reason);
      expect(m[field]).toBe(expected === "CAPTURED" ? value.replace(/[\t\n\v\f\r\u0085\p{Z}]+/gu, " ").trim() : "");
    }
    expect(safeContextLabel(value)).toBe(m.title);
    if (!reason) expect(m).not.toHaveProperty("labelReasons");
  });

  it("normalizes layout whitespace, preserves Unicode spelling and enforces raw length before formatting", () => {
    const value = '  Café\r\n\t東京\u00a0—\u2009[航海] “مرحبا” 🚀  ';
    const text = 'Café 東京 — [航海] “مرحبا” 🚀';
    expect(sourceDeclarations({ title: value }).title).toBe(text);
    expect(safeContextLabel(text)).toBe(text);
    expect(safeContextLabel("Cafe\u0301")).toBe("Cafe\u0301");
    // Previously accepted ASCII spacing stays valid in historical private reports.
    const historical = { candidateId: "00000000-0000-4000-8000-000000000000", name: "", title: "Nebula  Orchard", identityTitle: "", season: null, episode: null };
    expect(projectPrivateCandidate(historical)).toEqual(historical);
    for (const max of [96, 160]) {
      const bounded = "a ".repeat(max / 2 - 1) + "ab";
      expect(safeContextLabel(bounded, max)).toBe(bounded);
      expect(safeContextLabel(bounded + " ", max)).toBe("");
    }
    expect(sourceDeclarations({ title: " \n".repeat(81) }).labelStatus!.title).toBe("OVER_LIMIT");
    expect(sourceDeclarations({ title: "\n\t\u0085\u2028" }).labelStatus!.title).toBe("EMPTY");
    expect(safeContextLabel("a ".repeat(1000000), Infinity)).toBe("");
  });

  it("retains control, invisible format and surrogate rejection without dropping suspicious characters", () => {
    for (let code = 0; code < 160; code++) {
      if (code >= 32 && code < 127 || [9, 10, 11, 12, 13, 133].includes(code)) continue;
      expect(sourceDeclarations({ title: "Nebula" + String.fromCharCode(code) }).labelReasons!.title).toBe("CONTROL");
    }
    for (const c of ["\u202e", "\u2066", "\u200b", "\u200d", "\ufeff", "\ud800", "\udfff", "\ue000"]) {
      expect(safeContextLabel("Nebula" + c)).toBe("");
    }
  });

  it.each([
    "Nebula\nhttps://example.invalid", "h\nttps: invented", "ｗｗｗ．example.invalid",
    "ｈｔｔｐｓ： invented", "Nebula\nBearer synthetic", "to\tken synthetic", "ｐａｓｓｗｏｒｄ synthetic",
    "Nebula\n/invented/path", "user＠example.invalid", "key＝synthetic", "／invented",
    'Nebula\n</script><img src=x onerror="synthetic">', "＜script＞", "%68%74%74%70%73%3a",
    "Nebula\n" + "q".repeat(32)
  ])("withholds the entire value after format normalization, including obfuscated sensitive content: %#", value => {
    const m = sourceDeclarations({ title: value });
    expect(m.title).toBe(""); expect(m.labelStatus!.title).toBe("WITHHELD");
    expect(safeContextLabel(value)).toBe("");
    expect(() => projectPrivateCandidate({ ...m, candidateId: "00000000-0000-4000-8000-000000000000", title: value, labelStatus: { ...m.labelStatus, title: "CAPTURED" } })).toThrow();
  });

  it("round-trips formatted text privately through JSON and DOM and removes it from anonymous exports", () => {
    const title = 'Café\n東京 — [航海] “مرحبا” & "Dawn" 🚀';
    const text = 'Café 東京 — [航海] “مرحبا” & "Dawn" 🚀';
    const r = validatePrivateReport(JSON.parse(JSON.stringify(capture([title]))));
    expect(r.context[0]!.candidates![0]!.title).toBe(text);
    const html = renderDiagnosticHtml(r);
    expect(html).toContain("\\u0026");
    const dom = diagnosticReportDom(html);
    dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain(text);
    const anonymous = anonymizeDiagnosticExport(r);
    expect(JSON.stringify(anonymous)).not.toMatch(/Café|航海|labelStatus|labelReasons|PRIVATE_LOCAL/);
    expect(renderDiagnosticHtml(anonymous)).not.toContain("Café");
  });

  it("rejects arbitrary reason payloads, keys, accessors and contradictory states; accepts history without guessing", () => {
    const m = { candidateId: "00000000-0000-4000-8000-000000000000", ...sourceDeclarations({ title: "<invented>" }) };
    expect(projectPrivateCandidate(m)).toEqual(m);
    const old = { ...m }; delete old.labelReasons; expect(projectPrivateCandidate(old)).toEqual(old);
    for (const reasons of [{ title: "secret text" }, { url: "MARKUP" }, { name: "MARKUP" }, {}, [], { title: "MARKUP", extra: "MARKUP" }]) {
      expect(() => projectPrivateCandidate({ ...m, labelReasons: reasons })).toThrow("INVALID_PRIVATE_REPORT");
    }
    expect(() => projectPrivateCandidate({ ...m, labelStatus: undefined })).toThrow();
    const getter = vi.fn(() => "MARKUP");
    expect(() => projectPrivateCandidate({ ...m, labelReasons: Object.defineProperty({}, "title", { get: getter }) })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps reasons private, renders only validated predicates, and counts historical gaps separately", () => {
    const r = capture(["<invented>", "invented\u202e", "safe ".repeat(33), "Invented safe"]);
    const candidates = r.context[0]!.candidates!;
    delete candidates[1]!.labelReasons;
    delete candidates[3]!.labelStatus;
    expect(validatePrivateReport(r)).toEqual(r);
    const counts = privateLabelCounts(r);
    expect(counts).toMatchObject({ withheld: 2, overLimit: 1, historicalStatusUnknown: 1, withheldByReason: { MARKUP: 1, UNRECORDED: 1 } });
    expect(JSON.stringify(counts)).not.toMatch(/Invented|invented|candidateId|resolutionId/);
    expect(JSON.stringify(anonymizeDiagnosticExport(r))).not.toMatch(/labelReasons|MARKUP|UNSUPPORTED_CHARACTER/);
    const dom = diagnosticReportDom(renderDiagnosticHtml(r));
    dom.ids.get("sources-human")!.children[0]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).toContain("Angle bracket");
    dom.ids.get("sources-human")!.children[1]!.children[0]!.children[0]!.click();
    expect(dom.ids.get("source-inspector")!.textContent).not.toContain("Angle bracket");
  });

  it("accounts sparse reason bytes in existing truncation limits", () => {
    const r = capture(Array.from({ length: 256 }, () => "invented\u202e"));
    expect(r.report.state).toBe("TRUNCATED");
    expect(r.context[0]!.metadataCapture).toBe("CONTEXT_LIMIT");
    expect(Buffer.byteLength(JSON.stringify(r.context[0]))).toBeLessThan(32768 + 64);
    expect(r.context[0]!.candidates!.length).toBeLessThan(256);
    const m = sourceDeclarations({ title: "invented\u202e" }); const old = { ...m }; delete old.labelReasons;
    expect(Buffer.byteLength(JSON.stringify(m)) - Buffer.byteLength(JSON.stringify(old))).toBeLessThanOrEqual(50);
  });

  it("runs the private aggregate tool on synthetic input and fails closed without echoing paths or payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synthetic-labels-"));
    try {
      const file = join(dir, "fixture.json"); await writeFile(file, JSON.stringify(capture(["<invented>", "invented\u202e"])));
      const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/private-label-counts.ts", ...args], { encoding: "utf8" });
      const result = run("--private-local", file);
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ withheld: 2, withheldByReason: { MARKUP: 1, UNSUPPORTED_CHARACTER: 1 } });
      for (const args of [[file], ["--private-local", join(dir, "missing-secret")]]) {
        const bad = run(...args); expect(bad.status).toBe(1); expect(bad.stdout).toBe(""); expect(bad.stderr).toBe("PRIVATE_LABEL_COUNTS_FAILED\n");
      }
      for (const value of ["secret-not-json", "x".repeat(2 * 1024 * 1024 + 1)]) {
        await writeFile(file, value); const bad = run("--private-local", file);
        expect(bad.status).toBe(1); expect(bad.stderr).toBe("PRIVATE_LABEL_COUNTS_FAILED\n"); expect(bad.stdout).toBe("");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
