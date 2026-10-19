import "dotenv/config";
import { caseSegments, loadEvaluationCases } from "./evaluation-corpus";
import { loadConfig } from "../src/config";
import type { Logger } from "../src/logger";
import { DirectTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { createProviderEndpointPolicy, createUrlPolicy } from "../src/streams/factory";
import { ProviderQualityEvaluation, formatProviderQualityTable } from "../src/streams/provider-quality-evaluation";
import { EvaluationCost } from "../src/streams/evaluation-cost";
import { IdentityPrecisionEvaluation } from "../src/streams/identity-precision-evaluation";
import { SourceDiversityEvaluation, composeResolverTraces } from "../src/streams/source-diversity-evaluation";
import { StremioAddonStreamProvider } from "../src/streams/providers/stremio-addon-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { loadStremioAddonConfigs } from "../src/streams/stremio-addon-config";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

type FailureCategory = "invalid arguments" | "invalid input" | "bridge configuration invalid"
  | "addon configuration unavailable" | "direct probe disabled"
  | "provider initialization failed" | "resolution failed" | "unexpected failure";

class EvaluationFailure extends Error {
  constructor(readonly category: FailureCategory) { super(category); }
}

function stage<T>(category: FailureCategory, action: () => T): T {
  try { return action(); } catch { throw new EvaluationFailure(category); }
}


async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 3) || (args[0] !== "--input" && args[0] !== "--corpus")
    || (args.length === 3 && args[2] !== "--json")) throw new EvaluationFailure("invalid arguments");
  const corpus = stage("invalid input", () => loadEvaluationCases(args[1]!, args[0] as "--input" | "--corpus"));
  const config = stage("bridge configuration invalid", loadConfig);
  if (!config.stremioAddonProvidersFile) throw new EvaluationFailure("addon configuration unavailable");
  if (!config.directHttpProbe.enabled) throw new EvaluationFailure("direct probe disabled");
  const addons = stage("addon configuration unavailable", () =>
    loadStremioAddonConfigs(config.stremioAddonProvidersFile!).filter((addon) => addon.enabled));
  const ids = addons.map((addon) => "stremio-addon-" + addon.id);
  const identity = new IdentityPrecisionEvaluation(ids, { diagnostics: true });
  const diversity = new SourceDiversityEvaluation(ids);
  const cost = new EvaluationCost(ids);
  const evaluator = new ProviderQualityEvaluation(addons.map((addon) => ({
    id: `stremio-addon-${addon.id}`, name: addon.name
  })));
  const { policy, probe, providers } = stage("provider initialization failed", () => {
    const policy = createUrlPolicy(config);
    const transport = new DirectTransport(policy, config.httpPrivacy, quiet);
    const probe = new DirectStreamProbe(transport, config.directHttpProbe, quiet);
    const providers = addons.map((addon) => new StremioAddonStreamProvider({
    ...addon, timeoutMs: config.stremioAddonRequestTimeoutMs,
    manifestTtlMs: config.stremioAddonManifestTtlMs,
    endpointPolicy: (url) => createProviderEndpointPolicy(config, url),
    diagnostic: (event) => {
      if (event.type === "request") cost.request("stremio-addon-" + addon.id);
      if (event.type === "response") cost.response("stremio-addon-" + addon.id);
      if (event.type === "raw-streams") evaluator.rawStreams(`stremio-addon-${addon.id}`, event.streams);
    }
    }));
    return { policy, probe, providers };
  });
  for (const evaluationCase of corpus.cases) {
    const item = evaluationCase.item;
    const registry = stage("provider initialization failed", () => {
      const registry = new StreamProviderRegistry(config.streamProviderTimeoutMs, quiet, config.streamProviderMaxConcurrent);
      for (const provider of providers) registry.register(provider);
      return registry;
    });
    const trace = evaluator.itemTrace();
    const observation = diversity.item(caseSegments(evaluationCase));
    const resolver = new StreamResolver(registry, policy, probe,
      composeResolverTraces(trace, observation.trace, identity.itemTrace(item)), config.streamRankingPolicy);
    try { await resolver.resolve(item); }
    catch { throw new EvaluationFailure("resolution failed"); }
    evaluator.finishItem(trace);
    observation.finish();
    for (const diagnostic of resolver.diagnostics()) {
      if (diagnostic.status === "ok" || diagnostic.status === "error")
        cost.evaluation(diagnostic.id, diagnostic.status, diagnostic.latencyMs);
    }
  }
  const report = { ...evaluator.report(), kind: "stremio", version: 3,
    corpus: { id: corpus.id, version: corpus.version, fingerprint: corpus.fingerprint },
    segments: diversity.report(), cost: cost.report(), identityPrecision: identity.report() };
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report)}\n`
    : `${formatProviderQualityTable(report)}\n`);
}

void main().catch((error: unknown) => {
  const category = error instanceof EvaluationFailure ? error.category : "unexpected failure";
  process.stderr.write(`EVALUATION_FAILED: ${category}\n`);
  process.exitCode = 1;
});
