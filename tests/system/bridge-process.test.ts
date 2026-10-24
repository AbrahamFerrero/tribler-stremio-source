// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { createServer, request as httpRequest, type RequestListener, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestStremioAddon } from "../../src/examples/test-stremio-addon";
import { adjudicate, pilotMode, publicIdentityState, type Dimensions } from "../identity-qa/harness";
import { knownViolations } from "../identity-qa/known-violations";
import { intakeContract, pilotContract } from "../identity-qa/pilot-corpus";

import { syntheticAdminToken } from "../helpers";
import { nativeHttpFetch } from "../native-http-client";
import { loadStreamRankingPolicy } from "../../src/streams/ranking-policy";
import { rankedStreamDescription } from "../../src/streams/presentation";
import type { NormalizedStreamSource } from "../../src/streams/types";

const hash = "a".repeat(40);
const bytes = Buffer.from("synthetic-acceptance-video-bytes");
const syntheticDirectUrl = "https://1.1.1.1/fixture-video.mp4";
const securitySentinel = "SECURITY_TEST_TRIBLER_KEY_DO_NOT_LEAK_7f3a9c2d";

function bridgeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const path = new URL(input).pathname;
  const headers = new Headers(init.headers);
  if (/^\/(health|providers|resolve|downloads)(?:\/|$)/.test(path)) headers.set("Authorization", `Bearer ${syntheticAdminToken}`);
  else if (/^\/(catalog|meta|stream)\//.test(path)) headers.set("Origin", "https://web.stremio.com");
  return nativeHttpFetch(input, { ...init, headers });
}

const root = process.cwd();
const hostRoot = join(root, "python-adapter-host");
const fixtureAddon = join(hostRoot, "tests", "fixtures", "fake_kodi_addon");
const ac8TestId = "tt8765432";

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function within<T>(value: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 2_000); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000))
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error("test child survived cleanup");
}

function capture(child: ChildProcess): { stdout: string; stderr: string } {
  const output = { stdout: "", stderr: "" };
  const append = (name: "stdout" | "stderr") => (chunk: Buffer | string): void => {
    output[name] = `${output[name]}${String(chunk)}`.slice(-65_536);
  };
  child.stdout?.on("data", append("stdout"));
  child.stderr?.on("data", append("stderr"));
  return output;
}

async function ready(url: string, child: ChildProcess, timeoutMs = 8_000, acceptedStatuses = new Set([200]), admin = false): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`child exited before readiness: ${last}`);
    try {
      const response = admin ? await bridgeFetch(`${url}/health`) : await fetch(`${url}/health`);
      if (acceptedStatuses.has(response.status)) return await response.json() as Record<string, unknown>;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`child readiness timeout: ${last}`);
}

function childEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec", "PYTHONHOME", "PYTHONPATH"];
  return { ...Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])), ...values };
}

describe("system: configured bridge and Python host", () => {
  let tribler: Server | undefined;
  let python: ChildProcess | undefined;
  let node: ChildProcess | undefined;
  let stateDirectory = "";
  let bridgeUrl = "";
  let pythonUrl = "";
  let triblerUrl = "";
  let nodeOutput = { stdout: "", stderr: "" };
  const selected: number[][] = [];
  const triblerOperations: Array<{ method: string; path: string }> = [];
  const triblerDownloads: Array<{ infohash: string; name: string; status: string; progress: number; speed_down: number; speed_up: number; num_peers: number; num_seeds: number }> = [];
  let pendingTriblerStream: { started: () => void; aborted: () => void; startedPromise: Promise<void>; abortedPromise: Promise<void> } | undefined;

  async function startBridge(overrides: Record<string, string> = {}, addons: Array<Record<string, unknown>> = [], directoryOverride?: string): Promise<{
    child: ChildProcess; url: string; directory: string; output: { stdout: string; stderr: string };
  }> {
    const directory = directoryOverride ?? await mkdtemp(join(tmpdir(), "tribler-acceptance-"));
    if (addons.length) await writeFile(join(directory, "addons.json"), JSON.stringify(addons));
    const probe = await listen((_q, response) => response.end()); await close(probe.server);
    const environment = childEnvironment({
      BRIDGE_ADMIN_TOKEN: syntheticAdminToken, BRIDGE_PORT: new URL(probe.url).port, PUBLIC_BASE_URL: probe.url,
      TRIBLER_URL: triblerUrl, TRIBLER_API_KEY: securitySentinel, TRIBLER_AUTO_DISCOVER: "false",
      CATALOG_PROVIDER: "configured", LEGAL_TEST_MAGNET: `magnet:?xt=urn:btih:${hash}`,
      STREAM_PROVIDERS: "external_http", STREAM_PROVIDER_EXTERNAL_ENABLED: "true",
      STREAM_PROVIDER_EXTERNAL_URL: `${pythonUrl}/resolve`, STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS: "1000",
      STREAM_PROVIDER_TIMEOUT_MS: "1000", TORRENT_SAFETY_MODE: "fast", TRIBLER_STREAM_BUFFER_ENABLED: "false",
      METADATA_TIMEOUT_MS: "1000", NO_SEEDS_TIMEOUT_MS: "1000", POLL_INTERVAL_MS: "10",
      CLEANUP_INTERVAL_MS: "1000",
      ...(addons.length ? { STREAM_PROVIDER_STREMIO_ADDONS_FILE: "addons.json" } : {}), ...overrides
    });
    const child = spawn(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "index.ts")], { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const output = capture(child);
    try {
      await ready(probe.url, child, 8_000, new Set([200, 503]), true);
    } catch (error) {
      try { await stop(child); }
      finally { if (!directoryOverride) await removeTemporaryDirectory(directory); }
      throw error;
    }
    return { child, url: probe.url, directory, output };
  }

  async function startP2pPython(): Promise<{ child: ChildProcess; url: string; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), "tribler-acceptance-profile-"));
    const probe = await listen((_q, response) => response.end()); await close(probe.server);
    const environment = childEnvironment({
      PYTHON_ADAPTER_PORT: new URL(probe.url).port,
      PYTHON_ADAPTER_KODI_RESOLVER_ENABLED: "true",
      PYTHON_ADAPTER_KODI_ADDON_PATH: fixtureAddon,
      PYTHON_ADAPTER_KODI_ADDON_ID: "script.module.fake",
      PYTHON_ADAPTER_KODI_MODULE: "adapter_host.kodi.adapters.p2p_metadata",
      PYTHON_ADAPTER_KODI_SETTINGS_FILE: join(fixtureAddon, "settings.example.json"),
      PYTHON_ADAPTER_KODI_PROFILE_PATH: directory,
      PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS: "1",
      PYTHON_ADAPTER_KODI_SOURCE_MODULE: "example_p2p.sources.torrents.metadata_source",
      PYTHON_ADAPTER_KODI_SOURCE_ID: "example_p2p",
      PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING: "provider.example_p2p",
      PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE: "capture-streams"
    });
    const child = spawn("python", ["-m", "adapter_host"], { cwd: hostRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    await ready(probe.url, child);
    return { child, url: probe.url, directory };
  }

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "tribler-acceptance-"));
    const fixture = await listen((request, response) => { void (async () => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      triblerOperations.push({ method: request.method ?? "", path });
      const body = await new Promise<string>((resolveBody) => { let value = ""; request.on("data", (chunk) => { value += String(chunk); }); request.on("end", () => resolveBody(value)); });
      response.setHeader("Content-Type", "application/json");
      if (path === "/api/downloads" && request.method === "GET") return void response.end(JSON.stringify({ downloads: triblerDownloads }));
      if (path === "/api/downloads" && request.method === "PUT") {
        if (!triblerDownloads.some((download) => download.infohash === hash)) {
          triblerDownloads.push({ infohash: hash, name: "fixture", status: "DOWNLOADING", progress: 0, speed_down: 0, speed_up: 0, num_peers: 1, num_seeds: 1 });
        }
        return void response.end(JSON.stringify({ started: true, infohash: hash }));
      }
      if (path === `/api/downloads/${hash}/files`) return void response.end(JSON.stringify({ infohash: hash, files: [{ index: 2, name: "fixture-selected.mkv", size: bytes.length, included: true, progress: 0 }] }));
      if (path === `/api/downloads/${hash}` && request.method === "PATCH") {
        const payload = JSON.parse(body) as { selected_files?: unknown };
        selected.push(Array.isArray(payload.selected_files) && payload.selected_files.every(Number.isSafeInteger)
          ? payload.selected_files as number[] : []);
        return void response.end(JSON.stringify({ modified: true }));
      }
      if (path === `/api/downloads/${hash}` && request.method === "DELETE") {
        const index = triblerDownloads.findIndex((download) => download.infohash === hash);
        if (index >= 0) triblerDownloads.splice(index, 1);
        return void response.end(JSON.stringify({ removed: true }));
      }
      if (path === `/api/downloads/${hash}/stream/2`) {
        if (pendingTriblerStream) {
          const pending = pendingTriblerStream;
          const aborted = (): void => pending.aborted();
          request.once("aborted", aborted);
          response.once("close", aborted);
          pending.started();
          return;
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ""));
        const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Number(range[2]) : bytes.length - 1;
        const chunk = bytes.subarray(start, end + 1);
        response.statusCode = range ? 206 : 200;
        response.setHeader("Accept-Ranges", "bytes"); response.setHeader("Content-Type", "video/x-matroska");
        response.setHeader("Content-Length", String(chunk.length));
        if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
        return void response.end(chunk);
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: "not found" }));
    })(); });
    tribler = fixture.server;
    triblerUrl = fixture.url;
    // The reservation is closed immediately; readiness polling, rather than a sleep, handles the normal bind race.
    const pythonProbe = await listen((_q, r) => r.end()); await close(pythonProbe.server); pythonUrl = pythonProbe.url;
    const pythonEnvironment = childEnvironment({
      PYTHON_ADAPTER_PORT: new URL(pythonUrl).port,
      PYTHON_ADAPTER_KODI_RESOLVER_ENABLED: "true",
      PYTHON_ADAPTER_KODI_ADDON_PATH: fixtureAddon,
      PYTHON_ADAPTER_KODI_ADDON_ID: "script.module.fake",
      PYTHON_ADAPTER_KODI_MODULE: "fake_kodi_module",
      PYTHON_ADAPTER_KODI_SETTINGS_FILE: join(fixtureAddon, "settings.example.json"),
      PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS: "1"
    });
    python = spawn("python", ["-m", "adapter_host"], { cwd: hostRoot, env: pythonEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    await ready(pythonUrl, python);
    const bridgeProbe = await listen((_q, r) => r.end()); await close(bridgeProbe.server); bridgeUrl = bridgeProbe.url;
    const nodeEnvironment = childEnvironment({
      BRIDGE_ADMIN_TOKEN: syntheticAdminToken, BRIDGE_PORT: new URL(bridgeUrl).port, PUBLIC_BASE_URL: bridgeUrl,
      TRIBLER_URL: fixture.url, TRIBLER_API_KEY: securitySentinel, TRIBLER_AUTO_DISCOVER: "false",
      CATALOG_PROVIDER: "configured", LEGAL_TEST_MAGNET: `magnet:?xt=urn:btih:${hash}`,
      STREAM_PROVIDERS: "external_http", STREAM_PROVIDER_EXTERNAL_ENABLED: "true",
      STREAM_PROVIDER_EXTERNAL_URL: `${pythonUrl}/resolve`, STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS: "1000",
      STREAM_PROVIDER_TIMEOUT_MS: "1000", TORRENT_SAFETY_MODE: "fast", TRIBLER_STREAM_BUFFER_ENABLED: "false",
      METADATA_TIMEOUT_MS: "1000", NO_SEEDS_TIMEOUT_MS: "1000", POLL_INTERVAL_MS: "10",
      CLEANUP_INTERVAL_MS: "1000"
    });
    node = spawn(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "index.ts")], { cwd: stateDirectory, env: nodeEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    nodeOutput = capture(node);
    await ready(bridgeUrl, node, 8_000, new Set([200]), true);
  }, 20_000);

  // Two sequential stops (6 s each), 3 s removal retries, 1 s close and 4 s I/O margin.
  afterAll(async () => {
    await stop(node); await stop(python); await close(tribler); if (stateDirectory) await removeTemporaryDirectory(stateDirectory);
  }, 20_000);

  async function expectOpaqueDirectStream(resource: string, filename: string): Promise<void> {
    const response = await bridgeFetch(`${bridgeUrl}/stream/${resource}.json`);
    expect(response.status).toBe(200);
    const body = await response.json() as { streams: Array<{ name: string; url: string }> };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]?.name).toMatch(/^HTTPS(?: · |$)/);

    const playback = new URL(body.streams[0]!.url);
    expect(playback.origin).toBe(bridgeUrl);
    expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
    expect(playback.pathname).not.toContain(filename);
    expect(JSON.stringify(body)).not.toContain(syntheticDirectUrl);
  }

  it("A01 starts cleanly and exposes public readiness diagnostics", async () => {
    const health = await bridgeFetch(`${bridgeUrl}/health`); expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, bridge: "ready", tribler: "reachable" });
    const providers = await bridgeFetch(`${bridgeUrl}/providers`); expect(providers.status).toBe(200);
    expect(JSON.stringify(await providers.json())).toContain("external_http");
    expect(`${nodeOutput.stdout}\n${nodeOutput.stderr}`).not.toContain(securitySentinel);
  });

  it("A03 returns an opaque episode stream without publishing the producer's identity filename", async () => {
    await expectOpaqueDirectStream(
      "series/tt7654321%3A4%3A5",
      "episode-identity-tt7654321-s04e05.mp4"
    );
  });

  it("PR23 carries safe labels through real Python worker, host, bridge and public HTTP", async () => {
    const response = await bridgeFetch(`${bridgeUrl}/stream/movie/fixture%3Adescribed.json`);
    expect(response.status).toBe(200);
    const body = await response.json() as { streams: Array<{ name: string; title?: string; url: string }> };
    expect(body.streams).toHaveLength(2);
    expect(body.streams.map(stream => stream.title).sort()).toEqual([
      "Dual audio", "Japanese audio · English subtitles"
    ]);
    expect(new Set(body.streams.map(stream => stream.url)).size).toBe(2);
    expect(body.streams.map(stream => stream.name).sort()).toEqual(["HTTPS · ID? · 1080p", "Tribler · ID? · 1080p"]);
    for (const stream of body.streams) {
      const playback = new URL(stream.url);
      expect(playback.origin).toBe(bridgeUrl);
      expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\/stream\.(mp4|mkv)$/);
    }
    const publicText = JSON.stringify(body);
    for (const excluded of ["Synthetic private description", "synthetic-private", syntheticDirectUrl, "magnet:", securitySentinel]) {
      expect(publicText).not.toContain(excluded);
    }
    expect(`${nodeOutput.stdout}\n${nodeOutput.stderr}`).not.toContain("synthetic-private");
  });

  // 8 s readiness + 5 s HTTP + 6 s stop + 3 s removal retries + 8 s fixture/I/O.
  it("AC4 aggregates providers, deduplicates direct sources, and exposes ranked results", async () => {
    const addon = createTestStremioAddon();
    await new Promise<void>((resolveListen) => addon.listen(0, "127.0.0.1", resolveListen));
    const address = addon.address();
    if (!address || typeof address === "string") throw new Error("addon fixture failed to bind");
    const manifestUrl = `http://127.0.0.1:${address.port}/manifest.json`;
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      isolated = await startBridge({
        STREAM_PROVIDERS: "external_http,stremio_addons",
        STREAM_PROVIDER_STREMIO_ADDONS_FILE: "addons.json", STREMIO_ADDON_REQUEST_TIMEOUT_MS: "1000"
      }, [{ id: "ac4", name: "AC4 Stremio fixture", manifestUrl, enabled: true }]);
      const response = await bridgeFetch(`${isolated.url}/stream/movie/tt7654322.json`);
      expect(response.status).toBe(200);
      const body = await response.json() as { streams: Array<{ name: string; title?: string; url: string }> };
      expect(body.streams).toHaveLength(3);
      for (const [index, resolution] of ["2160p", "1080p", "720p"].entries()) {
        expect(body.streams[index]!.name).toContain(resolution);
        expect(body.streams[index]!.name).not.toContain("AC4");
        expect(body.streams[index]!.title).toBeUndefined();
      }
      expect(body.streams.map((stream) => stream.name.startsWith("HTTPS"))).toEqual([true, true, true]);
      for (const stream of body.streams) {
        const playback = new URL(stream.url);
        expect(playback.origin).toBe(isolated.url);
        expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\//);
      }
      expect(JSON.stringify(body)).not.toContain("https://1.1.1.1/");

      const providers = await (await bridgeFetch(`${isolated.url}/providers`)).json() as {
        providers: Array<{ id: string; status: string }>;
      };
      expect(providers.providers.find((provider) => provider.id === "external_http")).toMatchObject({ status: "ok" });
      expect(providers.providers.find((provider) => provider.id === "stremio-addon-ac4")).toMatchObject({ status: "ok" });
    } finally {
      if (isolated) {
        await stop(isolated.child);
        await removeTemporaryDirectory(isolated.directory);
      }
      await close(addon);
    }
  }, 30_000);

  // 8 s readiness + 3 routes * 6 s HTTP/diagnostics + 6 s stop + 3 s removal retries + 5 s I/O.
  it("qualifies synthetic movie and episode matrices through one real bridge after a permitted metadata redirect", async () => {
    const movieId = "tt9999999999", seriesId = "tt9999999998", blockedId = "tt9999999997";
    const sentinel = "SYNTHETIC_IDENTITY_QA_SECRET_91a7";
    const moviePath = `/meta/movie/${movieId}.json`;
    const rejectedRedirectPath = "/synthetic-private-metadata.json";
    const requests: string[] = [];
    let movieMetadataHits = 0;
    const movieSurvivors = [
      "Synthetic.Meridian.1987.1080p.mkv", "Meridiano.Sintetico.1987.720p.mkv", "Server 1",
      "Synthetic.Northern.Signal.1987.1080p.mkv", "Synthetic Meridian (1987) 1080p\n01:46:00"
    ];
    const movieRejections = ["Synthetic.Meridian.2004.1080p.mkv", "Synthetic.Meridian.S01E06.1080p.mkv",
      "Synthetic.Meridian.S01.E06.720p.mkv", "Synthetic Meridian (1987) 1080p\n00:20:00",
      "Synthetic Meridian (1987) 1080p", "Synthetic Meridian (1987) 720p"];
    const episodeSurvivors = ["Synthetic.Harbour.S02E03.1080p.mkv", "Synthetic.Harbour.S02.E03.720p.mkv", "Server 1",
      "Synthetic Harbour (1998) S02E03"];
    const episodeRejections = ["Synthetic.Harbour.S02E04.1080p.mkv", "Synthetic.Harbour.S03E03.1080p.mkv",
      "Synthetic.Harbour.S02.E04.720p.mkv", "Synthetic.Harbour.S03.E03.720p.mkv"];
    const rawStreams = (labels: string[], prefix: string) => labels.map((description, index) => ({
      url: `https://1.1.1.1/synthetic-${prefix}-variant-${index}.mkv?token=${sentinel}`, name: "Direct", description,
      behaviorHints: { filename: description.endsWith(".mkv") ? description : `synthetic-${prefix}-variant-${index}.mkv`,
        proxyHeaders: { request: { Cookie: sentinel, Authorization: sentinel, "X-Api-Key": sentinel } } },
      cookies: sentinel, privatePath: join(root, "synthetic-private-path"), magnet: `magnet:?secret=${sentinel}`
    }));
    const fixture = await listen((incoming, response) => {
      const path = decodeURIComponent(new URL(incoming.url ?? "/", "http://fixture").pathname);
      requests.push(path);
      expect(incoming.headers.cookie).toBeUndefined();
      expect(incoming.headers.authorization).toBeUndefined();
      expect(incoming.headers["x-api-key"]).toBeUndefined();
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Set-Cookie", `synthetic_session=${sentinel}`);
      if (path === moviePath) {
        movieMetadataHits += 1;
        if (movieMetadataHits === 1) {
          // The loopback exception is exact-URL scoped. A different path is
          // forbidden; the second response from the allowed URL supplies metadata.
          response.writeHead(302, { Location: moviePath });
          response.end();
          return;
        }
        response.end(JSON.stringify({ meta: { id: movieId, type: "movie", name: "Synthetic Meridian",
          releaseInfo: "1987", runtime: "107 min" } }));
        return;
      }
      if (path === `/meta/movie/${blockedId}.json`) {
        response.writeHead(302, { Location: `${rejectedRedirectPath}?token=${sentinel}` });
        response.end();
        return;
      }
      if (path === `/meta/series/${seriesId}.json`) {
        response.end(JSON.stringify({ meta: { id: seriesId, type: "series", name: "Synthetic Harbour", releaseInfo: "1998" } }));
        return;
      }
      if (path === "/manifest.json") {
        response.end(JSON.stringify({ id: "org.synthetic.identity", name: "Synthetic identity fixture",
          description: "Deterministic identity QA", version: "1.0.0", types: ["movie", "series"],
          resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }] }));
        return;
      }
      const labels = path === `/stream/movie/${movieId}.json` ? [...movieSurvivors, ...movieRejections]
        : path === `/stream/series/${seriesId}:2:3.json` ? [...episodeSurvivors, ...episodeRejections]
        : path === `/stream/movie/${blockedId}.json` ? ["Synthetic Meridian (2004) 1080p"] : undefined;
      if (labels) {
        const streams = rawStreams(labels, path.includes("/series/") ? "episode" : "movie");
        // Episodic resources contradict movie labels; series year alone is deferred.
        for (const entry of streams) {
          const name = entry.description === "Synthetic Meridian (1987) 1080p" ? "episode-1.mp4"
            : entry.description === "Synthetic Meridian (1987) 720p" ? "ep.1.v0.1234567890.720.m3u8"
            : entry.description === "Synthetic Harbour (1998) S02E03" ? "Synthetic.Northern.Grove.2020.Ep3.mp4" : undefined;
          if (name) entry.url = `https://1.1.1.1/${name}?token=${sentinel}`;
        }
        response.end(JSON.stringify({ streams }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ meta: null }));
    });
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      isolated = await startBridge({ STREAM_PROVIDERS: "stremio_addons",
        STREAM_PROVIDER_STREMIO_ADDONS_FILE: "addons.json", STREMIO_MOVIE_METADATA_BASE_URL: `${fixture.url}/`,
        DIRECT_HTTP_PROBE_ENABLED: "false"
      }, [{ id: "synthetic-identity", name: "Synthetic identity fixture", manifestUrl: `${fixture.url}/manifest.json`, enabled: true }]);
      const active = isolated;
      const assertPublicRoute = async (resource: string, survivors: string[], rejections: string[]) => {
        const response = await bridgeFetch(`${active.url}/stream/${resource}.json`);
        expect(response.status).toBe(200);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(response.headers.has("location")).toBe(false);
        const body = await response.json() as { streams: Array<{ name: string; title?: string; url: string }> };
        // Public names no longer identify releases. Assert the same count,
        // safe resolution multiset and exact rejection diagnostics below.
        const safeLabels = survivors.map(label => {
          const resolution = /\b(1080|720)p\b/.exec(label)?.[1];
          return resolution ? `HTTPS · ${resolution}p` : "HTTPS";
        });
        expect(body.streams.map(entry => entry.name.replace(/ · ID[?!✓]/, "")).sort()).toEqual(safeLabels.sort());
        for (const label of [...survivors, ...rejections]) expect(body.streams.some(entry => entry.title === label)).toBe(false);
        for (const entry of body.streams) {
          expect(entry.name).toMatch(/^HTTPS(?: · ID[?!✓])?(?: · (?:720|1080)p)?$/);
          expect(entry.title).toBeUndefined();
          const playback = new URL(entry.url);
          expect(playback.origin).toBe(active.url);
          expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\//);
          expect(playback.search).toBe("");
        }
        const providerResponse = await bridgeFetch(`${active.url}/providers`);
        expect(providerResponse.status).toBe(200);
        const diagnostics = await providerResponse.json() as {
          providers: Array<{ id: string; status: string; identityRejections: number }>
        };
        expect(diagnostics.providers.find((entry) => entry.id === "stremio-addon-synthetic-identity"))
          .toMatchObject({ status: "ok", identityRejections: rejections.length });
        const health = await bridgeFetch(`${active.url}/health`);
        expect(health.status).toBe(200);
        const healthBody: unknown = await health.json();
        expect(healthBody).toMatchObject({ ok: true, bridge: "ready", tribler: "reachable" });
        const publicAndDiagnosticOutput = `${JSON.stringify(body)}\n${JSON.stringify(Object.fromEntries(response.headers.entries()))}\n${JSON.stringify(diagnostics)}\n${JSON.stringify(healthBody)}\n${active.output.stdout}\n${active.output.stderr}`;
        for (const forbidden of ["https://1.1.1.1/", fixture.url, sentinel, securitySentinel,
          rejectedRedirectPath, "token=", "synthetic_session", "magnet:", "Authorization", "Cookie",
          "X-Api-Key", active.directory, JSON.stringify(active.directory).slice(1, -1),
          join(root, "synthetic-private-path"), JSON.stringify(join(root, "synthetic-private-path")).slice(1, -1)]) {
          expect(publicAndDiagnosticOutput).not.toContain(forbidden);
        }
        expect(active.child.exitCode).toBeNull();
        expect(active.child.signalCode).toBeNull();
      };
      await assertPublicRoute(`movie/${movieId}`, movieSurvivors, movieRejections);
      expect(movieMetadataHits).toBe(2);
      await assertPublicRoute(`series/${seriesId}:2:3`, episodeSurvivors, episodeRejections);
      expect(requests).toContain(`/meta/series/${seriesId}.json`);
      // A redirect to a different localhost path remains blocked. The metadata
      // failure must still allow the otherwise non-contradictory stream request.
      await assertPublicRoute(`movie/${blockedId}`, ["Synthetic Meridian (2004) 1080p"], []);
      expect(requests).toContain(`/meta/movie/${blockedId}.json`);
      expect(requests).not.toContain(rejectedRedirectPath);
    } finally {
      if (isolated) {
        await stop(isolated.child);
        await removeTemporaryDirectory(isolated.directory);
      }
      await close(fixture.server);
    }
  }, 40_000);

  // 8 s readiness + 3 streams * 4 s HTTP + 6 s stop + 3 s removal retries + 6 s I/O.
  it("Case 11 derives ID! from structured movie evidence and keeps plain/forged-label controls ID? (SYSTEM, no media probe)", async () => {
    // Reuse the process harness and supported external-provider boundary. These
    // public literal media locators are never fetched; no DNS/TLS/policy override.
    // This proves final identity/admission/public wiring, not media or content truth.
    const scenarios = [
      { id: "tt9999999911", scenario: "11", expected: "SUSPICIOUS", marker: "ID!" },
      { id: "tt9999999907", scenario: "UNKNOWN", expected: "UNKNOWN", marker: "ID?" },
      { id: "tt9999999909", scenario: "forged-label", expected: "UNKNOWN", marker: "ID?" }
    ];
    const requested: string[] = [];
    let mediaHits = 0;
    const fixture = await listen((incoming, response) => { void (async () => {
      expect(incoming.headers.cookie).toBeUndefined();
      expect(incoming.headers.authorization).toBeUndefined();
      expect(incoming.headers["x-api-key"]).toBeUndefined();
      response.setHeader("Content-Type", "application/json");
      const path = new URL(incoming.url ?? "/", "http://fixture").pathname;
      if (path.startsWith("/meta/movie/")) {
        const id = path.slice("/meta/movie/".length, -".json".length);
        response.end(JSON.stringify({ meta: { id, type: "movie", name: "Synthetic Meridian", releaseInfo: "1994" } }));
        return;
      }
      if (path === "/resolve") {
        let raw = "";
        for await (const chunk of incoming) raw += String(chunk);
        const item = JSON.parse(raw) as { id: string; type: string; title: string; year: number; externalIds: { imdb: string } };
        expect(item).toMatchObject({ type: "movie", title: "Synthetic Meridian", year: 1994, externalIds: { imdb: item.id } });
        const scenario = scenarios.find(entry => entry.id === item.id);
        expect(scenario).toBeDefined();
        requested.push(item.id);
        const forged = scenario?.scenario === "forged-label"
          ? { name: "ID!", identityState: "SUSPICIOUS", confidence: "SUSPICIOUS",
            metadata: { identityState: "SUSPICIOUS", confidence: "SUSPICIOUS" } } : {};
        const candidate = { type: "https", url: syntheticDirectUrl, title: "Server 1", ...forged,
          ...(scenario?.scenario === "11" ? { metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } } : {}) };
        if (scenario?.scenario === "11") expect(JSON.stringify(candidate)).not.toMatch(/ID!|SUSPICIOUS/);
        response.end(JSON.stringify({ streams: [candidate] }));
        return;
      }
      mediaHits += 1;
      response.statusCode = 404;
      response.end("{}");
    })(); });
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      isolated = await startBridge({ STREAM_PROVIDERS: "external_http",
        STREAM_PROVIDER_EXTERNAL_URL: `${fixture.url}/resolve`,
        STREMIO_MOVIE_METADATA_BASE_URL: `${fixture.url}/`, DIRECT_HTTP_PROBE_ENABLED: "false" });
      for (const scenario of scenarios) {
        const response = await bridgeFetch(`${isolated.url}/stream/movie/${scenario.id}.json`);
        expect(response.status).toBe(200);
        const body = await response.json() as { streams: Array<{ name: string; url: string; title?: string }> };
        expect(body.streams).toHaveLength(1);
        const stream = body.streams[0]!;
        expect(stream.name).toBe(`HTTPS · ${scenario.marker}`);
        expect(publicIdentityState(stream)).toBe(scenario.expected);
        expect(stream.title).toBeUndefined();
        const playback = new URL(stream.url);
        expect(playback.origin).toBe(isolated.url);
        expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
        expect(playback.search).toBe("");
        expect(response.headers.has("set-cookie")).toBe(false);
        process.stdout.write(`${JSON.stringify({ level: "SYSTEM", scenario: scenario.scenario,
          httpStatus: response.status, publicIdentityState: publicIdentityState(stream),
          disposition: "ADMIT", streams: body.streams.length, name: stream.name, probe: "DISABLED" })}\n`);
        const publicOutput = JSON.stringify(body) + isolated.output.stdout + isolated.output.stderr;
        for (const forbidden of [syntheticDirectUrl, fixture.url, securitySentinel, isolated.directory,
          JSON.stringify(isolated.directory).slice(1, -1), "Synthetic Aurora", "Synthetic Meridian"]) {
          expect(publicOutput).not.toContain(forbidden);
        }
      }
      expect(requested).toEqual(scenarios.map(entry => entry.id));
      expect(mediaHits).toBe(0);
      expect(isolated.child.exitCode).toBeNull();
    } finally {
      if (isolated) {
        await stop(isolated.child);
        await removeTemporaryDirectory(isolated.directory);
      }
      await close(fixture.server);
    }
  }, 35_000);

  // 8 s readiness + 5 cases * 6 s HTTP/diagnostics + 6 s stop + 3 s removal retries + 8 s I/O.
  it("Identity Phase 5 carries 05/13 and negative/echo controls through real adapters and public HTTP (pre-probe only)", async () => {
    // Public literal locators are NEVER fetched: probing is explicitly disabled,
    // as in the existing system identity matrix. No DNS override or media allowlist.
    // This proves intake/public wiring, not measured/effective-resource identity.
    const opaque = "https://1.1.1.1/synthetic-phase5-opaque.mp4";
    const wrongYear = "https://1.1.1.1/Synthetic.Meridian.1987.mp4";
    const cases = ["05", "05-negative", "13", "13-negative", "03"] as const;
    const ids = Object.fromEntries(cases.map((caseId, index) => [caseId, `tt99999999${String(index).padStart(2, "0")}`]));
    const claim = (id: string) => ({ identity: { externalIds: { imdb: id } } });
    const fixed = Object.fromEntries(cases.map(caseId => [ids[caseId]!, [{ type: "https",
      url: caseId.startsWith("05") ? wrongYear : opaque,
      ...(caseId === "05-negative" ? {} : { metadata: claim(caseId === "05" ? ids[caseId]! : "tt8888888888") })
    }]]));
    const requested: string[] = [];
    const metadataRequested = new Set<string>();
    const fixture = await listen((incoming, response) => { void (async () => {
      const path = new URL(incoming.url ?? "/", "http://fixture").pathname;
      response.setHeader("Content-Type", "application/json");
      const meta = /^\/meta\/movie\/(tt\d+)\.json$/.exec(path);
      if (meta) {
        metadataRequested.add(meta[1]!);
        response.end(JSON.stringify({ meta: { id: meta[1], type: "movie", name: "Synthetic Meridian",
          releaseInfo: "1994", runtime: "107 min" } }));
        return;
      }
      if (path === "/resolve" && incoming.method === "POST") {
        const raw = await new Promise<string>(resolveBody => {
          let body = ""; incoming.on("data", chunk => { body += String(chunk); });
          incoming.on("end", () => resolveBody(body));
        });
        const body = JSON.parse(raw) as { id: string; title: string; year: number; externalIds: { imdb: string } };
        expect(Object.values(ids).includes(body.id)).toBe(true);
        expect(body.title === "Synthetic Meridian" && body.year === 1994 && body.externalIds.imdb === body.id).toBe(true);
        expect(incoming.headers.authorization === undefined && incoming.headers.cookie === undefined).toBe(true);
        requested.push(body.id);
        // Only the echo control copies request identity. Other payloads are fixed
        // before the child starts and cannot inherit identity from its request.
        const streams = body.id === ids["03"]
          ? [{ type: "https", url: opaque, metadata: claim(body.externalIds.imdb) }] : fixed[body.id];
        response.end(JSON.stringify({ streams }));
        return;
      }
      response.statusCode = 404; response.end("{}");
    })(); });
    const directory = await mkdtemp(join(tmpdir(), "tribler-acceptance-"));
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      // A genuinely distinct producer contributes the matching origin for 13.
      await writeFile(join(directory, "sources.json"), JSON.stringify({ [ids["13"]!]: [
        { type: "https", url: opaque, metadata: claim(ids["13"]!) }
      ] }));
      isolated = await startBridge({ STREAM_PROVIDERS: "local_json,external_http",
        STREAM_PROVIDER_LOCAL_JSON_FILE: "sources.json", STREAM_PROVIDER_LOCAL_JSON_DIRECTORY: ".",
        STREAM_PROVIDER_EXTERNAL_URL: `${fixture.url}/resolve`,
        STREMIO_MOVIE_METADATA_BASE_URL: `${fixture.url}/`, DIRECT_HTTP_PROBE_ENABLED: "false"
      }, [], directory);
      let contractFailureCount = 0;
      for (const caseId of cases) {
        const response = await bridgeFetch(`${isolated.url}/stream/movie/${ids[caseId]}.json`);
        expect(response.status).toBe(200);
        const body = await response.json() as { streams: Array<{ name: string; url: string; title?: string }> };
        expect(body.streams.length <= 1).toBe(true);
        expect(requested.filter(id => id === ids[caseId]).length).toBe(1);
        expect(metadataRequested.has(ids[caseId]!)).toBe(true);
        for (const stream of body.streams) {
          const playback = new URL(stream.url);
          expect(playback.origin === isolated.url && /^\/source\/[A-Za-z0-9_-]{32}\//.test(playback.pathname)).toBe(true);
          expect(playback.search === "" && stream.title === undefined).toBe(true);
        }
        const providersResponse = await bridgeFetch(`${isolated.url}/providers`);
        expect(providersResponse.status).toBe(200);
        const diagnostic = await providersResponse.json() as {
          providers: Array<{ id: string; status: string; identityRejections?: number }> };
        expect(diagnostic.providers.find(provider => provider.id === "external_http")?.status).toBe("ok");
        const healthResponse = await bridgeFetch(`${isolated.url}/health`);
        expect(healthResponse.status).toBe(200);
        const health = await healthResponse.json() as {
          httpPrivacy: { directProbe: { enabled: boolean; requests: number } } };
        expect(health.httpPrivacy.directProbe).toMatchObject({ enabled: false, requests: 0 });
        const canonical = (intakeContract[caseId] ?? pilotContract[caseId])!;
        // Only public facts are observable here. Do not invent internal states,
        // per-origin reasons, normalized stages or validated media from counters.
        const expected: Dimensions = { admittedResources: canonical.admittedResources!,
          publicIdentityState: canonical.publicIdentityState! };
        const observed: Dimensions = { admittedResources: body.streams.length,
          publicIdentityState: body.streams.length === 0 ? "ABSENT" : publicIdentityState(body.streams[0]) };
        const applicable = knownViolations.filter(entry => entry.caseId === caseId && Object.hasOwn(expected, entry.dimension));
        const strict = adjudicate(caseId, expected, observed, "STRICT", []);
        const verdict = adjudicate(caseId, expected, observed, pilotMode(), applicable);
        contractFailureCount += verdict.failures.length;
        process.stdout.write("IDENTITY_PHASE5 " + JSON.stringify({ caseId, mode: pilotMode(), scope: "PRE_PROBE_PUBLIC_ONLY",
          probeEnabled: health.httpPrivacy.directProbe.enabled, probeNetworkStarts: health.httpPrivacy.directProbe.requests,
          internalIdentityState: "NOT_OBSERVABLE", perOriginReason: "NOT_OBSERVABLE",
          expected, observed, providerIdentityRejections: diagnostic.providers
            .reduce((sum, provider) => sum + (provider.identityRejections ?? 0), 0),
          strictDiscrepancies: strict.failures }) + "\n");
        const surfaces = JSON.stringify(body) + JSON.stringify(diagnostic) + isolated.output.stdout + isolated.output.stderr;
        for (const value of [opaque, wrongYear, fixture.url, securitySentinel, directory]) {
          expect(surfaces.includes(value)).toBe(false);
        }
      }
      expect(isolated.child.exitCode).toBeNull();
      expect(contractFailureCount, "original public contract discrepancies in safe reports; no new baseline entries").toBe(0);
    } finally {
      if (isolated) await stop(isolated.child);
      await removeTemporaryDirectory(directory);
      await close(fixture.server);
    }
  }, 55_000);

  // Two configurations: each allows 8 s readiness, 4 s HTTP, 6 s stop and
  // 3 s directory-removal retries; add 8 s for fixture I/O/assertions/close.
  it("P0 returns the exact post-quota ranking and opt-in F through an independent Node process", async () => {
    const movieId = "tt9999999999";
    const sentinel = "SYNTHETIC_RANKING_PRIVATE_SENTINEL";
    const policy = loadStreamRankingPolicy(join(root, "config", "stream-ranking.default.json"));
    const source = (index: number, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource => ({
      providerId: "external_http", type: "magnet",
      magnet: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, "0")}&dn=${sentinel}`,
      quality: "1080p", seeds: index, sizeBytes: 2 * 1024 ** 3,
      title: sentinel, metadata: { identityState: "CORROBORATED", token: sentinel }, ...extra
    });
    const ordinary = Array.from({ length: 50 }, (_, i) => source(i + 1));
    const late = source(51, { seeds: 127, quality: "2160p",
      metadata: { identity: { title: "Synthetic Aurora" }, identityState: "CORROBORATED" } });
    const suspicious = source(52, { seeds: 100000, quality: "2160p",
      metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } });
    const contradiction = source(53, { seeds: 100001, quality: "2160p",
      metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } });
    const input = [...ordinary, late, suspicious, contradiction];
    // Independent expected selection: the late unclassified source wins on score;
    // the higher-score suspicious source is last, and contradiction is rejected.
    const expected = [late, ...ordinary.slice(1).reverse()];
    let providerRequests = 0;
    let metadataRequests = 0;
    const fixture = await listen((incoming, response) => {
      incoming.resume();
      response.setHeader("Content-Type", "application/json");
      if (incoming.url === "/resolve" && incoming.method === "POST") {
        providerRequests += 1;
        response.end(JSON.stringify({ streams: input }));
      } else if (incoming.url === `/meta/movie/${movieId}.json`) {
        metadataRequests += 1;
        response.end(JSON.stringify({ meta: { id: movieId, type: "movie", name: "Synthetic Meridian", releaseInfo: "1994" } }));
      } else { response.statusCode = 404; response.end("{}"); }
    });
    const presentations: Array<Array<{ name: string; title: string | undefined }>> = [];
    try {
      for (const details of [false, true]) {
        let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
        try {
          isolated = await startBridge({
            STREAM_PROVIDER_EXTERNAL_URL: `${fixture.url}/resolve`,
            STREMIO_MOVIE_METADATA_BASE_URL: `${fixture.url}/`,
            STREAM_RANKING_CONFIG_FILE: join(root, "config", "stream-ranking.default.json"),
            STREAM_RANKING_DETAILS: String(details)
          });
          const response = await bridgeFetch(`${isolated.url}/stream/movie/${movieId}.json`);
          expect(response.status).toBe(200);
          const body = await response.json() as { streams: Array<{ name: string; title?: string; url: string;
            behaviorHints: { notWebReady: boolean } }>; cacheMaxAge: number };
          expect(body.cacheMaxAge).toBe(0);
          expect(body.streams).toHaveLength(50);
          expect(body.streams.map(s => s.name)).toEqual(expected.map((s, i) =>
            `Tribler · ${i === 0 ? "2160p" : "ID? · 1080p"} · 2.0GiB · ${s.seeds} seeds`));
          body.streams.forEach((stream, i) => {
            expect(stream.title).toBe(details ? rankedStreamDescription(expected[i]!, i + 1, policy) : undefined);
            if (details) expect(stream.title!.split("\n")).toHaveLength(2);
            expect(stream.behaviorHints).toEqual({ notWebReady: false });
            expect(Object.keys(stream).sort()).toEqual((details
              ? ["name", "title", "url", "behaviorHints"] : ["name", "url", "behaviorHints"]).sort());
            const playback = new URL(stream.url);
            expect(playback.origin).toBe(isolated!.url);
            expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\/stream$/);
            expect(playback.search).toBe("");
          });
          expect(new Set(body.streams.map(s => s.url)).size).toBe(50);
          expect(JSON.stringify(body)).not.toMatch(/magnet:|SYNTHETIC_RANKING_PRIVATE_SENTINEL|Synthetic Aurora|Synthetic Meridian|CORROBORATED|identityState|Authorization|traceback/i);
          expect(`${isolated.output.stdout}\n${isolated.output.stderr}`).not.toContain(securitySentinel);
          presentations.push(body.streams.map(({ name, title }) => ({ name, title })));
        } finally {
          if (isolated) {
            try { await stop(isolated.child); }
            finally { await removeTemporaryDirectory(isolated.directory); }
          }
        }
      }
      expect(presentations[1]!.map(s => s.name)).toEqual(presentations[0]!.map(s => s.name));
      expect(providerRequests).toBe(2);
      expect(metadataRequests).toBe(2);
    } finally { await close(fixture.server); }
  }, 50_000);

  // Two configurations: each allows 8 s readiness, 4 s HTTP (including health),
  // 6 s stop and 3 s removal retries; add 8 s for fixture I/O/assertions/close.
  it("P0 mixes unprobed HTTPS and Tribler without trusting forged HLS verification", async () => {
    const movieId = "tt9999999999";
    const sentinel = "SYNTHETIC_MIXED_PRIVATE";
    const torrent = (index: number, seeds: number, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource => ({
      providerId: "external_http", type: "magnet", quality: "1080p", sizeBytes: 2 * 1024 ** 3,
      magnet: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, "0")}&dn=${sentinel}`, seeds, ...extra
    });
    const https: NormalizedStreamSource = { providerId: "external_http", type: "https", quality: "1080p",
      url: `https://1.1.1.1/opaque.mp4?token=${sentinel}`, sizeBytes: 2 * 1024 ** 3,
      requestHeaders: { Referer: `https://origin.example/${sentinel}` }, metadata: { token: sentinel } };
    const input = [torrent(1, 0), https, torrent(2, 31),
      torrent(3, 100000, { quality: "2160p", metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }),
      { ...https, quality: "480p" }, // Same locator: lower-score duplicate.
      { ...https, url: "https://1.1.1.1/opaque.m3u8", directHttp: {
        status: "verified", verified: true, hls: true, responseStatus: 200, rangeSupported: false
      } }, // Provider observations are discarded; HLS still requires a real probe.
      torrent(4, 100001, { metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } })];
    const fixture = await listen((incoming, response) => {
      incoming.resume();
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(incoming.url === "/resolve" ? { streams: input }
        : { meta: { id: movieId, type: "movie", name: "Synthetic Meridian", releaseInfo: "1994" } }));
    });
    const names = ["Tribler · ID? · 1080p · 2.0GiB · 31 seeds", "HTTPS · ID? · 1080p · 2.0GiB",
      "Tribler · ID? · 1080p · 2.0GiB · 0 seeds", "Tribler · ID! · 2160p · 2.0GiB · 100000 seeds"];
    // Literal totals: 100+42+12=154; -12+42+12=42; -60+42+12=-6; 150+65+2=217.
    const detail = [
      "#1 · Score 154\nAvail +100 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +0",
      "#2 · Score 42\nAvail -12 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +0",
      "#3 · Score -6\nAvail -60 · Res +42 · Size +12 · Codec +0 · Meta +0 · Net +0",
      "#4 · Score 217\nAvail +150 · Res +65 · Size +2 · Codec +0 · Meta +0 · Net +0"
    ];
    try {
      for (const details of [false, true]) {
        let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
        try {
          isolated = await startBridge({ STREAM_PROVIDER_EXTERNAL_URL: `${fixture.url}/resolve`,
            STREMIO_MOVIE_METADATA_BASE_URL: `${fixture.url}/`, DIRECT_HTTP_PROBE_ENABLED: "false",
            STREAM_RANKING_CONFIG_FILE: join(root, "config", "stream-ranking.default.json"),
            STREAM_RANKING_DETAILS: String(details) });
          const response = await bridgeFetch(`${isolated.url}/stream/movie/${movieId}.json`);
          expect(response.status).toBe(200);
          const body = await response.json() as { streams: Array<{ name: string; title?: string; url: string;
            behaviorHints: { notWebReady: boolean } }>; cacheMaxAge: number };
          expect(body.cacheMaxAge).toBe(0);
          expect(body.streams.map(s => s.name)).toEqual(names);
          expect(body.streams.map(s => s.title)).toEqual(details ? detail : [undefined, undefined, undefined, undefined]);
          expect(new Set(body.streams.map(s => s.url)).size).toBe(4);
          body.streams.forEach((stream, i) => {
            expect(Object.keys(stream).sort()).toEqual((details
              ? ["name", "title", "url", "behaviorHints"] : ["name", "url", "behaviorHints"]).sort());
            expect(stream.behaviorHints).toEqual({ notWebReady: false });
            const playback = new URL(stream.url);
            expect(playback.origin).toBe(isolated!.url);
            expect(playback.pathname).toMatch(i === 1 ? /^\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/
              : /^\/source\/[A-Za-z0-9_-]{32}\/stream$/);
            expect(playback.search).toBe("");
          });
          expect(JSON.stringify(body)).not.toMatch(/1\.1\.1\.1|magnet:|SYNTHETIC_MIXED_PRIVATE|Synthetic Aurora|Synthetic Meridian|Authorization|metadata|directHttp/i);
          const health = await (await bridgeFetch(`${isolated.url}/health`)).json() as {
            httpPrivacy: { directProbe: { enabled: boolean; requests: number } } };
          expect(health.httpPrivacy.directProbe).toMatchObject({ enabled: false, requests: 0 });
          const logs = `${isolated.output.stdout}\n${isolated.output.stderr}`;
          expect(logs).not.toContain(securitySentinel);
          expect(logs).not.toContain(sentinel);
        } finally {
          if (isolated) {
            try { await stop(isolated.child); }
            finally { await removeTemporaryDirectory(isolated.directory); }
          }
        }
      }
    } finally { await close(fixture.server); }
  }, 50_000);

  // 8 s readiness + 4 s HTTP + 6 s stop + 3 s removal retries + 9 s fixture/I/O.
  it("AC1 enriches an IMDb movie from a separately configured meta endpoint", async () => {
    const metadata = await listen((incoming, response) => {
      response.setHeader("Content-Type", "application/json");
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      response.end(JSON.stringify(path === "/meta/movie/tt9900105.json"
        ? { meta: { id: "tt9900105", type: "movie", name: "Zunra", releaseInfo: "2011" } }
        : { meta: null }));
    });
    const streams = await listen((incoming, response) => {
      response.setHeader("Content-Type", "application/json");
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (path === "/manifest.json") {
        response.end(JSON.stringify({ id: "org.fixture.ac1", name: "AC1 streams",
          description: "Separate stream fixture", version: "1.0.0",
          resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
          types: ["movie"] }));
        return;
      }
      response.end(JSON.stringify({ streams: [
        { url: "https://1.1.1.1/ac1-wrong.mp4", description: "Vekra Meets Zunra (2020) 1080p" },
        { url: "https://1.1.1.1/ac1-matching.mp4", description: "Zunra (2011) 1080p" },
        { url: "https://1.1.1.1/ac1-localized.mp4", description: "준라 (2011) 1080p" },
        { url: "https://1.1.1.1/ac1-generic.mp4", name: "Server 1" }
      ] }));
    });
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      isolated = await startBridge({
        STREAM_PROVIDERS: "stremio_addons",
        STREAM_PROVIDER_STREMIO_ADDONS_FILE: "addons.json",
        STREMIO_MOVIE_METADATA_BASE_URL: `${metadata.url}/`
      }, [{ id: "ac1", name: "AC1 raw streams", manifestUrl: `${streams.url}/manifest.json`, enabled: true }]);
      const response = await bridgeFetch(`${isolated.url}/stream/movie/tt9900105.json`);
      expect(response.status).toBe(200);
      const body = await response.json() as { streams: Array<{ name: string; title?: string }> };
      const titles = body.streams.map(({ name, title }) => { expect(title).toBeUndefined(); return name; });
      expect(titles).not.toContain("Vekra Meets Zunra (2020) 1080p");
      expect(titles).toEqual(["HTTPS · 1080p", "HTTPS · 1080p", "HTTPS · ID?"]);
      expect(titles).toHaveLength(3);
    } finally {
      if (isolated) {
        await stop(isolated.child);
        await removeTemporaryDirectory(isolated.directory);
      }
      await Promise.all([close(metadata.server), close(streams.server)]);
    }
  }, 30_000);

  it("A04/A05/A09 resolve movie and episode torrents through both processes and preserve fileIndex", async () => {
    for (const resource of ["movie/fixture%3Aok", "series/tt1254207%3A1%3A2"]) {
      const streams = await (await bridgeFetch(`${bridgeUrl}/stream/${resource}.json`)).json() as { streams: Array<{ url: string }> };
      expect(streams.streams).toHaveLength(2);
      const torrent = streams.streams.find((stream) => stream.url.includes("/source/"));
      expect(torrent?.url).toBeTruthy();
      const redirected = await bridgeFetch(torrent!.url, { redirect: "manual" });
      expect(redirected.status).toBe(307);
      const play = new URL(redirected.headers.get("location")!, bridgeUrl);
      for (const start of [0, Math.floor(bytes.length / 2), Math.floor(bytes.length / 4)]) {
        const end = Math.min(start + 6, bytes.length - 1);
        const response = await bridgeFetch(play, { headers: { Range: `bytes=${start}-${end}` } });
        expect(response.status).toBe(206);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
        expect(Number(response.headers.get("content-length"))).toBe(end - start + 1);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
      }
    }
    expect(selected.every((indices) => indices.includes(2))).toBe(true);
  });

  it("AC6 aborts the Tribler stream when a real playback client disconnects", async () => {
    const streams = await (await bridgeFetch(`${bridgeUrl}/stream/movie/fixture%3Aok.json`)).json() as { streams: Array<{ url: string }> };
    const torrent = streams.streams.find((stream) => stream.url.includes("/source/"));
    expect(torrent?.url).toBeTruthy();
    const redirected = await bridgeFetch(torrent!.url, { redirect: "manual" });
    expect(redirected.status).toBe(307);
    const playback = new URL(redirected.headers.get("location")!, bridgeUrl);

    let started!: () => void;
    let aborted!: () => void;
    const pending = {
      started: () => started(), aborted: () => aborted(),
      startedPromise: new Promise<void>((resolve) => { started = resolve; }),
      abortedPromise: new Promise<void>((resolve) => { aborted = resolve; })
    };
    pendingTriblerStream = pending;
    const client = httpRequest(playback, { method: "GET" });
    client.on("error", () => { /* destroying the client is the behavior under test */ });
    client.end();
    try {
      await within(pending.startedPromise, "bridge did not open the Tribler stream");
      client.destroy();
      await within(pending.abortedPromise, "Tribler fixture did not observe the bridge abort");
    } finally {
      pendingTriblerStream = undefined;
      client.destroy();
    }
  });

  // 2 * 8 s readiness + 2 * 6 s stop + 6 * 2 s HTTP + 2 * 2 s abort waits + 3 s removal retries + 8 s I/O.
  it("AC7 persists lifecycle, avoids shutdown deletion, and protects active playback", async () => {
    triblerDownloads.splice(0);
    const directory = await mkdtemp(join(tmpdir(), "tribler-lifecycle-"));
    let first: Awaited<ReturnType<typeof startBridge>> | undefined;
    let restarted: Awaited<ReturnType<typeof startBridge>> | undefined;
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      first = await startBridge({}, [], directory);
      const resolved = await bridgeFetch(`${first.url}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: `magnet:?xt=urn:btih:${hash}` })
      });
      expect(resolved.status).toBe(200);
      const play = (await resolved.json() as { url: string }).url;
      const beforePin = await (await bridgeFetch(`${first.url}/downloads`)).json() as { downloads: Array<{ bridge?: { ownership?: string; retention?: string } }> };
      expect(beforePin.downloads[0]?.bridge).toMatchObject({ ownership: "BRIDGE_OWNED", retention: "EPHEMERAL" });
      expect((await bridgeFetch(`${first.url}/downloads/${hash}/pin`, { method: "POST" })).status).toBe(200);
      expect((await bridgeFetch(`${first.url}/downloads/${hash}/pin`, { method: "DELETE" })).status).toBe(200);
      const operationsBeforeShutdown = triblerOperations.length;
      await stop(first.child);
      first = undefined;
      expect(triblerOperations.slice(operationsBeforeShutdown)).not.toContainEqual({ method: "DELETE", path: `/api/downloads/${hash}` });

      restarted = await startBridge({}, [], directory);
      const afterRestart = await (await bridgeFetch(`${restarted.url}/downloads`)).json() as { downloads: Array<{ bridge?: { ownership?: string; retention?: string; activeStreams?: number } }> };
      expect(afterRestart.downloads[0]?.bridge).toMatchObject({ ownership: "BRIDGE_OWNED", retention: "RETAINED", activeStreams: 0 });

      let started!: () => void;
      let aborted!: () => void;
      const pending = {
        started: () => started(), aborted: () => aborted(),
        startedPromise: new Promise<void>((resolve) => { started = resolve; }),
        abortedPromise: new Promise<void>((resolve) => { aborted = resolve; })
      };
      pendingTriblerStream = pending;
      const playback = new URL(play); playback.protocol = new URL(restarted.url).protocol; playback.host = new URL(restarted.url).host;
      client = httpRequest(playback, { method: "GET" });
      client.on("error", () => { /* client teardown is expected */ });
      client.end();
      await within(pending.startedPromise, "bridge did not open the active Tribler stream");
      expect((await bridgeFetch(`${restarted.url}/downloads/${hash}`, { method: "DELETE" })).status).toBe(409);
      client.destroy();
      await within(pending.abortedPromise, "Tribler fixture did not observe active stream teardown");
    } finally {
      pendingTriblerStream = undefined;
      client?.destroy();
      if (first) await stop(first.child);
      if (restarted) await stop(restarted.child);
      await removeTemporaryDirectory(directory);
    }
  }, 55_000);

  it("A12 turns an invoked configured resolver failure into public degraded state", async () => {
    const streams = await bridgeFetch(`${bridgeUrl}/stream/movie/fixture%3Aexception.json`);
    expect(streams.status).toBe(200);
    expect(await streams.json()).toMatchObject({ streams: [] });
    const providers = await (await bridgeFetch(`${bridgeUrl}/providers`)).json() as { providers: Array<{ id: string; status: string; lastError?: string }> };
    const external = providers.providers.find((provider) => provider.id === "external_http");
    expect(external).toMatchObject({ status: "error" });
    expect(JSON.stringify(external)).not.toMatch(/fixture|secret|path|traceback/i);
    const health = await bridgeFetch(`${bridgeUrl}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, bridge: "degraded", tribler: "reachable" });
    expect(`${nodeOutput.stdout}\n${nodeOutput.stderr}`).not.toContain(securitySentinel);
  });

  // 8 s readiness + 3 s asserted stream limit + 2 s diagnostics + 6 s stop + 3 s removal retries + 8 s I/O.
  it("A10 bounds a timed-out provider while a healthy configured provider remains visible", async () => {
    const slow = await listen(() => { /* request stays open until the bridge aborts it */ });
    const addon = createTestStremioAddon();
    await new Promise<void>((resolveListen) => addon.listen(0, "127.0.0.1", resolveListen));
    const address = addon.address();
    if (!address || typeof address === "string") throw new Error("addon fixture failed to bind");
    const manifestUrl = `http://127.0.0.1:${address.port}/manifest.json`;
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      isolated = await startBridge({
        STREAM_PROVIDERS: "external_http,stremio_addons",
        STREAM_PROVIDER_EXTERNAL_URL: `${slow.url}/resolve`, STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS: "100",
        STREAM_PROVIDER_STREMIO_ADDONS_FILE: "addons.json", STREMIO_ADDON_REQUEST_TIMEOUT_MS: "1000"
      }, [{
        id: "healthy", name: "Healthy fixture", manifestUrl, enabled: true
      }]);
      const started = Date.now();
      const response = await bridgeFetch(`${isolated.url}/stream/movie/tt1254207.json`);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(response.status).toBe(200);
      const body = await response.json() as { streams?: Array<{ url?: string }> };
      expect(body.streams).toHaveLength(1);
      expect(body.streams?.[0]?.url).toMatch(/\/source\//);
      const providers = await (await bridgeFetch(`${isolated.url}/providers`)).json() as {
        providers: Array<{ id: string; status: string }>;
      };
      expect(providers.providers.find((provider) => provider.id === "external_http")).toMatchObject({ status: "error" });
      expect(providers.providers.find((provider) => provider.id === "stremio-addon-healthy")).toMatchObject({ status: "ok" });
      const health = await bridgeFetch(`${isolated.url}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ ok: false, bridge: "degraded", tribler: "reachable" });
      expect(`${isolated.output.stdout}\n${isolated.output.stderr}`).not.toContain(securitySentinel);
      expect(isolated.child.exitCode).toBeNull();
    } finally {
      if (isolated) {
        await stop(isolated.child);
        await removeTemporaryDirectory(isolated.directory);
      }
      await close(addon); await close(slow.server);
    }
  }, 30_000);

  // 2 * 8 s readiness + 3 * 6 s stop attempts + 10 s HTTP + 2 * 3 s removal retries + 5 s I/O.
  it("AC8 isolates a terminated provider process and preserves healthy provider results", async () => {
    const p2pPython = await startP2pPython();
    const addon = createTestStremioAddon();
    let isolated: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      await new Promise<void>((resolveListen) => addon.listen(0, "127.0.0.1", resolveListen));
      const address = addon.address();
      if (!address || typeof address === "string") throw new Error("addon fixture failed to bind");
      const manifestUrl = `http://127.0.0.1:${address.port}/manifest.json`;
      isolated = await startBridge({
        STREAM_PROVIDERS: "external_http,stremio_addons",
        STREAM_PROVIDER_EXTERNAL_URL: `${p2pPython.url}/resolve`,
        STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS: "1000",
        STREAM_PROVIDER_STREMIO_ADDONS_FILE: "addons.json",
        STREMIO_ADDON_REQUEST_TIMEOUT_MS: "1000"
      }, [{ id: "ac8", name: "AC8 healthy fixture", manifestUrl, enabled: true }]);

      await stop(p2pPython.child);
      expect(p2pPython.child.exitCode !== null || p2pPython.child.signalCode !== null).toBe(true);

      const expectHealthyResolution = async (): Promise<void> => {
        const response = await bridgeFetch(`${isolated!.url}/stream/movie/${ac8TestId}.json`);
        expect(response.status).toBe(200);
        const body = await response.json() as {
          streams: Array<{ name: string; title?: string; url: string }>;
        };
        // The exact singleton proves the failed external_http provider contributed []
        // while the healthy Stremio addon result survived registry aggregation.
        expect(body.streams).toHaveLength(1);
        expect(body.streams[0]?.name).toContain("720p");
        expect(body.streams[0]?.title).toBeUndefined();
        expect(body.streams[0]?.name).not.toContain("AC8 healthy Stremio source");
        const playback = new URL(body.streams[0]!.url);
        expect(playback.origin).toBe(isolated!.url);
        expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
        expect(JSON.stringify(body)).not.toContain("https://1.1.1.1/");
      };

      await expectHealthyResolution();
      const providers = await (await bridgeFetch(`${isolated.url}/providers`)).json() as {
        providers: Array<{ id: string; enabled: boolean; status: string; lastError?: string }>;
      };
      const external = providers.providers.find((provider) => provider.id === "external_http");
      expect(external).toMatchObject({ enabled: true, status: "error" });
      expect(external?.lastError).toMatch(/^Provider (?:failed|timed out)/);
      expect(external?.lastError).not.toMatch(/ECONNREFUSED|connectex|127\.0\.0\.1/i);
      expect(providers.providers.find((provider) => provider.id === "stremio-addon-ac8")).toMatchObject({
        enabled: true, status: "ok"
      });
      const health = await bridgeFetch(`${isolated.url}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ ok: false, bridge: "degraded", tribler: "reachable" });

      await expectHealthyResolution();
      expect(isolated.child.exitCode).toBeNull();
    } finally {
      if (isolated) {
        await stop(isolated.child);
        await removeTemporaryDirectory(isolated.directory);
      }
      await close(addon);
      await stop(p2pPython.child);
      await removeTemporaryDirectory(p2pPython.directory);
    }
  }, 55_000);

  // 8 s readiness + 1 s health HTTP + 6 s stop + 3 s removal retries + 7 s fixture/I/O.
  it("A13 reports a refused Tribler endpoint without auto-discovery", async () => {
    const unavailable = await listen((_q, response) => response.end()); await close(unavailable.server);
    const isolated = await startBridge({ TRIBLER_URL: unavailable.url, TRIBLER_AUTO_DISCOVER: "false" });
    try {
      const health = await bridgeFetch(`${isolated.url}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ ok: false, bridge: "unavailable", tribler: "unreachable" });
    } finally { await stop(isolated.child); await removeTemporaryDirectory(isolated.directory); }
  }, 25_000);

  // 2 * 8 s readiness + 12 s HTTP + 2 * 6 s stop + 2 * 3 s removal retries + 4 s I/O.
  it("A06 rejects an ambiguous episode torrent while preserving a valid sibling", async () => {
    const p2pPython = await startP2pPython();
    const isolated = await startBridge({ STREAM_PROVIDER_EXTERNAL_URL: `${p2pPython.url}/resolve` });
    try {
      const operationsBefore = triblerOperations.length;
      const response = await bridgeFetch(`${isolated.url}/stream/series/tt9999999999%3A2%3A3.json`);
      expect(response.status).toBe(200);
      const body = await response.json() as { streams?: unknown };
      expect(body).toMatchObject({ streams: [] });
      expect(body.streams).toEqual([]);
      expect(triblerOperations).toHaveLength(operationsBefore);

      const resolverState = await (await fetch(`${p2pPython.url}/resolvers`)).json() as {
        resolvers: Array<{ id: string; enabled: boolean; status: string; resultCount?: number }>;
      };
      expect(resolverState.resolvers.find((resolver) => resolver.id === "kodi_installed"))
        .toMatchObject({ enabled: true, status: "ok", resultCount: 0 });

      const providers = await (await bridgeFetch(`${isolated.url}/providers`)).json() as {
        providers: Array<{ id: string; status: string }>;
      };
      expect(providers.providers.find((provider) => provider.id === "external_http")).toMatchObject({ status: "ok" });
      const bridgeHealth = await bridgeFetch(`${isolated.url}/health`);
      expect(bridgeHealth.status).toBe(200);
      expect(await bridgeHealth.json()).toMatchObject({ ok: true, bridge: "ready", tribler: "reachable" });
      const pythonHealth = await fetch(`${p2pPython.url}/health`);
      expect(pythonHealth.status).toBe(200);
      expect(await pythonHealth.json()).toMatchObject({ ok: true });

      const valid = await bridgeFetch(`${isolated.url}/stream/series/tt9999999999%3A2%3A4.json`);
      expect(valid.status).toBe(200);
      const validBody = await valid.json() as { streams: Array<{ url: string }> };
      expect(validBody.streams).toHaveLength(1);
      const playback = new URL(validBody.streams[0]!.url);
      expect(playback.origin).toBe(isolated.url);
      expect(playback.pathname).toMatch(/^\/source\/[A-Za-z0-9_-]{32}\//);
      expect(JSON.stringify(validBody)).not.toContain(`magnet:?xt=urn:btih:${"f".repeat(40)}`);
    } finally {
      await stop(isolated.child); await stop(p2pPython.child);
      await removeTemporaryDirectory(isolated.directory);
      await removeTemporaryDirectory(p2pPython.directory);
    }
  }, 50_000);
});
