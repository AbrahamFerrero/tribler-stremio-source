import { effectiveStreamSize, streamHeight } from "./details";
import { getBridgeIdentityState } from "./resolver";
import type { NormalizedStreamSource } from "./types";
import type { StreamRankingPolicy } from "./ranking-policy";
import { scoreStream, streamScoreComponents } from "./scoring";

import { descriptionText, explicitLanguage, descriptionAudioMode, structuredAudioLanguage } from "./structured-metadata";

/** At most three closed labels (53 characters); no locators or metadata. */
export function safeStreamDescription(source: NormalizedStreamSource): string | undefined {
  const audio = descriptionText(source.audio);
  // A generic provider language field does not establish audiovisual language.
  // Retain it internally for ranking, but do not publish it as a media claim.
  const title = descriptionText(source.title);
  const components = title?.split(/[·|]/).map(part => part.trim()) ?? [];
  const audioClaims = new Set<string>();
  const structuredAudio = structuredAudioLanguage(audio);
  if (structuredAudio) audioClaims.add(structuredAudio);
  const subtitleClaims = new Set<string>();
  const modes = new Set<string>();
  const structuredMode = audio ? descriptionAudioMode(audio, true) : undefined;
  if (structuredMode) modes.add(structuredMode);
  // The entire presentation value must use the closed descriptor grammar.
  // Do not mine a label from a URL/query or an opaque release-name component.
  const isDescriptor = (part: string): boolean => Boolean(explicitLanguage(part, "audio")
    || explicitLanguage(part, "subtitles") || descriptionAudioMode(part));
  const titleParts = components.length <= 8 && components.every(isDescriptor) ? components : [];
  // Bound work and omit ambiguous/conflicting claims rather than guessing.
  for (const part of [...(audio ? [audio] : []), ...titleParts]) {
    const audioLanguage = explicitLanguage(part, "audio");
    const subtitleLanguage = explicitLanguage(part, "subtitles");
    if (audioLanguage) audioClaims.add(audioLanguage);
    if (subtitleLanguage) subtitleClaims.add(subtitleLanguage);
    const mode = descriptionAudioMode(part);
    if (mode) modes.add(mode);
  }
  const audioLanguage = audioClaims.size === 1 ? [...audioClaims][0] : undefined;
  const subtitleLanguage = subtitleClaims.size === 1 ? [...subtitleClaims][0] : undefined;
  const audioMode = modes.size === 1 ? [...modes][0] : undefined;
  const parts = [audioLanguage ? `${audioLanguage} audio` : undefined,
    audioLanguage?.includes("/") && audioMode === "Dual audio" ? undefined : audioMode,
    subtitleLanguage ? `${subtitleLanguage} subtitles` : undefined].filter(Boolean);
  const bounded: string[] = [];
  for (const part of parts) {
    if (part && bounded.length < 3 && [...bounded, part].join(" · ").length <= 53) bounded.push(part);
  }
  return bounded.length ? bounded.join(" · ") : undefined;
}

/** Two decimal places at most; normalize negative zero and omit trailing zeros. */
function scoreLabel(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Bridge-calculated detail only; policy must be the resolver's effective policy.
 * Each number is independently rounded to 0.01. The displayed component sum
 * differs from the displayed total by at most 0.035 points (six rounding errors
 * plus the total's). Ranking always uses the unrounded score.
 */
export function rankedStreamDescription(
  source: NormalizedStreamSource, position: number, policy: StreamRankingPolicy
): string | undefined {
  const languages = safeStreamDescription(source);
  const components = streamScoreComponents(source, policy);
  const total = scoreStream(source, policy);
  const detail = [
    ["Avail", components.availability], ["Res", components.resolution],
    ["Size", components.size], ["Codec", components.codec],
    ["Meta", components.metadata], ["Net", components.transport]
  ] satisfies Array<[string, number]>;
  if (!Number.isSafeInteger(position) || position < 1 || !Number.isFinite(total)
    || !detail.every(([, value]) => Number.isFinite(value))) return languages;
  const parts = detail.map(([label, value]) => {
    const number = scoreLabel(value);
    return `${label} ${Number(number) >= 0 ? "+" : ""}${number}`;
  }).join(" · ");
  const score = `#${position} · Score ${scoreLabel(total)}`;
  return languages ? `${languages}\n${score} · ${parts}` : `${score}\n${parts}`;
}

function sizeLabel(sizeBytes: number | undefined): string | undefined {
  if (sizeBytes === undefined) return undefined;
  if (sizeBytes >= 1024 ** 3) return `${(sizeBytes / 1024 ** 3).toFixed(1)}GiB`;
  if (sizeBytes >= 1024 ** 2) return `${Math.round(sizeBytes / 1024 ** 2)}MiB`;
  return undefined;
}

export function streamSummary(source: NormalizedStreamSource): string {
  const direct = source.type === "http" || source.type === "https";
  const probe = direct ? source.directHttp : undefined;
  const state = getBridgeIdentityState(source);
  const identity = state === "CORROBORATED" ? "ID✓" : state === "UNKNOWN" ? "ID?"
    : state === "SUSPICIOUS" ? "ID!" : undefined;
  const height = streamHeight(source);
  const parts = [
    direct ? source.type.toUpperCase() + (probe?.verified ? "✓" : "") : "Tribler",
    identity,
    height > 0 ? `${height}p` : undefined,
    sizeLabel(effectiveStreamSize(source)),
    probe?.responseHeaderLatencyMs !== undefined && Number.isFinite(probe.responseHeaderLatencyMs) && probe.responseHeaderLatencyMs >= 0
      ? `${(probe.responseHeaderLatencyMs / 1000).toFixed(1)}s` : undefined,
    direct || source.seeds === undefined || !Number.isSafeInteger(source.seeds) || source.seeds < 0
      ? undefined : `${source.seeds} ${source.seeds === 1 ? "seed" : "seeds"}`
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

/** Public routing hint only. Original locators/filenames stay in PlaybackManager. */
export function publicStreamFilename(source: NormalizedStreamSource): string {
  const probe = source.directHttp;
  if (probe?.hls) return "stream.m3u8";
  const types: Readonly<Record<string, string>> = {
    "video/mp4": "mp4", "video/x-matroska": "mkv", "video/webm": "webm",
    "video/quicktime": "mov", "video/mp2t": "ts", "application/vnd.apple.mpegurl": "m3u8",
    "application/x-mpegurl": "m3u8"
  };
  const type = probe?.contentType?.split(";")[0]?.trim().toLowerCase();
  if (type && Object.hasOwn(types, type)) return "stream." + types[type];
  let path: string | undefined;
  try { if (source.url) path = new URL(source.url).pathname; } catch { /* No public locator fallback. */ }
  const extension = /\.(mp4|m3u8|mkv|webm|mov|m4v|avi|ts)$/i.exec(path ?? source.filename ?? "")?.[1]?.toLowerCase();
  return extension ? "stream." + extension : "stream";
}
