import type { NormalizedStreamSource } from "./types";

export type VideoCodec = "HEVC" | "H.264" | "AV1";

/**
 * Positive safe integer bytes only. A valid provider declaration takes precedence,
 * including for HLS and when it contradicts an observation; neither is rewritten.
 * Tribler uses declarations only. HTTP fallback requires probe-owned evidence,
 * which normalization never accepts from providers. This is not file integrity.
 */
export function effectiveStreamSize(source: NormalizedStreamSource): number | undefined {
  const valid = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value > 0;
  if (valid(source.sizeBytes)) return source.sizeBytes;
  if (source.type !== "http" && source.type !== "https") return undefined;
  const probe = source.directHttp;
  return probe?.status === "verified" && probe.verified && probe.rangeSupported
    && probe.responseStatus === 206 && probe.sizeEvidence === "initial_range_206"
    && !probe.hls && !probe.archiveFormat && !probe.documentFormat && valid(probe.observedSizeBytes)
    ? probe.observedSizeBytes : undefined;
}

/** No recognized claim permits fallback; conflicting claims stop it as unknown.
 * Repeated aliases for the same value are compatible. These are unverified
 * provider claims, never audiovisual observations or independent identity.
 */
function fieldClaim<T>(claims: Set<T>): T | null | undefined {
  return claims.size > 1 ? null : claims.values().next().value;
}

function resolutionClaim(value: string | undefined, explicit: boolean): number | null | undefined {
  if (!value) return undefined;
  const claims = new Set<number>();
  // Bare supported heights are legacy structured values only, not release text.
  if (explicit && /^(2160|1440|1080|720|576|480|360|240)$/.test(value.trim())) {
    claims.add(Number(value.trim()));
  }
  for (const match of value.matchAll(/(?<![a-z0-9])(?:(2160|1440|1080|720|576|480|360|240)p|4k|uhd)(?![a-z0-9])/gi)) {
    claims.add(match[1] ? Number(match[1]) : 2160);
  }
  // Closed dimension pairs; no arbitrary heights, years or aspect-ratio guesses.
  for (const match of value.matchAll(/(?<![a-z0-9])(?:3840\s*[x×]\s*(2160)|4096\s*[x×]\s*(2160)|2560\s*[x×]\s*(1440)|1920\s*[x×]\s*(1080)|1280\s*[x×]\s*(720))(?![a-z0-9])/gi)) {
    claims.add(Number(match.slice(1).find(part => part !== undefined)));
  }
  return fieldClaim(claims);
}

export function streamHeight(source: NormalizedStreamSource): number {
  for (const field of ["resolution", "quality", "filename", "title"] as const) {
    const claim = resolutionClaim(source[field], field === "resolution" || field === "quality");
    if (claim !== undefined) return claim ?? 0;
  }
  return 0;
}

export function streamResolutionLabel(source: NormalizedStreamSource): string | undefined {
  const height = streamHeight(source);
  if (height === 2160) return "4K";
  return height > 0 ? `${height}p` : undefined;
}

export function streamCodec(source: NormalizedStreamSource): VideoCodec | undefined {
  // Legacy combined labels (e.g. quality="720p H.264") remain last-resort
  // inputs, after codec and release fields. Never mine resolution from codec.
  for (const value of [source.codec, source.filename, source.title, source.quality, source.resolution]) {
    if (!value) continue;
    const claims = new Set<VideoCodec>();
    if (/\bav1\b/i.test(value)) claims.add("AV1");
    if (/\b(?:hevc|h[ .]?265|x265)\b/i.test(value)) claims.add("HEVC");
    if (/\b(?:avc|h[ .]?264|x264)\b/i.test(value)) claims.add("H.264");
    const claim = fieldClaim(claims);
    if (claim !== undefined) return claim ?? undefined;
  }
  return undefined;
}
