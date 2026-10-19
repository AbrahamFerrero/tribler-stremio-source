import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TriblerEndpointDiscoveryOptions {
  listCandidates?: () => Promise<string[]>;
  probe?: (url: string) => Promise<boolean>;
}

function loopbackUrl(port: unknown, address: unknown): string | undefined {
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65_535) return undefined;
  if (address === "127.0.0.1") return `http://127.0.0.1:${numericPort}`;
  if (address === "::1") return `http://[::1]:${numericPort}`;
  return undefined;
}

function trustedLoopbackCandidate(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function windowsCandidates(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ids = @(Get-CimInstance Win32_Process -Filter \"Name='Tribler.exe'\" | Select-Object -ExpandProperty ProcessId)",
    "if ($ids.Count -eq 0) { '[]'; exit 0 }",
    "@(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $ids -and $_.LocalAddress -in @('127.0.0.1', '::1') } | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 3_000 });
    const value: unknown = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(value) ? value : [value];
    return rows.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const candidate = row as { LocalAddress?: unknown; LocalPort?: unknown };
      const url = loopbackUrl(candidate.LocalPort, candidate.LocalAddress);
      return url ? [url] : [];
    });
  } catch {
    return [];
  }
}

async function authenticatedDownloads(url: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${url}/api/downloads`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) return false;
    const payload = await response.json() as { downloads?: unknown };
    return Array.isArray(payload.downloads);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds an authenticated Tribler REST listener only among loopback ports owned
 * by the local Tribler process. Ambiguous or unavailable discovery fails closed.
 */
export async function discoverTriblerEndpoint(
  apiKey: string,
  options: TriblerEndpointDiscoveryOptions = {}
): Promise<string | undefined> {
  const candidates = [...new Set((await (options.listCandidates ?? windowsCandidates)())
    .flatMap((candidate) => trustedLoopbackCandidate(candidate) ?? []))];
  const probe = options.probe ?? ((url: string) => authenticatedDownloads(url, apiKey));
  const verified: string[] = [];
  for (const candidate of candidates) {
    if (await probe(candidate)) verified.push(candidate);
  }
  return verified.length === 1 ? verified[0] : undefined;
}
