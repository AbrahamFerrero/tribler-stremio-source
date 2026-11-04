import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogProviders } from "../../src/catalog/factory";
import { loadStreamRankingPolicy } from "../../src/streams/ranking-policy";
import { loadStremioAddonConfigs } from "../../src/streams/stremio-addon-config";
import { createStreamResolver, createUrlPolicy } from "../../src/streams/factory";
import { logger, safeErrorDetails } from "../../src/logger";
import { createApp } from "../../src/app";
import { testConfig } from "../helpers";
import { diagnosticReportFixture } from "../diagnostic-report-fixture";
import { serializeDiagnosticReport } from "../../src/diagnostics/report-model";
import { renderDiagnosticHtml } from "../../src/diagnostics/html-report";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "config-error-qa-"));
  directories.push(directory);
  const file = join(directory, "synthetic.json");
  writeFileSync(file, "{}");
  return file;
}
function caught(action: () => unknown): Error {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected synthetic configuration failure");
}
const marker = "SYNTH_INTERNAL_CAUSE_152";
function originalFailure(): Error {
  const error = new Error("synthetic read failure", { cause: new Error(marker) });
  error.stack = marker;
  return error;
}

describe("configuration error cause privacy", () => {
  it("does not disclose the cause stack on failure during startup module loading", () => {
    const hook = join(dirname(fixture()), "synthetic-startup-hook.mjs");
    writeFileSync(hook, `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (String(file).replaceAll('\\\\', '/').endsWith('/config/stream-ranking.default.json')) {
          const error = new Error('synthetic read failure');
          error.stack = '${marker}'; throw error;
        }
        return original.call(this, file, ...args);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href,
      "--import", pathToFileURL(hook).href, "src/index.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
      env: { ...process.env, DOTENV_CONFIG_PATH: join(dirname(hook), "nonexistent.env") }
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      level: "error", message: "Startup failed", error: { type: "Error" }
    });
    expect((JSON.parse(result.stderr) as { error: unknown }).error).toEqual({ type: "Error" });
    expect(result.stdout + result.stderr).not.toContain("synthetic read failure");
    expect(result.stdout + result.stderr).not.toContain(marker);
  }, 20_000);

  it.each(["catalog", "ranking", "addons"] as const)("preserves %s error identity and message without exporting internals", (kind) => {
    const file = fixture();
    const original = originalFailure();
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw original; });
    const error = caught(() => kind === "catalog"
      ? createCatalogProviders(testConfig({ catalogSourcesFile: file }))
      : kind === "ranking" ? loadStreamRankingPolicy(file) : loadStremioAddonConfigs(file));
    const prefix = kind === "catalog" ? `Could not read catalog sources file ${file}: `
      : kind === "ranking" ? `STREAM_RANKING_CONFIG_FILE ${resolve(file)}: ` : "Could not read Stremio addon config: ";
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe(prefix + original.message);
    expect(error.cause).toBe(original);
    expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
    expect(JSON.stringify(error)).toBe("{}");
    expect(safeErrorDetails(error)).toEqual({ type: "Error" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.error("Startup failed", { error: safeErrorDetails(error) });
    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({ message: "Startup failed", error: { type: "Error" } });
    for (const value of [marker, file, original.message, "stack", "cause"]) expect(output).not.toContain(value);
  });

  it("keeps allowed outer code/status while never accessing stack or cause", () => {
    const error = Object.assign(new Error("allowed local message"), { code: "EACCES", status: 503 });
    for (const key of ["cause", "stack"]) Object.defineProperty(error, key, {
      get() { throw new Error(marker); }
    });
    expect(safeErrorDetails(error)).toEqual({ type: "Error", code: "EACCES", status: 503 });
  });

  it("keeps addon configuration failures fail-closed and out of operational logs", () => {
    const file = fixture();
    const config = testConfig({ streamProviders: ["stremio_addons"], stremioAddonProvidersFile: file });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw originalFailure(); });
    const resolver = createStreamResolver([], config, logger, createUrlPolicy(config));
    expect(resolver.diagnostics().filter(provider => provider.type === "stremio_addons")).toEqual([]);
    const output = warning.mock.calls.map(call => String(call[0])).join("\n");
    expect(output).toContain("Stremio addon providers disabled");
    for (const value of [marker, file, "synthetic read failure", "stack", "cause"]) expect(output).not.toContain(value);
  });

  it("keeps a real wrapped configuration error out of public HTTP and request logs", async () => {
    const file = fixture();
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw originalFailure(); });
    const error = caught(() => loadStreamRankingPolicy(file));
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, service } = createApp(testConfig(), logger);
    // Use the existing HTTP error boundary with the actual wrapped error.
    service.diagnostics = () => Promise.reject(error);
    const response = await request(app).get("/downloads").set("Authorization", `Bearer ${testConfig().bridgeAdminToken}`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Request failed", type: "Error" });
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ error: { type: "Error" } });
    const publicOutput = JSON.stringify(response.body) + output.mock.calls.map(call => String(call[0])).join("\n");
    for (const value of [marker, file, "synthetic read failure", "stack", "cause"]) expect(publicOutput).not.toContain(value);
  });

  it.each(["cause", "stack", "error"])("rejects injected %s in anonymized JSON and HTML reports", (key) => {
    const report = { ...diagnosticReportFixture(), [key]: originalFailure() };
    expect(() => serializeDiagnosticReport(report)).toThrow("INVALID_DIAGNOSTIC_REPORT");
    expect(() => renderDiagnosticHtml(report)).toThrow("INVALID_DIAGNOSTIC_REPORT");
  });
});
