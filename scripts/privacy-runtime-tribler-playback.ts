import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rmdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { BIG_BUCK_BUNNY_MAGNET } from "../src/examples/test-stream-provider";
import { extractInfohash } from "../src/source";
import { TriblerClient } from "../src/tribler-client";
import { discoverTriblerEndpoint } from "../src/tribler-endpoint-discovery";
import { TriblerError } from "../src/errors";
import type { TriblerDownload, TriblerFile } from "../src/types";
import { selectMainVideo } from "../src/video-selection";
import { classifyRuntimeAudit } from "./privacy-runtime-audit-classifier";

const PROJECT_ROOT = process.cwd();
const OWNER_ROOT = resolve(PROJECT_ROOT, ".inspection-work", "privacy-runtime-tribler-playback");
const AUDIT_SECONDS = 35;
const SAMPLE_INTERVAL_MS = 100;
const RANGE_BYTES = 64 * 1024 * 1024;
const CONSUMER_BYTES_PER_SECOND = 1024 * 1024;
const METADATA_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_LOG_CHARS = 16_000;
const fixtureInfoHash = extractInfohash(BIG_BUCK_BUNNY_MAGNET);
if (!fixtureInfoHash) throw new Error("Legal Big Buck Bunny fixture is missing its infohash");
const infoHash: string = fixtureInfoHash;

interface AuditSnapshot {
  bridgePidKnown?: boolean;
  auditDurationSeconds?: number;
  loopbackTcpObserved?: boolean;
  nonLoopbackTcpObserved?: boolean;
  udpRemoteDestinationResult?: string;
}

function keepTail(previous: string, chunk: Buffer): string {
  return (previous + chunk.toString()).slice(-MAX_LOG_CHARS);
}

function redact(value: string, apiKey: string): string {
  let result = apiKey ? value.replaceAll(apiKey, "<redacted>") : value;
  result = result.replaceAll(BIG_BUCK_BUNNY_MAGNET, "<redacted>")
    .replaceAll(infoHash, "<redacted-infohash>");
  return result;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function downloadBoolean(download: TriblerDownload, key: string): boolean {
  return (download as Record<string, unknown>)[key] === true;
}

function downloadInteger(download: TriblerDownload, key: string): number | undefined {
  const value = (download as Record<string, unknown>)[key];
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function downloadString(download: TriblerDownload, key: string): string | undefined {
  const value = (download as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port");
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  return address.port;
}

async function getJson(url: string, timeoutMs = 5_000): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json() as unknown;
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return body;
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || (child as ChildProcess & { spawnError?: Error }).spawnError) {
      throw new Error("BRIDGE_STARTUP_FAILED");
    }
    try {
      const health = await getJson(`${baseUrl}/health`, 2_000) as { ok?: unknown; triblerStreaming?: unknown };
      if (health.ok === true && health.triblerStreaming) return;
    } catch { /* bounded loopback readiness retry */ }
    await delay(200);
  }
  throw new Error("BRIDGE_HEALTH_TIMEOUT");
}

function monitorChild(child: ChildProcess): void {
  child.on("error", (caught) => {
    (child as ChildProcess & { spawnError?: Error }).spawnError = caught;
  });
}

async function waitForChildExitOrError(child: ChildProcess, timeoutMs: number, timeoutCode: string): Promise<void> {
  const monitored = child as ChildProcess & { spawnError?: Error };
  if (monitored.spawnError) throw monitored.spawnError;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const outcome = await Promise.race([
    once(child, "exit").then(() => "exit" as const),
    once(child, "error").then(([error]) => ({ error }) as const),
    delay(timeoutMs).then(() => "timeout" as const)
  ]);
  if (outcome === "timeout") throw new Error(timeoutCode);
  if (typeof outcome === "object") throw outcome.error;
}

async function stopChild(child: ChildProcess, message: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExitOrError(child, 5_000, message);
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await waitForChildExitOrError(child, 2_000, message);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error(message);
}

async function waitForFiles(client: TriblerClient, destination: string): Promise<{ download: TriblerDownload; files: TriblerFile[] }> {
  const deadline = Date.now() + METADATA_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const download = await client.getDownload(infoHash);
    if (!download || !samePath(downloadString(download, "destination") ?? "", destination) ||
        !samePath(downloadString(download, "completed_dir") ?? "", destination)) {
      throw new Error("OWNED_DOWNLOAD_CHANGED");
    }
    if (download.error || download.status.toUpperCase().includes("ERROR")) throw new Error("TRIBLER_METADATA_FAILED");
    const files = await client.getFiles(infoHash).catch(() => []);
    if (files.length > 0) return { download, files };
    await delay(500);
  }
  throw new Error("TRIBLER_METADATA_TIMEOUT");
}

function parseAudit(stdout: string): AuditSnapshot {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error("AUDIT_NO_OUTPUT");
  const parsed = JSON.parse(line) as AuditSnapshot;
  if (typeof parsed.loopbackTcpObserved !== "boolean" || typeof parsed.nonLoopbackTcpObserved !== "boolean") {
    throw new Error("AUDIT_INVALID_OUTPUT");
  }
  return parsed;
}

async function removeOwnedDestination(destination: string, allowContent: boolean): Promise<boolean> {
  const contained = !relative(OWNER_ROOT, destination).startsWith("..") && !samePath(OWNER_ROOT, destination);
  if (!contained) return false;
  if (!existsSync(destination)) return true;
  // Tribler acknowledges deletion before its file handles have always been
  // released on Windows. Keep retrying the one UUID-owned directory; this
  // remains bounded and never broadens the cleanup scope.
  const deadline = Date.now() + 90_000;
  do {
    try {
      if (allowContent) await rm(destination, { recursive: true, force: true });
      else {
        if ((await readdir(destination)).length > 0) return false;
        await rmdir(destination);
      }
      return !existsSync(destination);
    } catch {
      if (Date.now() >= deadline) return false;
      await delay(200);
    }
  } while (Date.now() < deadline);
  return false;
}

async function cleanupRegistry(bridgeCwd: string): Promise<boolean> {
  const stateDir = resolve(bridgeCwd, ".bridge-state");
  const stateFile = resolve(stateDir, "managed-downloads.json");
  try {
    if (existsSync(stateFile)) {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as { downloads?: unknown };
      if (!Array.isArray(state.downloads) || state.downloads.some((entry) => {
        const hash = typeof entry === "object" && entry !== null
          ? (entry as { infohash?: unknown }).infohash : undefined;
        return typeof hash !== "string" || hash.toLowerCase() !== infoHash;
      })) return false;
      await rm(stateFile, { force: true });
    }
    if (existsSync(stateDir) && (await readdir(stateDir)).length === 0) await rmdir(stateDir);
    if ((await readdir(bridgeCwd)).length === 0) await rmdir(bridgeCwd);
    return !existsSync(bridgeCwd);
  } catch { return false; }
}

async function main(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const client = new TriblerClient(
    config.triblerUrl,
    config.triblerApiKey,
    config.streamHeaderTimeoutMs,
    fetch,
    config.triblerAutoDiscover ? () => discoverTriblerEndpoint(config.triblerApiKey) : undefined
  );
  const report: Record<string, unknown> = {
    test: "privacy-runtime-tribler-playback",
    bridgePidKnown: false,
    realTriblerPlayback: false,
    effectiveHops: null,
    httpStatus: null,
    playbackBytesObserved: false,
    auditDurationSeconds: 0,
    loopbackTcpObserved: false,
    nonLoopbackTcpObserved: false,
    bridgeExternalTcp: "unknown",
    udpRemoteExposure: "NOT_TESTED",
    evidenceLevel: "INCONCLUSIVE",
    result: "INCONCLUSIVE",
    cleanup: "OK",
    errorCode: null
  };
  const existing = await client.getDownload(infoHash);
  if (existing) throw new Error("FIXTURE_ALREADY_EXISTS");
  const defaults = await client.getAnonymityDefaults();
  if (!defaults?.enabled || defaults.hops < 1 || defaults.safeSeeding !== true) {
    throw new Error("ANONYMITY_CONFIGURATION_UNVERIFIED");
  }

  await mkdir(OWNER_ROOT, { recursive: true });
  const destination = resolve(OWNER_ROOT, randomUUID());
  if (relative(OWNER_ROOT, destination).startsWith("..") || existsSync(destination)) throw new Error("UNSAFE_TEST_DESTINATION");
  await mkdir(destination);
  const bridgeCwd = resolve(OWNER_ROOT, randomUUID());
  await mkdir(bridgeCwd);
  let bridge: ChildProcess | undefined;
  let auditor: ChildProcess | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller: AbortController | undefined;
  let owned = false;
  let bridgeStdout = "";
  let bridgeStderr = "";
  let auditStdout = "";
  let auditStderr = "";
  let cleanupFailure = false;
  // Deleting the fixture data is allowed only after the API confirms that the
  // exact download this run created is gone. Until then, leave the isolated
  // directory intact for safe manual cleanup and report the failure.
  let downloadRemoved = false;
  let errorCode: string | null = null;

  try {
    const added = await client.addDownload(BIG_BUCK_BUNNY_MAGNET, undefined, {
      onlyMetadata: true, destination, completedDir: destination
    });
    if (added.started !== true || added.infohash.toLowerCase() !== infoHash) throw new Error("TRIBLER_ADD_UNVERIFIED");
    owned = true;
    const metadata = await waitForFiles(client, destination);
    const selected = selectMainVideo(metadata.files);
    if (!selected) throw new Error("LEGAL_FIXTURE_NO_VIDEO");
    const hops = downloadInteger(metadata.download, "hops");
    if (hops !== defaults.hops || !downloadBoolean(metadata.download, "anon_download") ||
        !downloadBoolean(metadata.download, "safe_seeding")) throw new Error("ANONYMITY_CONFIGURATION_UNVERIFIED");
    report.effectiveHops = hops;
    await client.selectFiles(infoHash, [selected.index]);
    await client.resumeDownload(infoHash);

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const bridgeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BRIDGE_PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      CATALOG_PROVIDER: "configured",
      LEGAL_TEST_MAGNET: BIG_BUCK_BUNNY_MAGNET,
      STREAM_PROVIDERS: "catalog",
      ARCHIVE_HTTP_STREAMS: "false",
      DIRECT_HTTP_PROBE_ENABLED: "false"
    };
    delete bridgeEnv.CATALOG_SOURCES_FILE;
    bridge = spawn(process.execPath, ["--import", pathToFileURL(
      resolve(PROJECT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")
    ).href,
      resolve(PROJECT_ROOT, "src/index.ts")], {
      cwd: bridgeCwd, env: bridgeEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    bridge.stdout!.on("data", (chunk: Buffer) => { bridgeStdout = keepTail(bridgeStdout, chunk); });
    bridge.stderr!.on("data", (chunk: Buffer) => { bridgeStderr = keepTail(bridgeStderr, chunk); });
    monitorChild(bridge);
    report.bridgePidKnown = typeof bridge.pid === "number";
    await waitForHealth(baseUrl, bridge);

    const streamResponse = await getJson(`${baseUrl}/stream/movie/tribler%3Atest.json`) as { streams?: Array<{ url?: unknown }> };
    const sourceUrl = streamResponse.streams?.map((entry) => entry.url).find((value): value is string =>
      typeof value === "string" && new URL(value, baseUrl).pathname.startsWith("/source/"));
    if (!sourceUrl) throw new Error("NORMALIZED_TORRENT_SOURCE_UNAVAILABLE");

    const sourceResponse = await fetch(new URL(sourceUrl, baseUrl), {
      redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const playLocation = sourceResponse.headers.get("location");
    await sourceResponse.body?.cancel();
    if (sourceResponse.status !== 307 || !playLocation || !new URL(playLocation, baseUrl).pathname.startsWith("/play/")) {
      throw new Error("PLAYBACK_MANAGER_DID_NOT_REDIRECT");
    }
    controller = new AbortController();
    const playResponse = await fetch(new URL(playLocation, baseUrl), {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}`, "Accept-Encoding": "identity" },
      signal: controller.signal
    });
    report.httpStatus = playResponse.status;
    if (playResponse.status !== 206 || !playResponse.body) throw new Error("REAL_PLAYBACK_HTTP_STATUS_INVALID");
    reader = playResponse.body.getReader();

    // PLAYBACK_AUDIT_WINDOW_START: the resolved stream is now live through the bridge proxy.
    auditor = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      resolve(PROJECT_ROOT, "scripts/privacy-runtime-audit.ps1"), "-BridgeProcessId", String(bridge.pid),
      "-DurationSeconds", String(AUDIT_SECONDS), "-SampleIntervalMs", String(SAMPLE_INTERVAL_MS),
      "-AlreadyResolvedTorrentPlayback"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    auditor.stdout!.on("data", (chunk: Buffer) => { auditStdout = keepTail(auditStdout, chunk); });
    auditor.stderr!.on("data", (chunk: Buffer) => { auditStderr = keepTail(auditStderr, chunk); });
    monitorChild(auditor);

    const deadline = Date.now() + AUDIT_SECONDS * 1_000;
    let playbackBytes = 0;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      playbackBytes += value.byteLength;
      await delay(Math.ceil(value.byteLength * 1_000 / CONSUMER_BYTES_PER_SECOND));
    }
    report.playbackBytesObserved = playbackBytes > 0;
    const active = await client.getDownload(infoHash);
    report.realTriblerPlayback = Boolean(active && active.status &&
      downloadInteger(active, "hops") === defaults.hops && playbackBytes > 0);
    await waitForChildExitOrError(auditor, AUDIT_SECONDS + 10_000, "AUDIT_CHILD_TIMEOUT");
    const audit = parseAudit(auditStdout);
    report.auditDurationSeconds = audit.auditDurationSeconds ?? 0;
    report.loopbackTcpObserved = audit.loopbackTcpObserved ?? false;
    report.nonLoopbackTcpObserved = audit.nonLoopbackTcpObserved ?? false;
    report.bridgeExternalTcp = audit.nonLoopbackTcpObserved ? "yes" : "no";
    report.udpRemoteExposure = audit.udpRemoteDestinationResult ?? "NOT_TESTED";
    // PLAYBACK_AUDIT_WINDOW_END: the bounded local socket sample has completed.
    Object.assign(report, classifyRuntimeAudit({
      bridgePidKnown: report.bridgePidKnown === true,
      realTriblerPlayback: report.realTriblerPlayback === true,
      effectiveHops: typeof report.effectiveHops === "number" ? report.effectiveHops : null,
      httpStatus: typeof report.httpStatus === "number" ? report.httpStatus : null,
      playbackBytesObserved: report.playbackBytesObserved === true,
      auditDurationSeconds: typeof report.auditDurationSeconds === "number" ? report.auditDurationSeconds : 0,
      loopbackTcpObserved: report.loopbackTcpObserved === true,
      nonLoopbackTcpObserved: report.nonLoopbackTcpObserved === true
    }));
  } catch (error) {
    errorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "RUNTIME_AUDIT_FAILED";
  } finally {
    controller?.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    if (auditor) {
      try { await stopChild(auditor, "AUDIT_CHILD_SURVIVED"); }
      catch { cleanupFailure = true; }
    }
    if (bridge) {
      try { await stopChild(bridge, "BRIDGE_CHILD_SURVIVED"); }
      catch { cleanupFailure = true; }
    }
    if (owned) {
      try {
        const current = await client.getDownload(infoHash);
        if (!current || !samePath(downloadString(current, "destination") ?? "", destination)) {
          cleanupFailure = true;
          downloadRemoved = false;
        }
        else {
          await client.stopDownload(infoHash);
          const stoppedDeadline = Date.now() + 10_000;
          while (Date.now() < stoppedDeadline) {
            const stopped = await client.getDownload(infoHash);
            if (!stopped || stopped.status.toUpperCase() === "STOPPED") break;
            await delay(200);
          }
          // A stopped status is published before Tribler has necessarily
          // drained its stream and checkpoint work. Give that owned download
          // a bounded grace period before asking Tribler to remove its data.
          await delay(15_000);
          await client.deleteDownload(infoHash, true);
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline && await client.getDownload(infoHash)) await delay(200);
          downloadRemoved = !await client.getDownload(infoHash);
          if (!downloadRemoved) cleanupFailure = true;
        }
      } catch { cleanupFailure = true; }
    }
    if (!await removeOwnedDestination(destination, downloadRemoved).catch(() => false)) cleanupFailure = true;
    if (!await cleanupRegistry(bridgeCwd)) cleanupFailure = true;
  }
  if (cleanupFailure) report.cleanup = "CLEANUP_FAILED";
  if (errorCode) report.errorCode = errorCode;
  if (errorCode || cleanupFailure) {
    report.evidenceLevel = "INCONCLUSIVE";
    report.result = "INCONCLUSIVE";
  }
  // Child output is captured for local diagnosis but deliberately excluded from the report.
  void redact(bridgeStdout + bridgeStderr + auditStderr, config.triblerApiKey);
  return report;
}

void main().then((report) => {
  process.stdout.write(JSON.stringify(report) + "\n");
}).catch((error: unknown) => {
  const errorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : error instanceof TriblerError || (error instanceof Error && error.message === "fetch failed")
      ? "TRIBLER_UNAVAILABLE" : "PROJECT_CONFIGURATION_UNAVAILABLE";
  process.stdout.write(JSON.stringify({ test: "privacy-runtime-tribler-playback", result: "INCONCLUSIVE",
    evidenceLevel: "INCONCLUSIVE", cleanup: "UNKNOWN", errorCode }) + "\n");
  process.exitCode = 1;
});
