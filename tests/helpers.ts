export const syntheticAdminToken = "a1".repeat(32);
import type { OutboundRequest, OutboundTransport } from "../src/network/outbound-transport";
import type { AppConfig } from "../src/types";
import { defaultStreamRankingPolicy } from "../src/streams/ranking-policy";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 7000,
    bridgeAdminToken: syntheticAdminToken,
    publicBaseUrl: "http://127.0.0.1:7000",
    triblerUrl: "http://127.0.0.1:9999",
    triblerApiKey: "test-key",
    triblerAutoDiscover: false,
    torrentSafetyMode: "fast",
    archiveHttpStreams: true,
    catalogProvider: "internet-archive",
    catalogQuery: 'mediatype:movies AND format:"Archive BitTorrent" AND collection:feature_films',
    catalogPageSize: 50,
    catalogCacheTtlMs: 300_000,
    catalogRequestTimeoutMs: 15_000,
    directHttpTimeoutMs: 250,
    directHttpProbe: { enabled: false, timeoutMs: 250, maxCandidates: 8, maxConcurrent: 3 },
    streamRankingPolicy: defaultStreamRankingPolicy,
    httpPrivacy: {
      mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
      acceptCookies: false, userAgentMode: "minimal", maxRedirects: 3
    },
    httpStreamTokenTtlMs: 3_600_000,
    httpStreamTokenMaxEntries: 1_000,
    streamProviders: ["catalog"],
    streamProviderTimeoutMs: 250,
    streamProviderMaxConcurrent: 8,
    externalStreamProviderEnabled: false,
    externalStreamProviderTimeoutMs: 250,
    stremioAddonManifestTtlMs: 60_000,
    stremioAddonRequestTimeoutMs: 250,
    localStreamJsonDirectory: ".",
    metadataTimeoutMs: 1_000,
    noSeedsTimeoutMs: 30,
    pollIntervalMs: 1,
    streamHeaderTimeoutMs: 1_000,
    triblerStreamBuffer: { enabled: true, startupBytes: 8 * 1024 * 1024, seekBytes: 4 * 1024 * 1024,
      maxBytes: 64 * 1024 * 1024, prebufferTimeoutMs: 15_000 },
    downloadRetentionMode: "smart",
    cleanupIntervalMs: 1_000,
    cleanupRemoveData: false,
    managedDownloadsStateFile: ".bridge-state/test-managed-downloads.json",
    ...overrides
  };
}

export const silentLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
};

export type FixtureOutboundRequest = (request: OutboundRequest, signal?: AbortSignal) => Promise<Response>;
export function fixtureOutboundRequest(request: FixtureOutboundRequest): OutboundTransport["request"] {
  return async (outbound, signal) => ({ response: await request(outbound, signal), effectiveUrl: outbound.url });
}
