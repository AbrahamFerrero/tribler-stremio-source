import { open, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { checkDiagnosticExportDirectory } from "./export-file";
import { DiagnosticCliError } from "./cli-errors";
import { DIAGNOSTIC_LIMITS as L } from "./recorder";

export interface DiagnosticLocalConfig {
  mode: "anonymized" | "private";
  next: number;
  ttlSeconds: number;
  outputDir: string;
  openReport: boolean;
}
const defaults: DiagnosticLocalConfig = { mode: "anonymized", next: 3, ttlSeconds: 300,
  outputDir: ".cache/diagnostic-reports", openReport: false };

export function validateDiagnosticLocalConfig(input: unknown): DiagnosticLocalConfig {
  const invalid = (): never => { throw new DiagnosticCliError("INVALID_LOCAL_CONFIG", 2); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(key => !Object.hasOwn(defaults, key))) return invalid();
  const value = { ...defaults, ...v };
  if (!["anonymized", "private"].includes(String(value.mode)) ||
      !Number.isInteger(value.next) || Number(value.next) < 1 || Number(value.next) > L.resolutions ||
      !Number.isInteger(value.ttlSeconds) || Number(value.ttlSeconds) < 1 || Number(value.ttlSeconds) * 1000 > L.ttlMs ||
      typeof value.openReport !== "boolean" || typeof value.outputDir !== "string") return invalid();
  validateOutputDirectory(value.outputDir);
  return value;
}

/** Reject Windows device paths, UNC, ADS, drive-relative paths and ambiguous components. */
export function validateOutputDirectory(raw: string): void {
  const withoutDrive = raw.replace(/^[A-Za-z]:[\\/]/, "");
  if (!raw || raw.length > 4000 || /\0|^[\\/]{2}|^[A-Za-z]:[^\\/]/.test(raw) ||
      /[:<>"|?*]/.test(withoutDrive) || raw.split(/[\\/]/).some(part =>
        part !== "." && part !== ".." && (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
  }
  // A drive-qualified path is meaningful only on Windows.
  if (/^[A-Za-z]:/.test(raw) && !isAbsolute(raw)) throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
}

export async function readDiagnosticLocalConfig(): Promise<DiagnosticLocalConfig> {
  try {
    const handle = await open(resolve("config/diagnostic.local.json"), "r");
    try {
      if (!(await handle.stat()).isFile()) throw new Error();
      const bytes = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 8192) throw new Error();
      return validateDiagnosticLocalConfig(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "")) as unknown);
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    if (error instanceof DiagnosticCliError) throw error;
    throw new DiagnosticCliError("INVALID_LOCAL_CONFIG", 2);
  }
}

export async function diagnosticSessionOutput(outputDir: string): Promise<string> {
  validateOutputDirectory(outputDir);
  const parent = resolve(outputDir);
  try {
    if (parent === resolve(defaults.outputDir)) {
      await checkDiagnosticExportDirectory(process.cwd());
      let current = process.cwd();
      for (const part of defaults.outputDir.split("/")) {
        current = join(current, part);
        await mkdir(current, { recursive: true });
        await checkDiagnosticExportDirectory(current);
      }
    } else await checkDiagnosticExportDirectory(parent); // Custom directories must already exist.
    const filename = `diagnostic-${randomUUID()}.html`;
    return join(parent, filename);
  } catch (error) {
    if (error instanceof DiagnosticCliError) throw error;
    throw new DiagnosticCliError("EXPORT_FAILED", 5);
  }
}
