import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadService } from "../src/download-service";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { DirectHttpPlaybackBackend, TriblerPlaybackBackend } from "../src/playback/backends";
import { PlaybackManager } from "../src/playback/manager";
import { TriblerClient } from "../src/tribler-client";
import { silentLogger, testConfig } from "./helpers";

const hash = "a".repeat(40);
const magnet = `magnet:?xt=urn:btih:${hash}`;

afterEach(() => vi.restoreAllMocks());

describe("torrent playback privacy boundary", () => {
  it("uses only local Tribler REST and never invokes direct outbound transport or global fetch", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected global fetch"));
    const directRequest = vi.fn<OutboundTransport["request"]>().mockRejectedValue(new Error("direct transport invoked"));
    const direct: OutboundTransport = {
      id: "forbidden-direct", request: directRequest,
      diagnostics: () => ({ transport: "forbidden-direct", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    let failTribler = false;
    const rest = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(url.origin).toBe("http://127.0.0.1:9999");
      expect(url.pathname.startsWith("/api/downloads")).toBe(true);
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Api-Key")).toBe("fixture-key");
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Cookie")).toBeNull();
      if (failTribler) return Promise.resolve(new Response("unavailable", { status: 503 }));
      if (url.pathname === "/api/downloads") return Promise.resolve(new Response(JSON.stringify({
        downloads: [{ infohash: hash, name: "owned fixture", status: "DOWNLOADING",
          progress: 1, speed_down: 0, speed_up: 0, num_peers: 1, num_seeds: 1 }]
      }), { status: 200 }));
      if (url.pathname.endsWith("/files")) return Promise.resolve(new Response(JSON.stringify({
        infohash: hash, files: [{ index: 2, name: "owned-fixture.mp4", size: 32,
          included: true, progress: 1 }]
      }), { status: 200 }));
      if (init?.method === "PATCH") return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const client = new TriblerClient("http://127.0.0.1:9999", "fixture-key", 500, rest);
    const service = new DownloadService(client, testConfig(), silentLogger);
    const manager = new PlaybackManager([
      new DirectHttpPlaybackBackend(direct), new TriblerPlaybackBackend(service)
    ]);
    const source = { providerId: "owned-fixture", type: "magnet" as const, magnet,
      infoHash: hash, fileIndex: 2, filename: "owned-fixture.mp4" };
    const prepared = await manager.prepare(manager.register(source));
    expect(prepared.kind).toBe("redirect");
    expect(new URL(prepared.url!).hostname).toBe("127.0.0.1");
    expect(rest.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "GET", "PATCH"]);
    expect(directRequest).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();

    failTribler = true;
    await expect(manager.prepare(manager.register(source))).rejects.toThrow(/Tribler returned HTTP 503/);
    expect(directRequest).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
