import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { ExternalUrlPolicy } from "../network/url-policy";
import { StreamProviderRegistry, StreamResolver } from "../streams/resolver";
import { DiagnosticController } from "./controller";
import { diagnosticObserverFactory } from "./resolver-observer";
import { renderDiagnosticHtml } from "./html-report";
import { checkDiagnosticExportDirectory, writeDiagnosticExport } from "./export-file";

const execute = promisify(execFile);

/** No bridge/user configuration, HTTP listener, probe or outbound transport. Uses checked-in ranking defaults. */
export async function diagnosticDemo(mode: "private" | "anonymized" = "private"): Promise<string> {
  const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], { windowsHide: true });
  const root = resolve(stdout.trim());
  await checkDiagnosticExportDirectory(root);
  const directory = join(root, ".cache", "diagnostic-demo", randomUUID());
  const output = join(directory, "report.html");
  await execute("git", ["check-ignore", "--quiet", "--", relative(root, output)], { cwd: root, windowsHide: true });
  let parent = root;
  for (const part of [".cache", "diagnostic-demo"]) {
    // Directory components below are fixed or randomly generated, never request data.
    const child = join(parent, part); await mkdir(child, { recursive: true }); await checkDiagnosticExportDirectory(child); parent = child;
  }
  await mkdir(directory); await checkDiagnosticExportDirectory(directory);
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const registry = new StreamProviderRegistry(1000, log);
  const source = (providerId: string, height: number, resource: string) => ({ providerId, type: "https" as const,
    url: `https://media.example/${resource}.mp4`, filename: "synthetic.mp4", resolution: `${height}p`, sizeBytes: height * 1000 });
  registry.register({ id: "demo_north", name: "Synthetic North", isEnabled: () => true,
    resolve: () => Promise.resolve([source("demo_north", 1080, "shared"),
      { ...source("demo_north", 720, "episode-conflict"), metadata: { identity: { kind: "episode", season: 1, episode: 1 } } }]) });
  registry.register({ id: "demo_south", name: "Synthetic South", isEnabled: () => true,
    resolve: () => Promise.resolve([source("demo_south", 2160, "high"), source("demo_south", 1080, "shared"), source("demo_south", 720, "standard")]) });
  registry.register({ id: "demo_empty", name: "Synthetic Empty", isEnabled: () => true, resolve: () => Promise.resolve([]) });
  registry.register({ id: "demo_disabled", name: "Synthetic Disabled", isEnabled: () => false, resolve: () => Promise.resolve([]) });
  registry.register({ id: "demo_failure", name: "Synthetic Failure", isEnabled: () => true, resolve: () => Promise.reject(new Error("Synthetic failure")) });
  registry.register({ id: "demo_timeout", name: "Synthetic Timeout", timeoutMs: 20, isEnabled: () => true,
    resolve: (_item, context) => new Promise(resolve => {
      // Real abortable pending work keeps the standalone demo alive until its deadline.
      const timer = setTimeout(() => resolve([]), 1000);
      context.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve([]); }, { once: true });
    }) });
  const controller = new DiagnosticController();
  const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
  const resolver = new StreamResolver(registry, policy, undefined, undefined, undefined, 50, diagnosticObserverFactory(controller));
  controller.start({ ttlMs: 300000, resolutions: 3, retainReport: true }, mode === "private");
  try {
    for (const title of ["Invented Lighthouse", "Invented Moon Garden", "Invented Mountain"]) await resolver.resolve({ id: "synthetic-demo", kind: "movie", title, externalIds: {} });
  } finally { controller.stop(); }
  const privateReport = mode === "private" ? controller.readPrivateReport() : undefined;
  await writeDiagnosticExport(output, renderDiagnosticHtml(privateReport?.state === "AVAILABLE" ? privateReport.report : controller.report()), "html");
  return output;
}

/** Best-effort opening of a generated local HTML file, never a shell command/HTTP URL. */
export { openDiagnosticDemo } from "./open-report";
