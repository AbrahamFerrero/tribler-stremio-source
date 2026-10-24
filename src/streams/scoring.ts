import type { NormalizedStreamSource } from "./types";
import { validSeedCount } from "./seed-count";
import { recognizedStreamAudio, recognizedStreamLanguage } from "./structured-metadata";
import { effectiveStreamSize, streamCodec, streamHeight } from "./details";
import { defaultStreamRankingPolicy, type StreamRankingPolicy } from "./ranking-policy";

export interface StreamScoreComponents {
  availability: number;
  resolution: number;
  size: number;
  codec: number;
  metadata: number;
  transport: number;
}

function availabilityScore(seeds: number | undefined, policy: StreamRankingPolicy): number {
  seeds = validSeedCount(seeds);
  if (seeds === undefined) return policy.torrent.unknownSeeds;
  if (seeds === 0) return policy.torrent.zeroSeeds;
  // A logarithm makes the jump from 2 to 20 seeds matter far more than 80 to 150.
  return Math.min(policy.torrent.maxSeedScore, Math.log2(seeds + 1) * policy.torrent.seedScorePerDoubling);
}

function resolutionScore(height: number, policy: StreamRankingPolicy): number {
  if (height >= 2160) return policy.quality["2160p"];
  if (height >= 1440) return policy.quality["1440p"];
  if (height >= 1080) return policy.quality["1080p"];
  if (height >= 720) return policy.quality["720p"];
  if (height > 0) return policy.quality["480p"];
  return policy.quality.unknown;
}

function directSizeScore(sizeBytes: number | undefined, height: number): number {
  if (!sizeBytes || sizeBytes <= 0) return 0;
  const gib = sizeBytes / 1024 ** 3;
  // These are soft upper bounds for a stream that is practical to start promptly, not file-size limits.
  const comfortableMaximum = height >= 2160 ? 40 : height >= 1440 ? 28 : height >= 1080 ? 16 : height >= 720 ? 8 : 3;
  if (gib <= comfortableMaximum) return gib < comfortableMaximum / 8 ? 2 : 12;
  return Math.max(-60, 12 - Math.log2(gib / comfortableMaximum) * 32);
}

function torrentStreamabilityScore(sizeBytes: number | undefined): number {
  if (!sizeBytes || sizeBytes <= 0) return 0;
  const gib = sizeBytes / 1024 ** 3;
  // With no duration, file size is only a proxy for the rate needed during playback.
  // Keep 5-10 GiB practical and gradually demote sources beyond that range.
  return Math.max(-140, 12 - Math.max(0, gib - 10) * 9);
}

function codecScore(source: NormalizedStreamSource): number {
  switch (streamCodec(source)) {
    case "HEVC": return 8;
    case "H.264": return 7;
    case "AV1": return 6;
    default: return 0;
  }
}

function directAvailabilityScore(source: NormalizedStreamSource, policy: StreamRankingPolicy): number {
  switch (source.directHttp?.status ?? "unknown") {
    case "verified": return policy.direct.health.verified;
    case "reachable": return policy.direct.health.reachable;
    case "timeout": return policy.direct.health.timeout;
    case "unreachable": return policy.direct.health.unreachable;
    // Opting out of the probe preserves the previous neutral treatment of an
    // HTTP source with no availability data.
    default: return policy.direct.health.unknown;
  }
}

function directTransportScore(source: NormalizedStreamSource, policy: StreamRankingPolicy): number {
  if (source.type !== "http" && source.type !== "https") return 0;
  const probe = source.directHttp;
  if (!probe?.verified) return 0;
  const latency = probe.responseHeaderLatencyMs;
  const latencyScore = latency === undefined || !Number.isFinite(latency) || latency < 0 ? 0 : policy.direct.latencyMs.find(
    (band) => band.max === undefined || latency <= band.max
  )?.score ?? 0;
  return (probe.rangeSupported ? 15 : 0) + latencyScore + (source.type === "https" ? 3 : 0);
}

export function streamScoreComponents(
  source: NormalizedStreamSource, policy: StreamRankingPolicy = defaultStreamRankingPolicy
): StreamScoreComponents {
  const height = streamHeight(source);
  const sizeBytes = effectiveStreamSize(source);
  const direct = source.type === "http" || source.type === "https";
  return {
    availability: direct ? directAvailabilityScore(source, policy) : availabilityScore(source.seeds, policy),
    resolution: resolutionScore(height, policy),
    // Catalogs can offer HTTP and Tribler for the same file. Keep the existing
    // HTTP-first order when their availability is equally unknown.
    size: direct ? directSizeScore(sizeBytes, height)
      : Math.min(directSizeScore(sizeBytes, height), torrentStreamabilityScore(sizeBytes)),
    codec: codecScore(source),
    metadata: (recognizedStreamLanguage(source.language) ? 2 : 0) + (recognizedStreamAudio(source.audio) ? 1 : 0),
    transport: directTransportScore(source, policy)
  };
}

export function scoreStream(source: NormalizedStreamSource, policy: StreamRankingPolicy = defaultStreamRankingPolicy): number {
  const components = streamScoreComponents(source, policy);
  return components.availability + components.resolution + components.size + components.codec
    + components.metadata + components.transport;
}
