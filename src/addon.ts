import { extname } from "node:path";
import { addonBuilder } from "stremio-addon-sdk";
import { encodeStreamId } from "./automatic-stream";
import type { CatalogProvider, DirectStreamSource } from "./catalog/types";
import type { DownloadService } from "./download-service";
import { safeErrorDetails, type Logger } from "./logger";
import type { MovieMetadataLookup } from "./metadata/movie-metadata";
import type { PlaybackManager } from "./playback/manager";
import { parseStreamId } from "./source";
import { publicStreamFilename, rankedStreamDescription, safeStreamDescription, streamSummary } from "./streams/presentation";
import type { StreamRankingPolicy } from "./streams/ranking-policy";
import { isImdbMovieId } from "./streams/media-id-mapper";
import { parseStremioEpisodeIdentity } from "./streams/stremio-episode-identity";
import type { StreamResolver } from "./streams/resolver";
import type { NormalizedMediaItem } from "./streams/types";
import type { TriblerFile } from "./types";
import { inferVideoHeight } from "./video-selection";

function skipValue(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function variantLabel(variant: DirectStreamSource | TriblerFile): string {
  const name = "fileName" in variant ? variant.fileName : variant.name;
  const height = "height" in variant ? variant.height : inferVideoHeight(name);
  const width = "width" in variant ? variant.width : undefined;
  const format = "format" in variant && variant.format
    ? variant.format
    : extname(name).slice(1).toUpperCase();
  const resolution = width && height ? `${width}x${height} (${height}p)` : height ? `${height}p` : "unknown resolution";
  const size = variant.size >= 1_048_576
    ? `${Math.round(variant.size / 1_048_576)} MiB`
    : `${Math.round(variant.size / 1_024)} KiB`;
  return `${resolution} - ${format || "video"} - ${size}`;
}

function automaticUrl(
  publicBaseUrl: string,
  id: string,
  fileName: string,
  parameters: Record<string, string>
): string {
  const query = new URLSearchParams(parameters);
  return `${publicBaseUrl}/auto/${encodeStreamId(id)}/${encodeURIComponent(fileName)}?${query.toString()}`;
}

/**
 * The Stremio stream id remains authoritative. Catalog metadata can enrich it,
 * but never replaces the exact requested video identity.
 */
export function createStreamMediaItem(
  type: string,
  videoId: string,
  catalogItem?: Awaited<ReturnType<CatalogProvider["get"]>>
): NormalizedMediaItem {
  const episode = parseStremioEpisodeIdentity(type, videoId);
  const movieImdb = type === "movie" && isImdbMovieId(videoId) ? videoId : undefined;
  return {
    id: videoId,
    kind: catalogItem?.kind ?? (episode ? "episode" : catalogItem?.type ?? (type === "series" ? "series" : "movie")),
    // Text-only providers cannot safely infer a title from an episode ID.
    title: catalogItem?.name ?? (episode ? "" : videoId),
    externalIds: { ...(catalogItem?.externalIds ?? {}), ...(episode ? { imdb: episode.imdb } : {}),
      ...(movieImdb ? { imdb: movieImdb } : {}) },
    ...(catalogItem?.classifications ? { classifications: [...catalogItem.classifications] } : {}),
    stremio: { ...(catalogItem?.stremio ?? {}), type, videoId },
    ...(catalogItem?.season !== undefined ? { season: catalogItem.season } : episode ? { season: episode.season } : {}),
    ...(catalogItem?.episode !== undefined ? { episode: catalogItem.episode } : episode ? { episode: episode.episode } : {})
  };
}

export function createAddon(
  service: DownloadService,
  log: Logger,
  catalogInput: CatalogProvider | CatalogProvider[],
  publicBaseUrl: string,
  legalTestMagnet?: string,
  resolver?: StreamResolver,
  playback?: PlaybackManager,
  movieMetadata?: MovieMetadataLookup,
  presentation?: { rankingDetails?: boolean; rankingPolicy: StreamRankingPolicy }
) {
  const catalogs = Array.isArray(catalogInput) ? catalogInput : [catalogInput];
  const catalogManifest = catalogs.map((catalog) => ({
    type: catalog.definition.type,
    id: catalog.definition.id,
    name: catalog.definition.name,
    extra: [
      { name: "skip", isRequired: false },
      ...(catalog.definition.supportsSearch ? [{ name: "search", isRequired: false }] : [])
    ]
  }));
  const builder = new addonBuilder({
    id: "org.local.tribler.bridge",
    version: "1.1.0",
    name: "Local Tribler Bridge",
    description: "Multiple configurable catalogs with direct HTTP streaming and Tribler playback",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: catalogManifest
  });

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const catalog = catalogs.find((candidate) =>
      candidate.definition.type === type && candidate.definition.id === id
    );
    if (!catalog) return { metas: [] };
    try {
      const metas = await catalog.list({
        type,
        skip: skipValue(extra?.skip),
        ...(extra?.search ? { search: extra.search } : {})
      });
      return { metas };
    } catch (error) {
      log.warn("Catalog request failed", {
        provider: catalog.definition.id,
        error: safeErrorDetails(error)
      });
      return { metas: [] };
    }
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    const catalog = catalogs.find((candidate) => candidate.definition.type === type && candidate.owns(id));
    if (!catalog) return { meta: null };
    try {
      return { meta: await catalog.get(id) ?? null };
    } catch (error) {
      log.warn("Catalog metadata request failed", {
        provider: catalog.definition.id,
        id,
        error: safeErrorDetails(error)
      });
      return { meta: null };
    }
  });

  builder.defineStreamHandler(async ({ id, type }) => {
    const catalog = catalogs.find((candidate) => candidate.owns(id));
    try {
      if (resolver && playback) {
        const catalogItem = catalog ? await catalog.get(id) : undefined;
        const item = createStreamMediaItem(type, id, catalogItem);
        const yearMatch = /(?:^|\D)(\d{4})(?:\D|$)/.exec(catalogItem?.releaseInfo ?? "");
        if (yearMatch?.[1]) item.year = Number(yearMatch[1]);
        if (item.kind === "movie" && item.externalIds.imdb && movieMetadata
          && (!catalogItem || item.year === undefined || item.runtimeSeconds === undefined)) {
          try {
            const identity = await movieMetadata.lookup(item.externalIds.imdb);
            if (identity) {
              if (!catalogItem) item.title = identity.title;
              if (item.year === undefined && identity.year !== undefined) item.year = identity.year;
              if (identity.runtimeSeconds !== undefined) item.runtimeSeconds = identity.runtimeSeconds;
            }
          } catch {
            // Metadata improves qualification but must not gate stream availability.
          }
        }
        if (item.kind === "episode" && item.externalIds.imdb && (item.seriesTitle === undefined || item.year === undefined) && movieMetadata?.lookupSeries) {
          try {
            const identity = await movieMetadata.lookupSeries(item.externalIds.imdb);
            if (identity) {
              if (item.seriesTitle === undefined) item.seriesTitle = identity.title;
              if (item.year === undefined && identity.year !== undefined) item.year = identity.year;
            }
          } catch {
            // Missing series metadata must not gate stream availability.
          }
        }
        const resolvedSources = await resolver.resolve(item);
        if (resolvedSources.length > 0) {
          const streams = resolvedSources.map((source, index) => {
            const token = playback.register(source);
            const description = presentation?.rankingDetails
              ? rankedStreamDescription(source, index + 1, presentation.rankingPolicy)
              : safeStreamDescription(source);
            return {
              url: `${publicBaseUrl}/source/${token}/${publicStreamFilename(source)}`,
              name: streamSummary(source),
              ...(description ? { title: description } : {}),
              behaviorHints: { notWebReady: false }
            };
          });
          return { streams, cacheMaxAge: 0 };
        }
      }
      const ownedByCatalog = catalog !== undefined;
      const directVariants = catalog
        ? catalog.getDirectStreams
          ? await catalog.getDirectStreams(id)
          : catalog.getDirectStream
            ? [await catalog.getDirectStream(id)].filter(
                (candidate): candidate is DirectStreamSource => candidate !== undefined
              )
            : []
        : [];
      const streams: Array<Record<string, unknown>> = [];
      const supportsTribler = catalog?.supportsTriblerFallback
        ? await catalog.supportsTriblerFallback(id)
        : true;

      for (const variant of directVariants) {
        const label = variantLabel(variant);
        const quality = variant.height ? `${variant.height}p` : extname(variant.fileName).slice(1).toUpperCase();
        const common = { file: variant.fileName };
        streams.push({
          url: automaticUrl(publicBaseUrl, id, variant.fileName, common),
          name: `Direct - ${quality}`,
          title: `${label} - ${variant.fileName} - HTTP`,
          behaviorHints: { notWebReady: false }
        });
        if (supportsTribler) {
          streams.push({
            url: automaticUrl(publicBaseUrl, id, variant.fileName, { ...common, source: "tribler" }),
            name: `Tribler - ${quality}`,
            title: `${label} - ${variant.fileName} - BitTorrent only`,
            behaviorHints: { notWebReady: false }
          });
        }
      }

      if (streams.length === 0) {
        const request = ownedByCatalog
          ? { source: await catalog.getTorrentSource(id) }
          : parseStreamId(id, legalTestMagnet);
        const inspection = await service.inspect(request.source);
        for (const file of inspection.files) {
          const label = variantLabel(file);
          const height = inferVideoHeight(file.name);
          streams.push({
            url: automaticUrl(publicBaseUrl, id, file.name, {
              source: "tribler",
              fileIndex: String(file.index)
            }),
            name: `Tribler - ${height ? `${height}p` : extname(file.name).slice(1).toUpperCase()}`,
            title: `${label} - ${file.name}`,
            behaviorHints: { notWebReady: false }
          });
        }
      }

      return { streams, cacheMaxAge: 0 };
    } catch (error) {
      log.warn("Stream variant resolution failed", {
        id,
        provider: catalog?.definition.id ?? "manual",
        error: safeErrorDetails(error)
      });
      return { streams: [], cacheMaxAge: 0 };
    }
  });

  return builder.getInterface();
}
