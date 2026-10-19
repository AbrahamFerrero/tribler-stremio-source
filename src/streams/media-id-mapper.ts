import type { NormalizedMediaItem } from "./types";

const SAFE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,2047}$/;
const IMDB_BASE_ID = /^tt\d{5,12}$/;

export function isImdbMovieId(value: string): boolean {
  return IMDB_BASE_ID.test(value);
}

export function isSafeMediaId(value: string): boolean {
  return SAFE_ID.test(value);
}

export interface MediaIdMapper {
  readonly id: string;
  canMap(item: NormalizedMediaItem, targetNamespace: string): boolean;
  map(item: NormalizedMediaItem, targetNamespace: string): Promise<string | undefined>;
}

export class ImdbEpisodeIdMapper implements MediaIdMapper {
  readonly id = "imdb_episode";

  canMap(item: NormalizedMediaItem, targetNamespace: string): boolean {
    return item.kind === "episode" && targetNamespace === "imdb";
  }

  map(item: NormalizedMediaItem): Promise<string | undefined> {
    const imdb = item.externalIds.imdb;
    if (!imdb || !IMDB_BASE_ID.test(imdb) || !Number.isSafeInteger(item.season) || Number(item.season) < 0 ||
      !Number.isSafeInteger(item.episode) || Number(item.episode) < 0) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(`${imdb}:${item.season}:${item.episode}`);
  }
}

export class StoredExternalIdMapper implements MediaIdMapper {
  readonly id = "stored_external_id";

  canMap(item: NormalizedMediaItem, targetNamespace: string): boolean {
    return SAFE_NAMESPACE.test(targetNamespace) && typeof item.externalIds[targetNamespace] === "string";
  }

  map(item: NormalizedMediaItem, targetNamespace: string): Promise<string | undefined> {
    const value = item.externalIds[targetNamespace];
    return Promise.resolve(value && isSafeMediaId(value) ? value : undefined);
  }
}

export class MediaIdMapperRegistry {
  private readonly mappers: MediaIdMapper[] = [];

  constructor(mappers: MediaIdMapper[] = []) {
    for (const mapper of mappers) this.register(mapper);
  }

  register(mapper: MediaIdMapper): void {
    if (this.mappers.some(({ id }) => id === mapper.id)) throw new Error(`Duplicate media ID mapper: ${mapper.id}`);
    this.mappers.push(mapper);
  }

  async map(item: NormalizedMediaItem, targetNamespace: string): Promise<string | undefined> {
    for (const mapper of this.mappers) {
      if (!mapper.canMap(item, targetNamespace)) continue;
      return await mapper.map(item, targetNamespace);
    }
    return undefined;
  }
}

export function createDefaultMediaIdMapperRegistry(): MediaIdMapperRegistry {
  return new MediaIdMapperRegistry([new ImdbEpisodeIdMapper(), new StoredExternalIdMapper()]);
}
