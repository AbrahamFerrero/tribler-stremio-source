import type { NormalizedStreamSource } from "./types";

export type VideoCodec = "HEVC" | "H.264" | "AV1";

function searchable(source: NormalizedStreamSource): string {
  return [source.resolution, source.quality, source.codec, source.filename, source.title]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function streamHeight(source: NormalizedStreamSource): number {
  const value = searchable(source);
  if (/\b(?:2160p?|4k|uhd)\b/i.test(value)) return 2160;
  const match = /\b(1440|1080|720|576|480|360|240)p?\b/i.exec(value);
  return match ? Number(match[1]) : 0;
}

export function streamResolutionLabel(source: NormalizedStreamSource): string | undefined {
  const height = streamHeight(source);
  if (height === 2160) return "4K";
  return height > 0 ? `${height}p` : undefined;
}

export function streamCodec(source: NormalizedStreamSource): VideoCodec | undefined {
  const value = searchable(source);
  if (/\bav1\b/i.test(value)) return "AV1";
  if (/\b(?:hevc|h[ .]?265|x265)\b/i.test(value)) return "HEVC";
  if (/\b(?:avc|h[ .]?264|x264)\b/i.test(value)) return "H.264";
  return undefined;
}
