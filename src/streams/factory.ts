import type { CatalogProvider } from "../catalog/types";
import { safeErrorDetails, type Logger } from "../logger";
import { ExternalUrlPolicy } from "../network/url-policy";
import type { OutboundTransport } from "../network/outbound-transport";
import type { AppConfig } from "../types";
import { AddonRequestIdentityResolver } from "./addon-request-identity";
import { ExternalHttpStreamProvider } from "./providers/external-http-stream-provider";
import { StremioAddonStreamProvider } from "./providers/stremio-addon-stream-provider";
import { CatalogStreamProvider } from "./providers/catalog-stream-provider";
import { LocalJsonStreamProvider } from "./providers/local-json-stream-provider";
import { ManualStreamProvider } from "./providers/manual-stream-provider";
import { StreamProviderRegistry, StreamResolver, type StreamResolverTrace } from "./resolver";
import { DirectStreamProbe } from "./direct-stream-probe";
import { loadStremioAddonConfigs } from "./stremio-addon-config";

function internalEndpoints(config: AppConfig): Array<{ hostname: string; port: string }> {
  return [new URL(config.triblerUrl), new URL(config.publicBaseUrl)].map((url) => ({
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80")
  }));
}

export function createUrlPolicy(config: AppConfig): ExternalUrlPolicy {
  return new ExternalUrlPolicy({ blockedEndpoints: internalEndpoints(config) });
}

export function createProviderEndpointPolicy(config: AppConfig, endpointUrl: string): ExternalUrlPolicy {
  return new ExternalUrlPolicy({
    blockedEndpoints: internalEndpoints(config),
    allowedLoopbackUrls: [endpointUrl]
  });
}

export function createExternalProviderPolicy(config: AppConfig): ExternalUrlPolicy {
  return createProviderEndpointPolicy(config, config.externalStreamProviderUrl ?? "https://invalid.example/");
}

export function createStreamResolver(
  catalogs: CatalogProvider[],
  config: AppConfig,
  log: Logger,
  policy: ExternalUrlPolicy,
  transport?: OutboundTransport,
  identityResolver = new AddonRequestIdentityResolver(),
  trace?: StreamResolverTrace
): StreamResolver {
  const registry = new StreamProviderRegistry(
    config.streamProviderTimeoutMs,
    log,
    config.streamProviderMaxConcurrent
  );
  const enabled = new Set(config.streamProviders);
  for (const id of enabled) {
    if (!["catalog", "manual", "local_json", "external_http", "stremio_addons"].includes(id)) {
      log.warn("Unknown stream provider ignored", { provider: id });
    }
  }
  if (enabled.has("catalog")) {
    for (const catalog of catalogs) registry.register(new CatalogStreamProvider(catalog));
  }
  registry.register(new ManualStreamProvider({}, enabled.has("manual")));
  if (enabled.has("local_json") && config.localStreamJsonFile) {
    try {
      registry.register(new LocalJsonStreamProvider(config.localStreamJsonFile, config.localStreamJsonDirectory));
    } catch (error) {
      log.warn("Local JSON stream provider disabled", {
        error: safeErrorDetails(error)
      });
    }
  }
  if (enabled.has("local_json") && !config.localStreamJsonFile) {
    log.warn("Local JSON stream provider disabled", { error: "STREAM_PROVIDER_LOCAL_JSON_FILE is not configured" });
  }
  if (enabled.has("external_http") && config.externalStreamProviderEnabled && config.externalStreamProviderUrl) {
    registry.register(new ExternalHttpStreamProvider({
      url: config.externalStreamProviderUrl,
      timeoutMs: config.externalStreamProviderTimeoutMs,
      policy: createExternalProviderPolicy(config)
    }));
  } else {
    if (enabled.has("external_http") && config.externalStreamProviderEnabled) {
      log.warn("External HTTP stream provider disabled", { error: "STREAM_PROVIDER_EXTERNAL_URL is not configured" });
    }
    registry.register(new ExternalHttpStreamProvider({ url: "", timeoutMs: config.externalStreamProviderTimeoutMs, policy }));
  }
  if (enabled.has("stremio_addons")) {
    if (!config.stremioAddonProvidersFile) {
      log.warn("Stremio addon providers disabled", {
        error: "STREAM_PROVIDER_STREMIO_ADDONS_FILE is not configured"
      });
    } else {
      try {
        for (const addon of loadStremioAddonConfigs(config.stremioAddonProvidersFile)) {
          registry.register(new StremioAddonStreamProvider({
            ...addon,
            timeoutMs: config.stremioAddonRequestTimeoutMs,
            manifestTtlMs: config.stremioAddonManifestTtlMs,
            endpointPolicy: (url) => createProviderEndpointPolicy(config, url),
            identityResolver
          }));
        }
      } catch (error) {
        log.warn("Stremio addon providers disabled", {
          error: safeErrorDetails(error)
        });
      }
    }
  }
  const directProbe = transport ? new DirectStreamProbe(transport, config.directHttpProbe, log) : undefined;
  return new StreamResolver(registry, policy, directProbe, trace, config.streamRankingPolicy);
}
