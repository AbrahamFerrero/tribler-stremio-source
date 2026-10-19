import { basename } from "node:path";
import { createHash } from "node:crypto";
import { isVideoFile } from "../video-selection";
import type { BridgeIdentityState, EpisodeResourceObservation, MovieResourceObservation, NormalizedMediaItem, NormalizedStreamSource, ResourceIdentity } from "./types";

type CandidateIdentity = Pick<NormalizedMediaItem, "kind" | "title" | "year" | "season" | "episode" | "externalIds">;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maximum
    && ![...value].some((character) => character.charCodeAt(0) < 32)
    ? value.trim() : undefined;
}

function integer(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : undefined;
}

/** Only this explicit, bounded metadata shape is treated as content identity. */
export function normalizeCandidateIdentity(value: unknown): Partial<CandidateIdentity> | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const statedKind = raw.kind ?? raw.type;
  const kind = statedKind === "movie" || statedKind === "series" || statedKind === "episode" ? statedKind : undefined;
  const title = text(raw.title, 300);
  const year = integer(raw.year, 9999) || undefined;
  const season = integer(raw.season, 100_000);
  const episode = integer(raw.episode, 100_000);
  const ids = record(raw.externalIds);
  const externalIds = ids ? Object.fromEntries(Object.entries(ids).slice(0, 20).flatMap(([namespace, value]) => {
    const id = text(value, 256);
    return /^[A-Za-z0-9_-]{1,40}$/.test(namespace) && id ? [[namespace, id]] : [];
  })) as Record<string, string> : undefined;
  if (!kind && !title && year === undefined && season === undefined && episode === undefined
    && !Object.keys(externalIds ?? {}).length) return undefined;
  return {
    ...(kind ? { kind } : {}), ...(title ? { title } : {}), ...(year !== undefined ? { year } : {}),
    ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}),
    ...(externalIds && Object.keys(externalIds).length ? { externalIds } : {})
  };
}

function explicitReleaseTitle(value: string | undefined): Pick<CandidateIdentity, "title" | "year"> | undefined {
  // Only a label beginning with an explicit Title (YYYY) states identity.
  // The suffix may be release metadata, but arbitrary labels lack this prefix.
  const match = value && /^(.{1,300}?)\s+\((\d{4})\)(?:$|(?:\s+|[·-]\s*)\S[\s\S]*)/.exec(value.trim());
  return match ? { title: match[1]!, year: Number(match[2]) } : undefined;
}

function isResourceName(name: string): boolean {
  return name.length > 0 && name.length <= 1024
    && ![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && !/[/\\:?#=&]/.test(name)
    && (isVideoFile({ index: 0, name, size: 0, included: true, progress: 0 }) || /\.m3u8$/i.test(name));
}

/** Decode only the final URL component. Kept transient; never copy it to diagnostics or a source filename. */
export function mediaResourceBasename(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    const component = url.pathname.split("/").at(-1) ?? "";
    if (component.length > 3072) return undefined;
    const name = decodeURIComponent(component);
    return isResourceName(name) ? name : undefined;
  } catch { return undefined; }
}

export function videoReleaseNames(source: NormalizedStreamSource): string[] {
  const names: string[] = [];
  if (source.filename && source.filename.length <= 1024 && isResourceName(basename(source.filename))) {
    names.push(basename(source.filename));
  }
  for (const line of source.title?.split(/\r?\n/) ?? []) {
    // Only a whitespace-free filename token in a label counts; preceding prose cannot donate a year.
    for (const token of line.matchAll(/(?:^|\s)([^\s]+?\.[A-Za-z0-9]{2,5})(?=$|[\s\]])/g)) {
      const name = basename(token[1]!);
      if (!token[1]!.includes(":") && isResourceName(name)) names.push(name);
    }
  }
  return names;
}

function videoFilenameYear(names: string[]): number | undefined {
  const years = new Set<number>();
  for (const name of names) {
    for (const match of name.matchAll(/(?:^|[._ -])((?:19|20)\d{2})(?=$|[._ -])/g)) {
      years.add(Number(match[1]));
    }
  }
  return years.size === 1 ? [...years][0] : undefined;
}

/** Release markers only. Bare Ep forms do not guess a season or borrow a later date as a series year. */
function resourceIdentity(names: string[]): ResourceIdentity | undefined {
  const episodes = new Set<number>();
  const seasons = new Set<number>();
  const prefixes: string[] = [];
  for (const name of names) {
    let firstMarker: number | undefined;
    for (const match of name.matchAll(/(?:^|[._ -])(?:S(\d{1,2})[._ -]?E(\d{1,2})|Ep(?:isode)?[._-]?(\d{1,3}))(?=$|[._ -])/gi)) {
      const season = match[1] === undefined ? undefined : Number(match[1]);
      const episode = Number(match[2] ?? match[3]);
      if (episode > 0 && (season === undefined || season > 0)) {
        episodes.add(episode);
        if (season !== undefined) seasons.add(season);
        firstMarker ??= match.index;
      }
    }
    if (firstMarker !== undefined) prefixes.push(name.slice(0, firstMarker));
  }
  if (episodes.size > 1 || seasons.size > 1) return undefined;
  const episode = episodes.size === 1 ? [...episodes][0] : undefined;
  const year = videoFilenameYear(episode !== undefined ? prefixes : names);
  if (episode === undefined) return year === undefined ? undefined : { year };
  const season = seasons.size === 1 ? [...seasons][0] : undefined;
  return { kind: "episode", episode, ...(season !== undefined ? { season } : {}),
    ...(year !== undefined ? { year } : {}) };
}

export function resourceIdentityFromUrl(raw: string): ResourceIdentity | undefined {
  const name = mediaResourceBasename(raw);
  return name ? resourceIdentity([name]) : undefined;
}

function resourceTitleKey(title: string): string | undefined {
  if (!title.trim() || title.length > 300) return undefined;
  // Exact canonical equality after resource separators, case and Unicode composition.
  // No containment, aliases, token removal or release-tag dictionary.
  const canonical = title.normalize("NFC").toLowerCase().replace(/[._\s]+/g, " ").trim();
  return createHash("sha256").update(canonical).digest("hex");
}

/** Called by the probe only after the effective root passes media validation. */
export function movieResourceObservationFromUrl(raw: string,
  validation: MovieResourceObservation["validation"]): MovieResourceObservation | undefined {
  const name = mediaResourceBasename(raw);
  const facts = resourceIdentityFromUrl(raw);
  if (!name || facts?.kind || facts?.year === undefined) return undefined;
  const match = /^(.{1,300}?)[._ -]+((?:19|20)\d{2})(?=$|[._ -])/.exec(name);
  if (!match) return undefined;
  const titleKey = resourceTitleKey(match[1]!);
  if (!titleKey || Number(match[2]) !== facts.year) return undefined;
  return { source: "effective_root", validation, titleKey, year: facts.year,
    queryPresent: new URL(raw).search.length > 0 };
}

/** Request-independent facts only. Bare coordinates never infer a series title. */
export function episodeResourceObservationFromUrl(raw: string,
  validation: MovieResourceObservation["validation"]): EpisodeResourceObservation | undefined {
  const name = mediaResourceBasename(raw);
  const facts = resourceIdentityFromUrl(raw);
  if (!name || facts?.kind !== "episode" || facts.season === undefined || facts.episode === undefined) return undefined;
  // A single explicit production year may delimit the series prefix; no unknown tokens are removed.
  const match = /^(.{1,300}?)[._ -]+(?:(?:19|20)\d{2}[._ -]+)?S(\d{1,2})[._ -]?E(\d{1,2})(?=$|[._ -])/i.exec(name);
  const titleKey = match ? resourceTitleKey(match[1]!) : undefined;
  return { source: "effective_root", validation, season: facts.season, episode: facts.episode,
    ...(titleKey ? { titleKey } : {}), ...(facts.year !== undefined ? { year: facts.year } : {}),
    queryPresent: new URL(raw).search.length > 0 };
}

function validatedFileResource(source: NormalizedStreamSource,
  observation: Pick<MovieResourceObservation, "source" | "validation">): boolean {
  const probe = source.directHttp;
  if (!probe || probe.hls || probe.archiveFormat || probe.documentFormat || observation.source !== "effective_root") return false;
  return observation.validation === "range_206"
    ? probe.verified && probe.rangeSupported && probe.responseStatus === 206
    : observation.validation === "video_200" && probe.responseStatus === 200 && probe.status === "reachable"
      && (probe.contentType?.startsWith("video/") ?? false);
}

/** File-resource confidence only; callers apply contradictions and origin disputes first. */
export function effectiveMovieIdentityState(item: NormalizedMediaItem, source: NormalizedStreamSource): BridgeIdentityState | undefined {
  const probe = source.directHttp;
  const observation = probe?.movieResource;
  if (item.kind !== "movie" || item.year === undefined || !observation || probe?.hls
    || observation.source !== "effective_root" || observation.year !== item.year) return undefined;
  if (!validatedFileResource(source, observation)) return undefined;
  // A compatible year without the canonical title anchor is insufficient identity.
  // Unequal hashes alone cannot establish an explicit other-work title or alias.
  if (observation.titleKey !== resourceTitleKey(item.title)) return "UNKNOWN";
  return observation.queryPresent || (source.url && new URL(source.url).search.length > 0) ? "SUSPICIOUS" : "CORROBORATED";
}

/** Called after hard qualification; candidate-ID claims remain outside this slice. */
export function effectiveEpisodeIdentityState(item: NormalizedMediaItem, source: NormalizedStreamSource): BridgeIdentityState | undefined {
  const observation = source.directHttp?.episodeResource;
  if (item.kind !== "episode" || !observation || !validatedFileResource(source, observation)) return undefined;
  if (!item.seriesTitle || item.season === undefined || item.episode === undefined || !observation.titleKey
    || observation.titleKey !== resourceTitleKey(item.seriesTitle)
    || observation.season !== item.season || observation.episode !== item.episode) return "UNKNOWN";
  const yearConflict = item.year !== undefined && observation.year !== undefined && observation.year !== item.year;
  return yearConflict || observation.queryPresent || (source.url && new URL(source.url).search.length > 0)
    ? "SUSPICIOUS" : "CORROBORATED";
}

function explicitDurationSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const durations = value.split(/\r?\n/).flatMap((line) => {
    const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(line.trim());
    if (!match) return [];
    const seconds = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
    return seconds > 0 && seconds <= 600 * 60 ? [seconds] : [];
  });
  return durations.length === 1 ? durations[0] : undefined;
}

/** Weak provider duration labels retain their original, more conservative movie rule. */
function presentationRuntimeContradicts(requestedSeconds: number, candidateSeconds: number): boolean {
  const difference = Math.abs(requestedSeconds - candidateSeconds);
  return difference > 30 * 60 && difference * 4 > requestedSeconds;
}

/** Gross measured gaps; episodes require trusted duration for the exact requested S/E. */
export function runtimeContradicts(kind: NormalizedMediaItem["kind"], requestedSeconds: number, candidateSeconds: number): boolean {
  if (kind !== "movie" && kind !== "episode") return false;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0
    || !Number.isFinite(candidateSeconds) || candidateSeconds <= 0) return false;
  const tolerance = kind === "episode" ? Math.max(3 * 60, requestedSeconds * 0.2)
    : Math.max(10 * 60, requestedSeconds * 0.3);
  return Math.abs(requestedSeconds - candidateSeconds) > tolerance;
}

/** Only independently measured, verified media duration can contradict requested runtime. */
function measuredRuntimeSeconds(source: NormalizedStreamSource): number | undefined {
  const probe = source.directHttp;
  const seconds = probe?.actualRuntimeSeconds;
  return probe?.verified === true && (probe.runtimeEvidence === "hls_vod" || probe.runtimeEvidence === "mp4_mvhd")
    && seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function measuredRuntimeMismatch(item: NormalizedMediaItem, source: NormalizedStreamSource): boolean {
  const seconds = measuredRuntimeSeconds(source);
  return item.runtimeSeconds !== undefined && seconds !== undefined
    && runtimeContradicts(item.kind, item.runtimeSeconds, seconds);
}

/**
 * Sparse bounded claims: neutral evidence stays UNKNOWN; an explicit structured
 * different movie title with a compatible year is SUSPICIOUS (AC-ID-066).
 * External IDs and resource anchors still require separate composition. This
 * does not decide admission, authenticate IDs or infer aliases from free text.
 */
export function sparseCandidateIdentityState(item: NormalizedMediaItem,
  source: NormalizedStreamSource): "UNKNOWN" | "SUSPICIOUS" | undefined {
  const claim = normalizeCandidateIdentity(record(source.metadata)?.identity);
  let titleConcern = false;
  if (claim) {
    // A declared ID alone establishes neither independence nor corroboration.
    // Hard conflicts are decided by qualification before this sparse fallback.
    if (claim.title && resourceTitleKey(claim.title) !== resourceTitleKey(item.kind === "episode"
      ? item.seriesTitle ?? item.title : item.title)) {
      if (item.kind !== "movie" || item.year === undefined || claim.year !== item.year) return undefined;
      titleConcern = true;
    }
    if (claim.kind && claim.kind !== item.kind && !(item.kind === "episode" && claim.kind === "series")) return undefined;
    if (claim.year !== undefined && claim.year !== item.year) return undefined;
    if (claim.season !== undefined && claim.season !== item.season) return undefined;
    if (claim.episode !== undefined && claim.episode !== item.episode) return undefined;
  }
  // ID/title disputes still require the deferred provenance/composition work.
  if (titleConcern && Object.keys(claim?.externalIds ?? {}).length) return undefined;
  if (explicitReleaseTitle(source.title)) return undefined;
  if (resourceIdentity(videoReleaseNames(source))) return undefined;
  if (source.url && resourceIdentityFromUrl(source.url)) return undefined;
  if (source.directHttp?.resourceIdentities?.length) return undefined;
  // Series identity and more complex episodic evidence remain unclassified.
  return item.kind === "movie" || item.kind === "episode" ? titleConcern ? "SUSPICIOUS" : "UNKNOWN" : undefined;
}

export function canClassifyAdmittedUnknown(item: NormalizedMediaItem, source: NormalizedStreamSource): boolean {
  return sparseCandidateIdentityState(item, source) === "UNKNOWN";
}

export type IdentityMismatchReason = "KIND_CONFLICT" | "EXTERNAL_ID_CONFLICT"
  | "EPISODE_COORDINATE_CONFLICT" | "MOVIE_YEAR_CONFLICT" | "TEXTUAL_RUNTIME_CONFLICT";

/** Observation gate only; callers must already have decided MOVIE_YEAR_CONFLICT. */
export function canObservePreProbeMovieResourceYearConflict(item: NormalizedMediaItem,
  source: NormalizedStreamSource): boolean {
  if (item.kind !== "movie" || item.year === undefined || source.directHttp
    || normalizeCandidateIdentity(record(source.metadata)?.identity) || explicitReleaseTitle(source.title)) return false;
  // Only actual candidate filename/original basename, not filename-looking presentation.
  // Reuse the qualification parser; disagreeing or multiple original years stay unobserved.
  const names = source.filename
    ? videoReleaseNames({ providerId: source.providerId, type: source.type, filename: source.filename }) : [];
  const name = (source.type === "http" || source.type === "https") && source.url
    ? mediaResourceBasename(source.url) : undefined;
  if (name) names.push(name);
  const resource = resourceIdentity(names);
  return !resource?.kind && resource?.year !== undefined && resource.year !== item.year;
}

/** Returns a category only when both sides state a conflicting identity. */
export function identityMismatchReason(item: NormalizedMediaItem, source: NormalizedStreamSource,
  options: { deferTextualRuntime?: boolean } = {}): IdentityMismatchReason | undefined {
  const structured = normalizeCandidateIdentity(record(source.metadata)?.identity);
  const releaseTitle = item.kind === "movie" ? explicitReleaseTitle(source.title) : undefined;
  const releaseNames = item.kind === "movie" || item.kind === "episode" ? videoReleaseNames(source) : [];
  const urlIdentity = (item.kind === "movie" || item.kind === "episode")
    && (source.type === "http" || source.type === "https") && source.url
    ? resourceIdentityFromUrl(source.url) : undefined;
  const filenameIdentity = resourceIdentity(releaseNames);
  const independentFilename = (item.kind === "movie" || item.kind === "episode") && source.filename
    ? resourceIdentity(videoReleaseNames({ providerId: source.providerId, type: source.type, filename: source.filename })) : undefined;
  const resources = [independentFilename, urlIdentity,
    ...(item.kind === "movie" || item.kind === "episode" ? source.directHttp?.resourceIdentities ?? [] : [])];
  const identity = structured || releaseTitle ? { ...releaseTitle, ...structured } : undefined;
  const candidateRuntime = item.kind === "movie" ? explicitDurationSeconds(source.title) : undefined;
  for (const evidence of [identity, filenameIdentity, ...resources]) {
    if (evidence?.kind && evidence.kind !== item.kind
      && !(item.kind === "episode" && evidence.kind === "series")) return "KIND_CONFLICT";
  }
  for (const [namespace, id] of Object.entries(identity?.externalIds ?? {})) {
    const requested = Object.hasOwn(item.externalIds, namespace) ? item.externalIds[namespace] : undefined;
    if (requested && requested !== id) return "EXTERNAL_ID_CONFLICT";
  }
  if (item.kind === "episode") {
    for (const evidence of [identity, filenameIdentity, ...resources]) {
      if (evidence?.season !== undefined && item.season !== undefined && evidence.season !== item.season) return "EPISODE_COORDINATE_CONFLICT";
      if (evidence?.episode !== undefined && item.episode !== undefined && evidence.episode !== item.episode) return "EPISODE_COORDINATE_CONFLICT";
    }
    // Series/resource year comparison is deferred; it must not reject an episode.
  }
  if (item.kind === "movie") {
    if (item.year !== undefined && (
      (releaseTitle?.year !== undefined && releaseTitle.year !== item.year) ||
      (structured?.year !== undefined && structured.year !== item.year) ||
      (filenameIdentity?.year !== undefined && filenameIdentity.year !== item.year) ||
      resources.some((evidence) => evidence?.year !== undefined && evidence.year !== item.year)
    )) return "MOVIE_YEAR_CONFLICT";
    if (!options.deferTextualRuntime && measuredRuntimeSeconds(source) === undefined
      && item.runtimeSeconds !== undefined && candidateRuntime !== undefined) {
      if (presentationRuntimeContradicts(item.runtimeSeconds, candidateRuntime)) return "TEXTUAL_RUNTIME_CONFLICT";
    }
  }
  return undefined;
}

/** Boolean compatibility API delegates to the single qualification decision path. */
export function identityMismatch(item: NormalizedMediaItem, source: NormalizedStreamSource,
  options: { deferTextualRuntime?: boolean } = {}): boolean {
  return identityMismatchReason(item, source, options) !== undefined;
}
