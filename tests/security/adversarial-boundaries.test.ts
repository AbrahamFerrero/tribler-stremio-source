import { afterEach, describe, expect, it, vi } from "vitest";
import request from "../http-client";
import { createApp } from "../../src/app";
import { discoverTriblerEndpoint } from "../../src/tribler-endpoint-discovery";
import { outboundPlaybackHeaders, type HttpPrivacyPolicy } from "../../src/network/http-privacy";
import { ExternalUrlPolicy, fetchWithValidatedRedirects } from "../../src/network/url-policy";
import { TriblerClient } from "../../src/tribler-client";
import { silentLogger, testConfig } from "../helpers";

const sentinel = "SECURITY_TEST_TRIBLER_KEY_DO_NOT_LEAK_7f3a9c2d";
const privacy: HttpPrivacyPolicy = {
  mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
  acceptCookies: false, userAgentMode: "minimal", maxRedirects: 3
};

function publicPolicy() {
  return new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
}

function refusal(): TypeError {
  return Object.assign(new TypeError("connection refused"), { cause: { code: "ECONNREFUSED" } });
}

afterEach(() => vi.restoreAllMocks());

describe("security adversarial boundaries", () => {
  it.each([
    "http://0.0.0.0/video", "http://100.64.0.1/video", "http://198.18.0.1/video",
    "http://224.0.0.1/video", "http://255.255.255.255/video", "http://[fc00::1]/video",
    "http://[fe80::1]/video", "http://[ff02::1]/video", "http://127.1/video",
    "http://2130706433/video", "http://0x7f000001/video", "http://user:pass@93.184.216.34/video"
  ])("SEC20-31 rejects unsafe or alternative URL form %s", async (url) => {
    await expect(publicPolicy().validate(url)).rejects.toThrow();
  });

  it("SEC32-37 rejects private redirect targets and mixed DNS before a request", async () => {
    const redirected = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: "http://192.168.1.10/private" }
    }));
    await expect(fetchWithValidatedRedirects("https://public.example/video", publicPolicy(), {}, redirected))
      .rejects.toThrow(/private|reserved/);
    expect(redirected).toHaveBeenCalledOnce();

    const mixed = new ExternalUrlPolicy({ resolver: () => Promise.resolve([
      { address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }
    ]) });
    await expect(mixed.validate("https://rebind.example/video")).rejects.toThrow(/private|reserved/);
  });

  it("SEC40-51 forwards only bounded media headers and runtime rejects CRLF injection", () => {
    expect(() => outboundPlaybackHeaders({ Accept: "video/mp4\r\nX-Injected: yes" }, privacy)).toThrow();
    const headers = outboundPlaybackHeaders({
      Accept: "video/mp4", Range: "bytes=4-9", "If-Range": "etag",
      Authorization: "Bearer secret", Cookie: "sid=secret", "X-Api-Key": "secret",
      "Proxy-Authorization": "secret", "X-Forwarded-For": "10.0.0.1", Origin: "https://origin.example",
      Referer: "https://referrer.example", "Set-Cookie": "sid=upstream", "User-Agent": "hostile"
    }, privacy);
    expect(Object.fromEntries(headers)).toEqual({
      accept: "video/mp4", "accept-encoding": "identity", range: "bytes=4-9", "user-agent": "Mozilla/5.0"
    });
  });

  it("SEC01-05 keeps the Tribler sentinel in the authorized header and out of errors", async () => {
    const outputs: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...values: unknown[]) => { outputs.push(values.join(" ")); };
    console.warn = (...values: unknown[]) => { outputs.push(values.join(" ")); };
    try {
      const success = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ downloads: [] }), {
        headers: { "Content-Type": "application/json" }
      }));
      await new TriblerClient("http://127.0.0.1:52194", sentinel, 100, success).listDownloads();
      expect(new Headers(success.mock.calls[0]?.[1]?.headers).get("X-Api-Key")).toBe(sentinel);

      for (const status of [401, 403, 500]) {
        const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response(sentinel, { status }));
        await expect(new TriblerClient("http://127.0.0.1:52194", sentinel, 100, failing).listDownloads())
          .rejects.not.toThrow(sentinel);
      }
      await expect(new TriblerClient("http://127.0.0.1:52194", sentinel, 100, vi.fn<typeof fetch>().mockRejectedValue(refusal()))
        .listDownloads()).rejects.not.toThrow(sentinel);
      expect(outputs.join(" ")).not.toContain(sentinel);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("SEC06-08/TAD16-17 discovers only in memory and does not emit the sentinel", async () => {
    const originalUrl = process.env.TRIBLER_URL;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const discovered = await discoverTriblerEndpoint(sentinel, {
        listCandidates: () => Promise.resolve(["http://127.0.0.1:53000", "http://192.168.1.9:53001"]),
        probe: (url) => Promise.resolve(url === "http://127.0.0.1:53000")
      });
      expect(discovered).toBe("http://127.0.0.1:53000");
      expect(process.env.TRIBLER_URL).toBe(originalUrl);
      await expect(discoverTriblerEndpoint(sentinel, {
        listCandidates: () => Promise.resolve(["http://127.0.0.1:53000", "http://127.0.0.1:53001"]), probe: () => Promise.resolve(true)
      })).resolves.toBeUndefined();
      expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(sentinel);
    } finally {
      if (originalUrl === undefined) delete process.env.TRIBLER_URL;
      else process.env.TRIBLER_URL = originalUrl;
    }
  });

  it("SEC13-15 keeps the sentinel out of public diagnostics and generic errors", async () => {
    const tribler = new TriblerClient("http://127.0.0.1:52194", sentinel, 100,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(sentinel, { status: 401 })));
    const { app } = createApp(testConfig({ triblerApiKey: sentinel }), silentLogger, tribler);
    const health = await request(app).get("/health");
    const providers = await request(app).get("/providers");
    const generic = await request(app).get("/source/not-a-valid-token/video.mp4");
    expect(health.status).toBe(503);
    expect(generic.status).toBe(400);
    for (const response of [health, providers, generic]) expect(response.text).not.toContain(sentinel);
  });

  it("does not reflect malformed Tribler response content through health or downloads errors", async () => {
    const tribler = new TriblerClient("http://127.0.0.1:52194", sentinel, 100,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(sentinel, { status: 200 })));
    const log = { ...silentLogger, error: vi.fn() };
    const { app } = createApp(testConfig({ triblerApiKey: sentinel }), log, tribler);
    for (const path of ["/health", "/downloads"]) {
      const response = await request(app).get(path);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.text).not.toContain(sentinel.slice(0, 10));
    }
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(sentinel.slice(0, 10));
  });

  it("does not expose Tribler tracker URLs or raw errors through /downloads", async () => {
    const trackerUrl = "https://tracker.example/private?token=private-value";
    const tribler = new TriblerClient("http://127.0.0.1:52194", sentinel, 100,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ downloads: [{
        infohash: "a".repeat(40), name: "Authorized fixture", status: "DOWNLOADING", progress: 0.25,
        speed_down: 1, speed_up: 0, num_peers: 2, num_seeds: 1,
        trackers: [{ url: trackerUrl }], error: sentinel
      }] }), { headers: { "Content-Type": "application/json" } })));
    const { app } = createApp(testConfig({ triblerApiKey: sentinel }), silentLogger, tribler);
    const response = await request(app).get("/downloads").expect(200);
    expect((response.body as { downloads: unknown }).downloads).toEqual([{
      infohash: "a".repeat(40), name: "Authorized fixture", status: "DOWNLOADING", progress: 0.25,
      speed_down: 1, speed_up: 0, num_peers: 2, num_seeds: 1
    }]);
    expect(response.text).not.toContain(trackerUrl);
    expect(response.text).not.toContain(sentinel);
  });
});
