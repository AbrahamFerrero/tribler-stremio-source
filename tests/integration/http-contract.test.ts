import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "../http-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { logger } from "../../src/logger";
import type { CatalogProvider } from "../../src/catalog/types";
import { TriblerClient } from "../../src/tribler-client";
import { silentLogger, testConfig } from "../helpers";

// CONTRACT: real HTTP routing/serialization, substituted Tribler and catalog boundaries.
const hash = "a".repeat(40);
const catalog: CatalogProvider = {
  definition: { id: "synthetic", type: "movie", name: "Synthetic catalog" },
  owns: (id) => id === "synthetic:movie",
  list: () => Promise.resolve([{ id: "synthetic:movie", type: "movie", name: "Synthetic movie" }]),
  get: () => Promise.resolve({ id: "synthetic:movie", type: "movie", name: "Synthetic movie" }),
  getTorrentSource: () => Promise.resolve(`magnet:?xt=urn:btih:${hash}`),
  getDirectStream: () => Promise.resolve({ url: "https://media.example.invalid/fixture.mp4?signature=synthetic-private", fileName: "fixture.mp4", size: 32 })
};

describe("HTTP compatibility contracts", () => {
  let directory: string;
  let app: ReturnType<typeof createApp>["app"];
  let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bridge-contract-"));
    upstream = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ downloads: [] }))));
    const client = new TriblerClient("http://127.0.0.1:9999", "synthetic-api-secret", 100, upstream);
    app = createApp(testConfig({ managedDownloadsStateFile: join(directory, "state.json") }), silentLogger, client, catalog).app;
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

  it("publishes readiness, provider and download envelopes with safe headers", async () => {
    const health = await request(app).get("/health").expect(200);
    expect(health.body).toMatchObject({ ok: true, bridge: "ready", tribler: "reachable", downloads: 0, providers: { catalog_synthetic: "never-run" } });
    const providers = await request(app).get("/providers").expect(200);
    expect((providers.body as { providers: unknown[] }).providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "catalog_synthetic", enabled: true, status: "never-run" })]));
    const downloads = await request(app).get("/downloads").expect(200);
    expect(downloads.body).toEqual({ downloads: [] });
    for (const response of [health, providers, downloads]) {
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["x-powered-by"]).toBeUndefined();
      expect(response.text).not.toMatch(/synthetic-api-secret|127\.0\.0\.1:9999/);
    }
  });

  it("returns a private unavailable-health error without upstream details", async () => {
    upstream.mockRejectedValue(new Error("synthetic-api-secret /private/fixture"));
    const response = await request(app).get("/health").expect(503);
    expect(response.body).toMatchObject({ ok: false, bridge: "unavailable", tribler: "unreachable", error: "Tribler health check failed" });
    expect(response.body).not.toHaveProperty("downloads");
    expect(response.text).not.toMatch(/synthetic-api-secret|private\/fixture/);
  });

  it("projects downloads rather than serializing arbitrary Tribler fields", async () => {
    upstream.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ downloads: [{
      infohash: hash, name: "https://media.example.invalid/?secret=synthetic", status: "STOPPED", progress: 0,
      speed_down: 0, speed_up: 0, num_peers: 0, num_seeds: 0, destination: "/private/fixture", token: "synthetic-hidden"
    }] }))));
    const response = await request(app).get("/downloads").expect(200);
    expect((response.body as { downloads: unknown[] }).downloads[0]).toEqual({ infohash: hash, name: "[redacted]", status: "STOPPED", progress: 0,
      speed_down: 0, speed_up: 0, num_peers: 0, num_seeds: 0 });
  });

  it.each(["/health", "/providers", "/downloads", "/manifest.json", "/meta/movie/synthetic:movie.json", "/catalog/movie/synthetic.json"])("supports bodyless HEAD for %s", async (path) => {
    const get = await request(app).get(path).expect(200);
    const head = await request(app).head(path).expect(200);
    expect(head.text).toBeUndefined();
    expect(head.headers["content-type"]).toBe(get.headers["content-type"]);
  });

  it("serves Stremio shapes and keeps resolved playback URLs opaque", async () => {
    const manifest = await request(app).get("/manifest.json").expect(200);
    expect(manifest.body).toMatchObject({ id: "org.local.tribler.bridge", resources: ["catalog", "meta", "stream"], types: ["movie", "series"] });
    const meta = await request(app).get("/meta/movie/synthetic:movie.json").expect(200);
    expect((meta.body as { meta: unknown }).meta).toMatchObject({ id: "synthetic:movie", type: "movie", name: "Synthetic movie" });
    expect((await request(app).get("/meta/movie/unknown.json").expect(200)).body).toEqual({ meta: null });
    const response = await request(app).get("/stream/movie/synthetic:movie.json").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const streams = (response.body as { streams: Array<{ url: string }> }).streams;
    expect(streams).toHaveLength(1);
    const stream = streams[0]!;
    expect(stream).toMatchObject({ name: expect.any(String) as unknown, behaviorHints: { notWebReady: false } });
    expect(stream.url).toMatch(/^http:\/\/127\.0\.0\.1:7000\/source\/[\w-]{32}\//);
    expect(response.text).not.toMatch(/signature|synthetic-private|media\.example|synthetic:movie/);
  });

  it.each([{}, { source: 42 }, { source: "fixture", fileIndex: -1 }, { source: "fixture", fileIndex: 0.5 }])("rejects invalid resolve input %j before contacting Tribler", async (body) => {
    const response = await request(app).post("/resolve").send(body).expect(400);
    expect(response.body).toEqual({ error: "source is required and fileIndex must be a non-negative integer" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("bounds JSON requests and sanitizes parser errors using the existing 400 mapping", async () => {
    for (const body of ['{"source":', JSON.stringify({ source: "x".repeat(32768) })]) {
      const response = await request(app).post("/resolve").set("Content-Type", "application/json").send(body).expect(400);
      expect(response.body).toEqual({ error: "Request failed", type: expect.any(String) as unknown });
      expect(response.text).not.toContain(body);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not reflect an unexpected dependency Error.name in public HTTP or stderr", async () => {
    const marker = "P2A_SYNTH_FORGED_NAME_123";
    const forged = Object.assign(new Error(`Authorization: Bearer ${marker}`), { name: marker });
    upstream.mockRejectedValue(forged);
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new TriblerClient("http://127.0.0.1:9999", "synthetic-api-secret", 100, upstream);
    const hardened = createApp(testConfig({ managedDownloadsStateFile: join(directory, "safe-state.json") }), logger, client, catalog).app;
    const response = await request(hardened).get("/downloads").expect(400);
    expect(response.body).toEqual({ error: "Request failed", type: "UnknownError" });
    const logs = output.mock.calls.map((entry) => entry.join(" ")).join(" ");
    expect(logs).toContain("UnknownError");
    expect(logs).not.toContain(marker);
    expect(response.text).not.toContain(marker);
  });

  it("preserves missing-managed-download and selection errors", async () => {
    for (const method of ["post", "delete"] as const) {
      const response = await request(app)[method](`/downloads/${hash}/pin`).expect(404);
      expect(response.body).toEqual({ error: "Request failed", type: "ManagedDownloadNotFoundError" });
    }
    expect((await request(app).post(`/downloads/${hash}/select`).send({}).expect(400)).body)
      .toEqual({ error: "fileIndex must be a non-negative integer" });
  });

  it("selects a file with the resolved-stream envelope and no upstream secrets", async () => {
    const file = { index: 2, name: "synthetic.mp4", size: 32, included: true, progress: 1 };
    upstream.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("/files") ? { files: [file] } : { modified: true })));
    });
    const response = await request(app).post(`/downloads/${hash}/select`).send({ fileIndex: 2 }).expect(200);
    expect(response.body).toEqual({ infohash: hash, file, url: `http://127.0.0.1:7000/play/${hash}/2/synthetic.mp4` });
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.text).not.toContain("synthetic-api-secret");
  });

  it.each([
    ["bytes=2-4", 206, "bytes 2-4/32", "3"],
    ["bytes=-4", 206, "bytes 28-31/32", "4"],
    ["bytes=32-", 416, "bytes */32", undefined],
    ["bytes=0-1,3-4", 416, "bytes */32", undefined]
  ] as const)("describes Tribler HEAD ranges (%s) without returning bytes", async (range, status, contentRange, length) => {
    upstream.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ files: [
      { index: 2, name: "synthetic.mp4", size: 32, included: true, progress: 1 }
    ] }))));
    const response = await request(app).head(`/play/${hash}/2/synthetic.mp4`).set("Range", range).expect(status);
    expect(response.headers["content-range"]).toBe(contentRange);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    if (length !== undefined) expect(response.headers["content-length"]).toBe(length);
    expect(response.text).toBeUndefined();
  });

  it.each(["/source/missing/video.mp4", `/source/${"z".repeat(32)}/video.mp4`, "/hls/missing", `/hls/${"z".repeat(32)}`])("rejects unrecognized playback token at %s", async (path) => {
    const response = await request(app).get(path).expect(400);
    expect(response.body).toMatchObject({ error: "Request failed", type: expect.any(String) as unknown });
    expect(response.text).not.toContain("z".repeat(32));
    await request(app).head(path).expect(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("exposes expired source tokens as a private 400 response", async () => {
    app = createApp(testConfig({ httpStreamTokenTtlMs: 1, managedDownloadsStateFile: join(directory, "expiry.json") }), silentLogger,
      new TriblerClient("http://127.0.0.1:9999", "synthetic-api-secret", 100, upstream), catalog).app;
    const response = await request(app).get("/stream/movie/synthetic:movie.json").expect(200);
    const path = new URL((response.body as { streams: Array<{ url: string }> }).streams[0]!.url).pathname;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await request(app).get(path).expect(400)).body)
      .toEqual({ error: "Request failed", type: "PlaybackTokenExpiredError" });
  });

  it("characterizes unsupported methods as 404 rather than inventing 405", async () => {
    for (const path of ["/health", "/providers", "/manifest.json", "/source/missing/video.mp4", "/hls/missing"]) {
      await request(app).post(path).send({}).expect(404);
    }
    await request(app).get("/resolve").expect(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
