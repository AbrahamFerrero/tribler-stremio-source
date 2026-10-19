import { fixtureOutboundRequest, type FixtureOutboundRequest } from "./helpers";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { KodiSourceQualityEvaluation, formatKodiSourceQualityTable, validateBatches,
  type KodiSourceBatch } from "../src/streams/kodi-source-quality-evaluation";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import type { NormalizedStreamSource } from "../src/streams/types";
import { silentLogger } from "./helpers";
import { inputItems } from "../scripts/evaluation-input";
import { IdentityPrecisionEvaluation } from "../src/streams/identity-precision-evaluation";
import { composeResolverTraces } from "../src/streams/source-diversity-evaluation";

const secret = "PRIVATE_TOKEN_123";
const url = (name: string) => `https://media.example/${name}.mp4?token=${secret}`;
const counts = (returned: number, direct: number, distinct: number, exclusive: number, shared: number) => ({
  returned, direct, torrent: 0, positiveSeeds: 0, unknownSeeds: 0, zeroSeeds: 0, zeroSeedWouldDrop: 0,
  distinct, exclusive, shared
});
const batches: KodiSourceBatch[] = [
  { profileId: "pack", sourceId: "a", status: "ok", elapsedMs: 12, counts: counts(2, 2, 2, 1, 1),
    candidates: [{ providerId: "python", type: "https", url: url("verified") },
      { providerId: "python", type: "https", url: url("shared") }] },
  { profileId: "pack", sourceId: "b", status: "ok", elapsedMs: 20, counts: counts(2, 2, 2, 1, 1),
    candidates: [{ providerId: "python", type: "https", url: url("shared") },
      { providerId: "python", type: "https", url: url("reject") }] },
  { profileId: "pack", sourceId: "empty", status: "ok", elapsedMs: 5, counts: counts(0, 0, 0, 0, 0), candidates: [] }
];

describe("Kodi inner-source quality evaluation", () => {
  it("evaluates real callable profile rows through the shared funnel with stable empty/error units", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kodi-callable-evaluation-"));
    try {
      const configFile = join(directory, "profiles.json");
      const profiles = ["direct", "empty", "exception"].map((id) => {
        const settingsFile = join(directory, `${id}.json`);
        writeFileSync(settingsFile, JSON.stringify({ "fixture.mode": id === "direct" ? "" : id }));
        return { id, name: id, enabled: true,
          addonPath: join(process.cwd(), "python-adapter-host/tests/fixtures/fake_kodi_addon"),
          addonId: "script.module.fake", module: "adapter_host.kodi.adapters.callable_stream_resolver",
          // Allow Python startup under parallel CI load; timeout behavior has dedicated worker tests.
          callable: "resolve", workerTimeoutSeconds: 5, settingsFile, profilePath: join(directory, id),
          adapterConfig: { targetModule: "callable_stream_fixture", targetCallable: "get_stream_data", resultMode: "tuple" } };
      });
      writeFileSync(configFile, JSON.stringify({ version: 1, profiles }));
      const item = { id: "tt1254207", kind: "movie" as const, title: "Big Buck Bunny", year: 2008,
        externalIds: { imdb: "tt1254207" } };
      const readBatches = () => {
        const result = spawnSync("python", ["-B", "-m", "adapter_host.evaluate_kodi_sources"], {
          cwd: join(process.cwd(), "python-adapter-host"), encoding: "utf8", input: JSON.stringify(item), timeout: 20_000,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key))),
            PYTHON_ADAPTER_KODI_RESOLVERS_FILE: configFile }
        });
        expect(result.status).toBe(0);
        return validateBatches(JSON.parse(result.stdout) as unknown);
      };
      const initial = readBatches();
      expect(initial.map((row) => [row.profileId, row.sourceId, row.status])).toEqual([
        ["direct", "profile", "ok"], ["empty", "profile", "ok"], ["exception", "profile", "error"]
      ]);
      const evaluator = new KodiSourceQualityEvaluation(initial.map(({ profileId, sourceId }) => ({ profileId, sourceId })));
      const identity = new IdentityPrecisionEvaluation(["kodi-0", "kodi-1", "kodi-2"], { diagnostics: true });
      const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array(64), {
        status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-63/100" }
      }));
      const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
      const probe = new DirectStreamProbe(transport,
        { enabled: true, timeoutMs: 500, maxCandidates: 3, maxConcurrent: 1 }, silentLogger);
      const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "1.1.1.1", family: 4 }]) });
      // Reuse validated discovery output to test accumulation through two Node evaluations.
      for (const rows of [initial, initial]) {
        await evaluator.evaluateItem(rows, async (providers, trace) => {
          const registry = new StreamProviderRegistry(100, silentLogger);
          for (const provider of providers) registry.register({ id: provider.id, name: provider.id,
            isEnabled: () => true, resolve: () => Promise.resolve(provider.candidates) });
          await new StreamResolver(registry, policy, probe,
            composeResolverTraces(trace, identity.itemTrace(item))).resolve(item);
        });
      }
      const report = { ...evaluator.report(), identityPrecision: identity.report() };
      expect(report.evaluatedItems).toBe(2);
      expect(report.sources[0]).toMatchObject({ profileId: "direct", sourceId: "profile",
        rawDirect: 2, evalVerified: 2, evalFinal: 2, evalItems: 2, sourceErrors: 0 });
      expect(report.sources[1]).toMatchObject({ returned: 0, sourceErrors: 0 });
      expect(report.sources[2]).toMatchObject({ returned: 0, sourceErrors: 2 });
      expect(report.identityPrecision.diagnostics?.observations.some((row) => row.stage === "final")).toBe(true);
      for (const forbidden of ["https://", "magnet:", "do-not-expose", "Authorization", "Cookie", "infoHash", directory])
        expect(JSON.stringify(report)).not.toContain(forbidden);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25_000);

  it("passes explicit year and episode series title through the shared D1 input format", () => {
    const directory = mkdtempSync(join(tmpdir(), "kodi-input-"));
    try {
      const input = join(directory, "input.json");
      writeFileSync(input, JSON.stringify([
        { type: "movie", videoId: "synthetic:movie-01", title: "Synthetic Movie", year: 2010 },
        { type: "series", videoId: "tt1234567:1:2", kind: "episode", title: "Episode",
          seriesTitle: "Series", season: 1, episode: 2 }
      ]));
      const items = inputItems(input);
      expect(items[0]?.year).toBe(2010);
      expect(items[1]?.seriesTitle).toBe("Series");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates child envelopes without putting candidate payload in reports", () => {
    expect(validateBatches({ ok: true, sources: batches })).toHaveLength(3);
    for (const elapsedMs of [-1, 600_001, NaN, Infinity, "12"]) {
      expect(() => validateBatches({ ok: true, sources: [{ ...batches[0], elapsedMs }] })).toThrow();
    }
    expect(() => validateBatches({ ok: true, sources: [{ ...batches[0], sourceId: "https://private" }] })).toThrow();
    expect(() => validateBatches({ ok: false, error: "private path" })).toThrow();
  });

  it("uses synthetic providers and D1 trace for per-source probe outcomes", async () => {
    const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url: target }) =>
      Promise.resolve(target.includes("reject")
        ? new Response(null, { status: 403 })
        : new Response(new Uint8Array(64), { status: 206,
          headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-63/100" } })));
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const probe = new DirectStreamProbe(transport,
      { enabled: true, timeoutMs: 500, maxCandidates: 3, maxConcurrent: 1 }, silentLogger, () => 0);
    const evaluator = new KodiSourceQualityEvaluation(batches.map(({ profileId, sourceId }) => ({ profileId, sourceId })));
    await evaluator.evaluateItem(batches, async (providers, trace) => {
      const registry = new StreamProviderRegistry(100, silentLogger);
      for (const provider of providers) registry.register({ id: provider.id, name: provider.id,
        isEnabled: () => true, resolve: (): Promise<NormalizedStreamSource[]> => Promise.resolve(provider.candidates) });
      await new StreamResolver(registry, policy, probe, trace).resolve({
        id: "tt1234567", kind: "movie", title: "Fixture", externalIds: { imdb: "tt1234567" }
      });
    });
    const report = evaluator.report();
    expect(report.sources.map((row) => [row.evalTurns, row.evalNet, row.evalVerified,
      row.evalReject, row.evalFinal, row.shared])).toEqual([
      [2, 2, 2, 0, 2, 1], [1, 1, 0, 1, 0, 1], [0, 0, 0, 0, 0, 0]
    ]);
    // Three candidate probes; the rejected candidate also retries without Range.
    expect(request).toHaveBeenCalledTimes(4);
    expect(report.version).toBe(3);
    expect(report.kind).toBe("kodi");
    expect(report.cost[0]).toMatchObject({ profileId: "pack", sourceId: "a",
      evaluations: 1, latency: { p50Ms: 12, p95Ms: 12 } });
    expect(report.segments[0]?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "kodi-0", distinct: 2, shared: 1, exclusive: 1 })
    ]));
    const output = JSON.stringify(report) + formatKodiSourceQualityTable(report);
    for (const forbidden of [secret, "https://", "magnet:", "PRIVATE", "infoHash"]) expect(output).not.toContain(forbidden);
  });

  it("turns Python child configuration failures into fixed categories and leaves no candidates", () => {
    const directory = mkdtempSync(join(tmpdir(), "kodi-evaluation-"));
    try {
      const input = join(directory, "input.json");
      writeFileSync(input, JSON.stringify([{ type: "movie", videoId: "synthetic:movie-01", title: "Synthetic Movie" }]));
      const privatePath = join(directory, "private-token-config.json");
      const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        join(process.cwd(), "scripts", "evaluate-kodi-sources.ts"), "--input", input, "--json"], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env,
          TRIBLER_URL: "http://127.0.0.1:54528", DIRECT_HTTP_PROBE_ENABLED: "true",
          PYTHON_ADAPTER_KODI_RESOLVERS_FILE: privatePath }
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toMatch(/^EVALUATION_FAILED: (python child failed|python response invalid)$/);
      expect(result.stderr).not.toContain("private-token");
      expect(readdirSync(directory)).toEqual(["input.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
