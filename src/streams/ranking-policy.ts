import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface StreamRankingPolicy {
  direct: {
    health: { verified: number; reachable: number; unknown: number; timeout: number; unreachable: number };
    latencyMs: Array<{ max?: number; score: number }>;
  };
  torrent: { seedScorePerDoubling: number; maxSeedScore: number; zeroSeeds: number; unknownSeeds: number };
  quality: { "2160p": number; "1440p": number; "1080p": number; "720p": number; "480p": number; unknown: number };
}

const defaultPath = resolve(__dirname, "../..", "config", "stream-ranking.default.json");
const maxFileBytes = 32 * 1024;

function record(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be a JSON object`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`${path} must contain exactly: ${keys.join(", ")}`);
  }
  return object;
}

function integer(value: unknown, path: string, min = -1000, max = 1000): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < min || value > max) {
    throw new Error(`${path} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseStreamRankingPolicy(value: unknown): StreamRankingPolicy {
  const root = record(value, "stream ranking", ["direct", "torrent", "quality"]);
  const direct = record(root.direct, "direct", ["health", "latencyMs"]);
  const health = record(direct.health, "direct.health", ["verified", "reachable", "unknown", "timeout", "unreachable"]);
  const parsedHealth = {
    verified: integer(health.verified, "direct.health.verified"),
    reachable: integer(health.reachable, "direct.health.reachable"),
    unknown: integer(health.unknown, "direct.health.unknown"),
    timeout: integer(health.timeout, "direct.health.timeout"),
    unreachable: integer(health.unreachable, "direct.health.unreachable")
  };
  if (!(parsedHealth.verified > parsedHealth.reachable && parsedHealth.reachable >= parsedHealth.unknown
    && parsedHealth.unknown >= parsedHealth.timeout && parsedHealth.timeout >= parsedHealth.unreachable)) {
    throw new Error("direct.health must decrease from verified through unreachable");
  }
  if (!Array.isArray(direct.latencyMs) || direct.latencyMs.length < 2 || direct.latencyMs.length > 8) {
    throw new Error("direct.latencyMs must contain 2 to 8 ordered bands");
  }
  let lastMax = 0;
  let lastScore = Number.POSITIVE_INFINITY;
  const latencyMs = direct.latencyMs.map((entry, index) => {
    const final = index === (direct.latencyMs as unknown[]).length - 1;
    const band = record(entry, `direct.latencyMs[${index}]`, final ? ["score"] : ["max", "score"]);
    const score = integer(band.score, `direct.latencyMs[${index}].score`);
    if (score > lastScore) throw new Error("direct.latencyMs scores must not increase with latency");
    lastScore = score;
    if (final) return { score };
    const max = integer(band.max, `direct.latencyMs[${index}].max`, 1, 60_000);
    if (max <= lastMax) throw new Error("direct.latencyMs max values must increase");
    lastMax = max;
    return { max, score };
  });
  const torrent = record(root.torrent, "torrent", ["seedScorePerDoubling", "maxSeedScore", "zeroSeeds", "unknownSeeds"]);
  const parsedTorrent = {
    seedScorePerDoubling: integer(torrent.seedScorePerDoubling, "torrent.seedScorePerDoubling", 1, 200),
    maxSeedScore: integer(torrent.maxSeedScore, "torrent.maxSeedScore", 1, 1000),
    zeroSeeds: integer(torrent.zeroSeeds, "torrent.zeroSeeds"),
    unknownSeeds: integer(torrent.unknownSeeds, "torrent.unknownSeeds")
  };
  if (parsedTorrent.zeroSeeds > parsedTorrent.unknownSeeds) {
    throw new Error("torrent.zeroSeeds must not outrank unknownSeeds");
  }
  const quality = record(root.quality, "quality", ["2160p", "1440p", "1080p", "720p", "480p", "unknown"]);
  const parsedQuality = {
    "2160p": integer(quality["2160p"], "quality.2160p"),
    "1440p": integer(quality["1440p"], "quality.1440p"),
    "1080p": integer(quality["1080p"], "quality.1080p"),
    "720p": integer(quality["720p"], "quality.720p"),
    "480p": integer(quality["480p"], "quality.480p"),
    unknown: integer(quality.unknown, "quality.unknown")
  };
  if (!(parsedQuality["2160p"] >= parsedQuality["1440p"] && parsedQuality["1440p"] >= parsedQuality["1080p"]
    && parsedQuality["1080p"] >= parsedQuality["720p"] && parsedQuality["720p"] >= parsedQuality["480p"]
    && parsedQuality["480p"] >= parsedQuality.unknown)) {
    throw new Error("quality scores must not decrease as resolution increases");
  }
  return { direct: { health: parsedHealth, latencyMs }, torrent: parsedTorrent, quality: parsedQuality };
}

export function loadStreamRankingPolicy(file = defaultPath): StreamRankingPolicy {
  const path = resolve(file);
  try {
    if (statSync(path).size > maxFileBytes) throw new Error(`file exceeds ${maxFileBytes} bytes`);
    return parseStreamRankingPolicy(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`STREAM_RANKING_CONFIG_FILE ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const defaultStreamRankingPolicy = loadStreamRankingPolicy();
