import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { runDiagnosticCli } from "../src/diagnostics/cli";
import { DiagnosticCliError } from "../src/diagnostics/cli-errors";
import { captureInteraction } from "../src/diagnostics/interaction";
import { DiagnosticController } from "../src/diagnostics/controller";
import { diagnosticHttp } from "../src/diagnostics/http";
import { requestDiagnosticAdmin, type DiagnosticAdminTransport } from "../src/diagnostics/admin-client";
import { diagnosticSessionOutput, readDiagnosticLocalConfig, validateDiagnosticLocalConfig } from "../src/diagnostics/local-config";
import { localRequestPolicy } from "../src/local-request-policy";
import { syntheticAdminToken } from "./helpers";
import { diagnosticTranslations } from "../src/diagnostics/i18n";

const env = { BRIDGE_ADMIN_TOKEN: syntheticAdminToken };
async function temporary(test: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-session-"));
  try { await test(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function fixture(root: string) {
  let now = 0;
  const controller = new DiagnosticController(() => now);
  const signals = new EventEmitter();
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const interaction = captureInteraction(input, signals);
  const dispose = vi.spyOn(interaction, "dispose");
  const transport = vi.fn<DiagnosticAdminTransport>(r => {
    if (r.operation === "identity") return Promise.resolve({ status: 200, data: { id: "org.local.tribler.bridge", name: "Local Tribler Bridge", resources: ["stream"] } });
    if (r.operation.endsWith("start")) controller.start(JSON.parse(r.body!) as Parameters<DiagnosticController["start"]>[0], r.operation === "private/start");
    if (r.operation === "stop") controller.stop();
    const data = r.operation === "private/report" ? controller.readPrivateReport() : undefined;
    return Promise.resolve({ status: 200, ownership: true, data: r.operation === "report" ? controller.report() :
      data?.state === "AVAILABLE" ? data.report : controller.status() });
  });
  const localConfig = () => Promise.resolve(validateDiagnosticLocalConfig({ outputDir: root, ttlSeconds: 1 }));
  const out: string[] = [], errors: string[] = [];
  const close = vi.fn(() => Promise.resolve());
  const startBridge = vi.fn(() => Promise.resolve(close));
  const workflows = { localConfig, interaction: () => interaction, startBridge };
  const run = (args: string[] = [], t = transport as DiagnosticAdminTransport) => runDiagnosticCli(args, env,
    { out: line => out.push(line), error: line => errors.push(line) }, t, workflows);
  return { run, workflows, transport, controller, input, signals, interaction, dispose, close, startBridge, out, errors,
    advance: () => { now += 1000; } };
}

describe("default local diagnostic session", () => {
  it.each(["quota", "ttl", "enter"])("keeps an owned service in the foreground after %s until repeated Ctrl+C", async finish => temporary(async root => {
    const h = fixture(root); let absent = true, settled = false;
    h.workflows.localConfig = () => Promise.resolve(validateDiagnosticLocalConfig({ outputDir: root, ttlSeconds: 1, openReport: true }));
    const open = vi.fn(async (path: string) => { expect(await readFile(path, "utf8")).toContain("diagnostic-data"); return false; });
    Object.assign(h.workflows, { openDemo: open });
    const t: DiagnosticAdminTransport = async r => {
      if (absent) { absent = false; throw new DiagnosticCliError("BRIDGE_ABSENT", 3); }
      const response = await h.transport(r);
      if (r.operation === "start") {
        if (finish === "quota") for (let i = 0; i < 3; i++) h.controller.beginResolution()!.finish();
        if (finish === "ttl") h.advance();
        if (finish === "enter") h.input.write("\n");
      }
      return response;
    };
    const pending = h.run([], t).then(code => { settled = true; return code; });
    try {
      await vi.waitFor(() => expect(h.out).toContain(diagnosticTranslations.en.bridgeRunning));
      expect(settled).toBe(false); expect(h.close).not.toHaveBeenCalled(); expect(h.dispose).not.toHaveBeenCalled();
      expect(h.controller.status()).toEqual({ state: "OFF", reportAvailable: true });
      expect(h.controller.beginResolution()).toBeUndefined();
      expect(open).toHaveBeenCalledOnce();
      const files = await readdir(root); expect(files).toHaveLength(1);
      h.input.write("\n"); h.input.end(); // Neither Enter after capture nor EOF is shutdown.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(h.close).not.toHaveBeenCalled(); expect(settled).toBe(false);
      h.signals.emit("SIGINT"); h.signals.emit("SIGINT");
      expect(await pending).toBe(130); expect(h.close).toHaveBeenCalledOnce(); expect(h.dispose).toHaveBeenCalledOnce();
      expect(await readdir(root)).toEqual(files);
      expect(h.transport.mock.calls.filter(([r]) => r.operation === "report")).toHaveLength(1);
    } finally { h.signals.emit("SIGINT"); await pending; }
  }));

  it("keeps an owned service available after failed export and permits explicit recovery without automatic retry", async () => temporary(async root => {
    const h = fixture(root); let absent = true;
    const t: DiagnosticAdminTransport = async r => {
      if (absent) { absent = false; throw new DiagnosticCliError("BRIDGE_ABSENT", 3); }
      const response = await h.transport(r);
      if (r.operation === "start") h.input.write("\n");
      if (r.operation === "report") await rm(root, { recursive: true });
      return response;
    };
    const pending = h.run([], t);
    try {
      await vi.waitFor(() => expect(h.out).toContain(diagnosticTranslations.en.bridgeRunning));
      expect(h.errors.filter(line => line.startsWith("EXPORT_FAILED:"))).toHaveLength(1);
      expect(h.errors).toContain(diagnosticTranslations.en.exportRecovery);
      expect(h.close).not.toHaveBeenCalled(); expect(h.controller.status()).toEqual({ state: "OFF", reportAvailable: true });
      await mkdir(root);
      const output = join(root, "recovered.html");
      expect(await runDiagnosticCli(["export", "--format", "html", "--output", output], env,
        { out: () => undefined, error: () => undefined }, h.transport)).toBe(0);
      expect(await readFile(output, "utf8")).toContain("diagnostic-data");
      expect(h.close).not.toHaveBeenCalled();
      h.signals.emit("SIGINT"); h.signals.emit("SIGINT");
      expect(await pending).toBe(5); expect(h.close).toHaveBeenCalledOnce();
      expect(await readdir(root)).toEqual(["recovered.html"]);
      expect(h.transport.mock.calls.filter(([r]) => r.operation === "report")).toHaveLength(2); // One automatic attempt, one explicit retry.
      expect(h.transport.mock.calls.filter(([r]) => r.operation === "stop")).toHaveLength(1);
    } finally { h.signals.emit("SIGINT"); await pending; }
  }));

  it.each(["absent", "invalid"])("keeps an owned service OFF and available after an %s report response", async failure => temporary(async root => {
    const h = fixture(root); let absent = true;
    const t: DiagnosticAdminTransport = async r => {
      if (absent) { absent = false; throw new DiagnosticCliError("BRIDGE_ABSENT", 3); }
      const response = await h.transport(r);
      if (r.operation === "start") h.input.write("\n");
      if (r.operation === "report") return { status: failure === "absent" ? 404 : 200, data: { secret: "private-canary" } };
      return response;
    };
    const pending = h.run([], t);
    try {
      await vi.waitFor(() => expect(h.out).toContain(diagnosticTranslations.en.bridgeRunning));
      expect(h.close).not.toHaveBeenCalled(); expect(h.controller.status().state).toBe("OFF");
      expect(h.errors.join()).not.toContain("private-canary"); expect(await readdir(root)).toEqual([]);
      h.signals.emit("SIGINT"); h.signals.emit("SIGINT");
      expect(await pending).toBe(failure === "absent" ? 4 : 3);
      expect(h.close).toHaveBeenCalledOnce();
      expect(h.transport.mock.calls.filter(([r]) => r.operation === "report")).toHaveLength(1);
    } finally { h.signals.emit("SIGINT"); await pending; }
  }));

  it("reuses an authenticated compatible bridge, ignores EOF and exports on TTL", async () => temporary(async root => {
    const h = fixture(root);
    const pending = h.run(); h.input.end();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await readdir(root)).toEqual([]);
    h.advance();
    expect(await pending).toBe(0);
    expect(h.startBridge).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledOnce();
    const files = await readdir(root); expect(files).toHaveLength(1);
    expect(await readFile(join(root, files[0]!), "utf8")).toContain('"reason":"EXPIRED"');
    expect(h.transport.mock.calls.filter(([r]) => r.operation.endsWith("start"))[0]![0]).toMatchObject({ preserveReport: true, operation: "start" });
  }));

  it("exports automatically at quota and never starts a provider/media request", async () => temporary(async root => {
    const h = fixture(root);
    const transport: DiagnosticAdminTransport = r => {
      if (r.operation === "status" && h.controller.status().state === "ON" && h.controller.status().reserved === 0) {
        for (let i = 0; i < 3; i++) h.controller.beginResolution()!.finish();
      }
      return h.transport(r);
    };
    expect(await h.run([], transport)).toBe(0);
    expect(h.controller.report()?.resolutions).toHaveLength(3);
    expect(h.transport.mock.calls.filter(([r]) => r.operation === "stop")).toHaveLength(1);
    expect(h.transport.mock.calls.filter(([r]) => r.operation === "report")).toHaveLength(1);
    expect(await readdir(root)).toHaveLength(1);
  }));

  it.each(["SIGINT", "SIGTERM", "SIGHUP"])("latches repeated %s during start and exports exactly once", async signal => temporary(async root => {
    const h = fixture(root);
    const t: DiagnosticAdminTransport = async r => {
      const response = await h.transport(r);
      if (r.operation === "start") { h.signals.emit(signal); h.signals.emit(signal); }
      return response;
    };
    expect(await h.run([], t)).toBe(130);
    expect(h.controller.report()?.state).toBe("CLOSED");
    expect(h.transport.mock.calls.filter(([r]) => r.operation === "stop")).toHaveLength(1);
    expect(h.transport.mock.calls.filter(([r]) => r.operation === "report")).toHaveLength(1);
    expect(await readdir(root)).toHaveLength(1);
    expect(h.out).toContain(join(root, (await readdir(root))[0]!));
    expect(h.signals.listenerCount(signal)).toBe(0);
  }));

  it("starts only after connection refusal and closes its own bridge after writing", async () => temporary(async root => {
    const h = fixture(root); let absent = true;
    const t: DiagnosticAdminTransport = r => {
      if (absent) { absent = false; return Promise.reject(new DiagnosticCliError("BRIDGE_ABSENT", 3)); }
      const response = h.transport(r);
      if (r.operation === "start") h.signals.emit("SIGINT");
      return response;
    };
    h.close.mockImplementation(async () => { expect(await readdir(root)).toHaveLength(1); });
    expect(await h.run([], t)).toBe(130);
    expect(h.startBridge).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  }));

  it.each([401, 403, 404, 500, 302])("fails closed on a foreign listener returning %i", async status => temporary(async root => {
    const h = fixture(root);
    expect(await h.run([], () => Promise.resolve({ status, data: {} }))).toBe(3);
    expect(h.startBridge).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
    expect(h.dispose).toHaveBeenCalledOnce();
  }));

  it("does not start on a timeout, invalid schema, or older bridge without ownership support", async () => temporary(async root => {
    for (const t of [() => Promise.reject(new Error("private-canary")),
      () => Promise.resolve({ status: 200, ownership: true, data: { invalid: "private-canary" } }),
      () => Promise.resolve({ status: 200, data: { state: "OFF", reportAvailable: false } })]) {
      const h = fixture(root); expect(await h.run([], t)).toBe(3);
      expect(h.startBridge).not.toHaveBeenCalled(); expect(h.errors.join()).not.toContain("private-canary");
    }
  }));

  it.each(["capture", "report"])("leaves an existing %s untouched", async kind => temporary(async root => {
    const h = fixture(root);
    h.controller.start({ ttlMs: 300000, resolutions: 1, retainReport: true });
    if (kind === "report") h.controller.stop();
    const before = kind === "capture" ? h.controller.status() : h.controller.report();
    try {
      expect(await h.run()).toBe(4);
      expect(h.transport.mock.calls.map(([r]) => r.operation)).toEqual(["identity", "status"]);
      expect(kind === "capture" ? h.controller.status() : h.controller.report()).toEqual(before);
    } finally { h.controller.stop(); }
  }));

  it.each(["local", "argument", "override"])("requires explicit private consent via %s", async source => temporary(async root => {
    const h = fixture(root);
    if (source !== "argument") h.workflows.localConfig = () => Promise.resolve(validateDiagnosticLocalConfig({ outputDir: root, mode: "private" }));
    const t: DiagnosticAdminTransport = r => {
      const response = h.transport(r);
      if (r.operation.endsWith("start")) h.signals.emit("SIGINT");
      return response;
    };
    expect(await h.run(source === "local" ? [] : ["--mode", source === "argument" ? "private" : "anonymized"], t)).toBe(130);
    const html = await readFile(join(root, (await readdir(root))[0]!), "utf8");
    expect(html.includes('"privacy":"PRIVATE_LOCAL"')).toBe(source !== "override");
    expect(h.out.join()).not.toContain(syntheticAdminToken);
  }));

  it("reports export failure without overwrite, leakage or repeated stop and closes an owned bridge", async () => temporary(async root => {
    const h = fixture(root); let first = true;
    const t: DiagnosticAdminTransport = async r => {
      if (first) { first = false; throw new DiagnosticCliError("BRIDGE_ABSENT", 3); }
      const response = await h.transport(r);
      if (r.operation === "report") await rm(root, { recursive: true });
      if (r.operation === "start") h.signals.emit("SIGINT");
      return response;
    };
    expect(await h.run([], t)).toBe(5);
    expect(h.errors.join()).toContain("EXPORT_FAILED"); expect(h.errors.join()).not.toContain(syntheticAdminToken);
    expect(h.close).toHaveBeenCalledOnce(); expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.transport.mock.calls.filter(([r]) => r.operation === "stop")).toHaveLength(1);
  }));

  it("keeps a successful report when optional browser opening fails", async () => temporary(async root => {
    const h = fixture(root);
    const open = vi.fn(() => Promise.reject(new Error("private-canary")));
    expect(await runDiagnosticCli([], env, { out: s => h.out.push(s), error: s => h.errors.push(s) }, r => {
      const response = h.transport(r); if (r.operation === "start") h.signals.emit("SIGINT"); return response;
    }, { ...h.workflows, localConfig: () => Promise.resolve(validateDiagnosticLocalConfig({ outputDir: root, openReport: true })), openDemo: open })).toBe(130);
    expect(open).toHaveBeenCalledOnce(); expect(await readdir(root)).toHaveLength(1); expect(h.errors).toEqual([]);
  }));
});

describe("optional local diagnostic preferences", () => {
  it.each([null, [], { secret: "private-canary" }, { mode: "PRIVATE" }, { mode: null }, { next: 0 }, { next: 11 },
    { next: 1.5 }, { ttlSeconds: 301 }, { ttlSeconds: 0 }, { ttlSeconds: "1" }, { openReport: "true" }, { outputDir: null }])("rejects invalid preferences %j", value => {
    expect(() => validateDiagnosticLocalConfig(value)).toThrow("INVALID_LOCAL_CONFIG");
  });
  it.each(["\\\\host\\share", "\\\\?\\C:\\report", "C:relative", "C:\\reports:stream", "NUL", "x/CON.html", "x/trailing.", "x/trailing ", "x\0y"])("rejects unsafe Windows directory syntax %s", outputDir => {
    expect(() => validateDiagnosticLocalConfig({ outputDir })).toThrow("OUTPUT_UNSAFE");
  });
  it("accepts bounded defaults, opt-in and Windows absolute local paths", async () => temporary(async root => {
    expect(validateDiagnosticLocalConfig({})).toMatchObject({ mode: "anonymized", next: 3, ttlSeconds: 300, openReport: false });
    expect(validateDiagnosticLocalConfig({ mode: "private", next: 10, ttlSeconds: 1 }).mode).toBe("private");
    const folder = join(root, "reports with spaces"); await mkdir(folder);
    const a = await diagnosticSessionOutput(folder), b = await diagnosticSessionOutput(folder);
    expect(a).not.toBe(b); expect(a.startsWith(folder)).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  }));
  it("reads only the optional bounded local JSON, fails closed, and leaves it untouched", async () => temporary(async root => {
    // Mock cwd rather than touching the operator's real local preferences.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect((await readDiagnosticLocalConfig()).mode).toBe("anonymized");
      await mkdir(join(root, "config")); const file = join(root, "config/diagnostic.local.json");
      await writeFile(file, '\ufeff{"mode":"private"}'); expect((await readDiagnosticLocalConfig()).mode).toBe("private");
      for (const content of ['{"mode":', " ".repeat(8193), '{"next":11}']) {
        await writeFile(file, content); await expect(readDiagnosticLocalConfig()).rejects.toMatchObject({ code: "INVALID_LOCAL_CONFIG" });
        expect(await readFile(file, "utf8")).toBe(content);
      }
    } finally { cwd.mockRestore(); }
  }));
});

it("atomically rejects replacement stop and preserves a report created between preflight and start", async () => {
  const c = new DiagnosticController(); const app = express();
  app.use(localRequestPolicy(syntheticAdminToken)); app.use("/diagnostics", diagnosticHttp(c));
  const auth = `Bearer ${syntheticAdminToken}`;
  const options = { ttlMs: 300000, resolutions: 1, retainReport: true };
  c.start(options); const old = c.status().id!; c.stop(); c.start(options); const replacement = c.status().id;
  try {
    await request(app).post("/diagnostics/stop").set("Authorization", auth).set("X-Diagnostic-Session", old).expect(409);
    expect(c.status().id).toBe(replacement);
    await request(app).post("/diagnostics/stop").set("Authorization", auth).set("X-Diagnostic-Session", "private-canary").expect(400);
    c.stop(); const retained = c.report();
    await request(app).post("/diagnostics/start").set("Authorization", auth).set("X-Diagnostic-Preserve-Report", "true").send(options).expect(409);
    expect(c.report()).toEqual(retained);
    await request(app).post("/diagnostics/private/start").set("Authorization", auth).set("X-Diagnostic-Preserve-Report", "true").send(options).expect(409);
    expect(c.report()).toEqual(retained);
  } finally { c.stop(); }
});

it("fails closed against a real unauthorized occupied port without starting a bridge", async () => temporary(async root => {
  const credentials: unknown[] = [];
  const server = express().use((req, res) => { credentials.push(req.headers.authorization); res.status(401).json({ secret: "private-canary" }); }).listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const h = fixture(root);
  try {
    expect(await h.run(["--bridge", `http://127.0.0.1:${address.port}`], requestDiagnosticAdmin)).toBe(3);
    expect(h.startBridge).not.toHaveBeenCalled(); expect(h.errors.join()).toContain("BRIDGE_INCOMPATIBLE");
    expect(credentials).toEqual([undefined]);
    expect(h.errors.join()).not.toContain("private-canary"); expect(server.listening).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

it("reuses the real authenticated API and leaves its listener running after signal export", async () => temporary(async root => {
  const h = fixture(root), c = new DiagnosticController(), app = express();
  app.use(localRequestPolicy(syntheticAdminToken));
  app.get("/manifest.json", (_req, res) => res.json({ id: "org.local.tribler.bridge", name: "Local Tribler Bridge", resources: ["stream"] }));
  app.use("/diagnostics", diagnosticHttp(c));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  try {
    const transport: DiagnosticAdminTransport = async r => {
      const response = await requestDiagnosticAdmin(r);
      if (r.operation === "start") h.signals.emit("SIGINT");
      return response;
    };
    expect(await h.run(["--bridge", `http://127.0.0.1:${address.port}`], transport)).toBe(130);
    expect(server.listening).toBe(true); expect(h.startBridge).not.toHaveBeenCalled();
    expect(c.report()?.state).toBe("CLOSED"); expect(await readdir(root)).toHaveLength(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));
