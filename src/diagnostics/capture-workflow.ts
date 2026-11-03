import type { DiagnosticAdminTransport } from "./admin-client";
import { DiagnosticCliError } from "./cli-errors";
import type { DiagnosticController } from "./controller";
import type { DiagnosticDictionary } from "./i18n";
import type { CaptureInteraction } from "./interaction";
import { renderDiagnosticHtml } from "./html-report";
import { validateDiagnosticExport } from "./private-context";
import { writeDiagnosticExport } from "./export-file";

/** Export-stage failure after an owned capture has been confirmed OFF. */
export class CaptureExportFailure extends DiagnosticCliError {
  constructor(error: unknown) {
    const safe = error instanceof DiagnosticCliError ? error : new DiagnosticCliError("EXPORT_FAILED", 5);
    super(safe.code, safe.exitCode);
  }
}

export type DiagnosticStatus = ReturnType<DiagnosticController["status"]>;
interface CaptureOptions { bridge: URL; token: string; next: number; ttl: number; output: string; mode?: "private" | "anonymized"; preserveReport?: boolean }
export async function captureWorkflow(options: CaptureOptions, transport: DiagnosticAdminTransport,
  validateStatus: (input: unknown) => DiagnosticStatus, interaction: CaptureInteraction,
  d: DiagnosticDictionary, io: { out(line: string): void; error(line: string): void }): Promise<void> {
  let owned: string | undefined;
  let stopped = false;
  const request = async (operation: "start" | "status" | "stop" | "report") => {
    const apiOperation = options.mode === "private" && (operation === "start" || operation === "report") ? `private/${operation}` as const : operation;
    const response = await transport({ bridge: options.bridge, token: options.token, operation: apiOperation,
      ...(operation === "stop" && owned ? { sessionId: owned } : {}),
      ...(operation === "start" && options.preserveReport ? { preserveReport: true } : {}),
      method: operation === "start" || operation === "stop" ? "POST" : "GET",
      ...(operation === "start" ? { body: JSON.stringify({ ttlMs: options.ttl * 1000, resolutions: options.next, retainReport: true }) } : {}) })
      .catch((error: unknown) => { if (operation === "start") io.error(d.captureCleanupWarning); throw error; });
    if ([401, 403].includes(response.status)) throw new DiagnosticCliError("ACCESS_DENIED", 3);
    if (response.status === 409) {
      if (operation === "stop") { stopped = true; throw new DiagnosticCliError("CAPTURE_REPLACED", 4); }
      throw new DiagnosticCliError(options.preserveReport && operation === "start" ? "SESSION_BUSY" : "CAPTURE_ACTIVE", 4);
    }
    if (response.status === 404 && operation === "report") throw new DiagnosticCliError(options.mode === "private" ? "PRIVATE_REPORT_NOT_FOUND" : "REPORT_NOT_FOUND", 4);
    if (response.status === 410 && operation === "report") throw new DiagnosticCliError("REPORT_EXPIRED", 4);
    if (response.status !== 200) throw new DiagnosticCliError("REQUEST_FAILED", 3);
    return response.data;
  };
  const status = async () => validateStatus(await request("status"));
  const checkOwner = (s: DiagnosticStatus) => {
    if (s.state === "ON" && s.id !== owned) { stopped = true; throw new DiagnosticCliError("CAPTURE_REPLACED", 4); }
  };
  const stopOwned = async () => {
    const s = await status(); checkOwner(s);
    if (s.state === "ON") {
      const after = validateStatus(await request("stop"));
      if (after.state !== "OFF") throw new DiagnosticCliError("INVALID_RESPONSE", 3);
    }
    stopped = true;
  };
  try {
    const initialData = await request("start");
    let initial: DiagnosticStatus;
    try {
      initial = validateStatus(initialData);
      if (initial.state !== "ON" || initial.quota !== options.next) throw new DiagnosticCliError("INVALID_RESPONSE", 3);
    } catch (error) { io.error(d.captureCleanupWarning); throw error; }
    owned = initial.id;
    const deadline = interaction.now() + initial.remainingMs;
    if (options.mode === "private") io.out(d.privateNotice);
    io.out(d.captureInstructions);
    let current: DiagnosticStatus = initial;
    for (;;) {
      if (interaction.interrupted()) break;
      checkOwner(current);
      if (current.state === "OFF" || (current.reserved >= options.next && current.active === 0) || interaction.now() >= deadline) break;
      const reason = await interaction.wait(Math.min(500, Math.max(0, deadline - interaction.now())));
      if (reason === "INTERRUPT" || interaction.interrupted()) break;
      if (reason === "ENTER") break;
      current = await status();
    }
    await stopOwned();
    try {
      let report;
      try { report = validateDiagnosticExport(await request("report"));
        if ((options.mode === "private") !== ("privacy" in report)) throw new Error("INVALID_RESPONSE");
      }
      catch (error) { if (error instanceof DiagnosticCliError) throw error; throw new DiagnosticCliError("INVALID_RESPONSE", 3); }
      if (("privacy" in report ? report.report.id : report.id) !== owned) throw new DiagnosticCliError("CAPTURE_REPLACED", 4);
      try { await writeDiagnosticExport(options.output, renderDiagnosticHtml(report), "html"); }
      catch (error) {
        if (error instanceof DiagnosticCliError) throw error;
        throw new DiagnosticCliError("EXPORT_FAILED", 5);
      }
    } catch (error) { throw new CaptureExportFailure(error); }
    io.out(d.exported);
  } finally {
    if (owned && !stopped) {
      try { await stopOwned(); }
      catch { io.error(d.captureCleanupWarning); }
    }
    interaction.dispose();
  }
}
