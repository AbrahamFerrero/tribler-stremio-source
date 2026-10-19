const IMDB_EPISODE_ID = /^(tt\d{5,12}):(\d+):(\d+)$/;

export interface StremioEpisodeIdentity {
  imdb: string;
  season: number;
  episode: number;
}

/** Strictly enriches the standard Stremio IMDb episode form without changing it. */
export function parseStremioEpisodeIdentity(type: string, videoId: string): StremioEpisodeIdentity | undefined {
  if (type !== "series") return undefined;
  const match = IMDB_EPISODE_ID.exec(videoId);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 0) return undefined;
  return { imdb: match[1], season, episode };
}
