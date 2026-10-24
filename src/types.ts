export interface TriblerFile {
  index: number;
  name: string;
  size: number;
  included: boolean;
  priority?: number;
  progress: number;
}

export interface TriblerDownload {
  infohash: string;
  name: string;
  status: string;
  progress: number;
  speed_down: number;
  speed_up: number;
  num_peers: number;
  num_seeds: number;
  error?: string;
  time_added?: number;
  size?: number;
  [key: string]: unknown;
}

export type DownloadOwnership = "EXTERNAL" | "BRIDGE_OWNED";
export type DownloadRetention = "EPHEMERAL" | "RETAINED" | "PINNED";
export type DownloadRetentionMode = "smart" | "ephemeral" | "keep_all";

export interface ManagedDownload {
  infohash: string;
  createdAt: number;
  lastAccess: number;
  ownership: DownloadOwnership;
  retention?: DownloadRetention;
  servedBytes: number;
  activeStreams: number;
  selectedFileIndex?: number;
  selectedFileName?: string;
}

export interface AppConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  publicBaseUrl: string;
  bridgeAdminToken?: string;
  triblerUrl: string;
  triblerApiKey: string;
  triblerAutoDiscover: boolean;
  torrentSafetyMode: "balanced" | "fast";
  archiveHttpStreams: boolean;
  catalogProvider: "internet-archive" | "configured";
  catalogSourcesFile?: string;
  catalogQuery: string;
  catalogPageSize: number;
  catalogCacheTtlMs: number;
  catalogRequestTimeoutMs: number;
  directHttpTimeoutMs: number;
  directHttpProbe: {
    enabled: boolean;
    timeoutMs: number;
    maxCandidates: number;
    maxConcurrent: number;
  };
  streamRankingPolicy: import("./streams/ranking-policy").StreamRankingPolicy;
  streamRankingDetails?: boolean;
  httpPrivacy: import("./network/http-privacy").HttpPrivacyPolicy;
  httpStreamTokenTtlMs: number;
  httpStreamTokenMaxEntries: number;
  streamProviders: string[];
  streamMaxResultsPerProvider?: number;
  streamProviderTimeoutMs: number;
  streamProviderMaxConcurrent: number;
  externalStreamProviderEnabled: boolean;
  externalStreamProviderUrl?: string;
  externalStreamProviderTimeoutMs: number;
  stremioAddonProvidersFile?: string;
  stremioMovieMetadataBaseUrl?: string;
  stremioAddonManifestTtlMs: number;
  stremioAddonRequestTimeoutMs: number;
  localStreamJsonFile?: string;
  localStreamJsonDirectory: string;
  legalTestMagnet?: string;
  metadataTimeoutMs: number;
  noSeedsTimeoutMs: number;
  pollIntervalMs: number;
  streamHeaderTimeoutMs: number;
  triblerStreamBuffer: {
    enabled: boolean;
    startupBytes: number;
    seekBytes: number;
    maxBytes: number;
    prebufferTimeoutMs: number;
  };
  downloadRetentionMode: DownloadRetentionMode;
  cleanupIntervalMs: number;
  cleanupRemoveData: boolean;
  managedDownloadsStateFile: string;
}
