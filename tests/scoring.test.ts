import { describe, expect, it } from "vitest";
import { streamSummary } from "../src/streams/presentation";
import { scoreStream, streamScoreComponents } from "../src/streams/scoring";
import { loadStreamRankingPolicy } from "../src/streams/ranking-policy";
import type { NormalizedStreamSource } from "../src/streams/types";

const gib = 1024 ** 3;

function stream(overrides: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource {
  return { providerId: "test", type: "magnet", quality: "1080p", ...overrides };
}

describe("stream scoring", () => {
  // Hand-calculated from the versioned JSON and algorithm, never from a scorer.
  // Seeds: 20*log2(n+1); size: min(direct soft bound, 12-9*max(0, GiB-10)).
  it.each([
    { name: "verified HTTPS, 140ms", source: stream({ type: "https", sizeBytes: 5 * gib,
      codec: "HEVC", language: "en", audio: "en",
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 140 } }),
      components: { availability: 120, resolution: 42, size: 12, codec: 8, metadata: 3, transport: 43 }, total: 228 },
    { name: "31-seed torrent", source: stream({ seeds: 31, sizeBytes: 5 * gib, codec: "H.264" }),
      components: { availability: 100, resolution: 42, size: 12, codec: 7, metadata: 0, transport: 0 }, total: 161 },
    { name: "timeout HTTPS", source: stream({ type: "https", quality: "480p", sizeBytes: gib,
      directHttp: { status: "timeout", verified: false, rangeSupported: false } }),
      components: { availability: -30, resolution: 12, size: 12, codec: 0, metadata: 0, transport: 0 }, total: -6 },
    // 20*log2(3) = 31.69925001442312; 12-9*(12.5-10) = -10.5.
    { name: "fractional oversized two-seed torrent", source: stream({ seeds: 2, sizeBytes: 12.5 * gib }),
      components: { availability: 31.69925001442312, resolution: 42, size: -10.5, codec: 0, metadata: 0, transport: 0 },
      total: 63.19925001442312 }
  ])("independent numeric oracle: $name", ({ source, components, total }) => {
    const policy = loadStreamRankingPolicy();
    const actual = streamScoreComponents(source, policy);
    for (const key of Object.keys(components) as Array<keyof typeof components>) {
      expect(actual[key]).toBeCloseTo(components[key], 10);
    }
    expect(scoreStream(source, policy)).toBeCloseTo(total, 10);
  });

  it("strongly prefers healthy availability without making seeds linear", () => {
    const few = scoreStream(stream({ sizeBytes: 8 * gib, seeds: 5 }));
    const healthy = scoreStream(stream({ sizeBytes: 8 * gib, seeds: 100 }));
    expect(healthy).toBeGreaterThan(few);
    expect(streamScoreComponents(stream({ seeds: 0 })).availability).toBeLessThan(0);
    const earlyGain = streamScoreComponents(stream({ seeds: 20 })).availability
      - streamScoreComponents(stream({ seeds: 2 })).availability;
    const lateGain = streamScoreComponents(stream({ seeds: 150 })).availability
      - streamScoreComponents(stream({ seeds: 80 })).availability;
    expect(earlyGain).toBeGreaterThan(lateGain);
  });

  it("prefers a practical torrent over oversized releases even with many seeds or 4K", () => {
    const practical1080p = stream({ quality: "1080p", codec: "HEVC", sizeBytes: 5 * gib, seeds: 80 });
    const oversized1080p = stream({ quality: "1080p", sizeBytes: 20 * gib, seeds: 300 });
    const giant4k = stream({ quality: "2160p REMUX", sizeBytes: 70 * gib, seeds: 300 });
    expect(scoreStream(practical1080p)).toBeGreaterThan(scoreStream(oversized1080p));
    expect(scoreStream(practical1080p)).toBeGreaterThan(scoreStream(giant4k));
    expect(streamScoreComponents(stream()).size).toBe(0);
  });

  it("keeps codec differences small and extracts a known codec from a release title", () => {
    const hevc = stream({ title: "Movie.1080p.BluRay.x265", sizeBytes: 8 * gib, seeds: 20 });
    const h264 = stream({ codec: "H.264", sizeBytes: 8 * gib, seeds: 20 });
    const manySeedsH264 = stream({ codec: "H.264", sizeBytes: 8 * gib, seeds: 100 });
    expect(scoreStream(hevc)).toBeGreaterThanOrEqual(scoreStream(h264));
    expect(scoreStream(manySeedsH264)).toBeGreaterThan(scoreStream(hevc));
  });

  it("keeps incomplete metadata valid and formats a compact, degrading summary", () => {
    expect(() => scoreStream(stream())).not.toThrow();
    expect(streamSummary(stream({
      title: "Movie.1080p.x265", sizeBytes: Math.round(8.2 * gib), language: "es/en", seeds: 123
    }))).toBe("Tribler · 1080p · 8.2GiB · 123 seeds");
    expect(streamSummary(stream({ resolution: "1080p", sizeBytes: 0 }))).toBe("Tribler · 1080p");
  });

  it("keeps one global order for verified HTTPS and healthy episode torrents", () => {
    const verified1080 = stream({ type: "https", quality: "1080p", codec: "HEVC", sizeBytes: 5 * gib,
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 140 } });
    const verified720 = stream({ type: "https", quality: "720p", codec: "H.264", sizeBytes: 5 * gib,
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 140 } });
    const healthyTorrent = stream({ quality: "1080p", codec: "HEVC", sizeBytes: 5 * gib, seeds: 100 });
    const timeout1080 = stream({ ...verified1080,
      directHttp: { status: "timeout", verified: false, rangeSupported: false } });
    expect(scoreStream(verified1080)).toBeGreaterThan(scoreStream(healthyTorrent));
    expect(scoreStream(verified720)).toBeGreaterThan(scoreStream(healthyTorrent));
    expect(scoreStream(verified720)).toBeGreaterThan(scoreStream(timeout1080));
    expect(streamSummary(verified1080)).not.toContain("Range");
    expect(streamSummary(healthyTorrent)).toContain("100 seeds");
  });

  it("ranks a verified direct HTTPS source above a medium torrent and demotes an unhealthy one", () => {
    const direct = stream({ type: "https", url: "https://media.example/video.mp4", sizeBytes: 8 * gib,
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 140 } });
    const mediumTorrent = stream({ seeds: 20, sizeBytes: 8 * gib });
    const failedDirect = stream({ type: "https", url: "https://media.example/broken.mp4",
      directHttp: { status: "unreachable", verified: false, rangeSupported: false } });
    expect(scoreStream(direct)).toBeGreaterThan(scoreStream(mediumTorrent));
    expect(scoreStream(failedDirect)).toBeLessThan(scoreStream(mediumTorrent));
    expect(streamSummary(direct)).toBe("HTTPS✓ · 1080p · 8.0GiB · 0.1s");
  });
  it("keeps reachable HLS between scarce torrents and a healthy higher-seed torrent", () => {
    const hls = stream({ type: "https", url: "https://media.example/live/index.m3u8", sizeBytes: 5 * gib,
      directHttp: { status: "verified", verified: true, hls: true, rangeSupported: false, responseHeaderLatencyMs: 300 } });
    const oneSeed = stream({ sizeBytes: 5 * gib, seeds: 1 });
    const threeSeeds = stream({ sizeBytes: 5 * gib, seeds: 3 });
    const healthy = stream({ sizeBytes: 5 * gib, seeds: 200 });
    expect(scoreStream(hls)).toBeGreaterThan(scoreStream(oneSeed));
    expect(scoreStream(hls)).toBeGreaterThan(scoreStream(threeSeeds));
    expect(scoreStream(healthy)).toBeGreaterThan(scoreStream(hls));
  });

  it("keeps reachable HTTPS above weak torrents without equating it with verification", () => {
    const reachable = stream({ type: "https", url: "https://media.example/video.mp4", sizeBytes: 5 * gib,
      directHttp: { status: "reachable", verified: false, rangeSupported: false } });
    const oneSeed = stream({ sizeBytes: 5 * gib, seeds: 1 });
    const threeSeeds = stream({ sizeBytes: 5 * gib, seeds: 3 });
    expect(scoreStream(reachable)).toBeGreaterThan(scoreStream(oneSeed));
    expect(scoreStream(reachable)).toBeGreaterThan(scoreStream(threeSeeds));
    const reachable480 = stream({ ...reachable, quality: "480p", sizeBytes: gib });
    const weak1080 = stream({ seeds: 5, quality: "1080p", sizeBytes: 5 * gib });
    expect(scoreStream(reachable480)).toBeGreaterThan(scoreStream(weak1080));
    expect(scoreStream(stream({ ...reachable, directHttp: {
      status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 140
    } }))).toBeGreaterThan(scoreStream(reachable));
  });

  it("keeps two verified HTTPS choices above ten weak higher-resolution torrents", () => {
    const direct = (["720p", "480p"] as const).map((quality) => stream({
      type: "https", url: `https://media.example/${quality}.mp4`, quality, sizeBytes: 1024 ** 3,
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 180 }
    }));
    const weak = Array.from({ length: 10 }, (_, index) => stream({
      quality: "1080p", seeds: index % 5 + 1, sizeBytes: 5 * gib
    }));
    expect(Math.min(...direct.map((source) => scoreStream(source))))
      .toBeGreaterThan(Math.max(...weak.map((source) => scoreStream(source))));
  });

  it("penalizes uncertain direct playback while allowing strong torrents to beat it", () => {
    const verified = stream({ type: "https", quality: "480p", sizeBytes: gib,
      directHttp: { status: "verified", verified: true, rangeSupported: true, responseHeaderLatencyMs: 100 } });
    const timeout = stream({ ...verified,
      directHttp: { status: "timeout", verified: false, rangeSupported: false } });
    const strong = stream({ quality: "1080p", seeds: 100, sizeBytes: 5 * gib });
    expect(scoreStream(verified)).toBeGreaterThan(scoreStream(timeout));
    expect(scoreStream(strong)).toBeGreaterThan(scoreStream(timeout));
    expect(streamSummary(timeout)).toBe("HTTPS · 480p · 1.0GiB");
  });
});
