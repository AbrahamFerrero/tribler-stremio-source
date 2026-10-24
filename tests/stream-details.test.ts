import { describe, expect, it } from "vitest";
import { streamCodec, streamHeight, streamResolutionLabel } from "../src/streams/details";
import { normalizeStreamSource } from "../src/streams/normalization";
import { rankedStreamDescription, safeStreamDescription, streamSummary } from "../src/streams/presentation";
import { defaultStreamRankingPolicy, parseStreamRankingPolicy } from "../src/streams/ranking-policy";
import { scoreStream, streamScoreComponents } from "../src/streams/scoring";
import type { NormalizedStreamSource } from "../src/streams/types";

function stream(fields: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource {
  return { providerId: "synthetic", type: "magnet", ...fields };
}

describe("field-local resolution and codec claims", () => {
  it.each([
    [{ resolution: "1080p", filename: "Synthetic.4K.mp4" }, 1080],
    [{ quality: "720p", filename: "Synthetic.1080p.mp4" }, 720],
    [{ resolution: "1920x1080" }, 1080],
    [{ resolution: "3840x2160" }, 2160],
    [{ resolution: "4096X2160" }, 2160],
    [{ resolution: "2560 × 1440" }, 1440],
    [{ resolution: "1280 x 720" }, 720],
    [{ resolution: "unrecognized", quality: "unknown", filename: "Synthetic.576p.mp4", title: "4K" }, 576],
    [{ filename: "opaque.mp4", title: "Synthetic 480p" }, 480],
    [{ codec: "1080p" }, 0],
    [{ resolution: "1080p / 4K", quality: "720p" }, 0],
    [{ filename: "Synthetic.720p.1080p.mp4", title: "4K" }, 0],
    [{ resolution: "1920x1080 720p" }, 0],
    [{ resolution: "3840x2160 UHD 4K 2160p" }, 2160],
    [{ title: "Synthetic 2026 1080 720 2160 240" }, 0],
    [{ title: "Synthetic 8192x1080 999x720 1920x999 2026x2160" }, 0],
    [{ title: "Synthetic A1080p 1080pixels 4kids UHDream" }, 0],
    [{ resolution: "1080" }, 1080],
    [{ quality: "720" }, 720],
    [{ resolution: "unknown", title: "opaque" }, 0]
  ] satisfies Array<[Partial<NormalizedStreamSource>, number]>)("resolution %j -> %s", (fields, height) => {
    expect(streamHeight(stream(fields))).toBe(height);
    expect(streamResolutionLabel(stream(fields))).toBe(height === 2160 ? "4K" : height ? `${height}p` : undefined);
  });

  it.each([
    [{ codec: "H.264", filename: "Synthetic.AV1.mp4" }, "H.264"],
    [{ filename: "Synthetic.x265.mp4" }, "HEVC"],
    [{ codec: "unknown", filename: "Synthetic.x264.mp4", title: "AV1" }, "H.264"],
    [{ title: "Synthetic.HEVC", quality: "AV1" }, "HEVC"],
    [{ quality: "720p H.264" }, "H.264"],
    [{ resolution: "1080p x265" }, "HEVC"],
    [{ codec: "H.264 AV1", filename: "Synthetic.x265.mp4" }, undefined],
    [{ filename: "Synthetic.x264.x265.mp4", title: "AV1" }, undefined],
    [{ codec: "HEVC H.265 x265" }, "HEVC"],
    [{ codec: "opaque", title: "Synthetic 2026" }, undefined]
  ] satisfies Array<[Partial<NormalizedStreamSource>, string | undefined]>)("codec %j -> %s", (fields, codec) => {
    expect(streamCodec(stream(fields))).toBe(codec);
  });

  it.each(["2160p", "4K", "UHD", "1440p", "1080p", "720p", "576p", "480p", "360p", "240p"])(
    "preserves unambiguous %s resolution and policy points", label => {
      const height = /4K|UHD/.test(label) ? 2160 : Number.parseInt(label);
      const source = stream({ title: `Synthetic.${label}.x265` });
      expect(streamHeight(source)).toBe(height);
      expect(streamCodec(source)).toBe("HEVC");
      const points = height >= 2160 ? 65 : height >= 1440 ? 52 : height >= 1080 ? 42 : height >= 720 ? 25 : 12;
      expect(streamScoreComponents(source).resolution).toBe(points);
      expect(scoreStream(source)).toBe(-12 + points + 8);
    });

  it.each(["HEVC", "H.265", "h 265", "x265", "H.264", "AVC", "x264", "AV1"])(
    "preserves unambiguous %s codec points", codec => {
      const points = /265|HEVC/i.test(codec) ? 8 : codec === "AV1" ? 6 : 7;
      expect(streamScoreComponents(stream({ codec })).codec).toBe(points);
    });

  it("uses unknown policy points for absent or ambiguous claims", () => {
    for (const fields of [{}, { resolution: "opaque", codec: "opaque" }, { resolution: "720p 4K", codec: "AV1 AVC" }]) {
      expect(streamScoreComponents(stream(fields))).toMatchObject({ resolution: 0, codec: 0 });
      expect(scoreStream(stream(fields))).toBe(-12);
    }
  });

  it.each(["http", "https", "hls", "magnet", "torrent"] as const)(
    "shares normalized %s claims, public literals and effective F policy", transport => {
      const type = transport === "hls" ? "https" : transport;
      const source = normalizeStreamSource({ type,
        url: `${type === "http" ? "http" : "https"}://media.example/opaque.${transport === "hls" ? "m3u8" : type === "torrent" ? "torrent" : "mp4"}`,
        magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
        resolution: "1920x1080", quality: "720p", codec: "H.264",
        filename: "PRIVATE_SENTINEL.4K.AV1.mp4", title: "PRIVATE_SENTINEL 4K AV1"
      }, "synthetic")!;
      if (transport === "hls") source.directHttp = { status: "verified", verified: true, rangeSupported: false, hls: true };
      expect(streamHeight(source)).toBe(1080);
      expect(streamCodec(source)).toBe("H.264");
      const custom = structuredClone(defaultStreamRankingPolicy);
      custom.quality["1080p"] = 45;
      for (const policy of [defaultStreamRankingPolicy, parseStreamRankingPolicy(custom)]) {
        const points = policy === defaultStreamRankingPolicy ? 42 : 45;
        const availability = transport === "hls" ? 120 : -12;
        const net = transport === "hls" ? 3 : 0;
        expect(streamScoreComponents(source, policy)).toEqual({ availability, resolution: points,
          size: 0, codec: 7, metadata: 0, transport: net });
        expect(scoreStream(source, policy)).toBe(availability + points + 7 + net);
        const detail = rankedStreamDescription(source, 1, policy)!;
        expect(detail).toContain(`Score ${availability + points + 7 + net}`);
        expect(detail).toContain(`Res +${points}`);
        expect(detail).toContain("Codec +7");
        expect(detail).not.toMatch(/PRIVATE_SENTINEL|AV1|H\.264|4K/);
      }
      expect(streamSummary(source)).toContain("1080p");
      expect(streamSummary(source)).not.toMatch(/PRIVATE_SENTINEL|AV1|H\.264|4K/);
      expect(safeStreamDescription(source)).toBeUndefined();
    });
});
