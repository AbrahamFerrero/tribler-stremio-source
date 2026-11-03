import { request } from "node:http";
import { DiagnosticCliError } from "./cli-errors";
import { DIAGNOSTIC_LIMITS as L } from "./recorder";

export function diagnosticBridge(raw: string): URL {
  const match = /^http:\/\/(127\.0\.0\.1|localhost)(?::([1-9][0-9]{0,4}))?\/?$/i.exec(raw);
  if (!match || (match[2] !== undefined && Number(match[2]) > 65535)) throw new DiagnosticCliError("INVALID_DESTINATION", 2);
  return new URL(raw);
}
export interface DiagnosticAdminRequest {
  bridge: URL; token: string; method: "GET" | "POST"; operation: "identity" | "start" | "status" | "stop" | "report" | "private/start" | "private/report"; body?: string; sessionId?: string; preserveReport?: boolean; ownerId?: string;
}
export type DiagnosticAdminTransport = (input: DiagnosticAdminRequest) => Promise<{ status: number; data: unknown; ownership?: boolean }>;

/** No proxy, DNS lookup or redirect. Even localhost is connected directly to 127.0.0.1. */
export const requestDiagnosticAdmin: DiagnosticAdminTransport = input => new Promise((resolve, reject) => {
  const bridge = diagnosticBridge(input.bridge.href);
  if (input.operation !== "identity" && !/^[a-fA-F0-9]{64}$/.test(input.token)) { reject(new DiagnosticCliError("ADMIN_TOKEN_INVALID", 2)); return; }
  const chunks: Buffer[] = []; let length = 0; let settled = false;
  const finish = (status?: number, data?: unknown, ownership = false) => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (status === undefined) reject(new DiagnosticCliError("REQUEST_FAILED", 3));
    else resolve({ status, data, ownership });
  };
  const req = request({ hostname: "127.0.0.1", port: Number(bridge.port || 80),
    path: input.operation === "identity" ? "/manifest.json" : `/diagnostics/${input.operation}`, method: input.method, agent: false,
    headers: { ...(input.ownerId ? { "X-Diagnostic-Owner": input.ownerId } : {}), ...(input.sessionId ? { "X-Diagnostic-Session": input.sessionId } : {}),
      ...(input.preserveReport ? { "X-Diagnostic-Preserve-Report": "true" } : {}), ...(input.operation === "identity" ? {} : { Authorization: `Bearer ${input.token}` }), Accept: "application/json",
      ...(input.body !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(input.body) } : {}) }
  }, res => {
    if (!/^application\/json(?:\s*;|$)/i.test(String(res.headers["content-type"] ?? "")) ||
        Number(res.headers["content-length"] ?? 0) > L.dtoBytes) { res.destroy(); finish(); return; }
    res.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > L.dtoBytes) { res.destroy(); finish(); return; }
      chunks.push(chunk);
    });
    res.on("aborted", () => finish()); res.on("error", () => finish());
    res.on("end", () => {
      try { finish(res.statusCode ?? 0, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, res.headers["x-diagnostic-protocol"] === "owned-session-v1"); }
      catch { finish(); }
    });
  });
  const timer = setTimeout(() => { req.destroy(); finish(); }, 5000);
  timer.unref(); req.on("error", (error: NodeJS.ErrnoException) => {
    if (!settled && error.code === "ECONNREFUSED") {
      settled = true; clearTimeout(timer); reject(new DiagnosticCliError("BRIDGE_ABSENT", 3));
    } else finish();
  }); req.end(input.body);
});
