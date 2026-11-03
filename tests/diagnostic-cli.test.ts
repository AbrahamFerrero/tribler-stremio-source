import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runDiagnosticCli, parseDiagnosticCommand } from "../src/diagnostics/cli";
import { diagnosticBridge, requestDiagnosticAdmin, type DiagnosticAdminTransport } from "../src/diagnostics/admin-client";
import { DiagnosticController } from "../src/diagnostics/controller";
import { diagnosticHttp } from "../src/diagnostics/http";
import { localRequestPolicy } from "../src/local-request-policy";
import { diagnosticTranslations } from "../src/diagnostics/i18n";
import { syntheticAdminToken } from "./helpers";
import { diagnosticReportFixture } from "./diagnostic-report-fixture";

const env = { BRIDGE_ADMIN_TOKEN: syntheticAdminToken };
function cli(args: string[], transport?: DiagnosticAdminTransport, environment: Record<string, string | undefined> = env) {
  const out: string[] = [], error: string[] = [];
  return runDiagnosticCli(args, environment, { out: s => { out.push(s); }, error: s => { error.push(s); } }, transport)
    .then(code => ({ code, out: out.join("\n"), error: error.join("\n") }));
}
describe("local bilingual diagnostic CLI", () => {
  it("defaults to English and translates help without requiring a token or request", async () => {
    const transport = vi.fn<DiagnosticAdminTransport>();
    expect((await cli(["help"], transport, {})).out).toBe(diagnosticTranslations.en.help);
    expect((await cli(["help", "--lang", "es"], transport, {})).out).toBe(diagnosticTranslations.es.help);
    expect((await cli(["status", "--help"], transport, {})).out).toBe(diagnosticTranslations.en.help);
    expect(parseDiagnosticCommand([]).operation).toBe("session");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["fr", "EN", "", "es-ES"])("rejects unknown language %s without network access", async language => {
    const transport = vi.fn<DiagnosticAdminTransport>(); const result = await cli(["status", "--lang", language], transport);
    expect(result.code).toBe(2); expect(result.error).toMatch(/INVALID_(?:LANGUAGE|ARGUMENTS)/); expect(transport).not.toHaveBeenCalled();
  });
  it("rejects invalid parameters, token flags and remote/ambiguous destinations without printing them", async () => {
    const transport = vi.fn<DiagnosticAdminTransport>();
    for (const args of [["start", "--next", "11", "--ttl", "60"], ["start", "--next", "1", "--ttl", "301"],
      ["start", "--next", "1.0", "--ttl", "60"], ["status", "--retain"], ["status", "--lang", "es", "--lang", "en"],
      ["export", "--format", "html"], ["status", "--token", "private-argument-canary"], ["unknown"]]) {
      const r = await cli(args, transport); expect(r.code).toBe(2); expect(r.error).not.toContain("private-argument-canary");
    }
    for (const bridge of ["https://localhost:7000", "http://evil.example:7000", "http://localhost.evil.example", "http://127.1:7000",
      "http://2130706433:7000", "http://0177.0.0.1:7000", "http://[::1]:7000", "http://localhost:00080", "http://localhost:65536",
      "http://localhost@evil.example/", "http://127.0.0.1:7000/private", "http://127.0.0.1:7000/?token=private-url-canary",
      "http://127.0.0.1:7000/#private-fragment", "http://127.0.0.1:7000\\evil"]) {
      const r = await cli(["status", "--bridge", bridge], transport); expect(r.code).toBe(2);
      expect(r.error).toContain("INVALID_DESTINATION"); expect(r.error).not.toContain("private-url-canary");
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires a valid environment token and localizes safe errors with stable codes", async () => {
    const transport = vi.fn<DiagnosticAdminTransport>();
    const absent = await cli(["status", "--lang", "es"], transport, {});
    expect(absent.error).toBe(`ADMIN_TOKEN_REQUIRED: ${diagnosticTranslations.es.ADMIN_TOKEN_REQUIRED}`);
    const invalid = await cli(["status"], transport, { BRIDGE_ADMIN_TOKEN: "private-token-canary" });
    expect(invalid.error).toBe(`ADMIN_TOKEN_INVALID: ${diagnosticTranslations.en.ADMIN_TOKEN_INVALID}`);
    expect(transport).not.toHaveBeenCalled();
    const failure = await cli(["report", "--lang", "es"], () => Promise.reject(new Error("private-error-canary")));
    expect(failure.code).toBe(3); expect(failure.error).toBe(`REQUEST_FAILED: ${diagnosticTranslations.es.REQUEST_FAILED}`);
  });
  it("sends stable English commands/fields with explicit retention only, independently of UI language", async () => {
    const transport = vi.fn<DiagnosticAdminTransport>(() => Promise.resolve({ status: 200, data: { state: "OFF", reportAvailable: false } }));
    for (const language of ["en", "es"]) {
      const r = await cli(["start", "--next", "2", "--ttl", "60", "--lang", language], transport); expect(r.code).toBe(0);
      expect(transport.mock.calls.at(-1)![0].body).toBe('{"ttlMs":60000,"resolutions":2,"retainReport":false}');
      expect(transport.mock.calls.at(-1)![0]).toMatchObject({ method: "POST", operation: "start", token: syntheticAdminToken });
      expect(r.out).not.toContain(syntheticAdminToken);
    }
    await cli(["start", "--next", "1", "--ttl", "1", "--retain"], transport);
    expect(transport.mock.calls.at(-1)![0].body).toContain('"retainReport":true');
    expect(parseDiagnosticCommand(["status"]).language).toBe("en");
  });
  it("handles active, absent, expired, denied and malicious responses with fixed errors", async () => {
    for (const [status, code, exit] of [[409, "CAPTURE_ACTIVE", 4], [404, "REPORT_NOT_FOUND", 4], [410, "REPORT_EXPIRED", 4], [401, "ACCESS_DENIED", 3], [500, "REQUEST_FAILED", 3]] as const) {
      const r = await cli(["report"], () => Promise.resolve({ status, data: { secret: "private-canary" } }));
      expect(r.code).toBe(exit); expect(r.error).toContain(code); expect(r.error).not.toContain("private-canary");
    }
    const r = await cli(["report"], () => Promise.resolve({ status: 200, data: { ...diagnosticReportFixture(), title: "private-canary" } }));
    expect(r.error).toContain("INVALID_RESPONSE"); expect(r.out).toBe("");
    const status = await cli(["status"], () => Promise.resolve({ status: 200, data: { state: "OFF", reportAvailable: false, secret: "private-canary" } }));
    expect(status.error).toContain("INVALID_RESPONSE"); expect(status.out).toBe("");
  });
  it("runs real local start/status/stop/report/export without providers or fetch and preserves JSON across languages", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic cli "));
    const c = new DiagnosticController(); const read = vi.spyOn(c, "readReport");
    const paths: string[] = []; const app = express(); app.use((req, _res, next) => { paths.push(req.path); next(); });
    app.use(localRequestPolicy(syntheticAdminToken)); app.use("/diagnostics", diagnosticHttp(c));
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing synthetic address");
    const bridge = ["--bridge", `http://localhost:${address.port}`]; const network = vi.spyOn(globalThis, "fetch");
    try {
      expect((await cli(["start", "--next", "1", "--ttl", "60", "--retain", ...bridge])).code).toBe(0);
      const capture = c.beginResolution()!; capture.record({ kind: "STAGE", stage: "FINAL", count: 1 }); capture.finish();
      expect((await cli(["status", ...bridge, "--lang", "es"])).out).toContain("[ON]");
      expect((await cli(["stop", ...bridge])).code).toBe(0);
      const report = await cli(["report", ...bridge]); expect(report.code).toBe(0); expect(report.out).toContain(c.report()!.id);
      expect(report.out).not.toContain('{"version"');
      for (const language of ["en", "es"]) {
        const output = join(root, `${language}.json`);
        const result = await cli(["export", "--format", "json", "--output", output, ...bridge, "--lang", language]); expect(result.code).toBe(0);
        expect(result.out).not.toContain(root); expect(result.out).not.toContain(syntheticAdminToken);
      }
      expect(await readFile(join(root, "en.json"), "utf8")).toBe(await readFile(join(root, "es.json"), "utf8"));
      const output = join(root, "report with spaces.html");
      expect((await cli(["export", "--format", "html", "--output", output, ...bridge, "--lang", "es"])).code).toBe(0);
      const html = await readFile(output, "utf8"); expect(html).toContain('<html lang="en">');
      const embedded = /<script id="diagnostic-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
      expect(JSON.parse(embedded)).toEqual(JSON.parse(await readFile(join(root, "en.json"), "utf8")));
      expect(paths).toEqual(["/diagnostics/start", "/diagnostics/status", "/diagnostics/stop", ...Array.from({ length: 4 }, () => "/diagnostics/report")]);
      expect(read).toHaveBeenCalledTimes(4); expect(network).not.toHaveBeenCalled();
      const failed = await cli(["export", "--format", "json", "--output", join(root, "missing", "report.json"), ...bridge]);
      expect(failed.code).toBe(5); expect(failed.error).not.toContain(root); expect((await readdir(root)).sort()).toEqual(["en.json", "es.json", "report with spaces.html"]);
    } finally { network.mockRestore(); c.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
  it("never follows a redirect or sends a second administrative request", async () => {
    let redirected = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/diagnostics/status") redirected++;
      expect(req.headers.host).toMatch(/^127\.0\.0\.1:/); expect(req.headers.authorization).toBe(`Bearer ${syntheticAdminToken}`);
      res.writeHead(302, { "Content-Type": "application/json", Location: "/private-redirect-canary" }); res.end("{}");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
    try { expect((await cli(["status", "--bridge", `http://localhost:${address.port}`])).code).toBe(3); expect(redirected).toBe(0); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("bounds native HTTP responses before parsing and produces no files on invalid export data", async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 3000000 }); res.end("{}"); });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    try { await expect(requestDiagnosticAdmin({ bridge: diagnosticBridge(`http://127.0.0.1:${address.port}`), token: syntheticAdminToken, method: "GET", operation: "report" })).rejects.toMatchObject({ code: "REQUEST_FAILED" }); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    const root = await mkdtemp(join(tmpdir(), "diagnostic-invalid-"));
    try {
      const result = await cli(["export", "--format", "html", "--output", join(root, "report.html")], () => Promise.resolve({ status: 200, data: { private: "private-canary" } }));
      expect(result.code).toBe(3); expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("runs the portable script entry point for English and Spanish help", async () => {
    for (const language of ["en", "es"] as const) {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/diagnostic.ts", "help", "--lang", language], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", error = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (s: string) => { out += s; }); child.stderr.on("data", (s: string) => { error += s; });
      const code: unknown = (await once(child, "close"))[0]; expect(code).toBe(0); expect(error).toBe(""); expect(out.trim()).toBe(diagnosticTranslations[language].help);
    }
  });
});
