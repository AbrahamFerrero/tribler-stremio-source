import type { Request, Response as ExpressResponse } from "express";
import { describe, expect, it, vi } from "vitest";
import { proxyDirectHttp } from "../src/automatic-stream";
import type { Logger } from "../src/logger";
import { MINIMAL_HTTP_USER_AGENT, type HttpPrivacyPolicy } from "../src/network/http-privacy";
import { DirectTransport, type OutboundTransport, type PinnedRequest } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectHttpPlaybackBackend } from "../src/playback/backends";

const privacy: HttpPrivacyPolicy = {
  mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
  acceptCookies: false, userAgentMode: "minimal", maxRedirects: 3
};

function recordingLogger(): { logger: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const record = (_message: string, context?: Record<string, unknown>): void => { entries.push(context ?? {}); };
  return { logger: { debug: record, info: record, warn: record, error: record }, entries };
}

describe("privacy-first outbound transport", () => {
  it("allowlists headers, uses a minimal UA and does not retain redirect cookies", async () => {
    const observed: Headers[] = [];
    const pinned: PinnedRequest = (_target, init) => {
      observed.push(new Headers(init.headers));
      if (observed.length === 1) {
        return Promise.resolve(new globalThis.Response(null, {
          status: 302,
          headers: { Location: "https://host-b.example/video.mp4?token=second-secret", "Set-Cookie": "sid=secret" }
        }));
      }
      return Promise.resolve(new globalThis.Response("video", {
        status: 206,
        headers: { "Set-Cookie": "sid=another-secret", "Content-Type": "video/mp4" }
      }));
    };
    const { logger, entries } = recordingLogger();
    const transport = new DirectTransport(new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }), privacy, logger, pinned);
    await transport.request({
      url: "https://host-a.example/private-path-token-ABC123?token=first-secret#fragment",
      method: "GET",
      headers: {
        Accept: "video/*", Range: "bytes=10-20", "If-Range": "etag-value",
        "User-Agent": "Stremio Windows exact-version", Referer: "https://private.example/title",
        Cookie: "session=secret", Authorization: "Bearer secret", "Proxy-Authorization": "secret",
        Origin: "https://private.example", "X-Forwarded-For": "192.168.1.1", "X-Real-IP": "10.0.0.1",
        Forwarded: "for=secret", Via: "secret", "X-Api-Key": "secret", "Sec-Fetch-Site": "same-origin",
        DNT: "1"
      }
    });
    expect(observed).toHaveLength(2);
    for (const headers of observed) {
      expect(Object.fromEntries(headers)).toEqual({
        accept: "video/*",
        "accept-encoding": "identity",
        "user-agent": MINIMAL_HTTP_USER_AGENT
      });
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("referer")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    }
    expect(JSON.stringify(entries)).not.toContain("first-secret");
    expect(JSON.stringify(entries)).not.toContain("second-secret");
    expect(JSON.stringify(entries)).not.toContain("fragment");
    expect(JSON.stringify(entries)).not.toContain("private-path-token-ABC123");
  });

  it("validates every redirect and blocks a redirect to localhost", async () => {
    const pinned = vi.fn<PinnedRequest>().mockResolvedValue(new globalThis.Response(null, {
      status: 302, headers: { Location: "http://127.0.0.1/private.mp4" }
    }));
    const transport = new DirectTransport(new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }), privacy, recordingLogger().logger, pinned);
    await expect(transport.request({ url: "https://public.example/video.mp4", method: "GET" }))
      .rejects.toThrow(/private|reserved/);
    expect(pinned).toHaveBeenCalledTimes(1);
  });

  it("blocks mixed public/private DNS answers before opening a socket", async () => {
    const pinned = vi.fn<PinnedRequest>();
    const transport = new DirectTransport(new ExternalUrlPolicy({
      resolver: () => Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 }
      ])
    }), privacy, recordingLogger().logger, pinned);
    await expect(transport.request({ url: "https://rebind.example/video.mp4", method: "GET" }))
      .rejects.toThrow(/private|reserved/);
    expect(pinned).not.toHaveBeenCalled();
  });

  it("connects to the validated IP while retaining the HTTPS hostname for Host and SNI", async () => {
    const policy = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    const pinned = vi.fn<PinnedRequest>().mockImplementation((target) => {
      expect(target.address).toBe("93.184.216.34");
      expect(target.url.protocol).toBe("https:");
      expect(target.url.hostname).toBe("media.example");
      return Promise.resolve(new globalThis.Response("ok", { status: 200 }));
    });
    const transport = new DirectTransport(policy, privacy, recordingLogger().logger, pinned);
    await transport.request({ url: "https://media.example/video.mp4", method: "GET" });
    expect(pinned).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to global fetch when the selected transport fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const failing: OutboundTransport = {
      id: "failing",
      request: () => Promise.reject(new Error("transport failed")),
      diagnostics: () => ({ transport: "failing", requests: 1, failures: 1, averageLatencyMs: 0 })
    };
    const request = { headers: {} } as Request;
    await expect(proxyDirectHttp(
      { url: "https://media.example/video.mp4", fileName: "video.mp4", size: 1 },
      request, {} as ExpressResponse, 100, new AbortController().signal, "GET", failing
    )).rejects.toThrow(/transport failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cleans up the header deadline when entry-scope parsing fails", async () => {
    vi.useFakeTimers();
    try {
      const pinned = vi.fn<PinnedRequest>();
      const transport = new DirectTransport(new ExternalUrlPolicy(), privacy, recordingLogger().logger, pinned);
      await expect(proxyDirectHttp({ url: "invalid", fileName: "stream", size: 0 },
        { headers: {} } as Request, {} as ExpressResponse, 100,
        new AbortController().signal, "GET", transport)).rejects.toThrow();
      expect(pinned).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("passes cancellation to the transport and exposes it through the direct backend only", async () => {
    const request = vi.fn<OutboundTransport["request"]>((_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(
        signal.reason instanceof Error ? signal.reason : new Error("cancelled")
      ), { once: true });
    }));
    const transport: OutboundTransport = {
      id: "test", request,
      diagnostics: () => ({ transport: "test", requests: 1, failures: 0, averageLatencyMs: 0 })
    };
    const backend = new DirectHttpPlaybackBackend(transport);
    const playable = await backend.prepare({
      providerId: "test", type: "https", url: "https://media.example/video.mp4"
    });
    expect(playable.transport).toBe(transport);
    const controller = new AbortController();
    const pending = transport.request({ url: "https://media.example/video.mp4", method: "GET" }, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});


describe("effective outbound URL", () => {
  it("refuses validator authority after HTTPS even when the final HTTP URL and selectors match", async () => {
    const received: Headers[] = [];
    let redirect = false;
    const finalUrl = "http://media.example/video.mp4";
    const transport = new DirectTransport(new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    }), privacy, recordingLogger().logger, (target, init) => {
      received.push(new Headers(init.headers));
      return Promise.resolve(redirect && target.url.protocol === "https:"
        ? new globalThis.Response(null, { status: 302, headers: { Location: finalUrl } })
        : new globalThis.Response("abcdef", { headers: { ETag: '"private-validator"' } }));
    });
    const initial = await transport.request({ url: finalUrl, method: "GET" });
    expect(initial.representationRequestKey).toBeDefined();
    redirect = true; received.length = 0;
    const resumed = await transport.request({ url: "https://entry.example/video", method: "GET",
      headers: { Range: "bytes=2-4" }, conditionalRange: true, rangeBindingActive: () => true,
      rangeBinding: { effectiveUrl: finalUrl, requestKey: initial.representationRequestKey!,
        upstreamEtag: '"private-validator"', opaqueEtag: '"opaque"' } });
    expect(received).toHaveLength(2);
    for (const headers of received) {
      expect(headers.has("Range")).toBe(false); expect(headers.has("If-Range")).toBe(false);
    }
    expect(resumed.representationRequestKey).toBeUndefined();
    expect(resumed.conditionalRangeSent).toBe(false);
    expect(await resumed.response.text()).toBe("abcdef");
  });

  it("returns the validated request URL with zero, one, and two redirects", async () => {
    const urls = [
      "https://entry.example/redirect?token=private",
      "https://middle.example/wrapper",
      "https://cdn.example/media/master.m3u8"
    ];
    for (const redirects of [0, 1, 2]) {
      const visited: string[] = [];
      const pinned: PinnedRequest = (target) => {
        visited.push(target.url.toString());
        return Promise.resolve(visited.length <= redirects
          ? new globalThis.Response(null, { status: 302, headers: { Location: urls[visited.length] ?? "" } })
          : new globalThis.Response("#EXTM3U", { status: 200 }));
      };
      const transport = new DirectTransport(new ExternalUrlPolicy({
        resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
      }), privacy, recordingLogger().logger, pinned);
      const result = await transport.request({ url: urls[0]!, method: "GET" });
      expect(result.effectiveUrl).toBe(urls[redirects]);
      expect(result.response.status).toBe(200);
      expect(visited).toEqual(urls.slice(0, redirects + 1));
    }
  });

  it("validates a later redirect before connecting and preserves the redirect limit", async () => {
    const pinned = vi.fn<PinnedRequest>().mockImplementation((target) => Promise.resolve(
      new globalThis.Response(null, { status: 302, headers: {
        Location: target.url.hostname === "entry.example"
          ? "https://middle.example/wrapper" : "http://127.0.0.1/private"
      } })
    ));
    const policy = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    const transport = new DirectTransport(policy, privacy, recordingLogger().logger, pinned);
    await expect(transport.request({ url: "https://entry.example/redirect", method: "GET" }))
      .rejects.toThrow(/private|reserved/);
    expect(pinned).toHaveBeenCalledTimes(2);

    const looping = vi.fn<PinnedRequest>().mockResolvedValue(new globalThis.Response(null, {
      status: 302, headers: { Location: "/again" }
    }));
    const limited = new DirectTransport(policy, { ...privacy, maxRedirects: 1 }, recordingLogger().logger, looping);
    await expect(limited.request({ url: "https://entry.example/start", method: "GET" }))
      .rejects.toThrow(/redirect limit/i);
    expect(looping).toHaveBeenCalledTimes(2);
  });
});
