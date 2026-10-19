import "dotenv/config";
import { loadConfig } from "../src/config";
import { createCatalogProviders } from "../src/catalog/factory";
import { CatalogStreamProvider } from "../src/streams/providers/catalog-stream-provider";
import { ExternalHttpStreamProvider, type ExternalHttpDiagnosticEvent } from "../src/streams/providers/external-http-stream-provider";
import { LocalJsonStreamProvider } from "../src/streams/providers/local-json-stream-provider";
import { ManualStreamProvider } from "../src/streams/providers/manual-stream-provider";
import { StremioAddonStreamProvider, type StremioAddonDiagnosticEvent } from "../src/streams/providers/stremio-addon-stream-provider";
import { loadStremioAddonConfigs } from "../src/streams/stremio-addon-config";
import { createExternalProviderPolicy, createProviderEndpointPolicy, createUrlPolicy } from "../src/streams/factory";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StreamProviderRegistry, StreamResolver, type StreamResolverTrace } from "../src/streams/resolver";
import type { Logger } from "../src/logger";
import { DirectTransport } from "../src/network/outbound-transport";
import { createStreamMediaItem } from "../src/addon";
import { PlaybackManager } from "../src/playback/manager";
import { TriblerPlaybackBackend } from "../src/playback/backends";
import { DownloadService } from "../src/download-service";
import { FileManagedDownloadStore } from "../src/managed-download-store";
import { TriblerClient } from "../src/tribler-client";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const EPISODE_ID = /^tt\d{7,10}:\d{1,3}:\d{1,3}$/i;
const MOVIE_ID = /^tt\d{7,10}$/i;

function requestedCases(): Array<{ caseId: string; type: "series" | "movie"; videoId: string }> {
  const episodes = (process.env.DIAGNOSTIC_EPISODE_IDS ?? "").split(",")
    .map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!episodes.length || episodes.some((value) => !EPISODE_ID.test(value))) {
    throw new Error("DIAGNOSTIC_EPISODE_IDS_REQUIRED");
  }
  const movie = (process.env.DIAGNOSTIC_MOVIE_ID ?? "").trim().toLowerCase();
  if (movie && !MOVIE_ID.test(movie)) throw new Error("DIAGNOSTIC_MOVIE_ID_INVALID");
  return [
    ...episodes.slice(0, 10).map((videoId, index) => ({ caseId: `episode-${index + 1}`, type: "series" as const, videoId })),
    ...(movie ? [{ caseId: "movie-control", type: "movie" as const, videoId: movie }] : []),
  ];
}
const externalHttpOnly = process.argv.includes("--external-http-only");

type RawCapture = { requestType?: string; requestId?: string; httpStatus?: number; streams?: unknown[]; errorClass?: string };
type Stage = "provider" | "normalized" | "deduplicated" | "final";
type StageSources = Record<Stage, NormalizedStreamSource[]>;

function emptyStages(): StageSources {
  return { provider: [], normalized: [], deduplicated: [], final: [] };
}

function isTorrent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.type === "magnet" || raw.type === "torrent" || typeof raw.infoHash === "string" ||
    typeof raw.magnet === "string" || (typeof raw.url === "string" && raw.url.startsWith("magnet:"));
}

function isDirect(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url : "";
  return raw.type === "http" || raw.type === "https" || url.startsWith("http:") || url.startsWith("https:");
}

function rawSummary(streams: unknown[] | undefined) {
  const values = streams ?? [];
  let rawInfoHashCount = 0;
  let rawMagnetCount = 0;
  let rawHttpCount = 0;
  let rawHttpsCount = 0;
  let rawFileIdxCount = 0;
  let rawFilenameHintCount = 0;
  let rawUnsupportedCount = 0;
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { rawUnsupportedCount += 1; continue; }
    const raw = value as Record<string, unknown>;
    const url = typeof raw.url === "string" ? raw.url : "";
    if (typeof raw.infoHash === "string" && raw.infoHash.trim()) rawInfoHashCount += 1;
    if ((typeof raw.magnet === "string" && raw.magnet.startsWith("magnet:")) || url.startsWith("magnet:")) rawMagnetCount += 1;
    if (url.startsWith("http:")) rawHttpCount += 1;
    if (url.startsWith("https:")) rawHttpsCount += 1;
    if (Number.isSafeInteger(raw.fileIdx) && Number(raw.fileIdx) >= 0) rawFileIdxCount += 1;
    const hints = raw.behaviorHints;
    if (typeof hints === "object" && hints !== null && typeof (hints as Record<string, unknown>).filename === "string") rawFilenameHintCount += 1;
    if (!isTorrent(value) && !isDirect(value)) rawUnsupportedCount += 1;
  }
  return { rawStreamCount: values.length, rawInfoHashCount, rawMagnetCount, rawHttpCount, rawHttpsCount,
    rawFileIdxCount, rawFilenameHintCount, rawUnsupportedCount, rawTorrentCount: rawInfoHashCount + rawMagnetCount,
    rawDirectCount: rawHttpCount + rawHttpsCount };
}

function count(sources: readonly NormalizedStreamSource[], predicate: (source: NormalizedStreamSource) => boolean): number {
  return sources.filter(predicate).length;
}

function torrent(source: NormalizedStreamSource): boolean { return source.type === "magnet" || source.type === "torrent"; }
function direct(source: NormalizedStreamSource): boolean { return source.type === "http" || source.type === "https"; }

function classification(
  episode: boolean, providerType: string | undefined, capture: RawCapture, stages: StageSources, error: boolean
): string {
  if (error) return "PROVIDER_ERROR";
  if (episode && providerType === "stremio_addon" && (!capture.requestType || !capture.requestId)) {
    return "PROVIDER_EPISODE_REQUEST_BROKEN";
  }
  const raw = rawSummary(capture.streams);
  const providerTorrentCount = count(stages.provider, torrent);
  const normalizedTorrentCount = count(stages.normalized, torrent);
  const dedupedTorrentCount = count(stages.deduplicated, torrent);
  const finalTorrentCount = count(stages.final, torrent);
  if (raw.rawTorrentCount === 0) return providerType === "external_http"
    ? "ADAPTER_NO_TORRENTS" : "UPSTREAM_NO_TORRENTS";
  if (providerTorrentCount === 0 || normalizedTorrentCount === 0) return "RAW_TORRENT_DROPPED_BY_NORMALIZATION";
  if (dedupedTorrentCount === 0) return "NORMALIZED_TORRENT_DROPPED_BY_DEDUPE";
  if (finalTorrentCount === 0) return "NORMALIZED_TORRENT_DROPPED_BY_RESOLVER";
  return "TORRENT_SURVIVES_TO_FINAL_RESULTS";
}

class TraceProvider implements StreamProvider {
  readonly type: string;
  readonly timeoutMs?: number;
  constructor(private readonly inner: StreamProvider, private readonly capture: Map<string, RawCapture>, type?: string) {
    this.type = type ?? inner.type ?? "unknown";
    if (inner.timeoutMs !== undefined) this.timeoutMs = inner.timeoutMs;
  }
  get id(): string { return this.inner.id; }
  get name(): string { return this.inner.name; }
  isEnabled(): boolean { return this.inner.isEnabled(); }
  diagnosticDetails() { return this.inner.diagnosticDetails?.() ?? {}; }
  async resolve(item: NormalizedMediaItem, context: { signal: AbortSignal }): Promise<NormalizedStreamSource[]> {
    try {
      const streams = await this.inner.resolve(item, context);
      const entry = this.capture.get(this.inner.id) ?? {};
      entry.streams ??= streams;
      this.capture.set(this.inner.id, entry);
      return streams;
    } catch (error) {
      const entry = this.capture.get(this.inner.id) ?? {};
      entry.errorClass = error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT"
        : error instanceof Error ? error.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : "UNKNOWN";
      this.capture.set(this.inner.id, entry);
      throw error;
    }
  }
}

function itemFor(type: string, videoId: string): NormalizedMediaItem {
  return createStreamMediaItem(type, videoId);
}

async function main(): Promise<unknown> {
  const config = loadConfig();
  const urlPolicy = createUrlPolicy(config);
  const raw = new Map<string, RawCapture>();
  const providers: StreamProvider[] = [];
  const recordStremio = (id: string) => (event: StremioAddonDiagnosticEvent): void => {
    const capture = raw.get(id) ?? {};
    if (event.type === "request") { capture.requestType = event.requestType; capture.requestId = event.requestId; }
    else if (event.type === "response") capture.httpStatus = event.httpStatus;
    else capture.streams = event.streams;
    raw.set(id, capture);
  };
  const recordExternal = (id: string) => (event: ExternalHttpDiagnosticEvent): void => {
    const capture = raw.get(id) ?? {};
    if (event.type === "request") { capture.requestType = event.requestType; capture.requestId = event.requestId; }
    else if (event.type === "response") capture.httpStatus = event.httpStatus;
    else capture.streams = event.streams;
    raw.set(id, capture);
  };
  if (!externalHttpOnly && config.streamProviders.includes("catalog")) {
    for (const catalog of createCatalogProviders(config, urlPolicy)) providers.push(new CatalogStreamProvider(catalog));
  }
  if (!externalHttpOnly) providers.push(new ManualStreamProvider({}, config.streamProviders.includes("manual")));
  if (!externalHttpOnly && config.streamProviders.includes("local_json") && config.localStreamJsonFile) {
    providers.push(new LocalJsonStreamProvider(config.localStreamJsonFile, config.localStreamJsonDirectory));
  }
  if (config.streamProviders.includes("external_http") && config.externalStreamProviderEnabled && config.externalStreamProviderUrl) {
    providers.push(new ExternalHttpStreamProvider({ url: config.externalStreamProviderUrl,
      timeoutMs: config.externalStreamProviderTimeoutMs, policy: createExternalProviderPolicy(config),
      diagnostic: recordExternal("external_http") }));
  }
  if (!externalHttpOnly && config.streamProviders.includes("stremio_addons") && config.stremioAddonProvidersFile) {
    for (const addon of loadStremioAddonConfigs(config.stremioAddonProvidersFile)) {
      const id = `stremio-addon-${addon.id}`;
      providers.push(new StremioAddonStreamProvider({ ...addon, timeoutMs: config.stremioAddonRequestTimeoutMs,
        manifestTtlMs: config.stremioAddonManifestTtlMs, endpointPolicy: (url) => createProviderEndpointPolicy(config, url),
        diagnostic: recordStremio(id) }));
    }
  }
  const output: Array<Record<string, unknown>> = [];
  let firstFinalTorrent: NormalizedStreamSource | undefined;
  for (const testCase of requestedCases()) {
    raw.clear();
    const stagesByProvider = new Map<string, StageSources>();
    const trace: StreamResolverTrace = { stage: (stage, sources) => {
      if (stage === "probed" || stage === "admitted") return;
      for (const source of sources) {
        const stages = stagesByProvider.get(source.providerId) ?? emptyStages();
        stages[stage].push(source);
        stagesByProvider.set(source.providerId, stages);
      }
    } };
    const registry = new StreamProviderRegistry(config.streamProviderTimeoutMs, silentLogger, config.streamProviderMaxConcurrent);
    for (const provider of providers) registry.register(new TraceProvider(provider, raw,
      provider instanceof StremioAddonStreamProvider ? "stremio_addon"
        : provider instanceof ExternalHttpStreamProvider ? "external_http"
          : provider instanceof CatalogStreamProvider ? "catalog"
            : provider instanceof ManualStreamProvider ? "manual"
              : provider instanceof LocalJsonStreamProvider ? "local_json" : undefined));
    const transport = new DirectTransport(urlPolicy, config.httpPrivacy, silentLogger);
    const resolver = new StreamResolver(registry, urlPolicy,
      new DirectStreamProbe(transport, config.directHttpProbe, silentLogger), trace);
    const item = itemFor(testCase.type, testCase.videoId);
    const final = await resolver.resolve(item);
    firstFinalTorrent ??= final.find(torrent);
    const statuses = new Map(resolver.diagnostics().map((entry) => [entry.id, entry]));
    for (const provider of providers) {
      const status = statuses.get(provider.id);
      const capture = raw.get(provider.id) ?? {};
      const stages = stagesByProvider.get(provider.id) ?? emptyStages();
      const rawCounts = rawSummary(capture.streams);
      const providerError = status?.status === "error";
      output.push({
        case: testCase.caseId, providerId: provider.id, providerType: status?.type ?? provider.type ?? "unknown", enabled: status?.enabled ?? false,
        requestType: capture.requestType ?? item.kind, requestId: capture.requestId ?? item.id,
        requestSucceeded: !providerError && status?.status === "ok", httpStatus: capture.httpStatus ?? null,
        providerErrorClass: providerError ? capture.errorClass ?? "PROVIDER_ERROR" : null,
        identity: { kind: item.kind, imdbPresent: Boolean(item.externalIds.imdb), season: item.season ?? null,
          episode: item.episode ?? null, stremioType: item.stremio?.type ?? null, stremioVideoId: item.stremio?.videoId ?? null },
        ...rawCounts,
        normalizedTorrentCount: count(stages.normalized, torrent), normalizedHttpCount: count(stages.normalized, (source) => source.type === "http"),
        normalizedHttpsCount: count(stages.normalized, (source) => source.type === "https"),
        dedupedTorrentCount: count(stages.deduplicated, torrent), dedupedDirectCount: count(stages.deduplicated, direct),
        resolvedTorrentCount: count(stages.final, torrent), resolvedDirectCount: count(stages.final, direct),
        rankedTorrentCount: count(stages.final, torrent), rankedDirectCount: count(stages.final, direct),
        finalTorrentCount: count(final.filter((source) => source.providerId === provider.id), torrent),
        classification: classification(item.kind === "episode", provider.type, capture, stages, providerError)
      });
    }
  }
  const torrentSource = output.find((entry) => entry.classification === "TORRENT_SURVIVES_TO_FINAL_RESULTS");
  let playback: Record<string, unknown> = { torrentReachedPlayback: false };
  if (torrentSource) {
    const service = new DownloadService(new TriblerClient(config.triblerUrl, config.triblerApiKey, config.streamHeaderTimeoutMs),
      config, silentLogger, Date.now, new FileManagedDownloadStore(config.managedDownloadsStateFile, silentLogger));
    const backend = new TriblerPlaybackBackend(service);
    const source = firstFinalTorrent!;
    const manager = new PlaybackManager([backend]);
    const token = manager.register(source);
    playback = { torrentReachedPlayback: true, playbackTokenRegistered: /^[A-Za-z0-9_-]{32}$/.test(token),
      triblerBackendCanHandle: backend.canHandle(source) };
  }
  return { test: "diagnose-episodic-streams", cases: output, playback };
}

void main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
  process.stdout.write(JSON.stringify({ test: "diagnose-episodic-streams", error: "DIAGNOSTIC_FAILED" }) + "\n");
  process.exitCode = 1;
});
