import "dotenv/config";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024;
const HASH = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";
const RATE = MIB;
const PLAYBACK_RATE = 460_000; // Approximately 276 MB over Big Buck Bunny's 596-second runtime.
const AB_RANGE_BYTES = 32 * MIB;
const AB_SEEK_BYTES = 4 * MIB;
const RANGE_BYTES = 128 * MIB;
const QUALIFICATION_RANGE_BYTES = 64 * MIB;
const PIECE_DIAGNOSTIC_RANGE_BYTES = 8 * MIB;
const SEEK_BYTES = 8 * MIB;
const WARM_PROBE_BYTES = 256 * 1024;
const MAX_PASS_MS = 8 * 60 * 1_000;
const METADATA_MS = 120_000;
const PROJECT_ROOT = process.cwd();
const OWNER_ROOT = resolve(PROJECT_ROOT, ".bridge-state", "swarm-benchmark");
const BRIDGE_ENTRY = resolve(PROJECT_ROOT, "src/index.ts");
const TRIBLER_URL = process.env.TRIBLER_URL?.replace(/\/$/, "");
const API_KEY = process.env.TRIBLER_API_KEY ?? "";
let MAGNET;

function installBridgeTrace() {
  // Benchmark child only: record numeric offsets and monotonic times, never URLs or credentials.
  const originalFetch = globalThis.fetch;
  const originalWrite = ServerResponse.prototype.write;
  let nextId = 0;
  const record = (event, id, offset, status) => {
    process.stdout.write(`BENCH_STREAM_TRACE ${JSON.stringify({ event, id, offset,
      ...(status === undefined ? {} : { status }), ns: process.hrtime.bigint().toString() })}\n`);
  };
  const rangeOffset = (headers) => {
    const match = /^bytes=(\d+)-/.exec(new globalThis.Headers(headers).get("range") ?? "");
    return match ? Number(match[1]) : null;
  };
  record("preloadReady", null, null);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/downloads\/[a-f0-9]{40}\/stream\/\d+$/.test(url)) {
      return originalFetch(input, init);
    }
    const id = ++nextId;
    const offset = rangeOffset(init?.headers);
    record("upstreamRequest", id, offset);
    const response = await originalFetch(input, init);
    record("upstreamHeaders", id, offset, response.status);
    if (!response.body) return response;
    let first = true;
    const body = response.body.pipeThrough(new globalThis.TransformStream({ transform(chunk, controller) {
      if (first) { first = false; record("upstreamBody", id, offset); }
      controller.enqueue(chunk);
    } }));
    return new globalThis.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  ServerResponse.prototype.write = function (chunk, ...args) {
    if (!this.benchmarkFirstWrite && this.req?.url?.startsWith("/play/") && chunk?.length > 0) {
      this.benchmarkFirstWrite = true;
      record("bridgeWrite", null, rangeOffset(this.req.headers), this.statusCode);
    }
    return originalWrite.call(this, chunk, ...args);
  };
}

function redact(value) {
  let result = value;
  for (const secret of [API_KEY, MAGNET]) if (secret) result = result.replaceAll(secret, "<redacted>");
  return result;
}

async function json(url, init = {}, timeoutMs = 5_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status} returned non-JSON`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${redact(text.slice(0, 300))}`);
  return body;
}

function tribler(path, init = {}, timeoutMs = 5_000) {
  return json(`${TRIBLER_URL}${path}`, {
    ...init, headers: { "X-Api-Key": API_KEY, ...(init.body ? { "Content-Type": "application/json" } : {}) }
  }, timeoutMs);
}

async function download(withPieces = false) {
  const query = withPieces ? `?get_pieces=1&infohash=${HASH}` : "";
  const payload = await tribler(`/api/downloads${query}`);
  return payload.downloads.find(entry => entry.infohash?.toLowerCase() === HASH);
}

function presentPieces(entry) {
  const mask = Buffer.from(entry.pieces ?? "", "base64");
  if (!entry.total_pieces || mask.length < Math.ceil(entry.total_pieces / 8)) {
    throw new Error("Tribler did not return a complete piece bitfield");
  }
  let count = 0;
  for (const byte of mask) {
    let value = byte;
    while (value) { count += value & 1; value >>= 1; }
  }
  return count;
}

function piecePresent(entry, index) {
  const mask = Buffer.from(entry.pieces ?? "", "base64");
  if (!Number.isSafeInteger(index) || index < 0 || index >= entry.total_pieces
    || mask.length < Math.ceil(entry.total_pieces / 8)) throw new Error("Invalid Tribler piece bitfield");
  // Tribler's documented bitmask encodes the first piece in the high bit.
  return (mask[Math.floor(index / 8)] & (1 << (7 - index % 8))) !== 0;
}

function decodeBencode(bytes) {
  let cursor = 0;
  function read(depth = 0) {
    if (depth > 32 || cursor >= bytes.length) throw new Error("Invalid torrent metadata depth or length");
    const start = cursor;
    const type = bytes[cursor++];
    let value;
    if (type === 105) {
      const end = bytes.indexOf(101, cursor);
      if (end < 0) throw new Error("Invalid torrent integer");
      value = Number(bytes.toString("ascii", cursor, end)); cursor = end + 1;
      if (!Number.isSafeInteger(value)) throw new Error("Unsafe torrent integer");
    } else if (type === 108 || type === 100) {
      value = type === 108 ? [] : new Map();
      while (bytes[cursor] !== 101) {
        if (cursor >= bytes.length) throw new Error("Unterminated torrent collection");
        if (type === 108) value.push(read(depth + 1));
        else {
          const key = read(depth + 1).value;
          if (!Buffer.isBuffer(key)) throw new Error("Invalid torrent dictionary key");
          value.set(key.toString("utf8"), read(depth + 1));
        }
      }
      cursor++;
    } else if (type >= 48 && type <= 57) {
      cursor--;
      const colon = bytes.indexOf(58, cursor);
      if (colon < 0) throw new Error("Invalid torrent byte string");
      const length = Number(bytes.toString("ascii", cursor, colon));
      if (!Number.isSafeInteger(length) || length < 0 || colon + 1 + length > bytes.length) {
        throw new Error("Invalid torrent byte string length");
      }
      cursor = colon + 1;
      value = bytes.subarray(cursor, cursor + length);
      cursor += length;
    } else throw new Error("Invalid torrent metadata type");
    return { value, start, end: cursor };
  }
  const root = read();
  if (cursor !== bytes.length || !(root.value instanceof Map)) throw new Error("Invalid torrent metadata root");
  return root.value;
}

function dictionaryValue(node, key) {
  if (!(node?.value instanceof Map) || !node.value.has(key)) throw new Error(`Torrent metadata lacks ${key}`);
  return node.value.get(key);
}

async function torrentLayout(restFiles, totalPieces) {
  const response = await fetch(`${TRIBLER_URL}/api/downloads/${HASH}/torrent`, {
    headers: { "X-Api-Key": API_KEY }, signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Tribler torrent export returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 4 * MIB) throw new Error("Torrent metadata is unexpectedly large");
  const info = decodeBencode(bytes).get("info");
  if (!info || createHash("sha1").update(bytes.subarray(info.start, info.end)).digest("hex") !== HASH) {
    throw new Error("Tribler torrent export does not match the legal fixture");
  }
  const pieceLength = dictionaryValue(info, "piece length").value;
  const fileNodes = info.value.has("files") ? dictionaryValue(info, "files").value
    : [info];
  if (!Number.isSafeInteger(pieceLength) || pieceLength <= 0 || !Array.isArray(fileNodes)) {
    throw new Error("Unsupported torrent piece layout");
  }
  let offset = 0;
  const files = fileNodes.map((node, index) => {
    const size = dictionaryValue(node, "length").value;
    if (!Number.isSafeInteger(size) || size < 0 || restFiles.find(file => file.index === index)?.size !== size) {
      throw new Error("Tribler file indices do not match the verified torrent layout");
    }
    const file = { index, size, torrentOffset: offset };
    offset += size;
    return file;
  });
  if (files.length !== restFiles.length || Math.ceil(offset / pieceLength) !== totalPieces) {
    throw new Error("Tribler piece count or file layout does not match the torrent export");
  }
  return { pieceLength, totalBytes: offset, files };
}

function pieceRange(layout, fileIndex, start, length) {
  const file = layout.files.find(candidate => candidate.index === fileIndex);
  if (!file || start < 0 || length <= 0 || start + length > file.size) throw new Error("Invalid mapped file range");
  return { first: Math.floor((file.torrentOffset + start) / layout.pieceLength),
    last: Math.floor((file.torrentOffset + start + length - 1) / layout.pieceLength) };
}

async function monitorActivity(started, signal, watches) {
  const first = { connectedPeerMs: null, downloadActivityMs: null, anyPieceMs: null };
  const pieces = Object.fromEntries(Object.entries(watches).map(([name, range]) => [name, {
    first: range.first, last: range.last, lastMissingMs: null, firstCompleteMs: null
  }]));
  while (!signal.aborted) {
    try {
      const entry = await download(true);
      if (entry) {
        const elapsed = Math.round(performance.now() - started);
        if (first.connectedPeerMs === null && (entry.num_connected_peers ?? 0) > 0) first.connectedPeerMs = elapsed;
        if (first.downloadActivityMs === null && (entry.speed_down ?? 0) > 0) first.downloadActivityMs = elapsed;
        if (first.anyPieceMs === null && entry.pieces && presentPieces(entry) > 0) first.anyPieceMs = elapsed;
        if (entry.pieces) for (const state of Object.values(pieces)) {
          if (state.firstCompleteMs !== null) continue;
          let complete = true;
          for (let index = state.first; index <= state.last; index++) {
            if (!piecePresent(entry, index)) { complete = false; break; }
          }
          if (complete) state.firstCompleteMs = elapsed;
          else state.lastMissingMs = elapsed;
        }
      }
    } catch { /* Monitoring is supplementary; the measured stream remains authoritative. */ }
    await delay(250, undefined, { signal }).catch(() => undefined);
  }
  return { first, pieces };
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function ready(baseUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError) {
      throw new Error(`Bridge exited early: ${child.spawnError?.message ?? child.exitCode}`);
    }
    try {
      const health = await json(`${baseUrl}/health`, {}, 2_000);
      if (health.ok && health.triblerStreaming) return;
    } catch { /* bounded readiness retry */ }
    await delay(200);
  }
  throw new Error("Bridge /health did not become ready in 20 seconds");
}

async function stopBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([once(child, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(2_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error("Bridge child survived cleanup");
}

function metricsDelta(before, after) {
  const result = {};
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === "number" && typeof before[key] === "number") result[key] = value - before[key];
  }
  result.bufferHighWaterBytes = after.bufferHighWaterBytes;
  return result;
}

function msSince(originNs, atNs = process.hrtime.bigint()) {
  return Math.round(Number(atNs - originNs) / 1_000_000);
}

async function waitForMetadata() {
  const deadline = Date.now() + METADATA_MS;
  while (Date.now() < deadline) {
    const current = await download(true);
    if (!current) throw new Error("Benchmark download disappeared while waiting for metadata");
    if (current.error || current.status?.includes("ERROR")) throw new Error(`Tribler metadata failed: ${current.status}`);
    if (current.total_pieces > 0 && current.pieces) {
      const files = (await tribler(`/api/downloads/${HASH}/files`)).files;
      if (files.length) return { current, files };
    }
    await delay(500);
  }
  throw new Error("Legal fixture metadata did not arrive within 120 seconds");
}

async function coldSnapshot(destination, fileIndex) {
  const entry = await download(true);
  if (!entry || resolve(entry.destination) !== destination) throw new Error("Benchmark download destination changed");
  const files = (await tribler(`/api/downloads/${HASH}/files`)).files;
  const file = files.find(candidate => candidate.index === fileIndex);
  const pieces = presentPieces(entry);
  if (!file || file.progress !== 0 || pieces !== 0) {
    throw new Error(`Requested data is not cold: fileProgress=${file?.progress}, presentPieces=${pieces}`);
  }
  return { status: entry.status, progress: entry.progress, fileProgress: file.progress,
    presentPieces: pieces, totalPieces: entry.total_pieces, destinationEmpty: readdirSync(destination).length === 0,
    hops: entry.hops, anonDownload: entry.anon_download, safeSeeding: entry.safe_seeding,
    allTimeDownload: entry.all_time_download };
}

async function stream(baseUrl, file, startedFrom, rangeBytes = RANGE_BYTES, clockOriginNs,
  consumerRate = RATE, measurePlayback = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Cold swarm pass timed out after 8 minutes")), MAX_PASS_MS);
  const started = performance.now();
  const requestAtMs = clockOriginNs ? msSince(clockOriginNs) : null;
  let firstByteMs = null;
  let firstClientByteAtMs = null;
  let bytes = 0;
  let clientReadWaitCount = 0;
  let clientReadWaitMs = 0;
  let readWaitOver10MsCount = 0;
  let readWaitOver10Ms = 0;
  let playbackStart = null;
  let playbackStartDownload = null;
  let playbackStartMetrics = null;
  let sixtySecondPlayback = null;
  let first60StallCount = 0;
  let first60StallMs = 0;
  let first60LongestStallMs = 0;
  let maxConnectedPeers = 0;
  let maxSpeedDown = 0;
  let lastSample = 0;
  try {
    const name = encodeURIComponent(file.name.split(/[\\/]/).pop() ?? "video.mp4");
    const response = await fetch(`${baseUrl}/play/${HASH}/${file.index}/${name}`, {
      headers: { Range: `bytes=0-${rangeBytes - 1}`, "Accept-Encoding": "identity" },
      signal: controller.signal
    });
    if (response.status !== 206 || !response.body) throw new Error(`Stream returned HTTP ${response.status}`);
    const expectedRange = `bytes 0-${rangeBytes - 1}/${file.size}`;
    if (response.headers.get("content-range") !== expectedRange
      || Number(response.headers.get("content-length")) !== rangeBytes) {
      throw new Error("Stream Range or Content-Length was incorrect");
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const waitingSince = performance.now();
        const { done, value } = await reader.read();
        const waited = performance.now() - waitingSince;
        if (done) break;
        // Reader latency includes ready-data scheduling; these are supplementary client-side numbers.
        if (firstByteMs !== null) {
          clientReadWaitCount += 1; clientReadWaitMs += waited;
          if (waited > 10) { readWaitOver10MsCount += 1; readWaitOver10Ms += waited; }
          if (measurePlayback && performance.now() - playbackStart <= 60_000 && waited > 100) {
            first60StallCount += 1;
            first60StallMs += waited;
            first60LongestStallMs = Math.max(first60LongestStallMs, waited);
          }
        }
        else {
          firstByteMs = Math.round(performance.now() - started);
          if (clockOriginNs) firstClientByteAtMs = msSince(clockOriginNs);
          if (measurePlayback) {
            playbackStart = performance.now();
            playbackStartDownload = await download(true);
            playbackStartMetrics = (await json(`${baseUrl}/health`)).triblerStreaming;
          }
        }
        bytes += value.byteLength;
        if (performance.now() - lastSample >= 5_000) {
          const current = await download();
          if (current) {
            maxConnectedPeers = Math.max(maxConnectedPeers, current.num_connected_peers ?? 0);
            maxSpeedDown = Math.max(maxSpeedDown, current.speed_down ?? 0);
          }
          lastSample = performance.now();
        }
        await delay(value.byteLength * 1_000 / consumerRate, undefined, { signal: controller.signal });
        if (measurePlayback && !sixtySecondPlayback && performance.now() - playbackStart >= 60_000) {
          const snapshot = await download(true);
          const health = (await json(`${baseUrl}/health`)).triblerStreaming;
          const elapsedMs = performance.now() - playbackStart;
          const downloadedBytes = snapshot.all_time_download - playbackStartDownload.all_time_download;
          sixtySecondPlayback = { observedMs: Math.round(elapsedMs), downloadedBytes,
            newPieces: presentPieces(snapshot) - presentPieces(playbackStartDownload),
            usefulMiBps: downloadedBytes / MIB / (elapsedMs / 1_000),
            bridgeMetrics: metricsDelta(playbackStartMetrics, health),
            stallCountOver100Ms: first60StallCount, stallMsOver100Ms: Math.round(first60StallMs),
            longestStallMs: Math.round(first60LongestStallMs) };
        }
      }
    } finally { reader.releaseLock(); }
    if (bytes !== rangeBytes) throw new Error(`Incomplete cold Range: ${bytes} of ${rangeBytes} bytes`);
    const totalMs = Math.round(performance.now() - started);
    const afterDownload = await download(true);
    if (!afterDownload) throw new Error("Benchmark download disappeared after stream");
    const newPieces = presentPieces(afterDownload) - startedFrom.presentPieces;
    const downloadedFromTribler = afterDownload.all_time_download - startedFrom.allTimeDownload;
    if (newPieces <= 0 || downloadedFromTribler <= 0) {
      throw new Error("No new torrent pieces or Tribler download bytes were recorded");
    }
    return { status: response.status, contentRange: expectedRange, contentLength: rangeBytes,
      ...(clockOriginNs ? { requestAtMs, firstClientByteAtMs } : {}),
      firstByteMs, totalMs, consumedBytes: bytes, clientReadWaitCount, clientReadWaitMs,
      readWaitOver10MsCount, readWaitOver10Ms,
      ...(measurePlayback ? { playbackDurationMs: Math.round(performance.now() - playbackStart),
        sixtySecondPlayback } : {}),
      newPieces, triblerDownloadedBytes: downloadedFromTribler, maxConnectedPeers, maxSpeedDown };
  } finally { clearTimeout(timeout); }
}

async function rangeProbe(url, file, start, length, headers, paced = true, clockOriginNs, consumerRate = RATE) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Seek Range timed out")), 120_000);
  const started = performance.now();
  const requestAtMs = clockOriginNs ? msSince(clockOriginNs) : null;
  let firstByteMs = null;
  let firstClientByteAtMs = null;
  let bytes = 0;
  let largestReadWaitMs = 0;
  let readWaitOverOneSecond = 0;
  const hash = createHash("sha256");
  try {
    const response = await fetch(url, {
      headers: { ...headers, Range: `bytes=${start}-${start + length - 1}`, "Accept-Encoding": "identity" },
      signal: controller.signal
    });
    const contentRange = `bytes ${start}-${start + length - 1}/${file.size}`;
    if (response.status !== 206 || response.headers.get("content-range") !== contentRange
      || Number(response.headers.get("content-length")) !== length || !response.body) {
      throw new Error(`Seek Range headers were incorrect: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const readStarted = performance.now();
        const { done, value } = await reader.read();
        const readWait = performance.now() - readStarted;
        if (done) break;
        if (firstByteMs === null) {
          firstByteMs = Math.round(performance.now() - started);
          if (clockOriginNs) firstClientByteAtMs = msSince(clockOriginNs);
        }
        else {
          largestReadWaitMs = Math.max(largestReadWaitMs, readWait);
          if (readWait > 1_000) readWaitOverOneSecond += 1;
        }
        bytes += value.length;
        hash.update(value);
        if (paced) await delay(value.length * 1_000 / consumerRate, undefined, { signal: controller.signal });
      }
    } finally { reader.releaseLock(); }
    if (bytes !== length) throw new Error(`Incomplete seek Range: ${bytes} of ${length} bytes`);
    const totalMs = Math.round(performance.now() - started);
    return { requestedOffset: start, status: response.status, contentRange, bytes, firstByteMs,
      ...(clockOriginNs ? { requestAtMs, firstClientByteAtMs } : {}),
      totalMs, deliveredMiBps: bytes / MIB / (totalMs / 1_000), largestReadWaitMs: Math.round(largestReadWaitMs),
      readWaitOverOneSecond, sha256: hash.digest("hex") };
  } finally { clearTimeout(timeout); }
}

async function qualifiedSeek(baseUrl, file, start, clockOriginNs, length = SEEK_BYTES, consumerRate = RATE) {
  const name = encodeURIComponent(file.name.split(/[\\/]/).pop() ?? "video.mp4");
  const before = await download(true);
  const beforePieces = presentPieces(before);
  const beforeMetrics = (await json(`${baseUrl}/health`)).triblerStreaming;
  const measured = await rangeProbe(`${baseUrl}/play/${HASH}/${file.index}/${name}`, file, start, length, {}, true, clockOriginNs, consumerRate);
  const after = await download(true);
  const afterMetrics = (await json(`${baseUrl}/health`)).triblerStreaming;
  return { ...measured, newPieces: presentPieces(after) - beforePieces,
    connectedPeers: after.num_connected_peers ?? null, speedDownAtEnd: after.speed_down ?? null,
    metrics: metricsDelta(beforeMetrics, afterMetrics) };
}

async function run(mode, qualification = false, pieceDiagnostic = false, abProfile = null) {
  const rangeBytes = abProfile ? AB_RANGE_BYTES : pieceDiagnostic ? PIECE_DIAGNOSTIC_RANGE_BYTES
    : qualification ? QUALIFICATION_RANGE_BYTES : RANGE_BYTES;
  const seekBytes = abProfile ? AB_SEEK_BYTES : SEEK_BYTES;
  const consumerRate = abProfile ? PLAYBACK_RATE : RATE;
  const existing = await download();
  if (existing) throw new Error("Big Buck Bunny already exists in Tribler; refusing to reuse or delete it");
  mkdirSync(OWNER_ROOT, { recursive: true });
  const destination = resolve(OWNER_ROOT, randomUUID());
  if (relative(OWNER_ROOT, destination).startsWith("..") || existsSync(destination)) {
    throw new Error("Benchmark destination is not an unused owned path");
  }
  mkdirSync(destination);
  let bridgeCwd;
  let child;
  let activityController;
  let activityPromise;
  let owned = false;
  let cleanup = { removed: false, dataAbsentAfter: false };
  let result;
  let error;
  let stdout = "";
  let stderr = "";
  const traceEvents = [];
  let traceRemainder = "";
  const traceFor = (offset, originNs) => {
    const request = traceEvents.find(event => event.event === "upstreamRequest" && event.offset === offset);
    if (!request) throw new Error("Benchmark bridge did not trace its upstream stream request");
    const eventTime = (name) => {
      const event = traceEvents.find(candidate => candidate.event === name && candidate.offset === offset
        && (candidate.id === request.id || name === "bridgeWrite")
        && BigInt(candidate.ns) >= BigInt(request.ns));
      return event ? msSince(originNs, BigInt(event.ns)) : null;
    };
    return { upstreamRequestMs: eventTime("upstreamRequest"), upstreamHeadersMs: eventTime("upstreamHeaders"),
      upstreamBodyMs: eventTime("upstreamBody"), bridgeWriteMs: eventTime("bridgeWrite") };
  };
  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const timelineStartNs = process.hrtime.bigint();
    const timelineStart = performance.now();
    const added = await tribler("/api/downloads", {
      method: "PUT", body: JSON.stringify({ uri: MAGNET, destination, completed_dir: destination, only_metadata: true })
    }, 30_000);
    if (!added.started || added.infohash?.toLowerCase() !== HASH) {
      throw new Error("Tribler did not create the expected legal fixture");
    }
    owned = true;
    const addedMs = Math.round(performance.now() - timelineStart);
    const { current, files } = await waitForMetadata();
    const metadataMs = Math.round(performance.now() - timelineStart);
    if (resolve(current.destination) !== destination) throw new Error("Tribler reused a different destination");
    const file = files.find(candidate => candidate.name.toLowerCase().endsWith(".mp4") && candidate.size >= rangeBytes);
    if (!file) throw new Error("Legal fixture has no MP4 large enough for the cold Range");
    const selectedFileMs = Math.round(performance.now() - timelineStart);
    const layout = qualification ? await torrentLayout(files, current.total_pieces) : undefined;
    const forwardStart = Math.floor((file.size * 0.5) / MIB) * MIB;
    const backwardStart = Math.floor((file.size * 0.25) / MIB) * MIB;
    const watches = layout ? {
      initialPiece: pieceRange(layout, file.index, 0, 1),
      initialBridgeBuffer: pieceRange(layout, file.index, 0, Math.min(8 * MIB, file.size)),
      initialHeader: pieceRange(layout, file.index, 0, Math.min(5 * MIB, file.size)),
      initialFivePercent: pieceRange(layout, file.index, 0, Math.floor(file.size * 0.05)),
      initialFooter: pieceRange(layout, file.index, file.size - Math.min(MIB, file.size), Math.min(MIB, file.size)),
      forwardPiece: pieceRange(layout, file.index, forwardStart, 1),
      forwardBridgeBuffer: pieceRange(layout, file.index, forwardStart, seekBytes),
      backwardPiece: pieceRange(layout, file.index, backwardStart, 1),
      backwardBridgeBuffer: pieceRange(layout, file.index, backwardStart, seekBytes)
    } : undefined;
    await tribler(`/api/downloads/${HASH}`, {
      method: "PATCH", body: JSON.stringify({ selected_files: [file.index] })
    });
    const beforeResume = await coldSnapshot(destination, file.index);
    if (beforeResume.presentPieces !== 0) throw new Error("Cold prerequisite failed before resume");
    await tribler(`/api/downloads/${HASH}`, { method: "PATCH", body: JSON.stringify({ state: "resume" }) });
    const resumedMs = Math.round(performance.now() - timelineStart);
    if (qualification) {
      activityController = new AbortController();
      activityPromise = monitorActivity(timelineStart, activityController.signal, watches);
    }
    await coldSnapshot(destination, file.index);
    bridgeCwd = resolve(OWNER_ROOT, randomUUID());
    mkdirSync(bridgeCwd);
    const bridgeEnv = { ...process.env, BRIDGE_PORT: String(port), PUBLIC_BASE_URL: baseUrl,
      TRIBLER_STREAM_BUFFER_ENABLED: mode === "ON" ? "true" : "false",
      ...(abProfile ? { TRIBLER_STREAM_STARTUP_BUFFER_MIB: String(abProfile.startupMiB),
        TRIBLER_STREAM_SEEK_BUFFER_MIB: String(abProfile.seekMiB) } : {}),
      ...(qualification ? { BENCH_TRACE_PRELOAD: "1" } : {}) };
    for (const name of ["CATALOG_SOURCES_FILE", "STREAM_PROVIDER_STREMIO_ADDONS_FILE",
      "STREAM_PROVIDER_LOCAL_JSON_FILE", "STREAM_PROVIDER_LOCAL_JSON_DIRECTORY"]) {
      if (bridgeEnv[name]) bridgeEnv[name] = resolve(PROJECT_ROOT, bridgeEnv[name]);
    }
    child = spawn(process.execPath, [
      ...(qualification ? ["--import", pathToFileURL(resolve(PROJECT_ROOT, "scripts/benchmark-tribler-swarm.mjs")).href] : []),
      "--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, BRIDGE_ENTRY], {
      cwd: bridgeCwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: bridgeEnv
    });
    child.stdout.on("data", chunk => {
      const value = chunk.toString();
      stdout = (stdout + value).slice(-16_000);
      traceRemainder += value;
      const lines = traceRemainder.split("\n");
      traceRemainder = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("BENCH_STREAM_TRACE ")) {
        try { traceEvents.push(JSON.parse(line.slice("BENCH_STREAM_TRACE ".length))); }
        catch { /* Malformed diagnostic lines cannot affect bridge streaming. */ }
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.on("error", caught => { child.spawnError = caught; });
    await ready(baseUrl, child);
    // Recheck immediately before the measured request; reject any hot pieces.
    const atRequest = await coldSnapshot(destination, file.index);
    if (abProfile && (atRequest.hops !== 2 || atRequest.anonDownload !== true)) {
      throw new Error("A/B requires the existing two-hop anonymous Tribler configuration");
    }
    const initial = (await json(`${baseUrl}/health`)).triblerStreaming;
    const requestMs = Math.round(performance.now() - timelineStart);
    const streamed = await stream(baseUrl, file, atRequest, rangeBytes,
      qualification ? timelineStartNs : undefined, consumerRate, Boolean(abProfile));
    const final = (await json(`${baseUrl}/health`)).triblerStreaming;
    const metrics = metricsDelta(initial, final);
    if (metrics.streamsCompleted !== 1 || metrics.streamsAborted !== 0
      || metrics.downstreamBytes !== rangeBytes || metrics.upstreamBytes !== rangeBytes) {
      throw new Error(`Bridge did not complete the cold Range: ${JSON.stringify(metrics)}`);
    }
    result = { mode, source: "Big Buck Bunny", fileIndex: file.index, fileBytes: file.size,
      rangeBytes, consumerBytesPerSecond: consumerRate, cold: atRequest,
      ...(abProfile ? { abProfile } : {}),
      timelineMs: { added: addedMs, metadata: metadataMs, selectedFile: selectedFileMs,
        resumed: resumedMs, request: requestMs, firstBridgeByte: requestMs + streamed.firstByteMs },
      privacy: { hops: atRequest.hops, anonDownload: atRequest.anonDownload,
        safeSeeding: atRequest.safeSeeding }, ...streamed, metrics,
      averageUpstreamMiBps: metrics.upstreamBytes / MIB / (streamed.totalMs / 1_000),
      averageDownstreamMiBps: metrics.downstreamBytes / MIB / (streamed.totalMs / 1_000) };
    if (qualification) {
      const initialTrace = traceFor(0, timelineStartNs);
      if (initialTrace.upstreamRequestMs < streamed.requestAtMs - 50
        || initialTrace.bridgeWriteMs === null
        || initialTrace.bridgeWriteMs > streamed.firstClientByteAtMs + 50) {
        throw new Error("Benchmark monotonic trace clocks did not correlate");
      }
      result.qualification = { layout: { pieceLength: layout.pieceLength, totalBytes: layout.totalBytes,
        selectedFileOffset: layout.files.find(candidate => candidate.index === file.index).torrentOffset,
        watches }, initialTrace };
      const forward = await qualifiedSeek(baseUrl, file, forwardStart, timelineStartNs, seekBytes, consumerRate);
      const forwardTrace = traceFor(forwardStart, timelineStartNs);
      result.qualification.forward = { ...forward, trace: forwardTrace };
      const backward = await qualifiedSeek(baseUrl, file, backwardStart, timelineStartNs, seekBytes, consumerRate);
      const backwardTrace = traceFor(backwardStart, timelineStartNs);
      result.qualification.backward = { ...backward, trace: backwardTrace };
      activityController.abort();
      const activity = await activityPromise;
      result.qualification.activity = activity;
      const name = encodeURIComponent(file.name.split(/[\\/]/).pop() ?? "video.mp4");
      const warmStart = backward.requestedOffset;
      const direct = await rangeProbe(`${TRIBLER_URL}/api/downloads/${HASH}/stream/${file.index}`,
        file, warmStart, WARM_PROBE_BYTES, { "X-Api-Key": API_KEY }, false);
      const bridged = await rangeProbe(`${baseUrl}/play/${HASH}/${file.index}/${name}`,
        file, warmStart, WARM_PROBE_BYTES, {}, false);
      if (direct.sha256 !== bridged.sha256) throw new Error("Warm direct and bridge Range bytes differ");
      result.qualification.warmProbe = { direct, bridged,
        ttfbDifferenceMs: bridged.firstByteMs - direct.firstByteMs };
    }
  } catch (caught) { error = caught; }
  finally {
    activityController?.abort();
    if (activityPromise) {
      const activity = await activityPromise;
      if (result?.qualification && !result.qualification.activity) result.qualification.activity = activity;
    }
    if (child) {
      try { await stopBridge(child); } catch (caught) { error = new Error(`${error?.message ?? "Run failed"}; bridge cleanup: ${caught.message}`); }
    }
    if (owned) {
      try {
        const current = await download();
        if (!current || resolve(current.destination) !== destination) {
          error = new Error(`${error?.message ?? "Run failed"}; owned destination changed; preserving data`);
        } else {
          const removed = await tribler(`/api/downloads/${HASH}`, {
            method: "DELETE", body: JSON.stringify({ remove_data: true })
          }, 30_000);
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            cleanup.removed = removed.removed === true && !(await download());
            cleanup.dataAbsentAfter = !existsSync(destination) || readdirSync(destination).length === 0;
            if (cleanup.removed && cleanup.dataAbsentAfter) break;
            await delay(200);
          }
          if (cleanup.dataAbsentAfter && existsSync(destination)) rmdirSync(destination);
          if (!cleanup.removed || !cleanup.dataAbsentAfter) {
            error = new Error(`${error?.message ?? "Run failed"}; owned benchmark data remains after cleanup`);
          }
        }
      } catch (caught) { error = new Error(`${error?.message ?? "Run failed"}; torrent cleanup: ${caught.message}`); }
    } else {
      try { if (readdirSync(destination).length === 0) rmdirSync(destination); }
      catch (caught) { error = new Error(`${error?.message ?? "Run failed"}; empty destination cleanup: ${caught.message}`); }
    }
    if (bridgeCwd) {
      try {
        const stateDir = resolve(bridgeCwd, ".bridge-state");
        const stateFile = resolve(stateDir, "managed-downloads.json");
        const temporaryStateFile = `${stateFile}.tmp`;
        let canRemove = true;
        for (const candidate of [stateFile, temporaryStateFile]) {
          if (existsSync(candidate)) {
            const state = JSON.parse(readFileSync(candidate, "utf8"));
            if (!Array.isArray(state.downloads) || state.downloads.length !== 0) {
              canRemove = false;
              error = new Error(`${error?.message ?? "Run failed"}; isolated bridge state contains owned downloads; preserving it`);
            } else {
              unlinkSync(candidate);
            }
          }
        }
        if (canRemove) {
          if (existsSync(stateDir)) rmdirSync(stateDir);
          rmdirSync(bridgeCwd);
        }
      } catch (caught) { error = new Error(`${error?.message ?? "Run failed"}; isolated bridge state cleanup: ${caught.message}`); }
    }
  }
  if (error && abProfile && result) return { ...result, cleanup, runError: redact(error.message) };
  if (error) throw new Error(`${redact(error.message)}\nBridge stdout: ${redact(stdout)}\nBridge stderr: ${redact(stderr)}`);
  return { ...result, cleanup };
}

async function main() {
  const qualification = process.argv.includes("--qualification");
  const pieceDiagnostic = process.argv.includes("--piece-diagnostic");
  const abArg = process.argv.slice(2).find(arg => arg.startsWith("--buffer-ab="));
  if (process.argv.slice(2).some(arg => !["--qualification", "--piece-diagnostic", abArg].includes(arg))
    || (qualification && pieceDiagnostic) || (abArg && (qualification || pieceDiagnostic))) {
    throw new Error("Usage: node scripts/benchmark-tribler-swarm.mjs [--qualification|--piece-diagnostic|--buffer-ab=STARTUP_MIB:SEEK_MIB]");
  }
  const fixture = readFileSync(resolve(PROJECT_ROOT, "src/examples/test-stream-provider.ts"), "utf8");
  MAGNET = /export const BIG_BUCK_BUNNY_MAGNET = "([^"]+)";/.exec(fixture)?.[1];
  if (!TRIBLER_URL || !API_KEY || !MAGNET?.includes(HASH)) {
    throw new Error("Tribler local configuration or documented legal fixture is missing");
  }
  for (const [name, expected] of [["STARTUP", 8], ["SEEK", 4], ["MAX", 64]]) {
    const raw = process.env[`TRIBLER_STREAM_${name}_BUFFER_MIB`];
    if (raw !== undefined && Number(raw) !== expected) throw new Error(`${name} buffer differs from the validated default`);
  }
  if (abArg) {
    const match = /^--buffer-ab=(8|4|2|1):(4|2|1)$/.exec(abArg);
    if (!match) throw new Error("A/B buffer sizes must be whole MiB startup 8/4/2/1 and seek 4/2/1");
    const bufferAb = await run("ON", true, false,
      { startupMiB: Number(match[1]), seekMiB: Number(match[2]) });
    return { ok: !bufferAb.runError, bufferAb };
  }
  if (pieceDiagnostic) return { ok: true, pieceDiagnostic: await run("ON", true, true) };
  if (qualification) return { ok: true, qualification: await run("ON", true) };
  const off = await run("OFF");
  const on = await run("ON");
  if (off.fileIndex !== on.fileIndex || off.fileBytes !== on.fileBytes
    || off.privacy.hops !== on.privacy.hops
    || off.privacy.anonDownload !== on.privacy.anonDownload
    || off.privacy.safeSeeding !== on.privacy.safeSeeding) {
    throw new Error("OFF and ON did not use identical file or privacy settings");
  }
  return { ok: true, source: "Big Buck Bunny", off, on };
}

if (process.env.BENCH_TRACE_PRELOAD === "1") installBridgeTrace();
else {
  try { console.log(JSON.stringify(await main())); }
  catch (error) {
    console.log(JSON.stringify({ ok: false, error: redact(error instanceof Error ? error.message : String(error)) }));
    process.exitCode = 1;
  }
}
