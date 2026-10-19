import "dotenv/config";
import { loadConfig } from "../src/config";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { loadEvaluationCases } from "./evaluation-corpus";
import { createCatalogProviders } from "../src/catalog/factory";
import { CatalogStreamProvider } from "../src/streams/providers/catalog-stream-provider";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";
import { LocalJsonStreamProvider } from "../src/streams/providers/local-json-stream-provider";
import { StremioAddonStreamProvider } from "../src/streams/providers/stremio-addon-stream-provider";
import { loadStremioAddonConfigs } from "../src/streams/stremio-addon-config";
import { createExternalProviderPolicy, createProviderEndpointPolicy, createUrlPolicy } from "../src/streams/factory";
import { StremioMovieMetadataLookup } from "../src/metadata/movie-metadata";
import { DirectTransport } from "../src/network/outbound-transport";
import { requestPinned } from "../src/network/url-policy";
import type { StreamProvider } from "../src/streams/types";
import type { Logger } from "../src/logger";
import { formatSmokeReport, rotateProviders, sampleSmokeCase, smokeCases, smokeReport, SMOKE_LIMITS,
  trustedSmokeItem, withinSmokeDeadline, providerCounts, parseSmokeArgs, type SmokeRow } from "./identity-live-smoke-runner";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function main(): Promise<void> {
  const { corpusPath, mode, json } = parseSmokeArgs(process.argv.slice(2));
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMOKE_LIMITS[mode].deadlineMs);
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const corpus = loadEvaluationCases(corpusPath, "--corpus");
    const cases = smokeCases(corpus, mode);
    const config = loadConfig();
    const policy = createUrlPolicy(config);
    let mediaRequests = 0;
    const transport = new DirectTransport(policy, config.httpPrivacy, quiet, async (target, init) => {
      mediaRequests += 1;
      return requestPinned(target, init); // Existing validated/pinned socket boundary, including redirects.
    });
    const providers: StreamProvider[] = [];
    const probe = new DirectStreamProbe(transport, { ...config.directHttpProbe,
      maxCandidates: Math.min(SMOKE_LIMITS[mode].slots, config.directHttpProbe.maxCandidates),
      maxConcurrent: Math.min(2, config.directHttpProbe.maxConcurrent),
      timeoutMs: Math.min(mode === "QUICK" ? 1500 : 3000, config.directHttpProbe.timeoutMs) }, quiet);
    const enabled = new Set(config.streamProviders);
    if (enabled.has("external_http") && config.externalStreamProviderEnabled && config.externalStreamProviderUrl) {
      providers.push(new ExternalHttpStreamProvider({ url: config.externalStreamProviderUrl,
        timeoutMs: Math.min(3000, config.externalStreamProviderTimeoutMs), policy: createExternalProviderPolicy(config) }));
    }
    if (enabled.has("stremio_addons") && config.stremioAddonProvidersFile) {
      for (const addon of loadStremioAddonConfigs(config.stremioAddonProvidersFile).filter(addon => addon.enabled)) {
        providers.push(new StremioAddonStreamProvider({ ...addon,
          timeoutMs: Math.min(3000, config.stremioAddonRequestTimeoutMs), manifestTtlMs: config.stremioAddonManifestTtlMs,
          endpointPolicy: url => createProviderEndpointPolicy(config, url) }));
      }
    }
    if (enabled.has("catalog")) {
      providers.push(...createCatalogProviders(config, policy).map(catalog => new CatalogStreamProvider(catalog)));
    }
    if (enabled.has("local_json") && config.localStreamJsonFile) {
      providers.push(new LocalJsonStreamProvider(config.localStreamJsonFile, config.localStreamJsonDirectory));
    }
    const rows: SmokeRow[] = [];
    const selectedProviders = new Map<string, StreamProvider>();
    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index]!;
      const caseStart = Date.now();
      if (controller.signal.aborted) {
        rows.push({ caseId: entry.id, cohort: `${entry.mediaClass}/${entry.cohort}`, status: "not_executed", elapsedMs: 0, diagnostics: null });
        continue;
      }
      const lookup = new StremioMovieMetadataLookup({ baseUrl: config.stremioMovieMetadataBaseUrl ?? "https://v3-cinemeta.strem.io",
        endpointPolicy: url => createProviderEndpointPolicy(config, url),
        timeoutMs: Math.max(1, Math.min(1500, SMOKE_LIMITS[mode].deadlineMs - (Date.now() - start))) });
      let item;
      try { item = await withinSmokeDeadline(() => trustedSmokeItem(entry.item, lookup), controller.signal); }
      catch {
        rows.push({ caseId: entry.id, cohort: `${entry.mediaClass}/${entry.cohort}`,
          status: controller.signal.aborted ? "timed_out" : "failed", elapsedMs: Date.now() - caseStart, diagnostics: null });
        continue;
      }
      const chosen = rotateProviders(providers, index);
      for (const provider of chosen) selectedProviders.set(provider.id, provider);
      const row = await sampleSmokeCase(entry, item, chosen, config, policy, transport, quiet, controller.signal, mode, () => mediaRequests, probe);
      row.elapsedMs = Date.now() - caseStart;
      rows.push(row);
    }
    const report = smokeReport(mode, rows, Date.now() - start, { configuredEnabled: providerCounts(providers),
      selectedDistinct: providerCounts([...selectedProviders.values()]) });
    process.stdout.write((json ? JSON.stringify(report) : formatSmokeReport(report)) + "\n");
  } finally {
    clearTimeout(timer); controller.abort();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}
void main().catch(() => { console.error("IDENTITY_SMOKE_FAILED: invalid input, configuration or unavailable environment; no raw details emitted."); process.exitCode = 1; });
