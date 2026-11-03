import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDiagnosticCli, parseDiagnosticCommand } from "../src/diagnostics/cli";
import type { DiagnosticAdminTransport } from "../src/diagnostics/admin-client";
import { DiagnosticController, validDiagnosticStart } from "../src/diagnostics/controller";
import { diagnosticHttp } from "../src/diagnostics/http";
import { diagnosticTranslations } from "../src/diagnostics/i18n";
import { captureInteraction, type CaptureInteraction, type CaptureWake } from "../src/diagnostics/interaction";
import { validateDiagnosticReport } from "../src/diagnostics/report-model";
import { validatePrivateReport, anonymizeDiagnosticExport } from "../src/diagnostics/private-context";
import * as demo from "../src/diagnostics/demo-workflow";
import { localRequestPolicy } from "../src/local-request-policy";
import { syntheticAdminToken } from "./helpers";

afterEach(() => vi.restoreAllMocks());
const env = { BRIDGE_ADMIN_TOKEN: syntheticAdminToken };
function fixture() {
  let now = 0, interrupted = false;
  const c = new DiagnosticController(() => now), operations: string[] = [];
  const wakes: CaptureWake[] = [];
  const interaction: CaptureInteraction = { now: () => now, interrupted: () => interrupted, dispose: vi.fn(),
    wait: () => { now += 500; const reason = wakes.shift() ?? "TICK"; interrupted ||= reason === "INTERRUPT"; return Promise.resolve(reason); } };
  const transport = vi.fn<DiagnosticAdminTransport>(request => {
    operations.push(request.operation);
    if (request.operation === "start") {
      const body: unknown = JSON.parse(request.body!);
      if (!validDiagnosticStart(body)) throw new Error("Invalid synthetic start options");
      const result = c.start(body);
      return Promise.resolve({ status: result === "ACTIVE" ? 409 : 200, data: c.status() });
    }
    if (request.operation === "stop") { c.stop(); return Promise.resolve({ status: 200, data: c.status() }); }
    if (request.operation === "status") return Promise.resolve({ status: 200, data: c.status() });
    return Promise.resolve({ status: c.report() ? 200 : 404, data: c.report() });
  });
  const out: string[] = [], error: string[] = [];
  const run = (args: string[], t: DiagnosticAdminTransport = transport, environment = env) => runDiagnosticCli(args, environment,
    { out: line => out.push(line), error: line => error.push(line) }, t, { interaction: () => interaction, openDemo: () => Promise.resolve(false) });
  return { c, operations, wakes, interaction, transport, out, error, run, advance: (ms: number) => { now += ms; } };
}
async function temporary(test: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-workflow-"));
  try { await test(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("high-level diagnostic workflows", () => {
  it("keeps advanced validation and requires explicit capture output with bounded defaults", async () => {
    expect(parseDiagnosticCommand(["capture", "--output", "report.html"])).toMatchObject({ next: 3, ttl: 300, language: "en" });
    expect(parseDiagnosticCommand(["capture", "--output", "report.html", "--lang", "es", "--next", "10", "--ttl", "1"])).toMatchObject({ next: 10, ttl: 1, language: "es" });
    for (const args of [["capture"], ["capture", "--output", "x", "--ttl", "301"], ["capture", "--output", "x", "--next", "0"],
      ["capture", "--output", "x", "--format", "html"], ["capture", "--output", "x", "--retain"], ["demo", "--output", "x"],
      ["demo", "--bridge", "http://localhost:7000"], ["demo", "--lang", "fr"], ["capture", "--output", "x", "--lang", "fr"]]) expect(() => parseDiagnosticCommand(args)).toThrow();
    const h = fixture(); expect(await h.run(["capture", "--output", "x"], h.transport, { BRIDGE_ADMIN_TOKEN: "" })).toBe(2);
    expect(h.operations).toEqual([]);
  });

  it.each(["en", "es"] as const)("runs an actual isolated synthetic demo in %s without a token, bridge or network", async language => {
    const transport = vi.fn<DiagnosticAdminTransport>(); const fetch = vi.spyOn(globalThis, "fetch");
    const out: string[] = [], errors: string[] = []; const open = vi.fn(() => Promise.resolve(false));
    expect(await runDiagnosticCli(["demo", "--lang", language], {}, { out: s => out.push(s), error: s => errors.push(s) }, transport, { openDemo: open })).toBe(0);
    const path = out[1]!;
    expect(path.startsWith(resolve(".cache/diagnostic-demo") + sep)).toBe(true);
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--", path]);
      const html = await readFile(path, "utf8");
      const privateReport = validatePrivateReport(JSON.parse(/<script id="diagnostic-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as unknown);
      const report = validateDiagnosticReport(anonymizeDiagnosticExport(privateReport));
      expect(privateReport.context).toHaveLength(3); expect(html).toContain(diagnosticTranslations.en.privateNotice);
      expect(JSON.stringify(report)).not.toContain("Synthetic North");
      expect(report).toMatchObject({ state: "CLOSED", reserved: 3 }); expect(report.resolutions).toHaveLength(3);
      for (const r of report.resolutions) {
        expect(r.events.some(e => e.kind === "RANKING")).toBe(true);
        expect(r.events.some(e => e.kind === "SNAPSHOT" && e.stage === "FINAL" && e.count === 3)).toBe(true);
      }
      expect(JSON.stringify(report)).not.toContain("media.example"); expect(html).toContain('<html lang="en">');
      expect(out[0]).toBe(diagnosticTranslations[language].demoComplete); expect(out[2]).toBe(diagnosticTranslations[language].demoOpenInstructions);
      expect(transport).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(errors).toEqual([]);
      expect(open).toHaveBeenCalledWith(path); expect(await readdir(dirname(path))).toEqual(["report.html"]);
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  });

  it("contains demo and optional browser failures without exposing exception text", async () => {
    vi.spyOn(demo, "diagnosticDemo").mockRejectedValue(new Error("private-demo-canary"));
    const h = fixture(); expect(await h.run(["demo"])).toBe(5);
    expect(h.error.join()).toContain("DEMO_FAILED"); expect(h.error.join()).not.toContain("private-demo-canary");
    expect(h.operations).toEqual([]);
  });

  it.each(["opened", "failed"] as const)("keeps the synthetic demo usable when optional browser opening is %s", async result => {
    const out: string[] = [], errors: string[] = [];
    const open = () => result === "opened" ? Promise.resolve(true) : Promise.reject(new Error("private-browser-canary"));
    expect(await runDiagnosticCli(["demo"], {}, { out: s => out.push(s), error: s => errors.push(s) }, undefined, { openDemo: open })).toBe(0);
    const path = out[1]!; expect(path.startsWith(resolve(".cache/diagnostic-demo") + sep)).toBe(true);
    try { expect(out[2]).toBe(result === "opened" ? diagnosticTranslations.en.demoOpening : diagnosticTranslations.en.demoOpenInstructions);
      expect(errors).toEqual([]); expect(out.join()).not.toContain("private-browser-canary");
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  });

  it.each(["en", "es"] as const)("stops and exports after requested resolutions finish in %s", async language => temporary(async root => {
    const h = fixture(); let complete = false;
    const transport: DiagnosticAdminTransport = request => {
      if (request.operation === "status" && !complete) {
        complete = true;
        for (let i = 0; i < 3; i++) { const capture = h.c.beginResolution()!; capture.record({ kind: "STAGE", stage: "FINAL", count: 0 }); capture.finish(); }
      }
      return h.transport(request);
    };
    const path = join(root, "explicit.html");
    expect(await h.run(["capture", "--output", path, "--lang", language], transport)).toBe(0);
    expect(h.c.status()).toMatchObject({ state: "OFF", reportAvailable: true });
    expect(h.c.report()).toMatchObject({ reserved: 3, reason: "STOPPED", state: "CLOSED" });
    expect(h.operations).toEqual(["start", "status", "status", "stop", "report"]);
    expect(h.out).toEqual([diagnosticTranslations[language].captureInstructions, diagnosticTranslations[language].exported]);
    expect(h.out.join()).not.toContain(path); expect(h.out.join()).not.toContain(syntheticAdminToken);
    expect(await readFile(path, "utf8")).toContain('<html lang="en">'); expect(h.interaction.dispose).toHaveBeenCalledOnce();
  }));

  it.each(["ENTER", "TICK"] as const)("finishes safely on %s without initiating resolutions", async wake => temporary(async root => {
    const h = fixture(); h.wakes.push(wake);
    expect(await h.run(["capture", "--output", join(root, "report.html"), "--ttl", "1"])).toBe(0);
    expect(h.c.report()).toMatchObject({ reserved: 0, reason: wake === "ENTER" ? "STOPPED" : "EXPIRED" });
    expect(h.operations.every(operation => ["start", "status", "stop", "report"].includes(operation))).toBe(true);
    expect(await readdir(root)).toEqual(["report.html"]);
  }));

  it("interrupts with cleanup, one export and exit 130", async () => temporary(async root => {
    const h = fixture(); h.wakes.push("INTERRUPT");
    expect(await h.run(["capture", "--output", join(root, "report.html")])).toBe(130);
    expect(h.c.status().state).toBe("OFF"); expect(h.operations).toEqual(["start", "status", "stop", "report"]);
    expect(await readdir(root)).toEqual(["report.html"]); expect(h.interaction.dispose).toHaveBeenCalledOnce();
  }));

  it.each(["start", "report"] as const)("honors interruption received during an in-flight %s request", async phase => temporary(async root => {
    const h = fixture(); h.wakes.push("ENTER");
    const transport: DiagnosticAdminTransport = async request => {
      const response = await h.transport(request);
      if (request.operation === phase) h.interaction.interrupted = () => true;
      return response;
    };
    expect(await h.run(["capture", "--output", join(root, "x")], transport)).toBe(130);
    expect(h.c.status().state).toBe("OFF"); expect(await readdir(root)).toEqual(["x"]); expect(h.interaction.dispose).toHaveBeenCalledOnce();
  }));

  it("warns on an uncertain start without stopping an unidentified session", async () => temporary(async root => {
    const h = fixture();
    const transport: DiagnosticAdminTransport = request => {
      if (request.operation === "start") { void h.transport(request); return Promise.reject(new Error("private-start-canary")); }
      return h.transport(request);
    };
    try { expect(await h.run(["capture", "--output", join(root, "x")], transport)).toBe(3);
      expect(h.operations).toEqual(["start"]); expect(h.error).toContain(diagnosticTranslations.en.captureCleanupWarning);
      expect(h.error.join()).not.toContain("private-start-canary"); expect(await readdir(root)).toEqual([]);
    } finally { h.c.stop(); }
  }));

  it("leaves an existing session alone on 409, and validates authorization before installing interaction", async () => temporary(async root => {
    const h = fixture(); h.c.start({ ttlMs: 300000, resolutions: 1, retainReport: false }); const id = h.c.status().id;
    try { expect(await h.run(["capture", "--output", join(root, "x")])).toBe(4);
      expect(h.c.status().id).toBe(id); expect(h.operations).toEqual(["start"]); expect(await readdir(root)).toEqual([]);
    } finally { h.c.stop(); }
    const invalid = fixture(); expect(await invalid.run(["capture", "--output", "x"], invalid.transport, { BRIDGE_ADMIN_TOKEN: "private-token-canary" })).toBe(2);
    expect(invalid.error.join()).not.toContain("private-token-canary"); expect(invalid.interaction.dispose).not.toHaveBeenCalled();
  }));

  it("does not stop or export a detected replacement session", async () => temporary(async root => {
    const h = fixture(); let replaced = false;
    const transport: DiagnosticAdminTransport = request => {
      if (request.operation === "status" && !replaced) { replaced = true; h.c.stop(); h.c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }); }
      return h.transport(request);
    };
    try { expect(await h.run(["capture", "--output", join(root, "x")], transport)).toBe(4);
      expect(h.c.status().state).toBe("ON"); expect(h.operations).not.toContain("stop"); expect(h.operations).not.toContain("report"); expect(await readdir(root)).toEqual([]);
    } finally { h.c.stop(); }
  }));

  it("revokes on polling failure, contains canaries and warns when cleanup cannot be confirmed", async () => temporary(async root => {
    const h = fixture(); let failed = false;
    const transport: DiagnosticAdminTransport = request => {
      if (request.operation === "status" && !failed) { failed = true; return Promise.reject(new Error("private-poll-canary")); }
      return h.transport(request);
    };
    expect(await h.run(["capture", "--output", join(root, "x")], transport)).toBe(3); expect(h.c.status().state).toBe("OFF");
    expect(h.error.join()).not.toContain("private-poll-canary"); expect(await readdir(root)).toEqual([]);
    const broken = fixture();
    const unavailable: DiagnosticAdminTransport = request => request.operation === "start" ? broken.transport(request) : Promise.reject(new Error("private-canary"));
    try { expect(await broken.run(["capture", "--output", join(root, "x")], unavailable)).toBe(3);
      expect(broken.error).toContain(diagnosticTranslations.en.captureCleanupWarning); expect(broken.error.join()).not.toContain("private-canary");
    } finally { broken.c.stop(); }
  }));

  it("stops before failed/no-overwrite export and rejects private report data", async () => temporary(async root => {
    const h = fixture(); h.wakes.push("ENTER"); const path = join(root, "existing.html"); await writeFile(path, "unchanged");
    expect(await h.run(["capture", "--output", path])).toBe(5); expect(h.c.status().state).toBe("OFF");
    expect(await readFile(path, "utf8")).toBe("unchanged"); expect(await readdir(root)).toEqual(["existing.html"]);
    const invalid = fixture(); invalid.wakes.push("ENTER");
    const transport: DiagnosticAdminTransport = request => request.operation === "report"
      ? Promise.resolve({ status: 200, data: { secret: "private-report-canary" } }) : invalid.transport(request);
    expect(await invalid.run(["capture", "--output", join(root, "new.html")], transport)).toBe(3);
    expect(invalid.c.status().state).toBe("OFF"); expect(invalid.error.join()).not.toContain("private-report-canary");
    expect(await readdir(root)).toEqual(["existing.html"]);
  }));

  it("orchestrates the actual native local API without fetching providers/media", async () => temporary(async root => {
    const c = new DiagnosticController(); const paths: string[] = []; const app = express();
    app.use((req, _res, next) => { paths.push(req.path); if (req.path === "/diagnostics/status" && c.status().state === "ON" && c.status().reserved === 0) {
      for (let i = 0; i < 3; i++) c.beginResolution()!.finish();
    } next(); });
    app.use(localRequestPolicy(syntheticAdminToken)); app.use("/diagnostics", diagnosticHttp(c));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const fetch = vi.spyOn(globalThis, "fetch"); const h = fixture();
    try { expect(await runDiagnosticCli(["capture", "--output", join(root, "real.html"), "--bridge", `http://localhost:${address.port}`], env,
      { out: s => h.out.push(s), error: s => h.error.push(s) }, undefined, { interaction: () => h.interaction })).toBe(0);
      expect(c.report()).toMatchObject({ reserved: 3, state: "CLOSED" }); expect(fetch).not.toHaveBeenCalled();
      expect(paths.every(path => path.startsWith("/diagnostics/"))).toBe(true); expect(paths).toHaveLength(5);
    } finally { c.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }));
});

it("latches Enter/signals during in-flight work and removes only its own listeners", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true }); const signals = new EventEmitter();
  const existing = vi.fn(); signals.on("SIGINT", existing);
  const interaction = captureInteraction(input, signals);
  input.write("private-input-canary\n"); expect(await interaction.wait(100)).toBe("ENTER");
  const waiting = interaction.wait(100); signals.emit("SIGINT"); expect(await waiting).toBe("INTERRUPT");
  expect(interaction.interrupted()).toBe(true); expect(await interaction.wait(100)).toBe("INTERRUPT");
  interaction.dispose(); expect(signals.listeners("SIGINT")).toEqual([existing]); expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(input.listenerCount("data")).toBe(0); expect(input.isPaused()).toBe(true); input.destroy();
});
