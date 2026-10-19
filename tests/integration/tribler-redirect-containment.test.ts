import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "../http-client";
import { createApp } from "../../src/app";
import type { CatalogProvider } from "../../src/catalog/types";
import { TriblerClient } from "../../src/tribler-client";
import { silentLogger, testConfig } from "../helpers";

const key = "SYNTHETIC_REDIRECT_KEY";
const hash = "a".repeat(40);
const uri = "https://synthetic.invalid/fixture.torrent?token=SYNTHETIC_URI";
const statuses = [301, 302, 303, 307, 308];
interface Hit { method: string; path: string; headers: IncomingHttpHeaders; body: string }
const servers: Server[] = [];

// Native loopback sockets are the substituted Tribler/recipient boundary.
async function origin(host = "127.0.0.1") {
  const hits: Hit[] = [];
  let connections = 0;
  let redirect: { status: number; location: string | undefined } | undefined;
  let gate: Promise<void> | undefined;
  let arrived: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const path = req.url ?? "/";
    hits.push({ method: req.method ?? "", path, headers: req.headers, body });
    arrived?.();
    if (gate) await gate;
    if (res.destroyed) return;
    if (redirect) {
      res.writeHead(redirect.status, redirect.location === undefined ? {} : { Location: redirect.location });
      res.end("SYNTHETIC_RESPONSE_SECRET");
    } else if (path.includes("/stream/")) {
      const range = req.headers.range;
      if (range === "bytes=99-100") {
        res.writeHead(416, { "Content-Range": "bytes */6" }); res.end();
      } else if (range === "bytes=2-4") {
        res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 2-4/6", "Content-Length": "3" }); res.end("cde");
      } else { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "6" }); res.end("abcdef"); }
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ downloads: [], settings: {}, started: true, infohash: hash,
        files: [{ index: 0, name: "synthetic.mp4", size: 6, included: true, progress: 1 }] }));
    }
  });
  servers.push(server);
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const base = `http://${host === "::1" ? "[::1]" : host}:${(server.address() as AddressInfo).port}`;
  return { base, hits, connections: () => connections,
    redirect: (status: number, location?: string) => { redirect = { status, location }; },
    healthy: () => { redirect = undefined; },
    hold: (promise: Promise<void>, onArrival: () => void) => { gate = promise; arrived = onArrival; } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
const catalog: CatalogProvider = { definition: { id: "synthetic", type: "movie", name: "Synthetic" },
  owns: () => false, list: () => Promise.resolve([]), get: () => Promise.resolve(undefined),
  getTorrentSource: () => Promise.reject(new Error("No fixture source")) };
function bridge(base: string) {
  const logs: unknown[] = [];
  const log = { ...silentLogger, warn: (message: string, context?: Record<string, unknown>) => { logs.push({ message, context }); } };
  const built = createApp(testConfig({ triblerUrl: base, triblerApiKey: key }), log, undefined, catalog);
  return { ...built, logs };
}
const play = `/play/${hash}/0/synthetic.mp4`;
const operations = [
  { name: "downloads GET", method: "GET", path: "/api/downloads", body: "", run: (c: TriblerClient) => c.listDownloads() },
  { name: "settings GET", method: "GET", path: "/api/settings", body: "", run: (c: TriblerClient) => c.getAnonymityDefaults() },
  { name: "download PUT", method: "PUT", path: "/api/downloads", body: JSON.stringify({ uri }), run: (c: TriblerClient) => c.addDownload(uri) },
  { name: "selection PATCH", method: "PATCH", path: `/api/downloads/${hash}`, body: JSON.stringify({ selected_files: [0] }), run: (c: TriblerClient) => c.selectFiles(hash, [0]) },
  { name: "download DELETE", method: "DELETE", path: `/api/downloads/${hash}`, body: JSON.stringify({ remove_data: false }), run: (c: TriblerClient) => c.deleteDownload(hash, false) }
];

describe("Tribler redirects through real loopback receivers", () => {
  for (const op of operations) {
    it.each(statuses)(`${op.name} refuses %i without contacting another port or recovering`, async status => {
      const a = await origin(), b = await origin();
      a.redirect(status, `${b.base}/unintended?token=SYNTHETIC_LOCATION`);
      const recover = vi.fn(() => Promise.resolve(b.base));
      const c = new TriblerClient(a.base, key, 1_000, fetch, recover);
      const outcome = await Promise.allSettled([op.run(c)]);
      expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
      expect(outcome[0]?.status).toBe("rejected"); expect(recover).not.toHaveBeenCalled();
      expect(a.hits).toHaveLength(1);
      expect(a.hits[0]).toMatchObject({ method: op.method, path: op.path, body: op.body });
      expect(a.hits[0]?.headers["x-api-key"]).toBe(key);
      expect(JSON.stringify(outcome)).not.toMatch(/SYNTHETIC_|unintended/);
    });
  }
  it.each(statuses)("refuses same-origin REST %i with no second authenticated request", async status => {
    const a = await origin(); a.redirect(status, `${a.base}/same-origin`);
    await expect(new TriblerClient(a.base, key, 1_000).listDownloads()).rejects.toThrow();
    expect(a.hits).toHaveLength(1);
  });
  it.each(statuses)("public playback refuses %i and closes stream accounting before a healthy seek", async status => {
    const a = await origin(), b = await origin(); a.redirect(status, `${b.base}/unintended?token=SYNTHETIC_LOCATION`);
    const built = bridge(a.base), ended = vi.spyOn(built.service, "endStream");
    const refused = await request(built.app).get(play).set("Range", "bytes=2-4");
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
    expect(refused.status).toBe(502); expect(refused.body).toEqual({ error: "Tribler stream failed" });
    expect(a.hits).toHaveLength(1); expect(a.hits[0]?.headers).toMatchObject({ "x-api-key": key, range: "bytes=2-4" });
    expect(ended).toHaveBeenCalledExactlyOnceWith(hash, 0);
    expect(JSON.stringify(built.logs)).not.toMatch(/SYNTHETIC_|unintended/);
    expect(JSON.stringify(built.logs)).not.toContain(hash);
    a.healthy();
    const health = await request(built.app).get("/health");
    expect(health.body).toMatchObject({ triblerStreaming: { streamsStarted: 1, streamsCompleted: 0,
      upstreamHeaderCount: 0, downstreamBytes: 0 } });
    const healthy = await request(built.app).get(play).set("Range", "bytes=2-4");
    expect(healthy.status).toBe(206); expect(Buffer.from(healthy.body).toString()).toBe("cde");
    expect(ended).toHaveBeenCalledTimes(2);
  });
  it.each(statuses)("public playback refuses same-origin %i", async status => {
    const a = await origin(); a.redirect(status, `${a.base}/same-origin`);
    expect((await request(bridge(a.base).app).get(play)).status).toBe(502);
    expect(a.hits).toHaveLength(1);
  });
  it.each(statuses)("public playback refuses %i without Location and omits its response body", async status => {
    const a = await origin(); a.redirect(status);
    const built = bridge(a.base);
    const response = await request(built.app).get(play);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Tribler stream failed" });
    expect(a.hits).toHaveLength(1);
    expect(JSON.stringify({ response: response.text, logs: built.logs })).not.toMatch(/SYNTHETIC_|aaaaaaaa/);
  });
  it("refuses credentialed Location and secret body on the public health route", async () => {
    const a = await origin(), b = await origin();
    a.redirect(307, b.base.replace("http://", "http://SYNTHETIC_USER:SYNTHETIC_PASSWORD@") + "/private?token=SYNTHETIC_LOCATION");
    const built = bridge(a.base); const response = await request(built.app).get("/health");
    expect(response.status).toBe(503); expect(b.connections()).toBe(0); expect(a.hits).toHaveLength(1);
    expect(JSON.stringify({ body: response.body as unknown, logs: built.logs })).not.toMatch(/SYNTHETIC_|private/);
  });
  it("contains concurrent state-changing redirects without recovery or replay", async () => {
    const a = await origin(), b = await origin(); a.redirect(307, b.base + "/unintended");
    const recover = vi.fn(() => Promise.resolve(b.base)); const client = new TriblerClient(a.base, key, 1_000, fetch, recover);
    const outcomes = await Promise.allSettled([client.addDownload(uri), client.resumeDownload(hash), client.deleteDownload(hash, false)]);
    expect(outcomes.every(row => row.status === "rejected")).toBe(true);
    expect(a.hits.map(row => row.method).sort()).toEqual(["DELETE", "PATCH", "PUT"]);
    expect(b.connections()).toBe(0); expect(recover).not.toHaveBeenCalled();
  });
  it.each(["127.0.0.1", "::1"])("preserves authenticated REST and public 200/206/416/HEAD on %s", async host => {
    const a = await origin(host); const client = new TriblerClient(a.base, key, 1_000);
    for (const op of operations) await op.run(client);
    expect(a.hits.slice(0, operations.length).map(({ method, path, body }) => ({ method, path, body })))
      .toEqual(operations.map(({ method, path, body }) => ({ method, path, body })));
    await client.resumeDownload(hash); await client.stopDownload(hash); await client.getFiles(hash);
    const built = bridge(a.base);
    const full = await request(built.app).get(play); expect(full.status).toBe(200); expect(Buffer.from(full.body).toString()).toBe("abcdef");
    expect((await request(built.app).get(play).set("Range", "bytes=2-4")).status).toBe(206);
    expect((await request(built.app).get(play).set("Range", "bytes=99-100")).status).toBe(416);
    const head = await request(built.app).head(play); expect(head.status).toBe(200); expect(head.headers["content-length"]).toBe("6");
    expect(a.hits.every(row => row.headers["x-api-key"] === key)).toBe(true);
  });
  it("cancellation while redirect headers are gated contacts no recipient and cleans up", async () => {
    const a = await origin(), b = await origin(); a.redirect(302, b.base + "/unintended");
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { arrived = resolve; }); a.hold(gate, arrived);
    const built = bridge(a.base); let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const endStream = built.service.endStream.bind(built.service);
    vi.spyOn(built.service, "endStream").mockImplementation((...args) => { endStream(...args); finished(); });
    const pending = request(built.app).get(play).set("Range", "bytes=2-4");
    pending.end(() => {}); await observed; pending.abort(); await done; release();
    expect(a.hits).toHaveLength(1); expect(b.connections()).toBe(0); expect(b.hits).toEqual([]);
  });
});
