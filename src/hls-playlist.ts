const MAX_PLAYLIST_BYTES = 512 * 1024;
const MAX_VOD_SEGMENTS = 4_096;
const MAX_VOD_SEGMENT_SECONDS = 3_600;
const MAX_VOD_SECONDS = 7 * 24 * 3_600;
// Dependency preflight is network work; a playlist with more distinct required
// init/key resources fails before any of them are requested.
const MAX_PREFLIGHT_DEPENDENCIES = 32;

export interface HlsPlaylistRewriteOptions {
  validateResource(url: string): Promise<void>;
  localResourceUrls(resources: readonly HlsPlaylistResource[]): string[];
}

export type HlsResourceKind = "segment" | "other";

export interface HlsPlaylistResource {
  url: string;
  kind: HlsResourceKind;
}

export interface HlsMediaReference {
  url: string;
  kind: "variant" | "segment";
}

export function isHlsContentType(contentType: string | undefined): boolean {
  return contentType === "application/vnd.apple.mpegurl"
    || contentType === "application/x-mpegurl"
    || contentType === "audio/mpegurl";
}

export function looksLikeHlsPlaylist(text: string): boolean {
  return text.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U");
}

function resolveResource(raw: string, parentUrl: string): string {
  let resolved: URL;
  try {
    resolved = new URL(raw, parentUrl);
  } catch {
    throw new Error("HLS playlist contains an invalid resource URL");
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error("HLS playlist resource scheme is not allowed");
  }
  if (resolved.username || resolved.password) throw new Error("HLS playlist resource credentials are not allowed");
  return resolved.toString();
}

async function collectResource(
  raw: string,
  parentUrl: string,
  options: HlsPlaylistRewriteOptions,
  kind: HlsResourceKind,
  resources: HlsPlaylistResource[]
): Promise<number> {
  const resolved = resolveResource(raw, parentUrl);
  await options.validateResource(resolved);
  resources.push({ url: resolved, kind });
  return resources.length - 1;
}

export interface HlsRequiredDependency {
  url: string;
  kind: "map" | "key";
}

async function rewriteTag(line: string, rewriteResource: (raw: string, kind: HlsResourceKind) => Promise<number>): Promise<Array<string | number>> {
  // RFC 8216 section 4.3.2.1: only the duration before the first comma is
  // functional. The optional title is text, never a resource attribute list.
  if (/^#EXTINF:/i.test(line.trim())) {
    const comma = line.indexOf(",");
    return [comma < 0 ? line : line.slice(0, comma + 1)];
  }
  if (!/\bURI\s*=/i.test(line)) return [line];
  const matches = quotedUriAttributes(line);
  if (matches.length === 0) throw new Error("HLS playlist contains a malformed URI attribute");
  const rewritten: Array<string | number> = [];
  let cursor = 0;
  for (const match of matches) {
    const raw = match[1];
    const index = match.index;
    if (raw === undefined || index === undefined || raw.length === 0) throw new Error("HLS playlist contains an empty resource URL");
    const quotedStart = line.indexOf('"', index);
    const quotedEnd = quotedStart < 0 ? -1 : line.indexOf('"', quotedStart + 1);
    if (quotedStart < 0 || quotedEnd < 0) throw new Error("HLS playlist contains a malformed URI attribute");
    rewritten.push(line.slice(cursor, quotedStart + 1));
    rewritten.push(await rewriteResource(raw, /^#EXT-X-PART:/i.test(line) ? "segment" : "other"));
    cursor = quotedEnd;
  }
  rewritten.push(line.slice(cursor));
  return rewritten;
}

function quotedUriAttributes(line: string): RegExpMatchArray[] {
  return [...line.matchAll(/\bURI\s*=\s*"([^"]*)"/gi)];
}

function bareResourceKind(line: string): HlsResourceKind | undefined {
  if (/^#EXTINF:/i.test(line)) return "segment";
  if (/^#EXT-X-STREAM-INF:/i.test(line) || /^#EXT-X-BYTERANGE:/i.test(line)) return "other";
  return undefined;
}

function tagExpectsBareUri(line: string): boolean {
  return bareResourceKind(line) !== undefined;
}

function isOrdinaryComment(line: string): boolean {
  // RFC 8216 section 4.1. Keep unknown #EXT tags, including the parser's
  // existing case-insensitive compatibility, because they may be functional.
  return line.startsWith("#") && !/^#EXT/i.test(line);
}

/**
 * Returns the variant or segment URLs which make a playlist playable. Key, map
 * and rendition references remain rewritten for playback but do not establish
 * that a playlist can deliver media.
 */
export function hlsMediaReferences(text: string, parentUrl: string): HlsMediaReference[] {
  if (!hasValidHlsStructure(text)) throw new Error("HLS playlist is invalid or too large");
  const references: HlsMediaReference[] = [];
  let expected: HlsMediaReference["kind"] | undefined;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isOrdinaryComment(trimmed)) continue;
    if (trimmed.startsWith("#")) {
      // EXT-X-BYTERANGE qualifies the pending media URI. It does not replace
      // the EXTINF declaration which established that URI as a segment.
      if (/^#EXT-X-BYTERANGE:/i.test(trimmed)) continue;
      expected = /^#EXT-X-STREAM-INF:/i.test(trimmed) ? "variant"
        : /^#EXTINF:/i.test(trimmed) ? "segment" : undefined;
      continue;
    }
    if (!expected) throw new Error("HLS playlist contains an unexpected resource URL");
    references.push({ url: resolveResource(trimmed, parentUrl), kind: expected });
    expected = undefined;
  }
  return references;
}

export function hasValidHlsStructure(text: string): boolean {
  if (Buffer.byteLength(text, "utf8") > MAX_PLAYLIST_BYTES || !looksLikeHlsPlaylist(text)) return false;
  let expectsUri = false;
  let resources = 0;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isOrdinaryComment(trimmed)) continue;
    if (trimmed.startsWith("#")) {
      if (/^#EXTINF:/i.test(trimmed)) { expectsUri = true; continue; }
      if (/\bURI\s*=/i.test(trimmed) && !/\bURI\s*=\s*"[^"]+"/i.test(trimmed)) return false;
      if (/\bURI\s*=\s*"[^"]+"/i.test(trimmed)) resources += [...trimmed.matchAll(/\bURI\s*=\s*"[^"]+"/gi)].length;
      expectsUri = tagExpectsBareUri(trimmed);
      continue;
    }
    if (!expectsUri) return false;
    resources += 1;
    expectsUri = false;
  }
  return !expectsUri && resources > 0;
}

/**
 * Rewrites recognized resource references to opaque local URLs and removes
 * ordinary comments and optional EXTINF titles. Other tag text is preserved;
 * this is not a general metadata sanitizer. The caller owns token lifetime.
 */
export async function rewriteHlsPlaylist(
  text: string,
  parentUrl: string,
  options: HlsPlaylistRewriteOptions
): Promise<string> {
  if (!hasValidHlsStructure(text)) {
    throw new Error("HLS playlist is invalid or too large");
  }
  hlsRequiredDependencies(text, parentUrl);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const resources: HlsPlaylistResource[] = [];
  const rewritten: Array<Array<string | number>> = [];
  const rewriteResource = async (raw: string, kind: HlsResourceKind): Promise<number> =>
    collectResource(raw, parentUrl, options, kind, resources);
  let expectedKind: HlsResourceKind | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isOrdinaryComment(trimmed)) continue;
    if (!trimmed) {
      rewritten.push([line]);
    } else if (trimmed.startsWith("#")) {
      rewritten.push(await rewriteTag(line, rewriteResource));
      // EXT-X-BYTERANGE applies to the already pending EXTINF segment.
      // Preserve that segment identity so playback registers it as media.
      if (!/^#EXT-X-BYTERANGE:/i.test(trimmed)) {
        expectedKind = bareResourceKind(trimmed);
      }
    } else {
      if (!expectedKind) throw new Error("HLS playlist contains an unexpected resource URL");
      rewritten.push([await rewriteResource(trimmed, expectedKind)]);
      expectedKind = undefined;
    }
  }
  const localUrls = options.localResourceUrls(resources);
  if (localUrls.length !== resources.length) throw new Error("HLS resource registration failed");
  return rewritten.map((parts) => parts.map((part) => typeof part === "number" ? localUrls[part] : part).join("")).join("\n");
}

/** All distinct required init and encryption resources on the selected media path. */
export function hlsRequiredDependencies(text: string, parentUrl: string): HlsRequiredDependency[] {
  if (!hasValidHlsStructure(text)) throw new Error("HLS playlist is invalid or too large");
  const dependencies: HlsRequiredDependency[] = [];
  const seen = new Set<string>();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const isMap = /^#EXT-X-MAP:/i.test(trimmed);
    const isKey = /^#EXT-X-(?:KEY|SESSION-KEY):/i.test(trimmed);
    if (!isMap && !isKey) continue;
    if (isKey) {
      const method = /(?:^|,)\s*METHOD\s*=\s*([A-Za-z0-9-]+)/i.exec(trimmed.slice(trimmed.indexOf(":") + 1))?.[1];
      if (!method) throw new Error("HLS key method is invalid");
      if (method.toUpperCase() === "NONE") {
        if (/^#EXT-X-SESSION-KEY:/i.test(trimmed) || /\bURI\s*=/i.test(trimmed)) {
          throw new Error("HLS NONE key has an invalid URI or session method");
        }
        continue;
      }
    }
    const attributes = quotedUriAttributes(trimmed);
    if (attributes.length !== 1 || !attributes[0]?.[1]) throw new Error("HLS required dependency URL is invalid");
    const kind = isMap ? "map" : "key";
    const url = resolveResource(attributes[0][1], parentUrl);
    const identity = `${kind}:${url}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    dependencies.push({ url, kind });
    if (dependencies.length > MAX_PREFLIGHT_DEPENDENCIES) {
      throw new Error("HLS playlist has too many required dependencies");
    }
  }
  return dependencies;
}

/** URL-bearing audio renditions required by the first selected master variant. */
export function hlsSelectedAudioRenditions(text: string, parentUrl: string): string[] {
  if (!hasValidHlsStructure(text)) throw new Error("HLS playlist is invalid or too large");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
  const selected = lines.find((line) => /^#EXT-X-STREAM-INF:/i.test(line));
  const group = selected ? /[:,]\s*AUDIO\s*=\s*"([^"]+)"/i.exec(selected)?.[1] : undefined;
  if (!group) return [];
  const urls = new Set<string>();
  for (const line of lines) {
    if (!/^#EXT-X-MEDIA:/i.test(line) || !/[:,]\s*TYPE\s*=\s*AUDIO(?:,|$)/i.test(line)) continue;
    const id = /[:,]\s*GROUP-ID\s*=\s*"([^"]+)"/i.exec(line)?.[1];
    if (id !== group) continue;
    const uri = quotedUriAttributes(line)[0]?.[1];
    if (!uri) continue; // An in-stream rendition has no separate resource.
    urls.add(resolveResource(uri, parentUrl));
    if (urls.size > MAX_PREFLIGHT_DEPENDENCIES) throw new Error("HLS has too many selected audio renditions");
  }
  return [...urls];
}

/** Duration stated by a complete, immutable HLS VOD media playlist. */
export function hlsVodDurationSeconds(text: string): number | undefined {
  if (!hasValidHlsStructure(text)) return undefined;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.at(-1) !== "#EXT-X-ENDLIST"
    || lines.filter((line) => line === "#EXT-X-ENDLIST").length !== 1
    || lines.filter((line) => line === "#EXT-X-PLAYLIST-TYPE:VOD").length !== 1) return undefined;
  let pending: number | undefined;
  let total = 0;
  let segments = 0;
  for (const line of lines) {
    if (/^#EXT-X-(?:STREAM-INF|I-FRAMES-ONLY|PART|PRELOAD-HINT|GAP|SKIP)(?::|$)/.test(line)) return undefined;
    if (line.startsWith("#EXTINF:")) {
      if (pending !== undefined) return undefined;
      const match = /^#EXTINF:(\d{1,4}(?:\.\d{1,6})?),[^\r\n]*$/.exec(line);
      const seconds = match ? Number(match[1]) : NaN;
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_VOD_SEGMENT_SECONDS) return undefined;
      pending = seconds;
    } else if (!line.startsWith("#")) {
      if (pending === undefined) return undefined;
      total += pending;
      segments += 1;
      if (segments > MAX_VOD_SEGMENTS || total > MAX_VOD_SECONDS) return undefined;
      pending = undefined;
    }
  }
  return segments > 0 && pending === undefined ? total : undefined;
}

export async function readHlsPlaylist(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
  expectedLength?: number
): Promise<string> {
  if (!body) throw new Error("HLS playlist has no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("HLS playlist request aborted");
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > MAX_PLAYLIST_BYTES) throw new Error("HLS playlist is too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  if (expectedLength !== undefined && total !== expectedLength) throw new Error("HLS playlist body length mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!hasValidHlsStructure(text)) throw new Error("HLS playlist is invalid");
  return text;
}
