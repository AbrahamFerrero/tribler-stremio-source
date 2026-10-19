// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { fixtureOutboundRequest, type FixtureOutboundRequest } from "./helpers";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { ProviderQualityEvaluation, formatProviderQualityTable } from "../src/streams/provider-quality-evaluation";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { NormalizedStreamSource } from "../src/streams/types";
import { silentLogger } from "./helpers";

const secret = "SECRET_TOKEN_123";
const item = { id: "tt1234567", kind: "movie" as const, title: "Fixture", externalIds: { imdb: "tt1234567" } };
const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });

function setup(trace?: ReturnType<ProviderQualityEvaluation["itemTrace"]>) {
  const registry = new StreamProviderRegistry(100, silentLogger);
  const sources: Record<string, NormalizedStreamSource[]> = {
    "stremio-addon-good": [
      { providerId: "stremio-addon-good", type: "https", url: `https://media.example/verified.mp4?token=${secret}` },
      { providerId: "stremio-addon-good", type: "https", url: `https://media.example/verified.mp4?token=${secret}` },
      { providerId: "stremio-addon-good", type: "https", url: `https://media.example/uncertain.mp4?token=${secret}` }
    ],
    "stremio-addon-bad": [
      { providerId: "stremio-addon-bad", type: "https", url: `https://media.example/reject.mp4?token=${secret}` }
    ],
    "stremio-addon-empty": []
  };
  for (const [id, values] of Object.entries(sources)) registry.register({
    id, name: id, type: "stremio_addon", isEnabled: () => true, resolve: () => Promise.resolve(values)
  });
  const request = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url }) => {
    if (url.includes("reject")) return Promise.resolve(new Response(null, { status: 403 }));
    if (url.includes("uncertain")) return Promise.resolve(new Response(null, { status: 503 }));
    return Promise.resolve(new Response(new Uint8Array(64), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-63/100" }
    }));
  });
  const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
    diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
  const probe = new DirectStreamProbe(transport,
    { enabled: true, timeoutMs: 500, maxCandidates: 3, maxConcurrent: 1 }, silentLogger, () => 0);
  return { resolver: new StreamResolver(registry, policy, probe, trace), request };
}

describe("Stremio provider quality evaluation", () => {
  it("reports a missing configured addon file without exposing its path in either CLI mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "provider-evaluation-"));
    try {
      const input = join(directory, "input.json");
      writeFileSync(input, JSON.stringify([{ type: "movie", videoId: "tt9900107" }]));
      const missing = join(directory, "secret-token-addons.json");
      for (const json of [false, true]) {
        const result = spawnSync(process.execPath, [
          join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
          join(process.cwd(), "scripts", "evaluate-stremio-providers.ts"),
          "--input", input, ...(json ? ["--json"] : [])
        ], {
          cwd: process.cwd(),
          env: { ...process.env, TRIBLER_URL: "http://127.0.0.1:54528",
            STREAM_PROVIDER_STREMIO_ADDONS_FILE: missing, DIRECT_HTTP_PROBE_ENABLED: "true" },
          encoding: "utf8"
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim()).toBe("EVALUATION_FAILED: addon configuration unavailable");
        expect(result.stderr).not.toContain("secret-token");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("attributes stages and probe outcomes without retaining or emitting URLs", async () => {
    const evaluation = new ProviderQualityEvaluation([
      { id: "stremio-addon-good", name: "Good" },
      { id: "stremio-addon-bad", name: "Bad" },
      { id: "stremio-addon-empty", name: "Empty" }
    ]);
    evaluation.rawStreams("stremio-addon-good", [
      { url: `https://media.example/verified.mp4?token=${secret}` },
      { url: `https://media.example/verified.mp4?token=${secret}` },
      { url: `https://media.example/uncertain.mp4?token=${secret}` }
    ]);
    evaluation.rawStreams("stremio-addon-bad", [{ url: `https://media.example/reject.mp4?token=${secret}` }]);
    const trace = evaluation.itemTrace();
    const { resolver, request } = setup(trace);
    const final = await resolver.resolve(item);
    evaluation.finishItem(trace);
    expect(final.map((source) => source.providerId)).toEqual(["stremio-addon-good", "stremio-addon-good"]);
    // Three candidate probes; the rejected candidate also retries without Range.
    expect(request).toHaveBeenCalledTimes(4);
    const report = evaluation.report();
    expect(report.providers.map((row) => ({
      id: row.id, raw: row.rawDirect, qualified: row.qualifiedDirect, deduped: row.dedupedDirect,
      turns: row.selectedTurns, net: row.networkStarts, verified: row.verified, uncertain: row.uncertain,
      rejected: row.deterministicRejects, admitted: row.admittedDirect, final: row.finalDirect,
      items: row.contributingItems
    }))).toEqual([
      { id: "stremio-addon-good", raw: 3, qualified: 3, deduped: 2, turns: 2,
        net: 2, verified: 1, uncertain: 1, rejected: 0, admitted: 2, final: 2, items: 1 },
      { id: "stremio-addon-bad", raw: 1, qualified: 1, deduped: 1, turns: 1,
        net: 1, verified: 0, uncertain: 0, rejected: 1, admitted: 0, final: 0, items: 0 },
      { id: "stremio-addon-empty", raw: 0, qualified: 0, deduped: 0, turns: 0,
        net: 0, verified: 0, uncertain: 0, rejected: 0, admitted: 0, final: 0, items: 0 }
    ]);
    expect(JSON.stringify(report) + formatProviderQualityTable(report)).not.toContain(secret);
    expect(JSON.stringify(report) + formatProviderQualityTable(report)).not.toContain("https://");
  });

  it("keeps normal resolver contents and ordering when observation is enabled", async () => {
    const without = await setup().resolver.resolve(item);
    const evaluation = new ProviderQualityEvaluation([
      { id: "stremio-addon-good", name: "Good" },
      { id: "stremio-addon-bad", name: "Bad" },
      { id: "stremio-addon-empty", name: "Empty" }
    ]);
    const withTrace = await setup(evaluation.itemTrace()).resolver.resolve(item);
    expect(withTrace).toEqual(without);
  });

  it("sanitizes configured provider names in all output formats", () => {
    const evaluation = new ProviderQualityEvaluation([{ id: "safe-id", name: `https://secret.example/?token=${secret}` }]);
    const report = evaluation.report();
    expect(JSON.stringify(report) + formatProviderQualityTable(report)).not.toContain(secret);
    expect(report.providers[0]?.name).toBe("safe-id");
  });
});

describe("D1 configured provider policy", () => {
  it("uses the parsed addon policy and makes no provider request for a disabled movie", async () => {
    const directory = mkdtempSync(join(tmpdir(), "provider-policy-evaluation-"));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500);
      response.end();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server unavailable");
      const addons = join(directory, "addons.json");
      const input = join(directory, "input.json");
      writeFileSync(addons, JSON.stringify([{
        id: "fixture", name: "Fixture", enabled: true,
        manifestUrl: "http://127.0.0.1:" + address.port + "/manifest.json",
        contentTypes: { movie: false, series: true, anime: true }
      }]));
      writeFileSync(input, JSON.stringify([{ type: "movie", videoId: "tt1234567" }]));
      const output = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [
          join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
          join(process.cwd(), "scripts", "evaluate-stremio-providers.ts"),
          "--input", input, "--json"
        ], {
          cwd: process.cwd(),
          env: { ...process.env, TRIBLER_URL: "http://127.0.0.1:54528",
            STREAM_PROVIDER_STREMIO_ADDONS_FILE: addons, DIRECT_HTTP_PROBE_ENABLED: "true" }
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      expect(output).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(output.stdout)).toMatchObject({
        evaluatedItems: 1, providers: [{ id: "stremio-addon-fixture", rawDirect: 0, finalDirect: 0 }],
        identityPrecision: { observationOnly: true, providers: [{ providerId: "stremio-addon-fixture",
          stages: { provider: { MATCH: 0, UNKNOWN: 0, SUSPICIOUS: 0, CONTRADICTION: 0 } } }] }
      });
      expect(requests).toBe(0);
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("D1 corpus cost accounting", () => {
  it("counts stream requests without retaining request IDs in the versioned report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "provider-cost-evaluation-"));
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.url === "/manifest.json"
        ? { id: "fixture", name: "Fixture", description: "Controlled fixture", version: "1.0.0",
          resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
          types: ["movie"] }
        : { streams: [] }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server unavailable");
      const addons = join(directory, "addons.json");
      const corpus = join(directory, "corpus.json");
      writeFileSync(addons, JSON.stringify([{ id: "fixture", name: "Fixture", enabled: true,
        manifestUrl: "http://127.0.0.1:" + address.port + "/manifest.json" }]));
      writeFileSync(corpus, JSON.stringify({ version: 1, id: "fixture-v1", cases: [{
        id: "movie-01", mediaClass: "movie", cohort: "mainstream",
        item: { type: "movie", videoId: "tt1234567" }
      }] }));
      const output = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [
          join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
          join(process.cwd(), "scripts", "evaluate-stremio-providers.ts"),
          "--corpus", corpus, "--json"
        ], { cwd: process.cwd(), env: { ...process.env, TRIBLER_URL: "http://127.0.0.1:54528",
          STREAM_PROVIDER_STREMIO_ADDONS_FILE: addons, DIRECT_HTTP_PROBE_ENABLED: "true" } });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      expect(output).toMatchObject({ status: 0, stderr: "" });
      expect(paths).toHaveLength(2);
      const report = JSON.parse(output.stdout) as {
        kind: string; version: number; evaluatedItems: number;
        cost: unknown[]; segments: Array<{ id: string }>
      };
      expect(report).toMatchObject({ kind: "stremio", version: 3, evaluatedItems: 1,
        cost: [{ id: "stremio-addon-fixture", evaluations: 1, requests: 1, responses: 1, errors: 0 }] });
      expect(report.segments.map((segment: { id: string }) => segment.id)).toEqual([
        "all", "movie", "mainstream", "movie/mainstream"
      ]);
      expect(output.stdout).not.toContain("tt1234567");
      expect(output.stdout).not.toContain("/stream/");
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
