import "dotenv/config";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { caseSegments, loadEvaluationCases } from "./evaluation-corpus";
import { EVALUATION_REPORT_MAX_BYTES } from "../src/streams/evaluation-comparison";
import { loadConfig } from "../src/config";
import type { Logger } from "../src/logger";
import { DirectTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { createUrlPolicy } from "../src/streams/factory";
import { KodiSourceQualityEvaluation, formatKodiSourceQualityTable, validateBatches,
  type KodiSourceBatch } from "../src/streams/kodi-source-quality-evaluation";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { IdentityPrecisionEvaluation } from "../src/streams/identity-precision-evaluation";
import { composeResolverTraces } from "../src/streams/source-diversity-evaluation";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import type { StreamResolverTrace } from "../src/streams/resolver";

const quiet: Logger = { debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined };
const HOST_DIRECTORY = resolve(__dirname, "../python-adapter-host");
const MAX_CHILD_BYTES = 8_000_000;
const ALLOWED_ENV = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|COMSPEC|LANG|LC_ALL|PYTHONIOENCODING|PYTHONUTF8|PYTHON_ADAPTER_[A-Z0-9_]+)$/i;
const SECRET_ENV = /(secret|password|credential|cookie|authorization|api[_-]?key|token)/i;

type FailureCategory = "invalid arguments" | "invalid input" | "bridge configuration invalid"
  | "direct probe disabled" | "python child failed" | "python response invalid"
  | "resolution failed" | "report too large" | "unexpected failure";
class EvaluationFailure extends Error {
  constructor(readonly category: FailureCategory) { super(category); }
}
function stage<T>(category: FailureCategory, action: () => T): T {
  try { return action(); } catch { throw new EvaluationFailure(category); }
}
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ALLOWED_ENV.test(name) && !SECRET_ENV.test(name) && !/^TRIBLER_/i.test(name)));
}
function mediaForPython(item: NormalizedMediaItem): object {
  return { id: item.id, kind: item.kind, title: item.title,
    ...(item.seriesTitle !== undefined ? { seriesTitle: item.seriesTitle } : {}),
    ...(item.year !== undefined ? { year: item.year } : {}),
    ...(item.season !== undefined ? { season: item.season } : {}),
    ...(item.episode !== undefined ? { episode: item.episode } : {}),
    externalIds: Object.fromEntries(Object.entries(item.externalIds).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string")),
    ...(item.classifications ? { classifications: item.classifications } : {}) };
}
export async function pythonBatches(item: NormalizedMediaItem): Promise<KodiSourceBatch[]> {
  const payload = JSON.stringify(mediaForPython(item));
  if (Buffer.byteLength(payload) > 32_768) throw new EvaluationFailure("invalid input");
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("python", ["-B", "-m", "adapter_host.evaluate_kodi_sources"], {
      cwd: HOST_DIRECTORY, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    child.stdout.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_CHILD_BYTES) { failed = true; child.kill(); return; }
      chunks.push(part);
    });
    // Consume but never forward child stderr; worker failures may contain private context.
    child.stderr.resume();
    child.on("error", () => reject(new EvaluationFailure("python child failed")));
    child.on("close", (code) => {
      if (failed || code !== 0) reject(new EvaluationFailure("python child failed"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(payload);
  });
  return stage("python response invalid", () => validateBatches(JSON.parse(output.toString("utf8")) as unknown));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 3) || (args[0] !== "--input" && args[0] !== "--corpus")
    || (args.length === 3 && args[2] !== "--json")) throw new EvaluationFailure("invalid arguments");
  const corpus = stage("invalid input", () => loadEvaluationCases(args[1]!, args[0] as "--input" | "--corpus"));
  const config = stage("bridge configuration invalid", loadConfig);
  if (!config.directHttpProbe.enabled) throw new EvaluationFailure("direct probe disabled");
  const policy = stage("bridge configuration invalid", () => createUrlPolicy(config));
  const transport = new DirectTransport(policy, config.httpPrivacy, quiet);
  const probe = new DirectStreamProbe(transport, config.directHttpProbe, quiet);
  let evaluator: KodiSourceQualityEvaluation | undefined;
  let identity: IdentityPrecisionEvaluation | undefined;
  for (const evaluationCase of corpus.cases) {
    const item = evaluationCase.item;
    const batches = await pythonBatches(item);
    evaluator ??= new KodiSourceQualityEvaluation(batches.map(({ profileId, sourceId }) => ({ profileId, sourceId })));
    identity ??= new IdentityPrecisionEvaluation(batches.map((_, index) => "kodi-" + index), { diagnostics: true });
    const identityTrace = identity.itemTrace(item);
    try {
      await evaluator.evaluateItem(batches, async (providers, trace: StreamResolverTrace) => {
        const registry = new StreamProviderRegistry(config.streamProviderTimeoutMs, quiet, config.streamProviderMaxConcurrent);
        for (const provider of providers) registry.register({
          id: provider.id, name: provider.id, isEnabled: () => true,
          resolve: (): Promise<NormalizedStreamSource[]> => Promise.resolve(provider.candidates)
        });
        await new StreamResolver(registry, policy, probe,
          composeResolverTraces(trace, identityTrace), config.streamRankingPolicy).resolve(item);
      }, caseSegments(evaluationCase));
    } catch { throw new EvaluationFailure("resolution failed"); }
  }
  const report = { ...evaluator!.report(),
    identityPrecision: identity!.report(),
    corpus: { id: corpus.id, version: corpus.version, fingerprint: corpus.fingerprint } };
  if (args.includes("--json")) {
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized) > EVALUATION_REPORT_MAX_BYTES)
      throw new EvaluationFailure("report too large");
    process.stdout.write(`${serialized}\n`);
  } else process.stdout.write(`${formatKodiSourceQualityTable(report)}\n`);
}
void main().catch((error: unknown) => {
  const category = error instanceof EvaluationFailure ? error.category : "unexpected failure";
  process.stderr.write(`EVALUATION_FAILED: ${category}\n`);
  process.exitCode = 1;
});
