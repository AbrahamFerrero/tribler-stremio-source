import "dotenv/config";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SINTEL_INFOHASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
const FILE_INDEX = 5;
const MIB = 1024 * 1024;
const RATE_BYTES_PER_SECOND = 2 * MIB;
const STARTUP_TIMEOUT_MS = 20_000;
const STREAM_TIMEOUT_MS = 180_000;
const SMOKE_TIMEOUT_MS = 30_000;
const MAX_LOG_CHARS = 16_000;
const PROJECT_ROOT = process.cwd();
const OWNER_ROOT = resolve(PROJECT_ROOT, ".bridge-state", "buffer-benchmark");

function keepTail(previous, chunk) {
  return (previous + chunk.toString()).slice(-MAX_LOG_CHARS);
}

function redact(value) {
  let result = value;
  for (const secret of [process.env.TRIBLER_API_KEY, process.env.LEGAL_TEST_MAGNET]) {
    if (secret) result = result.replaceAll(secret, "<redacted>");
  }
  return result;
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function getJson(url, timeoutMs = 5_000, allowHttpError = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  // Health/provider payloads can name private local integrations. The benchmark
  // only needs the status for diagnostics, never the response body.
  if (!response.ok && !allowHttpError) throw new Error(`HTTP ${response.status}`);
  return body;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError) {
      throw new Error(`Bridge exited before /health was ready: ${child.spawnError?.message ?? `exit=${child.exitCode}, signal=${child.signalCode}`}`);
    }
    try {
      const health = await getJson(`${baseUrl}/health`, 2_000, true);
      // /health intentionally reports 503 for a degraded optional provider. The
      // benchmark needs a usable Tribler stream path, not every catalog provider.
      if (health.tribler === "reachable" && health.triblerStreaming) return health.triblerStreaming;
      lastError = health.tribler === "unreachable" ? "Tribler is unreachable" : "missing triblerStreaming snapshot";
    } catch (error) {
      lastError = error.message;
    }
    await delay(200);
  }
  throw new Error(`/health was not ready within ${STARTUP_TIMEOUT_MS} ms: ${lastError}`);
}

async function stopBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([once(child, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(2_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error("Bridge child did not exit after cleanup");
}

function delta(before, after) {
  const result = {};
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === "number" && typeof before[key] === "number") {
      result[key] = value - before[key];
    }
  }
  // This metric is a maximum, not a counter. Each pass has its own bridge process.
  result.bufferHighWaterBytes = after.bufferHighWaterBytes;
  return result;
}

async function streamRange(baseUrl, startByte, rangeBytes, fileBytes, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Stream timed out after ${timeoutMs} ms`)), timeoutMs);
  const started = performance.now();
  let firstByteMs = null;
  let downstreamBytes = 0;
  let status = null;
  try {
    const url = `${baseUrl}/play/${SINTEL_INFOHASH}/${FILE_INDEX}/Sintel.mp4`;
    const response = await fetch(url, {
      headers: { Range: `bytes=${startByte}-${startByte + rangeBytes - 1}`, "Accept-Encoding": "identity" },
      signal: controller.signal
    });
    status = response.status;
    if (status !== 206 || !response.body) {
      throw new Error(`Stream returned HTTP ${status}: ${(await response.text()).slice(0, 300)}`);
    }
    const contentRange = response.headers.get("content-range");
    const expectedRange = `bytes ${startByte}-${startByte + rangeBytes - 1}/${fileBytes}`;
    if (contentRange !== expectedRange) {
      throw new Error(`Unexpected Content-Range: ${contentRange}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength !== rangeBytes) throw new Error(`Unexpected Content-Length: ${contentLength}`);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Math.round(performance.now() - started);
      downstreamBytes += value.byteLength;
      hash.update(value);
      await delay(value.byteLength * 1_000 / RATE_BYTES_PER_SECOND, undefined, { signal: controller.signal });
    }
    if (downstreamBytes !== rangeBytes) {
      throw new Error(`Incomplete stream: received ${downstreamBytes} of ${rangeBytes} bytes`);
    }
    return { status, contentRange, contentLength, firstByteMs,
      totalMs: Math.round(performance.now() - started), downstreamBytes, sha256: hash.digest("hex") };
  } finally {
    clearTimeout(timeout);
  }
}

async function abortRange(baseUrl, rangeBytes, fileBytes, before) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Abort benchmark timed out")), 30_000);
  let reader;
  let consumedBytes = 0;
  try {
    const response = await fetch(`${baseUrl}/play/${SINTEL_INFOHASH}/${FILE_INDEX}/Sintel.mp4`, {
      headers: { Range: `bytes=0-${rangeBytes - 1}`, "Accept-Encoding": "identity" },
      signal: controller.signal
    });
    if (response.status !== 206 || !response.body) throw new Error(`Abort stream returned HTTP ${response.status}`);
    if (response.headers.get("content-range") !== `bytes 0-${rangeBytes - 1}/${fileBytes}`) {
      throw new Error("Abort stream Content-Range was incorrect");
    }
    reader = response.body.getReader();
    let highWaterBeforeAbort = 0;
    while (highWaterBeforeAbort < 16 * MIB || consumedBytes < MIB) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Abort stream ended before the buffer grew");
      consumedBytes += value.byteLength;
      await delay(value.byteLength * 1_000 / RATE_BYTES_PER_SECOND, undefined, { signal: controller.signal });
      highWaterBeforeAbort = (await getJson(`${baseUrl}/health`)).triblerStreaming.bufferHighWaterBytes;
    }
    controller.abort(new Error("Intentional client abort"));
    await reader.cancel().catch(() => undefined);
    const deadline = Date.now() + 10_000;
    let settled;
    while (Date.now() < deadline) {
      settled = (await getJson(`${baseUrl}/health`)).triblerStreaming;
      if (settled.streamsAborted - before.streamsAborted === 1) break;
      await delay(100);
    }
    if (!settled || settled.streamsAborted - before.streamsAborted !== 1) {
      throw new Error("Bridge did not record the client abort");
    }
    await delay(250);
    const firstStable = (await getJson(`${baseUrl}/health`)).triblerStreaming;
    await delay(500);
    const after = (await getJson(`${baseUrl}/health`)).triblerStreaming;
    if (after.upstreamBytes !== firstStable.upstreamBytes) {
      throw new Error(`Upstream kept growing after abort: ${firstStable.upstreamBytes} -> ${after.upstreamBytes}`);
    }
    return { stream: { status: response.status, contentRange: response.headers.get("content-range"),
      contentLength: Number(response.headers.get("content-length")), consumedBytes, highWaterBeforeAbort,
      upstreamAtSettled: firstStable.upstreamBytes, upstreamAfterCleanup: after.upstreamBytes },
      after };
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort(new Error("Abort benchmark cleanup"));
    await reader?.cancel().catch(() => undefined);
  }
}

async function runPass(mode, kind = "normal") {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  mkdirSync(OWNER_ROOT, { recursive: true });
  const bridgeCwd = resolve(OWNER_ROOT, randomUUID());
  mkdirSync(bridgeCwd);
  let child;
  let stdout = "";
  let stderr = "";
  let error;
  let result;
  try {
    const bridgeEnv = { ...process.env, BRIDGE_PORT: String(port), PUBLIC_BASE_URL: baseUrl,
      TRIBLER_STREAM_BUFFER_ENABLED: mode === "ON" ? "true" : "false" };
    for (const name of ["CATALOG_SOURCES_FILE", "STREAM_PROVIDER_STREMIO_ADDONS_FILE",
      "STREAM_PROVIDER_LOCAL_JSON_FILE", "STREAM_PROVIDER_LOCAL_JSON_DIRECTORY"]) {
      if (bridgeEnv[name]) bridgeEnv[name] = resolve(PROJECT_ROOT, bridgeEnv[name]);
    }
    child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      resolve(PROJECT_ROOT, "src/index.ts")], {
      cwd: bridgeCwd, env: bridgeEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    child.stdout.on("data", chunk => { stdout = keepTail(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = keepTail(stderr, chunk); });
    child.on("error", caught => { child.spawnError = caught; });
    await waitForHealth(baseUrl, child);
    const head = await fetch(`${baseUrl}/play/${SINTEL_INFOHASH}/${FILE_INDEX}/Sintel.mp4`, {
      method: "HEAD", signal: AbortSignal.timeout(5_000)
    });
    if (!head.ok) throw new Error(`Sintel file index ${FILE_INDEX} is unavailable: HTTP ${head.status}`);
    const fileBytes = Number(head.headers.get("content-length"));
    if (!Number.isSafeInteger(fileBytes) || fileBytes < 12 * MIB) throw new Error(`Invalid Sintel file size: ${fileBytes}`);
    const startByte = kind === "seek" ? 64 * MIB : 0;
    const rangeBytes = kind === "smoke" ? 12 * MIB : kind === "seek" ? 32 * MIB : Math.min(128 * MIB, fileBytes);
    if (startByte + rangeBytes > fileBytes) throw new Error("Sintel is too small for the requested seek Range");
    const before = (await getJson(`${baseUrl}/health`)).triblerStreaming;
    if (!before) throw new Error("Initial /health snapshot is missing triblerStreaming");
    const { stream, after } = kind === "abort"
      ? await abortRange(baseUrl, rangeBytes, fileBytes, before)
      : { stream: await streamRange(baseUrl, startByte, rangeBytes, fileBytes,
        kind === "smoke" ? SMOKE_TIMEOUT_MS : STREAM_TIMEOUT_MS),
        after: (await getJson(`${baseUrl}/health`)).triblerStreaming };
    if (!after) throw new Error("Final /health snapshot is missing triblerStreaming");
    result = { mode, kind, fileIndex: FILE_INDEX, fileBytes, startByte, rangeBytes,
      consumerBytesPerSecond: RATE_BYTES_PER_SECOND, ...stream, metrics: delta(before, after) };
    if (kind === "abort"
      ? result.metrics.streamsCompleted !== 0 || result.metrics.streamsAborted !== 1
      : result.metrics.streamsCompleted !== 1 || result.metrics.streamsAborted !== 0) {
      throw new Error(`Stream did not complete cleanly: ${JSON.stringify(result.metrics)}`);
    }
  } catch (caught) {
    error = caught;
  } finally {
    if (child) {
      try { await stopBridge(child); } catch (cleanupError) {
        error = new Error(`${error?.message ?? "Benchmark failed"}; cleanup: ${cleanupError.message}`);
      }
    }
    try {
      const stateDir = resolve(bridgeCwd, ".bridge-state");
      const stateFile = resolve(stateDir, "managed-downloads.json");
      let canRemove = true;
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        if (!Array.isArray(state.downloads) || state.downloads.length !== 0) {
          canRemove = false;
          error = new Error(`${error?.message ?? "Benchmark failed"}; isolated bridge state contains owned downloads; preserving it`);
        } else {
          unlinkSync(stateFile);
        }
      }
      if (canRemove) {
        if (existsSync(stateDir)) rmdirSync(stateDir);
        rmdirSync(bridgeCwd);
      }
    } catch (cleanupError) {
      error = new Error(`${error?.message ?? "Benchmark failed"}; isolated state cleanup: ${cleanupError.message}`);
    }
  }
  if (error) {
    throw new Error(`${error.message}\nBridge stdout: ${redact(stdout)}\nBridge stderr: ${redact(stderr)}`);
  }
  return result;
}

async function main() {
  const smoke = process.argv.includes("--smoke");
  const seek = process.argv.includes("--seek");
  const abort = process.argv.includes("--abort");
  if (process.argv.slice(2).some(arg => !["--smoke", "--seek", "--abort"].includes(arg))
    || Number(smoke) + Number(seek) + Number(abort) > 1) {
    throw new Error("Usage: node scripts/benchmark-tribler-buffer.mjs [--smoke|--seek|--abort]");
  }
  if (!process.env.LEGAL_TEST_MAGNET?.toLowerCase().includes(SINTEL_INFOHASH)) {
    throw new Error("LEGAL_TEST_MAGNET must identify the documented Sintel fixture");
  }
  if (smoke) return { ok: true, smoke: await runPass("ON", "smoke") };
  if (seek) {
    const off = await runPass("OFF", "seek");
    const on = await runPass("ON", "seek");
    if (off.sha256 !== on.sha256) throw new Error("Seek Range bytes differ between OFF and ON");
    return { ok: true, seek: { off, on } };
  }
  if (abort) return { ok: true, abort: await runPass("ON", "abort") };
  const off = await runPass("OFF");
  const on = await runPass("ON");
  return { ok: true, off, on };
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: redact(error instanceof Error ? error.message : String(error)) }));
  process.exitCode = 1;
}
