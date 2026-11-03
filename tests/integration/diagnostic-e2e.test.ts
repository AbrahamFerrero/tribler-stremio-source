import { once } from "node:events";
import { get } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { CatalogProvider } from "../../src/catalog/types";
import { runDiagnosticCli } from "../../src/diagnostics/cli";
import { diagnosticTranslations } from "../../src/diagnostics/i18n";
import { validateDiagnosticReport } from "../../src/diagnostics/report-model";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import type { OutboundTransport } from "../../src/network/outbound-transport";
import { syntheticAdminToken, testConfig } from "../helpers";

function jsonRequest(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    get(url, { headers }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", (chunk: string) => { body += chunk; });
      response.on("error", reject); response.on("end", () => {
        try { resolve({ status: response.statusCode ?? 0, data: JSON.parse(body) as unknown }); }
        catch (error) { reject(error instanceof Error ? error : new Error("Invalid synthetic JSON response")); }
      });
    }).on("error", reject);
  });
}

it("captures a real application resolution through the native CLI and exports the same private-free bilingual dataset", async () => {
  const canary = "synthetic-private-e2e-canary";
  const network = vi.fn(() => Promise.reject(new Error(canary)));
  const transport: OutboundTransport = { id: "fixture", request: network,
    diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
  const direct = vi.fn(() => Promise.resolve([
    { url: `https://media.example/${canary}.mp4?signature=${canary}`, fileName: `${canary}.mp4`, size: 1000, height: 720 }
  ]));
  const catalog: CatalogProvider = { definition: { id: "fixture", type: "movie", name: "Synthetic" }, owns: () => true,
    list: () => Promise.resolve([]), get: () => Promise.resolve({ id: canary, type: "movie", name: canary }),
    getTorrentSource: () => Promise.resolve(""), supportsTriblerFallback: () => Promise.resolve(false), getDirectStreams: direct };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
  const makeApp = () => createApp(testConfig(), log, undefined, catalog, policy, transport).app;
  const server = makeApp().listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing synthetic listener");
  const bridge = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), "diagnostic-e2e-"));
  const cli = async (args: string[]) => {
    const out: string[] = [], errors: string[] = [];
    const code = await runDiagnosticCli([...args, "--bridge", bridge], { BRIDGE_ADMIN_TOKEN: syntheticAdminToken },
      { out: line => out.push(line), error: line => errors.push(line) });
    return { code, out: out.join("\n"), errors };
  };
  const streams = async () => {
    const response = await jsonRequest(`${bridge}/stream/movie/${canary}.json`, { Origin: "https://web.stremio.com" });
    expect(response.status).toBe(200);
    return response.data as { streams: Array<{ url: string; name: string; behaviorHints: unknown }> };
  };
  try {
    expect((await cli(["status"])).out).toContain("[OFF]");
    expect((await cli(["report"])).code).toBe(4);
    const off = await streams();
    expect((await cli(["start", "--next", "1", "--ttl", "300", "--retain"])).code).toBe(0);
    const on = await streams();
    const shape = (result: typeof on) => result.streams.map(s => {
      expect(new URL(s.url).pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\//);
      return { name: s.name, hints: s.behaviorHints };
    });
    expect(shape(on)).toEqual(shape(off)); expect(on.streams).toHaveLength(1);
    expect((await cli(["report"])).code).toBe(4);
    expect((await cli(["stop"])).code).toBe(0);
    const english = await cli(["report"]), spanish = await cli(["report", "--lang", "es"]);
    expect(english.out).toContain(diagnosticTranslations.en.session); expect(spanish.out).toContain(diagnosticTranslations.es.session);
    const jsonPath = join(root, "report.json"), htmlPath = join(root, "report.html");
    expect((await cli(["export", "--format", "json", "--output", jsonPath])).code).toBe(0);
    expect((await cli(["export", "--format", "html", "--output", htmlPath, "--lang", "es"])).code).toBe(0);
    const json = await readFile(jsonPath, "utf8"), html = await readFile(htmlPath, "utf8");
    const report = validateDiagnosticReport(JSON.parse(json) as unknown);
    expect(report).toMatchObject({ state: "CLOSED", reserved: 1, resolutions: [{ state: "CLOSED" }] });
    expect(report.resolutions[0]!.events.some(e => e.kind === "RANKING")).toBe(true);
    expect(JSON.parse(/<script id="diagnostic-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as unknown).toEqual(report);
    expect(html).toContain('<html lang="en">');
    const logs = JSON.stringify(Object.values(log).map(method => method.mock.calls));
    for (const text of [json, html, english.out, spanish.out, logs]) expect(text).not.toContain(canary);
    expect(network).not.toHaveBeenCalled(); expect(direct).toHaveBeenCalledTimes(2);
    const restarted = makeApp().listen(0, "127.0.0.1"); await once(restarted, "listening");
    try {
      const next = restarted.address(); if (!next || typeof next === "string") throw new Error("Missing restart listener");
      const headers = { Authorization: `Bearer ${syntheticAdminToken}` };
      const status = await jsonRequest(`http://127.0.0.1:${next.port}/diagnostics/status`, headers);
      expect(status.data).toEqual({ state: "OFF", reportAvailable: false });
      expect((await jsonRequest(`http://127.0.0.1:${next.port}/diagnostics/report`, headers)).status).toBe(404);
    } finally { restarted.closeAllConnections(); await new Promise<void>(resolve => restarted.close(() => resolve())); }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
