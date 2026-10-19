import type { StreamResourceCapabilities } from "./stremio-addon-manifest";
import { createDefaultMediaIdMapperRegistry, isSafeMediaId, type MediaIdMapperRegistry } from "./media-id-mapper";
import type { NormalizedMediaItem } from "./types";

export interface AddonRequestIdentity {
  type: string;
  id: string;
}

function safeType(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function typeCandidates(item: NormalizedMediaItem): string[] {
  const structural = item.kind === "movie" ? "movie" : "series";
  return [...new Set([
    item.stremio?.type,
    ...(item.classifications ?? []),
    structural
  ].filter((value): value is string => typeof value === "string" && safeType(value)))];
}

function compatible(id: string, prefixes: string[]): boolean {
  return isSafeMediaId(id) && (prefixes.length === 0 || prefixes.some((prefix) => id.startsWith(prefix)));
}

export class AddonRequestIdentityResolver {
  constructor(private readonly mappers: MediaIdMapperRegistry = createDefaultMediaIdMapperRegistry()) {}

  async resolve(
    item: NormalizedMediaItem,
    capabilities: StreamResourceCapabilities
  ): Promise<AddonRequestIdentity | undefined> {
    const type = typeCandidates(item).find((candidate) => capabilities.types.includes(candidate));
    if (!type) return undefined;
    const prefixes = capabilities.idPrefixes ?? [];
    const exactVideoId = item.stremio?.videoId;
    if (exactVideoId && compatible(exactVideoId, prefixes)) return { type, id: exactVideoId };

    for (const namespace of Object.keys(item.externalIds)) {
      const id = await this.mappers.map(item, namespace);
      if (id && compatible(id, prefixes)) return { type, id };
    }
    if (compatible(item.id, prefixes)) return { type, id: item.id };
    return undefined;
  }
}
