import { constants } from "node:fs";
import { lstat, open, link, unlink } from "node:fs/promises";
import { basename, dirname, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DiagnosticCliError } from "./cli-errors";
import { DIAGNOSTIC_LIMITS } from "./recorder";

export const HTML_REPORT_MAX_BYTES = 4 * 1024 * 1024;
export async function checkDiagnosticExportDirectory(parent: string) {
  const root = parse(parent).root;
  let current = root;
  let stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part); stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
  }
  return stat;
}

/** Stage in the checked directory, then publish with an atomic, no-clobber hard link. */
export async function writeDiagnosticExport(output: string, content: string, format: "json" | "html"): Promise<void> {
  if (!output || output.length > 4096 || /\0|^[\\/]{2}/.test(output) || /[\\/]$/.test(output) || [".", ".."].includes(basename(output))) throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
  const size = Buffer.byteLength(content);
  if (size > (format === "json" ? DIAGNOSTIC_LIMITS.dtoBytes : HTML_REPORT_MAX_BYTES)) throw new DiagnosticCliError("OUTPUT_TOO_LARGE", 5);
  const target = resolve(output), parent = dirname(target);
  if (/[:<>"|?*]|[. ]$/.test(basename(target)) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename(target)) ||
      /^[A-Za-z]:[^\\/]/.test(output)) throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
  let temporary: string | undefined; let created = false;
  try {
    const before = await checkDiagnosticExportDirectory(parent);
    try {
      const existing = await lstat(target);
      throw new DiagnosticCliError(existing.isSymbolicLink() ? "OUTPUT_UNSAFE" : "OUTPUT_EXISTS", 5);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    temporary = resolve(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    const after = await checkDiagnosticExportDirectory(parent);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new DiagnosticCliError("OUTPUT_UNSAFE", 5);
    await link(temporary, target); // EEXIST is authoritative, including concurrent writers.
  } catch (error) {
    if (error instanceof DiagnosticCliError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DiagnosticCliError("OUTPUT_EXISTS", 5);
    throw new DiagnosticCliError("EXPORT_FAILED", 5);
  } finally {
    if (created && temporary) { try { await unlink(temporary); } catch { /* Best-effort removal of this writer's temporary file only. */ } }
  }
}
