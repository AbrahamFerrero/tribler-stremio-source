import { randomUUID } from "node:crypto";
import { readDiagnosticLocalConfig, diagnosticSessionOutput, type DiagnosticLocalConfig } from "./local-config";
import { startDiagnosticBridge } from "./local-bridge";
import { diagnosticBridge, requestDiagnosticAdmin, type DiagnosticAdminTransport } from "./admin-client";
import { DiagnosticCliError } from "./cli-errors";
import { diagnosticTranslations, type DiagnosticLanguage, type DiagnosticDictionary } from "./i18n";
import { renderDiagnosticHtml } from "./html-report";
import { serializeDiagnosticReport, validateDiagnosticReport, diagnosticId } from "./report-model";
import { writeDiagnosticExport } from "./export-file";
import { DIAGNOSTIC_LIMITS as L } from "./recorder";
import { CaptureExportFailure, captureWorkflow, type DiagnosticStatus } from "./capture-workflow";
import { captureInteraction, type CaptureInteraction } from "./interaction";
import { validateDiagnosticExport, type DiagnosticExport } from "./private-context";

interface Command {
  operation: "start" | "status" | "stop" | "report" | "export" | "help" | "demo" | "capture" | "session";
  language: DiagnosticLanguage; bridge: URL; next?: number; ttl?: number; retain: boolean;
  format?: "json" | "html"; output?: string;
  mode: "private" | "anonymized"; explicitMode: boolean;
}
function invalid(): never { throw new DiagnosticCliError("INVALID_ARGUMENTS", 2); }
function selectedLanguage(args: string[]): DiagnosticLanguage {
  const value = args[args.indexOf("--lang") + 1]; return args.includes("--lang") && value === "es" ? "es" : "en";
}
export function parseDiagnosticCommand(args: string[]): Command {
  const values = new Map<string, string>(); const flags = new Set<string>(); let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--retain", "--help"].includes(arg)) { if (flags.has(arg)) invalid(); flags.add(arg); continue; }
    if (["--next", "--ttl", "--format", "--output", "--bridge", "--lang", "--mode"].includes(arg)) {
      const value = args[++i]; if (values.has(arg) || !value || value.startsWith("--")) invalid(); values.set(arg, value); continue;
    }
    if (arg.startsWith("-") || command !== undefined) invalid(); command = arg;
  }
  const language = values.get("--lang") ?? "en";
  if (language !== "en" && language !== "es") throw new DiagnosticCliError("INVALID_LANGUAGE", 2);
  if (flags.has("--help")) command = "help";
  command ??= "session";
  if (!["start", "status", "stop", "report", "export", "help", "demo", "capture", "session"].includes(command)) invalid();
  const allowed = command === "session" ? ["--next", "--ttl"] : command === "start" ? ["--next", "--ttl"] : command === "capture" ? ["--next", "--ttl", "--output"] : command === "export" ? ["--format", "--output"] : [];
  if ([...values.keys()].some(key => !["--bridge", "--lang", ...allowed, ...(["start", "capture", "demo", "report", "export", "session"].includes(command) ? ["--mode"] : [])].includes(key)) || (flags.has("--retain") && command !== "start")) invalid();
  if (command === "demo" && values.has("--bridge")) invalid();
  const mode = values.get("--mode") ?? (command === "demo" ? "private" : "anonymized");
  if (mode !== "private" && mode !== "anonymized") throw new DiagnosticCliError("INVALID_REPORT_MODE", 2);
  const result: Command = { operation: command as Command["operation"], language, mode, explicitMode: values.has("--mode"),
    bridge: diagnosticBridge(values.get("--bridge") ?? "http://127.0.0.1:7000"), retain: flags.has("--retain") };
  if (command === "start" || command === "capture") {
    const next = values.get("--next") ?? (command === "capture" ? "3" : ""), ttl = values.get("--ttl") ?? (command === "capture" ? "300" : "");
    if (!/^[1-9][0-9]*$/.test(next) || !/^[1-9][0-9]*$/.test(ttl) || Number(next) > 10 || Number(ttl) > 300) invalid();
    result.next = Number(next); result.ttl = Number(ttl);
  }
  if (command === "session") {
    for (const [key, field, max] of [["--next", "next", L.resolutions], ["--ttl", "ttl", L.ttlMs / 1000]] as const) {
      const raw = values.get(key);
      if (raw !== undefined) { if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) invalid(); result[field] = Number(raw); }
    }
  }
  if (command === "capture") { const output = values.get("--output"); if (!output) invalid(); result.output = output; }
  if (command === "export") {
    const format = values.get("--format"), output = values.get("--output");
    if ((format !== "json" && format !== "html") || !output) invalid(); result.format = format; result.output = output;
  }
  return result;
}
function statusSummary(input: unknown, d: DiagnosticDictionary): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DiagnosticCliError("INVALID_RESPONSE", 3);
  const v = input as Record<string, unknown>;
  const on = ["state", "id", "remainingMs", "quota", "reserved", "active", "skippedConcurrent", "events", "truncated", "reportAvailable"];
  const keys = v.state === "ON" ? on : v.state === "OFF" ? ["state", "reportAvailable"] : [];
  const number = (key: string, max: number, integer = true) => typeof v[key] === "number" && Number.isFinite(v[key]) &&
    (!integer || Number.isInteger(v[key])) && v[key] >= 0 && v[key] <= max;
  if (!keys.length || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k)) || typeof v.reportAvailable !== "boolean" ||
      (v.state === "ON" && (!diagnosticId(v.id) || !number("remainingMs", L.ttlMs, false) || !number("quota", L.resolutions) ||
        !number("reserved", L.resolutions) || !number("active", L.concurrent) || !number("skippedConcurrent", L.resolutions) ||
        !number("events", L.sessionEvents) || typeof v.truncated !== "boolean" || v.reportAvailable !== false ||
        Number(v.quota) < 1 || Number(v.reserved) > Number(v.quota) || Number(v.active) > Number(v.reserved) ||
        Number(v.skippedConcurrent) > Number(v.reserved)))) throw new DiagnosticCliError("INVALID_RESPONSE", 3);
  const lines = [`${d.state}: ${v.state === "ON" ? d.ON : d.OFF} [${String(v.state)}]`, `${d.reportAvailable}: ${v.reportAvailable ? d.yes : d.no}`];
  if (v.state === "ON") for (const key of ["id", "remainingMs", "quota", "reserved", "active", "skippedConcurrent", "events", "truncated"] as const) {
    const name = key === "id" ? d.session : d[key];
    lines.push(`${name}: ${typeof v[key] === "boolean" ? v[key] ? d.yes : d.no : String(v[key])}`);
  }
  return lines;
}

export interface DiagnosticWorkflowDependencies {
  interaction?: () => CaptureInteraction;
  localConfig?: () => Promise<DiagnosticLocalConfig>;
  startBridge?: typeof startDiagnosticBridge;
  openDemo?: (path: string) => Promise<boolean>;
}
export async function runDiagnosticCli(args: string[], env: Record<string, string | undefined>, io: { out: (line: string) => void; error: (line: string) => void }, transport: DiagnosticAdminTransport = requestDiagnosticAdmin, workflows: DiagnosticWorkflowDependencies = {}): Promise<number> {
  let language = selectedLanguage(args);
  try {
    const command = parseDiagnosticCommand(args); language = command.language; const d = diagnosticTranslations[language];
    if (command.operation === "help") { io.out(d.help); return 0; }
    if (command.operation === "demo") {
      try {
        // Advanced commands/capture never load the synthetic resolver or its defaults.
        const demo = await import("./demo-workflow");
        const output = await demo.diagnosticDemo(command.mode);
        io.out(d.demoComplete); io.out(output);
        let opened = false;
        try { opened = await (workflows.openDemo ?? demo.openDiagnosticDemo)(output); } catch { /* Browser launch is optional. */ }
        io.out(opened ? d.demoOpening : d.demoOpenInstructions); return 0;
      } catch { throw new DiagnosticCliError("DEMO_FAILED", 5); }
    }
    const token = env.BRIDGE_ADMIN_TOKEN;
    if (!token) throw new DiagnosticCliError("ADMIN_TOKEN_REQUIRED", 2);
    if (!/^[a-fA-F0-9]{64}$/.test(token)) throw new DiagnosticCliError("ADMIN_TOKEN_INVALID", 2);
    if (command.operation === "session") {
      const local = await (workflows.localConfig ?? readDiagnosticLocalConfig)();
      const output = await diagnosticSessionOutput(local.outputDir);
      // The default authority follows the same configured port as the production bridge.
      if (!args.includes("--bridge") && env.BRIDGE_PORT !== undefined) command.bridge = diagnosticBridge(`http://127.0.0.1:${env.BRIDGE_PORT}`);
      const interaction = (workflows.interaction ?? captureInteraction)();
      let close: (() => Promise<void>) | undefined;
      let captureTransport = transport;
      try {
        try {
          // Identify the existing public addon before disclosing the administrative Bearer.
          const identity = await transport({ bridge: command.bridge, token: "", operation: "identity", method: "GET" });
          const manifest = identity.data as Record<string, unknown> | null;
          if (identity.status !== 200 || !manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
              manifest.id !== "org.local.tribler.bridge" || manifest.name !== "Local Tribler Bridge" ||
              !Array.isArray(manifest.resources) || !manifest.resources.includes("stream")) throw new DiagnosticCliError("BRIDGE_INCOMPATIBLE", 3);
          const response = await transport({ bridge: command.bridge, token, operation: "status", method: "GET" });
          if ([401, 403].includes(response.status)) throw new DiagnosticCliError("ACCESS_DENIED", 3);
          if (response.status !== 200 || !response.ownership) throw new DiagnosticCliError("BRIDGE_INCOMPATIBLE", 3);
          statusSummary(response.data, d);
          const current = response.data as DiagnosticStatus;
          if (current.state === "ON" || current.reportAvailable) throw new DiagnosticCliError("SESSION_BUSY", 4);
        } catch (error) {
          // Only an explicit connection refusal permits startup. Timeouts/bad identity fail closed.
          if (!(error instanceof DiagnosticCliError) || error.code !== "BRIDGE_ABSENT") throw error;
          if (interaction.interrupted()) throw new DiagnosticCliError("CAPTURE_INTERRUPTED", 130);
          const ownerId = randomUUID();
          close = await (workflows.startBridge ?? startDiagnosticBridge)(command.bridge, token, ownerId);
          captureTransport = request => transport({ ...request, ...(request.operation.endsWith("start") ? { ownerId } : {}) });
        }
        if (interaction.interrupted()) throw new DiagnosticCliError("CAPTURE_INTERRUPTED", 130);
        let exportFailure: DiagnosticCliError | undefined;
        try {
          await captureWorkflow({ bridge: command.bridge, token, next: command.next ?? local.next, ttl: command.ttl ?? local.ttlSeconds,
            output, mode: command.explicitMode ? command.mode : local.mode, preserveReport: true }, captureTransport,
            data => { statusSummary(data, d); return data as DiagnosticStatus; }, { ...interaction, dispose: () => undefined }, d, io);
        } catch (error) {
          // Export-stage failures confirm capture is OFF, so playback may continue.
          // Uncertain capture/cleanup failures still follow the existing fail-closed path.
          if (!close || !(error instanceof CaptureExportFailure)) throw error;
          exportFailure = error;
          io.error(`${error.code}: ${d[error.code]}`);
          io.error(interaction.interrupted() ? d.exportClosing : d.exportRecovery);
        }
        if (!exportFailure) {
          io.out(output);
          if (local.openReport) {
            let opened = false;
            try { opened = await (workflows.openDemo ?? (await import("./open-report")).openDiagnosticDemo)(output); } catch { /* Optional. */ }
            if (!opened) io.out(d.openReportManually);
          }
        }
        if (close && !interaction.interrupted()) {
          io.out(d.bridgeRunning);
          // The diagnostic TTL bounds capture, not the lifetime of the service.
          // Enter/EOF after capture do not shut down or request another export.
          while (!interaction.interrupted()) await interaction.wait(1000);
        }
        return exportFailure?.exitCode ?? (interaction.interrupted() ? 130 : 0);
      } finally {
        try { await close?.(); } finally { interaction.dispose(); }
      }
    }
    if (command.operation === "capture") {
      const interaction = (workflows.interaction ?? captureInteraction)();
      await captureWorkflow({ bridge: command.bridge, token, next: command.next!, ttl: command.ttl!, output: command.output!, mode: command.mode }, transport,
        data => { statusSummary(data, d); return data as DiagnosticStatus; }, interaction, d, io);
      return interaction.interrupted() ? 130 : 0;
    }
    const operation = command.operation === "export" ? "report" : command.operation;
    const apiOperation = command.mode === "private" && (operation === "start" || operation === "report") ? `private/${operation}` as const : operation;
    const response = await transport({ bridge: command.bridge, token, operation: apiOperation,
      method: operation === "start" || operation === "stop" ? "POST" : "GET",
      ...(operation === "start" ? { body: JSON.stringify({ ttlMs: command.ttl! * 1000, resolutions: command.next!, retainReport: command.retain }) } : {}) });
    if ([401, 403].includes(response.status)) throw new DiagnosticCliError("ACCESS_DENIED", 3);
    if (response.status === 409) throw new DiagnosticCliError("CAPTURE_ACTIVE", 4);
    if (operation === "report" && response.status === 404) throw new DiagnosticCliError(command.mode === "private" ? "PRIVATE_REPORT_NOT_FOUND" : "REPORT_NOT_FOUND", 4);
    if (operation === "report" && response.status === 410) throw new DiagnosticCliError("REPORT_EXPIRED", 4);
    if (response.status !== 200) throw new DiagnosticCliError("REQUEST_FAILED", 3);
    if (operation !== "report") {
      const lines = statusSummary(response.data, d);
      if (operation === "start") io.out(d.started); if (operation === "stop") io.out(d.stopped);
      lines.forEach(line => io.out(line)); return 0;
    }
    let exported: DiagnosticExport;
    try { exported = command.mode === "private" ? validateDiagnosticExport(response.data) : validateDiagnosticReport(response.data);
      if ((command.mode === "private") !== ("privacy" in exported)) throw new Error("INVALID_RESPONSE");
    } catch { throw new DiagnosticCliError("INVALID_RESPONSE", 3); }
    const report = "privacy" in exported ? exported.report : exported;
    if (command.operation === "export") {
      const format = command.format!;
      await writeDiagnosticExport(command.output!, format === "json" ? ("privacy" in exported ? JSON.stringify(exported) : serializeDiagnosticReport(exported)) : renderDiagnosticHtml(exported), format);
      io.out(d.exported); return 0;
    }
    if ("privacy" in exported) io.out(d.privateNotice);
    io.out(`${d.session}: ${report.id}`); io.out(`${d.state}: ${d[report.state]} [${report.state}]`);
    io.out(`${d.reason}: ${d[report.reason]} [${report.reason}]`); io.out(`${d.resolutions}: ${report.resolutions.length}`);
    io.out(`${d.events}: ${report.events}`); io.out(`${d.reserved}: ${report.reserved}`); io.out(`${d.skippedConcurrent}: ${report.skippedConcurrent}`);
    io.out(d.reportHint); return 0;
  } catch (error) {
    const safe = error instanceof DiagnosticCliError ? error : new DiagnosticCliError("REQUEST_FAILED", 3);
    io.error(`${safe.code}: ${diagnosticTranslations[language][safe.code]}`); return safe.exitCode;
  }
}
