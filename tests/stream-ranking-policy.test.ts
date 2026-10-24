import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { defaultStreamRankingPolicy, loadStreamRankingPolicy, parseStreamRankingPolicy } from "../src/streams/ranking-policy";
import { scoreStream } from "../src/streams/scoring";
import type { NormalizedStreamSource } from "../src/streams/types";

let testFile: string | undefined;
function localPolicy(value: unknown): string {
  testFile = join(tmpdir(), `stream-ranking-${randomUUID()}.json`);
  writeFileSync(testFile, JSON.stringify(value));
  return testFile;
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (testFile) unlinkSync(testFile);
  testFile = undefined;
});

describe("stream ranking policy", () => {
  it("loads the checked-in policy when no custom file is configured", () => {
    expect(loadStreamRankingPolicy()).toEqual(defaultStreamRankingPolicy);
  });

  it("changes HTTPS-versus-torrent ordering through a local JSON file and startup config", () => {
    const direct: NormalizedStreamSource = { providerId: "test", type: "https", url: "https://media.example/video.mp4",
      quality: "480p", sizeBytes: 1024 ** 3,
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 100 } };
    const torrent: NormalizedStreamSource = { providerId: "test", type: "magnet", quality: "1080p",
      seeds: 5, sizeBytes: 5 * 1024 ** 3 };
    expect(scoreStream(direct)).toBeGreaterThan(scoreStream(torrent));
    const alternative = structuredClone(defaultStreamRankingPolicy);
    alternative.direct.health.verified = 90;
    alternative.torrent.seedScorePerDoubling = 60;
    const path = localPolicy(alternative);
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("STREAM_RANKING_CONFIG_FILE", path);
    const configured = loadConfig().streamRankingPolicy;
    expect(configured).toEqual(alternative);
    expect(scoreStream(torrent, configured)).toBeGreaterThan(scoreStream(direct, configured));
  });

  it("fails fast on invalid JSON, missing keys, unsafe keys, bad bands, and nonsensical scores", () => {
    const path = localPolicy({ direct: {} });
    expect(() => loadStreamRankingPolicy(path)).toThrow(/direct/);
    unlinkSync(path);
    writeFileSync(path, "{ invalid json");
    expect(() => loadStreamRankingPolicy(path)).toThrow(/STREAM_RANKING_CONFIG_FILE/);
    const policy = structuredClone(defaultStreamRankingPolicy);
    expect(() => parseStreamRankingPolicy({ ...policy, __proto__: { polluted: true } })).toThrow();
    policy.direct.latencyMs[1] = { max: 100, score: 11 };
    expect(() => parseStreamRankingPolicy(policy)).toThrow(/latencyMs/);
    const nonFinite = structuredClone(defaultStreamRankingPolicy);
    nonFinite.direct.health.verified = Number.NaN;
    expect(() => parseStreamRankingPolicy(nonFinite)).toThrow(/verified/);
    const missing = structuredClone(defaultStreamRankingPolicy) as unknown as Record<string, unknown>;
    delete missing.quality;
    expect(() => parseStreamRankingPolicy(missing)).toThrow(/quality/);
  });
});
