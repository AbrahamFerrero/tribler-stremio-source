import type { CatalogItem, CatalogProvider, CatalogRequest } from "./types";

const TEST_ID = "tribler:test";

export class ConfiguredMagnetCatalogProvider implements CatalogProvider {
  readonly definition = {
    id: "tribler-configured",
    type: "movie" as const,
    name: "Configured torrent"
  };

  constructor(private readonly magnet: string) {}

  owns(stremioId: string): boolean {
    return stremioId === TEST_ID;
  }

  list(request: CatalogRequest): Promise<CatalogItem[]> {
    if (request.type !== "movie" || request.skip > 0) return Promise.resolve([]);
    return Promise.resolve([{ id: TEST_ID, type: "movie", name: "Configured torrent" }]);
  }

  get(stremioId: string): Promise<CatalogItem | undefined> {
    return Promise.resolve(this.owns(stremioId)
      ? { id: TEST_ID, type: "movie", name: "Configured torrent" }
      : undefined);
  }

  getTorrentSource(stremioId: string): Promise<string> {
    if (!this.owns(stremioId)) throw new Error("Unknown configured catalog item");
    return Promise.resolve(this.magnet);
  }
}
