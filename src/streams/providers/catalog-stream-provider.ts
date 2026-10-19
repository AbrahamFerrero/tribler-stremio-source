import type { CatalogProvider } from "../../catalog/types";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider, StreamProviderContext } from "../types";

export class CatalogStreamProvider implements StreamProvider {
  readonly id: string;
  readonly name: string;

  constructor(private readonly catalog: CatalogProvider) {
    this.id = `catalog_${catalog.definition.id}`;
    this.name = catalog.definition.name;
  }

  isEnabled(): boolean { return true; }

  async resolve(item: NormalizedMediaItem, context: StreamProviderContext): Promise<NormalizedStreamSource[]> {
    if (!this.catalog.owns(item.id)) return [];
    const direct = this.catalog.getDirectStreams
      ? await this.catalog.getDirectStreams(item.id, context.signal)
      : this.catalog.getDirectStream
        ? [await this.catalog.getDirectStream(item.id, context.signal)].filter((value) => value !== undefined)
        : [];
    const streams: NormalizedStreamSource[] = direct.map((source) => ({
      providerId: this.id,
      type: new URL(source.url).protocol === "https:" ? "https" : "http",
      url: source.url,
      filename: source.fileName,
      sizeBytes: source.size,
      ...(source.height ? { quality: `${source.height}p`, resolution: `${source.width ?? "?"}x${source.height}` } : {}),
      ...(source.format ? { codec: source.format } : {})
    }));
    let torrent: string | undefined;
    try {
      if (!this.catalog.supportsTriblerFallback || await this.catalog.supportsTriblerFallback(item.id, context.signal)) {
        torrent = await this.catalog.getTorrentSource(item.id, context.signal);
      }
    } catch {
      torrent = undefined;
    }
    if (torrent) {
      const variants = direct.length > 0 ? direct : [undefined];
      for (const variant of variants) {
        streams.push({
          providerId: this.id,
          type: torrent.toLowerCase().startsWith("magnet:") ? "magnet" : "torrent",
          ...(torrent.toLowerCase().startsWith("magnet:") ? { magnet: torrent } : { url: torrent }),
          title: "Tribler",
          ...(variant ? {
            filename: variant.fileName,
            sizeBytes: variant.size,
            ...(variant.height ? { quality: `${variant.height}p` } : {}),
            ...(variant.format ? { codec: variant.format } : {})
          } : {})
        });
      }
    }
    return streams;
  }
}
