import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { authorityStatus, localRequestPolicy } from "../../src/local-request-policy";
import { loadConfig } from "../../src/config";
import { PlaybackManager } from "../../src/playback/manager";
import { TriblerClient } from "../../src/tribler-client";
import type { CatalogProvider } from "../../src/catalog/types";
import { silentLogger, syntheticAdminToken, testConfig } from "../helpers";

const origin = "https://web.stremio.com";
const hash = "b".repeat(40);
const mediaId = "synthetic:boundary";
const auto = `/auto/${Buffer.from(mediaId).toString("base64url")}/fixture.mp4?source=tribler`;
const play = `/play/${hash}/0/fixture.mp4`;

describe("localhost API boundary (synthetic HTTP contracts)", () => {
  let directory: string;
  let app: ReturnType<typeof createApp>["app"];
  let service: ReturnType<typeof createApp>["service"];
  let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
  let catalog: CatalogProvider;
  let log: typeof silentLogger;
  let server: Server | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "localhost-boundary-"));
    upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ downloads: [] })));
    catalog = {
      definition: { id: "synthetic", name: "Synthetic", type: "movie" },
      owns: () => true,
      list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(null),
      getTorrentSource: vi.fn().mockResolvedValue(`magnet:?xt=urn:btih:${hash}`),
      getDirectStream: vi.fn().mockResolvedValue({ url: "https://media.example.invalid/fixture.mp4", fileName: "fixture.mp4", size: 16 })
    };
    log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    ({ app, service } = make());
  });

  function make(token: string | undefined = syntheticAdminToken) {
    return createApp(testConfig({ bridgeAdminToken: token, managedDownloadsStateFile: join(directory, "state.json") }), log,
      new TriblerClient("http://127.0.0.1:9999", "synthetic-tribler-secret", 100, upstream), catalog);
  }

  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function state(): string { const path = join(directory, "state.json"); return existsSync(path) ? readFileSync(path, "utf8") : "absent"; }

  function watchEffects() {
    return [vi.spyOn(service, "inspect"), vi.spyOn(service, "resolve"), vi.spyOn(service, "pin"), vi.spyOn(service, "unpin"),
      vi.spyOn(service, "selectFile"), vi.spyOn(service, "cancelDownload"),
      vi.spyOn(PlaybackManager.prototype, "register"), vi.spyOn(PlaybackManager.prototype, "prepare"),
      vi.spyOn(PlaybackManager.prototype, "prepareHlsResource"), vi.spyOn(catalog, "list"), vi.spyOn(catalog, "get"),
      vi.spyOn(catalog, "getTorrentSource"), vi.spyOn(catalog, "getDirectStream")];
  }

  function zeroEffects(spies: ReturnType<typeof watchEffects>, before: string) {
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(state()).toBe(before);
  }

  it("rejects wrong authorities before parsing, providers, token renewal or mutations", async () => {
    const spies = watchEffects(); const before = state();
    for (const path of ["/health", "/stream/movie/fixture.json", auto, play, "/source/missing/video", "/hls/missing"]) {
      const response = await request(app).get(path).set("Host", "rebind.invalid:7000").set("X-Forwarded-Host", "127.0.0.1:7000");
      expect(response.status).toBe(403); expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    await request(app).post("/resolve").set("Host", "rebind.invalid:7000").set("Content-Type", "application/json").send("{").expect(403);
    zeroEffects(spies, before);
  });

  it("denies every administrative method, simple pin and OPTIONS without effects", async () => {
    const spies = watchEffects(); const before = state();
    for (const path of ["/health", "/providers", "/downloads", "/resolve", `/downloads/${hash}`, `/downloads/${hash}/select`, `/downloads/${hash}/pin`, "/DownLoads/unknown/"]) {
      for (const method of ["get", "head", "post", "delete", "options"] as const) {
        const response = await request(app)[method](path);
        expect(response.status).toBe(method === "options" ? 403 : 401);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    }
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      await request(app).post(`/downloads/${hash}/pin`).set("Content-Type", contentType).send("pin=true").expect(401);
    }
    zeroEffects(spies, before);
  });

  it("disables administration without configured credentials and rejects browser contexts even with credentials", async () => {
    const config = testConfig({ managedDownloadsStateFile: join(directory, "disabled.json") });
    delete config.bridgeAdminToken;
    const absent = createApp(config, log,
      new TriblerClient("http://127.0.0.1:9999", "synthetic", 100, upstream), catalog).app;
    await request(absent).get("/health").set("Authorization", `Bearer ${syntheticAdminToken}`).expect(403);
    await request(absent).delete(`/downloads/${hash}`).set("Authorization", `Bearer ${syntheticAdminToken}`).expect(403);
    for (const headers of [{ Origin: origin }, { Origin: "null" }, { Referer: `${origin}/` }, { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-User": "?1" }]) {
      await request(app).post(`/downloads/${hash}/pin`).set(headers).set("Authorization", `Bearer ${syntheticAdminToken}`).expect(403);
    }
    expect(upstream).not.toHaveBeenCalled(); expect(state()).toBe("absent");
  });

  it("preserves authorized diagnostics and pin/unpin state, without disclosing credentials", async () => {
    const before = state();
    await request(app).get("/health").set("Authorization", `Bearer ${"ab".repeat(32)}`).expect(401);
    expect(state()).toBe(before); expect(upstream).not.toHaveBeenCalled();
    const response = await request(app).get("/health").set("Authorization", `Bearer ${syntheticAdminToken}`).expect(200);
    expect(response.body).toMatchObject({ ok: true, tribler: "reachable" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    const pin = vi.fn().mockReturnValue({ retention: "pinned" });
    const unpin = vi.fn().mockReturnValue({ retention: "smart" });
    service.pin = pin; service.unpin = unpin;
    await request(app).post(`/downloads/${hash}/pin`).set("Authorization", `Bearer ${syntheticAdminToken}`).expect(200);
    await request(app).delete(`/downloads/${hash}/pin`).set("Authorization", `Bearer ${syntheticAdminToken}`).expect(200);
    expect(pin).toHaveBeenCalledExactlyOnceWith(hash); expect(unpin).toHaveBeenCalledExactlyOnceWith(hash);
    const parserError = await request(app).post("/resolve").set("Authorization", `Bearer ${syntheticAdminToken}`)
      .set("Content-Type", "application/json").send(`{"secret":"${syntheticAdminToken}",`).expect(400);
    await request(app).post(`/downloads/${hash}/pin?token=${syntheticAdminToken}`).send({ token: syntheticAdminToken }).expect(401);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([response.body, parserError.body, vi.mocked(log.error).mock.calls, vi.mocked(log.warn).mock.calls,
      vi.mocked(log.info).mock.calls, vi.mocked(log.debug).mock.calls])).not.toContain(syntheticAdminToken);
  });

  it("rejects hostile/null/partial web contexts before discovery or playback, including warmed state", async () => {
    const spies = watchEffects(); const before = state();
    const contexts = [{ Origin: "https://evil.example" }, { Origin: "null" }, { Origin: `${origin}:443` },
      { Origin: "https://sub.web.stremio.com" }, { Origin: "http://web.stremio.com" }, { Origin: `${origin}:444` },
      { "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "none" },
      { Referer: `${origin}/` }, { Origin: origin, "Sec-Fetch-Mode": "navigate" },
      { Origin: origin, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "iframe" }];
    for (const path of ["/catalog/movie/synthetic.json", "/meta/movie/fixture.json", "/stream/movie/fixture.json", "/stream/movie/fixture/extra.json", auto, play]) {
      for (const headers of contexts) for (const method of ["get", "head"] as const) {
        await request(app)[method](path).set(headers).expect(403);
      }
    }
    await request(app).get("/stream/movie/fixture.json").expect(403);
    zeroEffects(spies, before);
  });

  it("keeps Desktop CORS exact, prevents SDK/cache widening, and terminates safe preflights without issuing tokens", async () => {
    const prepare = vi.spyOn(PlaybackManager.prototype, "prepare");
    const register = vi.spyOn(PlaybackManager.prototype, "register");
    await request(app).options(`/stream/movie/${mediaId}.json`).set("Origin", origin).set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "Range, If-Range").expect(204);
    expect(register).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    const response = await request(app).get(`/stream/movie/${mediaId}.json`).set("Origin", origin)
      .set("Sec-Fetch-Site", "cross-site").set("Sec-Fetch-Mode", "cors").set("Sec-Fetch-Dest", "empty").expect(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Origin"); expect(register).toHaveBeenCalled();
    const denied = await request(app).get(`/stream/movie/${mediaId}.json`).set("Origin", "https://evil.example").expect(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    const tokenPath = new URL((response.body as { streams: { url: string }[] }).streams[0]!.url).pathname;
    await request(app).get(tokenPath).set("Host", "evil.example:7000").expect(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(response.text).not.toContain(syntheticAdminToken);
    await request(app).options(tokenPath).set("Origin", "null").set("Access-Control-Request-Method", "GET").expect(204);
    expect(prepare).not.toHaveBeenCalled();
    for (const headers of [{ "Access-Control-Request-Method": "DELETE" }, { "Access-Control-Request-Headers": "Authorization" }]) {
      const preflight = await request(app).options(`/stream/movie/${mediaId}.json`).set("Origin", origin).set(headers).expect(403);
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("retains native HEAD/Range and 307 contracts and checks play independently of prior source preparation", async () => {
    const file = { index: 0, name: "fixture.mp4", size: 16, included: true, progress: 1 };
    const resolve = vi.spyOn(service, "resolve").mockResolvedValue({ infohash: hash, file, url: `http://127.0.0.1:7000${play}` });
    const files = vi.spyOn(service.client, "getFiles").mockResolvedValue([file]);
    for (const method of ["get", "head"] as const) {
      const redirected = await request(app)[method](auto).expect(307);
      expect(redirected.headers.location).toBe(`http://127.0.0.1:7000${play}`);
      expect(redirected.headers.location).not.toContain(syntheticAdminToken);
    }
    expect(resolve).toHaveBeenCalledTimes(2);
    const response = await request(app).head(play).set("Range", "bytes=2-4").expect(206);
    expect(response.headers["content-range"]).toBe("bytes 2-4/16"); expect(response.text).toBeUndefined();
    files.mockClear(); resolve.mockClear();
    await request(app).head(play).set("Origin", "null").expect(403);
    expect(files).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  });

  it("suppresses attempts to restore wildcard CORS through setHeader and writeHead", async () => {
    const fixture = express(); fixture.use(localRequestPolicy());
    fixture.get("/stream/movie/fixture.json", (_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" }); res.end("{}");
    });
    const response = await request(fixture).get("/stream/movie/fixture.json").set("Origin", origin).expect(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin); expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("handles raw duplicate/absent Host, duplicate auth/context, absolute targets and alternate paths before effects", async () => {
    const spies = watchEffects(); const before = state();
    server = createServer(app); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
    const host = `127.0.0.1:${address.port}`;
    const cases = [
      `GET /health HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}`,
      "GET /health HTTP/1.1", `GET /health HTTP/1.1\r\nHost:`,
      `GET http://${host}/health HTTP/1.1\r\nHost: ${host}`,
      `GET /health HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${syntheticAdminToken}\r\nAuthorization: Bearer ${syntheticAdminToken}`,
      `GET /stream/movie/fixture.json HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nOrigin: ${origin}`,
      `GET ${play} HTTP/1.1\r\nHost: ${host}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Site: same-origin`,
      `POST /DownLoads/${hash}/pin/ HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0`,
      `POST /downloads%2f${hash}/pin HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0`,
      `GET /%68ealth HTTP/1.1\r\nHost: ${host}`
    ];
    for (const message of cases) {
      const result = await new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, "127.0.0.1"); let data = "";
        socket.setTimeout(2000, () => socket.destroy(new Error("raw HTTP timeout")));
        socket.on("error", reject); socket.on("data", (chunk: Buffer) => { data += chunk.toString(); }); socket.on("end", () => resolve(data));
        socket.on("connect", () => socket.end(`${message}\r\nConnection: close\r\n\r\n`));
      });
      expect(result).toMatch(/^HTTP\/1\.1 4\d\d/); expect(result.toLowerCase()).not.toContain("access-control-allow-origin");
    }
    zeroEffects(spies, before);
    const manifest = await request(server).get("/manifest.json").set("Host", `LOCALHOST:${address.port}`).set("X-Forwarded-Host", "evil.example").expect(200);
    expect(manifest.text).not.toContain("evil.example"); expect(manifest.text).not.toContain(syntheticAdminToken);
  });
});

describe("strict authority and startup configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("accepts only the selected listener profile and canonical effective port", () => {
    for (const host of ["127.0.0.1:7000", "localhost:7000", "LOCALHOST:7000"]) expect(authorityStatus(host, 7000)).toBe(200);
    for (const host of ["evil.example:7000", "127.1:7000", "2130706433:7000", "0x7f000001:7000", "127.0.0.2:7000", "127.000.0.1:7000", "localhost.:7000", "sub.localhost:7000", "localhost:7001", "localhost", "[::1]:7000", "[0:0:0:0:0:0:0:1]:7000"]) expect(authorityStatus(host, 7000)).toBeGreaterThanOrEqual(400);
    for (const host of ["localhost:", "localhost:07000", "localhost:0", "localhost:+7000", "localhost:65536", "localhost:7000:80", "user@localhost:7000", "http://localhost:7000", "localhost:7000/", "localhost,localhost:7000", "local host:7000", "localhost%00:7000"]) expect(authorityStatus(host, 7000)).toBe(400);
    expect(authorityStatus("localhost", 80)).toBe(200); expect(authorityStatus("[::1]:7000", 7000, true)).toBe(200);
  });
  it("fails startup for malformed credentials or public URLs outside the direct HTTP profile", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:9999"); vi.stubEnv("BRIDGE_PORT", "7000"); vi.stubEnv("BRIDGE_ADMIN_TOKEN", "invalid");
    expect(loadConfig).toThrow(/BRIDGE_ADMIN_TOKEN/);
    vi.stubEnv("BRIDGE_ADMIN_TOKEN", syntheticAdminToken);
    for (const url of ["https://localhost:7000", "http://127.1:7000", "http://localhost:7001", "http://localhost:7000/path", "http://localhost.:7000"]) {
      vi.stubEnv("PUBLIC_BASE_URL", url); expect(loadConfig).toThrow(/PUBLIC_BASE_URL/);
    }
    vi.stubEnv("PUBLIC_BASE_URL", "http://127.0.0.1:7000"); expect(loadConfig().bridgeAdminToken).toBe(syntheticAdminToken);
    vi.stubEnv("BRIDGE_ADMIN_TOKEN", undefined); expect(loadConfig().bridgeAdminToken).toBeUndefined();
  });
});
