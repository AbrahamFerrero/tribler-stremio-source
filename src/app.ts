import express, { type NextFunction, type Request, type Response } from "express";
import { getRouter } from "stremio-addon-sdk";
import { createAddon } from "./addon";
import { localRequestPolicy } from "./local-request-policy";
import { createAutomaticStreamHandler, proxyDirectHttp } from "./automatic-stream";
import type { SourceHeaderScope, SourceRequestHeaders } from "./network/http-privacy";
import type { RepresentationState } from "./playback/representation";
import { rewriteHlsPlaylist } from "./hls-playlist";
import { createCatalogProviders } from "./catalog/factory";
import type { CatalogProvider } from "./catalog/types";
import { DownloadService } from "./download-service";
import { ActiveStreamError, ManagedDownloadNotFoundError, MetadataTimeoutError, NoSeedsError, NoVideoFileError, RetentionConflictError, TriblerError, UnsafeFileSelectionError } from "./errors";
import { safeErrorDetails, safeErrorType, type Logger } from "./logger";
import { StremioMovieMetadataLookup } from "./metadata/movie-metadata";
import { FileManagedDownloadStore } from "./managed-download-store";
import type { ExternalUrlPolicy } from "./network/url-policy";
import { DirectTransport, type OutboundTransport } from "./network/outbound-transport";
import { DirectHttpPlaybackBackend, TriblerPlaybackBackend } from "./playback/backends";
import { PlaybackManager } from "./playback/manager";
import { createHeadHandler, createStreamHandler } from "./stream-proxy";
import { createProviderEndpointPolicy, createStreamResolver, createUrlPolicy } from "./streams/factory";
import { discoverTriblerEndpoint } from "./tribler-endpoint-discovery";
import { TriblerClient } from "./tribler-client";
import { TriblerStreamingMetrics } from "./tribler-streaming-metrics";
import type { AppConfig } from "./types";

function statusFor(error: unknown): number {
  if (error instanceof NoSeedsError || error instanceof NoVideoFileError || error instanceof UnsafeFileSelectionError) return 422;
  if (error instanceof ManagedDownloadNotFoundError) return 404;
  if (error instanceof ActiveStreamError || error instanceof RetentionConflictError) return 409;
  if (error instanceof MetadataTimeoutError) return 504;
  if (error instanceof TriblerError) return error.status === 401 ? 502 : (error.status ?? 502);
  return 400;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

function requestAbortSignal(req: Request): AbortSignal {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort(new Error("Client disconnected")));
  return controller.signal;
}

function stringParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function requestBody(req: Request): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : {};
}

export function createApp(
  config: AppConfig,
  log: Logger,
  client?: TriblerClient,
  provider?: CatalogProvider | CatalogProvider[],
  urlPolicyOverride?: ExternalUrlPolicy,
  outboundTransportOverride?: OutboundTransport
) {
  const tribler = client ?? new TriblerClient(
    config.triblerUrl,
    config.triblerApiKey,
    config.streamHeaderTimeoutMs,
    fetch,
    config.triblerAutoDiscover ? () => discoverTriblerEndpoint(config.triblerApiKey) : undefined
  );
  const triblerStreaming = new TriblerStreamingMetrics();
  const store = new FileManagedDownloadStore(config.managedDownloadsStateFile, log);
  const service = new DownloadService(tribler, config, log, Date.now, store, triblerStreaming);
  const urlPolicy = urlPolicyOverride ?? createUrlPolicy(config);
  const outboundTransport = outboundTransportOverride ?? new DirectTransport(urlPolicy, config.httpPrivacy, log);
  const catalogs = provider ? (Array.isArray(provider) ? provider : [provider]) : createCatalogProviders(config, urlPolicy);
  const resolver = createStreamResolver(catalogs, config, log, urlPolicy, outboundTransport);
  const movieMetadata = config.stremioMovieMetadataBaseUrl
    ? new StremioMovieMetadataLookup({
      baseUrl: config.stremioMovieMetadataBaseUrl,
      endpointPolicy: (url) => createProviderEndpointPolicy(config, url)
    }) : undefined;
  const httpPrivacyDiagnostics = () => ({
    mode: config.httpPrivacy.mode,
    transport: outboundTransport.id,
    dnsMode: config.httpPrivacy.dnsMode,
    cookies: config.httpPrivacy.acceptCookies,
    referer: config.httpPrivacy.sendReferer,
    sourceHeaderPolicy: "entry-origin-minimized-or-local-exact-rule",
    refererIsDefault: true,
    automaticDowngrade: false,
    metrics: outboundTransport.diagnostics(),
    directProbe: resolver.directProbeDiagnostics()
  });
  const playback = new PlaybackManager([
    new DirectHttpPlaybackBackend(outboundTransport),
    new TriblerPlaybackBackend(service)
  ], config.httpStreamTokenTtlMs, config.httpStreamTokenMaxEntries);
  const addon = createAddon(
    service, log, catalogs, config.publicBaseUrl, config.legalTestMagnet, resolver, playback, movieMetadata
  );
  const app = express();
  app.disable("x-powered-by");
  app.use(localRequestPolicy(config.bridgeAdminToken));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", asyncRoute(async (_req, res) => {
    const providerDiagnostics = (): Record<string, string> => Object.fromEntries(
      resolver.diagnostics().map((entry) => [entry.id, entry.status])
    );
    const providersDegraded = (): boolean => resolver.diagnostics().some((entry) => entry.enabled && entry.status === "error");
    try {
      const downloads = await tribler.listDownloads();
      const degraded = providersDegraded();
      res.status(degraded ? 503 : 200).json({
        ok: !degraded,
        bridge: degraded ? "degraded" : "ready",
        tribler: "reachable",
        downloads: downloads.length,
        providers: providerDiagnostics(),
        httpPrivacy: httpPrivacyDiagnostics()
        ,triblerStreaming: triblerStreaming.snapshot()
      });
    } catch {
      res.status(503).json({
        ok: false,
        bridge: "unavailable",
        tribler: "unreachable",
        providers: providerDiagnostics(),
        httpPrivacy: httpPrivacyDiagnostics(),
        error: "Tribler health check failed"
      });
    }
  }));

  app.get("/downloads", asyncRoute(async (req, res) => {
    const downloads = await service.diagnostics(requestAbortSignal(req));
    res.json({ downloads: downloads.map(({
      infohash, name, status, progress, speed_down, speed_up, num_peers, num_seeds, time_added, size, bridge
    }) => ({
      infohash,
      name: typeof name === "string" && !/https?:\/\/|magnet:\?/i.test(name) ? name : "[redacted]",
      status, progress, speed_down, speed_up, num_peers, num_seeds,
      ...(time_added !== undefined ? { time_added } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(bridge ? { bridge } : {})
    })) });
  }));

  app.get("/providers", (_req, res) => {
    res.json({ providers: resolver.diagnostics() });
  });

  app.post("/resolve", asyncRoute(async (req, res) => {
    const body = requestBody(req);
    const source = typeof body.source === "string" ? body.source : "";
    const rawIndex = body.fileIndex;
    const fileIndex = rawIndex === undefined ? undefined : Number(rawIndex);
    if (!source || (fileIndex !== undefined && (!Number.isSafeInteger(fileIndex) || fileIndex < 0))) {
      res.status(400).json({ error: "source is required and fileIndex must be a non-negative integer" });
      return;
    }
    const resolved = await service.resolve(source, fileIndex, requestAbortSignal(req));
    res.json(resolved);
  }));

  app.post("/downloads/:infohash/select", asyncRoute(async (req, res) => {
    const fileIndex = Number(requestBody(req).fileIndex);
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      res.status(400).json({ error: "fileIndex must be a non-negative integer" });
      return;
    }
    res.json(await service.selectFile(stringParam(req.params.infohash), fileIndex, requestAbortSignal(req)));
  }));

  app.delete("/downloads/:infohash", asyncRoute(async (req, res) => {
    const removeData = req.query.removeData === "true";
    await service.cancelDownload(stringParam(req.params.infohash), removeData, requestAbortSignal(req));
    res.status(204).end();
  }));

  app.post("/downloads/:infohash/pin", asyncRoute((req, res) => {
    res.json({ bridge: service.pin(stringParam(req.params.infohash)) });
  }));

  app.delete("/downloads/:infohash/pin", asyncRoute((req, res) => {
    res.json({ bridge: service.unpin(stringParam(req.params.infohash)) });
  }));

  const playPath = "/play/:infohash/:fileIndex/:filename";
  app.head(playPath, createHeadHandler(service));
  app.get(playPath, (req, res) => {
    void createStreamHandler(service, config.streamHeaderTimeoutMs, log, config.triblerStreamBuffer, triblerStreaming)(req, res);
  });

  const hlsProxyFor = (parent?: RepresentationState) => ({
    rewritePlaylist: async (text: string, parentUrl: string, sourceHeaders?: SourceRequestHeaders, scope?: SourceHeaderScope): Promise<string> => rewriteHlsPlaylist(text, parentUrl, {
      validateResource: async (url) => { await urlPolicy.validate(url); },
      localResourceUrls: (resources) => playback.registerHlsResources(resources.map(({ url, kind }) => ({
        url, isMediaSegment: kind === "segment"
      })), sourceHeaders, scope, parent).map((token) => `${config.publicBaseUrl}/hls/${token}`)
    })
  });
  const proxySource = async (
    source: { url?: string; filename?: string; sizeBytes?: number; hlsMediaSegment?: boolean; requestHeaders?: SourceRequestHeaders; sourceHeaderScope?: SourceHeaderScope }, req: Request, res: Response,
    signal: AbortSignal, method: "GET" | "HEAD", representation?: RepresentationState
  ): Promise<void> => {
    if (!source.url) throw new Error("Direct playback source is missing");
    await proxyDirectHttp({
      url: source.url,
      fileName: source.filename ?? "video",
      size: source.sizeBytes ?? 0,
      ...(source.requestHeaders ? { requestHeaders: source.requestHeaders } : {}),
      ...(source.sourceHeaderScope ? { sourceHeaderScope: source.sourceHeaderScope } : {})
    }, req, res, config.directHttpTimeoutMs, signal, method, outboundTransport,
    source.hlsMediaSegment ? { ...hlsProxyFor(representation), mediaSegment: true } : hlsProxyFor(representation), representation);
  };
  const sourcePlayback = (method: "GET" | "HEAD") => asyncRoute(async (req, res) => {
    const token = stringParam(req.params.token);
    const signal = requestAbortSignal(req);
    const playable = await playback.prepare(token, signal);
    if (playable.kind === "redirect" && playable.url) {
      res.redirect(307, playable.url);
      return;
    }
    const source = playable.source;
    if (!source?.url || !playable.transport) throw new Error("Direct playback source is missing");
    try {
      await proxySource(source, req, res, signal, method, playable.representation);
    } catch (error) {
      if (res.headersSent) throw error;
      log.warn("Direct source playback failed", {
        error: safeErrorDetails(error)
      });
      res.status(502).json({ error: "Direct playback failed" });
    }
  });
  app.head("/source/:token/:filename", sourcePlayback("HEAD"));
  app.get("/source/:token/:filename", sourcePlayback("GET"));
  const hlsPlayback = (method: "GET" | "HEAD") => asyncRoute(async (req, res) => {
    const signal = requestAbortSignal(req);
    const source = playback.prepareHlsResource(stringParam(req.params.token));
    await proxySource(source, req, res, signal, method, source.representation);
  });
  app.head("/hls/:token", hlsPlayback("HEAD"));
  app.get("/hls/:token", hlsPlayback("GET"));

  const automaticPath = "/auto/:token/:filename";
  const automaticHead = createAutomaticStreamHandler(
    service, catalogs, config.legalTestMagnet, config.directHttpTimeoutMs, log, "HEAD", outboundTransport, hlsProxyFor()
  );
  const automaticGet = createAutomaticStreamHandler(
    service, catalogs, config.legalTestMagnet, config.directHttpTimeoutMs, log, "GET", outboundTransport, hlsProxyFor()
  );
  app.head(automaticPath, automaticHead);
  app.get(automaticPath, automaticGet);

  const addonRouter = getRouter(addon);
  app.use((req, res, next) => {
    if (/^\/(?:manifest\.json\/?$|(?:catalog|meta|stream)\/)/.test(req.path)) addonRouter(req, res, next);
    else next();
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error("HTTP request failed", { error: safeErrorDetails(error) });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(statusFor(error)).json({
      error: "Request failed",
      type: safeErrorType(error)
    });
  });

  return { app, service, addon };
}
