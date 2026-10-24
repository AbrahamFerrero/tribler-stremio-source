import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestPinned } from "../src/network/url-policy";

describe("pinned HTTP response process safety", () => {
  // One child command allows 10 s; reserve 5 s for parent scheduling and output assertions.
  it.each([204, 205, 304])("survives GET %i and a subsequent GET 200", async (status) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", `
      const { createServer } = require('node:http');
      const { requestPinned } = require('./src/network/url-policy.ts');
      const server = createServer((req, res) => {
        if (req.url === '/empty') { res.writeHead(${status}); res.end(); }
        else { res.end('synthetic video'); }
      });
      server.listen(0, '127.0.0.1', async () => {
        try {
          const base = 'http://127.0.0.1:' + server.address().port;
          const target = path => ({ url: new URL(base + path), address: '127.0.0.1', family: 4 });
          const empty = await requestPinned(target('/empty'), { method: 'GET' });
          if (empty.status !== ${status} || empty.body !== null) throw new Error('invalid empty response');
          const next = await requestPinned(target('/video'), { method: 'GET' });
          if (await next.text() !== 'synthetic video') throw new Error('subsequent request failed');
          console.log('survived');
        } catch (error) { console.error(error); process.exitCode = 1; }
        finally { server.close(); server.closeAllConnections(); }
      });
    `], { cwd: process.cwd(), timeout: 10_000 });
    expect(stdout.trim()).toBe("survived");
    expect(stderr).toBe("");
  }, 15_000);
});

describe("pinned HTTP response lifecycle (loopback only)", () => {
  let server: Server;
  let base: string;
  const sockets = new Set<Socket>();
  const target = (path = "/video") => ({ url: new URL(base + path), address: "127.0.0.1", family: 4 as const });
  const idle = async (signal: AbortSignal): Promise<void> => {
    await vi.waitFor(() => {
      expect(sockets.size).toBe(0);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    });
  };

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === "/pending") return;
      if (req.url === "/truncated") {
        res.writeHead(200, { "Content-Length": "100" }); res.write("short");
        setImmediate(() => res.destroy()); return;
      }
      const status = Number(req.url?.slice(1));
      res.writeHead(status || 200, { "Content-Type": "video/mp4", "X-Fixture": "synthetic" });
      res.end(status ? undefined : "synthetic video");
    });
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture failed to bind");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    sockets.clear();
  });

  it.each([204, 205, 304])("closes GET %i sockets and removes abort listeners", async status => {
    const controller = new AbortController();
    const response = await requestPinned(target(`/${status}`), { signal: controller.signal });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(response.headers.get("x-fixture")).toBe("synthetic");
    await idle(controller.signal);
  });

  it("preserves HEAD metadata and GET 200 bytes", async () => {
    const controller = new AbortController();
    const head = await requestPinned(target(), { method: "HEAD", signal: controller.signal });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-type")).toBe("video/mp4");
    await idle(controller.signal);
    const get = await requestPinned(target(), { signal: controller.signal });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("synthetic video");
    await vi.waitFor(() => expect(getEventListeners(controller.signal, "abort")).toHaveLength(0));
  });

  it("rejects constructor failures repeatedly without exhausting the 64 connection slots", async () => {
    const controller = new AbortController();
    // Node accepts this synthetic status; WHATWG Response rejects it after stream conversion.
    for (let index = 0; index < 70; index += 1) {
      await expect(requestPinned(target("/600"), { signal: controller.signal })).rejects.toThrow(RangeError);
    }
    await idle(controller.signal);
    const next = await requestPinned(target(), {});
    expect(await next.text()).toBe("synthetic video");
  });

  it.each(["headers", "stream"])("rejects a synchronous %s processing error and cleans up", async stage => {
    const failure = new Error("synthetic response processing failure");
    if (stage === "headers") vi.spyOn(Headers.prototype, "append").mockImplementationOnce(() => { throw failure; });
    else vi.spyOn(Readable, "toWeb").mockImplementationOnce(() => { throw failure; });
    const controller = new AbortController();
    await expect(requestPinned(target(), { signal: controller.signal })).rejects.toBe(failure);
    await idle(controller.signal);
    const next = await requestPinned(target(), {});
    expect(await next.text()).toBe("synthetic video");
  });

  it("releases slots for synchronous request setup failures", async () => {
    const controller = new AbortController();
    for (let index = 0; index < 70; index += 1) {
      await expect(requestPinned(target(), { headers: { "bad header": "fixture" }, signal: controller.signal }))
        .rejects.toThrow(TypeError);
    }
    await idle(controller.signal);
    expect(await (await requestPinned(target(), {})).text()).toBe("synthetic video");
  });

  it("handles cancellation before and during a request without leaking listeners or sockets", async () => {
    const cancelled = AbortSignal.abort(new Error("synthetic pre-abort"));
    await expect(requestPinned(target(), { signal: cancelled })).rejects.toThrow("synthetic pre-abort");
    await idle(cancelled);
    const controller = new AbortController();
    const pending = requestPinned(target("/pending"), { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("synthetic abort");
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    controller.abort(new Error("synthetic abort"));
    await rejected;
    await idle(controller.signal);
  });

  it("exposes a truncated body as a controlled stream rejection", async () => {
    const controller = new AbortController();
    const response = await requestPinned(target("/truncated"), { signal: controller.signal });
    await expect(response.text()).rejects.toThrow();
    await idle(controller.signal);
    expect(await (await requestPinned(target(), {})).text()).toBe("synthetic video");
  });
});
