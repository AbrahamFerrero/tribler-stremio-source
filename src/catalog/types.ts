export type CatalogMediaType = "movie" | "series";

export interface CatalogItem {
  id: string;
  type: CatalogMediaType;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
  kind?: "movie" | "series" | "episode";
  season?: number;
  episode?: number;
  externalIds?: Record<string, string | undefined>;
  classifications?: string[];
  stremio?: {
    type?: string;
    videoId?: string;
  };
}

export interface CatalogRequest {
  type: string;
  skip: number;
  search?: string;
}

export interface CatalogDefinition {
  id: string;
  type: CatalogMediaType;
  name: string;
  supportsSearch?: boolean;
}

export interface DirectStreamSource {
  url: string;
  fileName: string;
  size: number;
  width?: number;
  height?: number;
  format?: string;
  source?: string;
}

export interface CatalogProvider {
  readonly definition: CatalogDefinition;
  owns(stremioId: string): boolean;
  list(request: CatalogRequest, signal?: AbortSignal): Promise<CatalogItem[]>;
  get(stremioId: string, signal?: AbortSignal): Promise<CatalogItem | undefined>;
  getTorrentSource(stremioId: string, signal?: AbortSignal): Promise<string>;
  supportsTriblerFallback?(stremioId: string, signal?: AbortSignal): Promise<boolean>;
  getDirectStream?(stremioId: string, signal?: AbortSignal): Promise<DirectStreamSource | undefined>;
  getDirectStreams?(stremioId: string, signal?: AbortSignal): Promise<DirectStreamSource[]>;
}
