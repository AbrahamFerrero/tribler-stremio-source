import type { SourceHeaderScope, SourceRequestHeaders } from "../network/http-privacy";

export type NormalizedMediaKind = "movie" | "series" | "episode";
export type StreamSourceType = "magnet" | "torrent" | "http" | "https";
/** Bridge decisions only. Absence means not yet classified, distinct from UNKNOWN. */
export type BridgeIdentityState = "UNKNOWN" | "CONTRADICTION" | "CORROBORATED" | "SUSPICIOUS";

export interface NormalizedMediaItem {
  id: string;
  kind: NormalizedMediaKind;
  title: string;
  /** Authoritative series title, distinct from an episode title; never inferred. */
  seriesTitle?: string;
  year?: number;
  /** Trusted runtime of the exact requested media item; never a series-wide episode estimate. */
  runtimeSeconds?: number;
  season?: number;
  episode?: number;
  externalIds: Record<string, string | undefined>;
  classifications?: string[];
  stremio?: {
    type?: string;
    videoId?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface NormalizedStreamSource {
  providerId: string;
  type: StreamSourceType;
  url?: string;
  magnet?: string;
  infoHash?: string;
  title?: string;
  filename?: string;
  quality?: string;
  resolution?: string;
  codec?: string;
  audio?: string;
  language?: string;
  sizeBytes?: number;
  seeds?: number;
  fileIndex?: number;
  /** Sanitized source-local HTTP request headers for direct streams only. */
  requestHeaders?: SourceRequestHeaders;
  /** Bridge-owned HLS context. Shared provider normalization never copies it. */
  sourceHeaderScope?: SourceHeaderScope;
  /**
   * Observations made by DirectStreamProbe after the provider value passed URL
   * validation. Providers cannot set this field through normalization.
   */
  directHttp?: DirectHttpProbeMetadata;
  /** Providers may state content identity in metadata.identity. */
  metadata?: Record<string, unknown>;
}

export type DirectHttpProbeStatus = "verified" | "reachable" | "unreachable" | "timeout" | "budget_exhausted" | "route_rejected" | "unknown";

/** Bounded numeric release evidence only; never a resource locator or basename. */
export interface ResourceIdentity {
  kind?: "episode";
  season?: number;
  episode?: number;
  year?: number;
}

/** Probe-owned effective file observation. No basename, locator or query values. */
export interface MovieResourceObservation {
  source: "effective_root";
  validation: "video_200" | "range_206";
  titleKey: string;
  year: number;
  queryPresent: boolean;
}

/** Same validated file boundary; title may be absent without an exact prefix. */
export interface EpisodeResourceObservation extends Omit<MovieResourceObservation, "titleKey" | "year"> {
  titleKey?: string;
  season: number;
  episode: number;
  /** Only an unambiguous production year before the episode marker. */
  year?: number;
}

export interface DirectHttpProbeMetadata {
  status: DirectHttpProbeStatus;
  verified: boolean;
  rangeSupported: boolean;
  /** Upstream response status, when the probe received an HTTP response. */
  responseStatus?: number;
  firstByteLatencyMs?: number;
  contentType?: string;
  observedSizeBytes?: number;
  /** Explicit archive signature in the bounded initial response prefix. */
  archiveFormat?: "zip";
  /** An obvious non-media document signature in the bounded response prefix. */
  documentFormat?: "html" | "xml" | "json";
  /** The response body was recognized as an HLS playlist, not a media file. */
  hls?: boolean;
  /** Duration from a complete HLS VOD media playlist observed by the probe. */
  actualRuntimeSeconds?: number;
  runtimeEvidence?: "hls_vod" | "mp4_mvhd";
  /** From successfully observed effective media/selected HLS playlist URLs. */
  resourceIdentities?: ResourceIdentity[];
  /** Qualified movie title/year boundary; excludes HLS selectable-branch scope. */
  movieResource?: MovieResourceObservation;
  /** Exact episode facts from the validated effective file; excludes HLS. */
  episodeResource?: EpisodeResourceObservation;
}

export interface StreamProviderContext {
  signal: AbortSignal;
}

export interface StreamProvider {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly timeoutMs?: number;
  isEnabled(): boolean;
  diagnosticDetails?(): Pick<ProviderDiagnostic, "type" | "supports" | "streamCapabilities">;
  resolve(item: NormalizedMediaItem, context: StreamProviderContext): Promise<NormalizedStreamSource[]>;
}

export interface ProviderDiagnostic {
  id: string;
  name: string;
  type?: string;
  supports?: string[];
  streamCapabilities?: {
    types: string[];
    idPrefixes?: string[];
  };
  enabled: boolean;
  status: "ok" | "disabled" | "error" | "never-run";
  latencyMs?: number;
  lastError?: string;
  /** Number of candidates rejected for explicit identity contradictions in the last resolve. */
  identityRejections?: number;
}
