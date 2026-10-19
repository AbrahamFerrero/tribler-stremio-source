import { readFileSync } from "node:fs";
import { createStreamMediaItem } from "../src/addon";
import type { NormalizedMediaItem } from "../src/streams/types";

const MAX_INPUT_BYTES = 65_536;
const MAX_ITEMS = 100;

export function inputItems(path: string): NormalizedMediaItem[] {
  const raw = readFileSync(path);
  if (raw.length > MAX_INPUT_BYTES) throw new Error("INPUT_INVALID");
  const payload: unknown = JSON.parse(raw.toString("utf8"));
  return parseEvaluationItems(payload);
}

export function parseEvaluationItems(payload: unknown): NormalizedMediaItem[] {
  if (!Array.isArray(payload) || !payload.length || payload.length > MAX_ITEMS) throw new Error("INPUT_INVALID");
  return payload.map((value): NormalizedMediaItem => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INPUT_INVALID");
    const item = value as Record<string, unknown>;
    if (typeof item.type !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.type)
      || typeof item.videoId !== "string" || item.videoId.length > 200
      || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(item.videoId)) throw new Error("INPUT_INVALID");
    const base = createStreamMediaItem(item.type, item.videoId);
    const kind = item.kind ?? base.kind;
    if (kind !== "movie" && kind !== "series" && kind !== "episode") throw new Error("INPUT_INVALID");
    const externalIds: Record<string, string> = { ...base.externalIds } as Record<string, string>;
    if (item.externalIds !== undefined) {
      if (typeof item.externalIds !== "object" || item.externalIds === null || Array.isArray(item.externalIds)) {
        throw new Error("INPUT_INVALID");
      }
      for (const [key, id] of Object.entries(item.externalIds)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(key) || typeof id !== "string"
          || id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(id)) throw new Error("INPUT_INVALID");
        externalIds[key] = id;
      }
    }
    const year = item.year ?? base.year;
    if (year !== undefined && (!Number.isSafeInteger(year) || Number(year) < 1 || Number(year) > 9999)) {
      throw new Error("INPUT_INVALID");
    }
    if (item.seriesTitle !== undefined && (typeof item.seriesTitle !== "string"
      || !item.seriesTitle.trim() || item.seriesTitle.length > 300
      || [...item.seriesTitle].some((character) => character.charCodeAt(0) < 32))) {
      throw new Error("INPUT_INVALID");
    }
    const season = item.season ?? base.season;
    const episode = item.episode ?? base.episode;
    if ((season !== undefined && (!Number.isSafeInteger(season) || Number(season) < 0))
      || (episode !== undefined && (!Number.isSafeInteger(episode) || Number(episode) < 0))) throw new Error("INPUT_INVALID");
    if (item.classifications !== undefined && (!Array.isArray(item.classifications)
      || item.classifications.some((entry: unknown) => typeof entry !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(entry)))) {
      throw new Error("INPUT_INVALID");
    }
    return {
      ...base, kind,
      title: typeof item.title === "string" && item.title.length <= 200 ? item.title : base.title,
      externalIds,
      ...(year !== undefined ? { year: Number(year) } : {}),
      ...(typeof item.seriesTitle === "string" ? { seriesTitle: item.seriesTitle.trim() } : {}),
      ...(season !== undefined ? { season: Number(season) } : {}),
      ...(episode !== undefined ? { episode: Number(episode) } : {}),
      ...(Array.isArray(item.classifications) ? { classifications: item.classifications as string[] } : {})
    };
  });
}
