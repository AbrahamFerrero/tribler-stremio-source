import { streamHeight } from "./details";
import { getBridgeIdentityState } from "./resolver";
import type { NormalizedStreamSource } from "./types";

// Values are presentation literals, never provider substrings. Language claims
// describe upstream labels; they do not verify the media's tracks.
const languages: Readonly<Record<string, string>> = {
  en: "English", eng: "English", english: "English",
  es: "Spanish", spa: "Spanish", spanish: "Spanish",
  fr: "French", fra: "French", french: "French",
  de: "German", deu: "German", german: "German",
  it: "Italian", ita: "Italian", italian: "Italian",
  pt: "Portuguese", por: "Portuguese", portuguese: "Portuguese",
  ja: "Japanese", jpn: "Japanese", japanese: "Japanese",
  ko: "Korean", kor: "Korean", korean: "Korean",
  zh: "Chinese", zho: "Chinese", chinese: "Chinese",
  ru: "Russian", rus: "Russian", russian: "Russian",
  hi: "Hindi", hin: "Hindi", hindi: "Hindi",
  hu: "Hungarian", hun: "Hungarian", hungarian: "Hungarian"
};

function descriptionText(value: string | undefined): string | undefined {
  // Fail closed on oversized fields, markup and controls, including newlines.
  if (!value || value.length > 500 || /[\p{Cc}\p{Cf}<>]/u.test(value)
    || /[^\x20-\x7e·]/u.test(value)) return undefined;
  return value.trim().toLowerCase();
}

function descriptionLanguage(value: string | undefined): string | undefined {
  return value && Object.hasOwn(languages, value) ? languages[value] : undefined;
}

function explicitLanguage(value: string, kind: "audio" | "subtitles"): string | undefined {
  const label = kind === "subtitles" ? "(?:subtitles|subs)" : kind;
  const match = new RegExp(`^(?:${label}: ([a-z]+)|([a-z]+) ${label})$`).exec(value);
  return descriptionLanguage(match?.[1] ?? match?.[2]);
}

function descriptionAudioMode(value: string, allowBare = false): string | undefined {
  const match = /^(dual|multi)(?: +audio)?$/.exec(value);
  if (!match || (!allowBare && value === match[1])) return undefined;
  return match[1] === "dual" ? "Dual audio" : "Multi audio";
}

/** Only the dedicated audio field accepts a whole pair of distinct known codes. */
function structuredAudioLanguage(value: string | undefined): string | undefined {
  const single = descriptionLanguage(value);
  if (single || !value) return single;
  const match = /^([a-z]{2,3}) *[/+,] *([a-z]{2,3})$/.exec(value);
  const first = descriptionLanguage(match?.[1]);
  const second = descriptionLanguage(match?.[2]);
  return first && second && first !== second ? `${first}/${second}` : undefined;
}

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

function sizeLabel(sizeBytes: number | undefined): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes) || sizeBytes > Number.MAX_SAFE_INTEGER || sizeBytes <= 0) return undefined;
  if (sizeBytes >= 1024 ** 3) return `${(sizeBytes / 1024 ** 3).toFixed(1)}GB`;
  if (sizeBytes >= 1024 ** 2) return `${Math.round(sizeBytes / 1024 ** 2)}MB`;
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
    sizeLabel(source.sizeBytes ?? probe?.observedSizeBytes),
    probe?.firstByteLatencyMs !== undefined && Number.isFinite(probe.firstByteLatencyMs) && probe.firstByteLatencyMs >= 0
      ? `${(probe.firstByteLatencyMs / 1000).toFixed(1)}s` : undefined,
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
