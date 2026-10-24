import { sanitizeSourceRequestHeaders } from "../network/http-privacy";
import { extractInfohash, normalizeTorrentSource } from "../source";
import { basename } from "node:path";
import { isDangerousFile, isVideoFile } from "../video-selection";
import { normalizeCandidateIdentity } from "./identity-qualification";
import type { NormalizedStreamSource } from "./types";
import { validSeedCount } from "./seed-count";
import { descriptionText, recognizedStreamAudio, recognizedStreamLanguage } from "./structured-metadata";

function text(value: unknown, length = 500): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, length) : undefined;
}

function structuredMetadata(value: unknown, length: number, recognized: (value: string) => boolean): string | undefined {
  // Check the complete original before trim or truncation can repair an invalid claim.
  if (typeof value !== "string" || !descriptionText(value)) return undefined;
  const trimmed = value.trim();
  // Valid claims may contain permitted ASCII spaces beyond the old truncation limit.
  // Keep safe short opaque/subtitle values, but never recognize only a truncated prefix.
  return recognized(value) || trimmed.length <= length ? trimmed : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

function fileEvidence(name: string): { index: number; name: string; size: number; included: boolean; progress: number } {
  return { index: 0, name, size: 0, included: true, progress: 0 };
}

function pathnameBasename(url: string): string {
  const pathname = new URL(url).pathname;
  try {
    return basename(decodeURIComponent(pathname));
  } catch {
    return basename(pathname);
  }
}

/**
 * A filename or URL path is only a structural hint. Opaque direct URLs are
 * admitted later by StreamResolver after DirectStreamProbe identifies video
 * media; dangerous names have already been rejected here.
 */
export function hasKnownDirectVideoName(source: NormalizedStreamSource): boolean {
  if ((source.type !== "http" && source.type !== "https") || !source.url) return false;
  const names = [source.filename, pathnameBasename(source.url)].filter((name): name is string => Boolean(name));
  return names.some((name) => isVideoFile(fileEvidence(name)));
}

export function normalizeStreamSource(value: unknown, providerId: string): NormalizedStreamSource | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (type !== "magnet" && type !== "torrent" && type !== "http" && type !== "https") return undefined;
  const url = text(raw.url, 8_192);
  const magnet = text(raw.magnet, 16_384);
  if ((type === "http" || type === "https") && !url) return undefined;
  if (type === "magnet" && !magnet) return undefined;
  if (type === "torrent" && !url) return undefined;
  if (url) {
    try {
      const protocol = new URL(url).protocol;
      if ((type === "http" && protocol !== "http:") || (type === "https" && protocol !== "https:")) return undefined;
    } catch {
      return undefined;
    }
  }
  let infoHash = text(raw.infoHash, 128);
  try {
    if (type === "magnet" && magnet) {
      normalizeTorrentSource(magnet);
      infoHash = extractInfohash(magnet) ?? infoHash;
    }
    if (type === "torrent" && url) normalizeTorrentSource(url);
  } catch {
    return undefined;
  }
  const title = text(raw.title);
  const filename = text(raw.filename, 1_024);
  if (filename && (hasControlCharacters(filename)
    || isDangerousFile(fileEvidence(filename)))) return undefined;
  if ((type === "http" || type === "https") && url) {
    // An executable-looking URL is never eligible for a MIME probe. A missing
    // extension is not dangerous, merely unproven.
    if (isDangerousFile(fileEvidence(pathnameBasename(url)))) return undefined;
  }
  const quality = text(raw.quality, 80);
  const resolution = text(raw.resolution, 80);
  const codec = text(raw.codec, 80);
  const audio = structuredMetadata(raw.audio, 120, recognizedStreamAudio);
  const language = structuredMetadata(raw.language, 80, recognizedStreamLanguage);
  const sizeBytes = number(raw.sizeBytes);
  const seeds = validSeedCount(raw.seeds);
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata as Record<string, unknown> : undefined;
  const identity = normalizeCandidateIdentity(metadata?.identity);
  const requestHeaders = (type === "http" || type === "https")
    ? sanitizeSourceRequestHeaders(raw.requestHeaders) : undefined;
  return {
    providerId,
    type,
    ...(url ? { url } : {}),
    ...(magnet ? { magnet } : {}),
    ...(infoHash ? { infoHash } : {}),
    ...(title ? { title } : {}),
    ...(filename ? { filename } : {}),
    ...(quality ? { quality } : {}),
    ...(resolution ? { resolution } : {}),
    ...(codec ? { codec } : {}),
    ...(audio ? { audio } : {}),
    ...(language ? { language } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(seeds !== undefined ? { seeds } : {}),
    ...(identity ? { metadata: { identity } } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(Number.isSafeInteger(raw.fileIndex) && Number(raw.fileIndex) >= 0 ? { fileIndex: Number(raw.fileIndex) } : {})
  };
}
