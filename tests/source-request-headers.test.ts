import { fixtureOutboundRequest } from "./helpers";
import { describe, expect, it, vi } from "vitest";
import { outboundPlaybackHeaders, sanitizeSourceRequestHeaders, type HttpPrivacyPolicy } from "../src/network/http-privacy";
import { DirectTransport, type OutboundTransport, type PinnedRequest } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { streamDeduplicationKey } from "../src/streams/stream-deduplication";
import { PlaybackManager } from "../src/playback/manager";
import { silentLogger } from "./helpers";

const privacy: HttpPrivacyPolicy = {
  mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
  acceptCookies: false, userAgentMode: "minimal", maxRedirects: 2
};
const required = { Referer: "https://site.example/watch", Accept: "video/mp4", "User-Agent": "Source/1" };

describe("source-scoped request headers", () => {
  it("keeps ordinary source identity while separating distinct header requirements", () => {
    const base = { providerId: "addon", type: "https" as const, url: "https://media.example/video.mp4" };
    expect(streamDeduplicationKey(base)).toBe("url:https://media.example/video.mp4:");
    expect(streamDeduplicationKey({ ...base, requestHeaders: { Referer: "https://one.example" } }))
      .not.toBe(streamDeduplicationKey({ ...base, requestHeaders: { Referer: "https://two.example" } }));
  });

  it("accepts four allowlisted names case-insensitively and drops forbidden or malformed values", () => {
    expect(sanitizeSourceRequestHeaders({
      REFERER: required.Referer, origin: "https://site.example", "user-agent": required["User-Agent"],
      accept: required.Accept, Cookie: "secret", Authorization: "secret", Host: "evil.example",
      Range: "bytes=999-", "If-Range": "evil", "Accept-Encoding": "gzip",
      Forwarded: "evil", "X-Forwarded-For": "evil", "Connection": "keep-alive",
      "Bad Name": "evil"
    })).toEqual({ Referer: required.Referer, Origin: "https://site.example",
      "User-Agent": required["User-Agent"], Accept: required.Accept });
    expect(sanitizeSourceRequestHeaders({ Referer: "https://site.example/\r\nInjected: yes" })).toBeUndefined();
    expect(sanitizeSourceRequestHeaders({ Accept: "x".repeat(1_025) })).toBeUndefined();
    expect(sanitizeSourceRequestHeaders({ Accept: "one", ACCEPT: "two" })).toEqual({ Accept: "one" });
    expect(sanitizeSourceRequestHeaders({ Accept: "bad\nvalue", ACCEPT: "valid" })).toEqual({ Accept: "valid" });
    expect(sanitizeSourceRequestHeaders({ constructor: "secret", toString: "secret" })).toBeUndefined();
    expect(sanitizeSourceRequestHeaders({
      Referer: "a".repeat(1_024), Origin: "b".repeat(1_024), Accept: "extra"
    })).toEqual({ Referer: "a".repeat(1_024), Origin: "b".repeat(1_024) });
    expect(sanitizeSourceRequestHeaders(Object.fromEntries([
      ["Accept", "video/mp4"], ...Array.from({ length: 32 }, (_, i) => ["x-" + i, "v"])
    ]))).toBeUndefined();
  });

  it("shares dedupe and cached probe observations for reordered normalized headers", async () => {
    const headers = { ...required, Origin: "https://site.example" };
    const reordered = sanitizeSourceRequestHeaders({ origin: headers.Origin,
      "user-agent": headers["User-Agent"], accept: headers.Accept, REFERER: headers.Referer })!;
    const source = { providerId: "addon", type: "https" as const,
      url: "https://media.example/video.mp4?signature=synthetic", requestHeaders: headers };
    const request = vi.fn<OutboundTransport["request"]>().mockImplementation(fixtureOutboundRequest(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/100" }
      }))));
    const probe = new DirectStreamProbe({ id: "fixture", request,
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
    { enabled: true, timeoutMs: 500, maxCandidates: 2, maxConcurrent: 1 }, silentLogger);
    const equivalent = { ...source, providerId: "other", requestHeaders: reordered };
    expect(streamDeduplicationKey(equivalent)).toBe(streamDeduplicationKey(source));
    const [first, second] = await probe.probe([source, equivalent]);
    expect(first?.directHttp?.status).toBe("verified");
    expect(second?.directHttp).toBe(first?.directHttp);
    expect(request).toHaveBeenCalledTimes(1);
    expect(probe.diagnostics()).toMatchObject({ requests: 1, cacheHits: 1 });
    expect(request.mock.calls[0]?.[0].sourceHeaders).toEqual(headers);

    // Exact requirements stay distinct even when transport privacy minimizes them.
    const distinct = [
      ...Object.keys(headers).map(name => ({ ...source,
        requestHeaders: { ...headers, [name]: headers[name as keyof typeof headers] + "other" } })),
      { ...source, url: source.url + "-other" },
      { providerId: source.providerId, type: source.type, url: source.url },
      { ...source, requestHeaders: { Accept: "*/*" } },
      { ...source, requestHeaders: { "User-Agent": "Mozilla/5.0" } }
    ];
    expect(new Set([source, ...distinct].map(streamDeduplicationKey)).size).toBe(9);
    for (const candidate of distinct) await probe.probe([candidate]);
    expect(request).toHaveBeenCalledTimes(9);
    expect(probe.diagnostics()).toMatchObject({ requests: 9, cacheHits: 1 });
  });

  it("keeps bridge range and encoding authoritative with explicit user-agent precedence", () => {
    const input = { Range: "bytes=0-63", "If-Range": "etag", Accept: "*/*" };
    const source = { ...required, Range: "bytes=999-", "Accept-Encoding": "gzip", Cookie: "secret" };
    for (const mode of ["minimal", "default", "custom"] as const) {
      const headers = outboundPlaybackHeaders(input, {
        ...privacy, userAgentMode: mode, ...(mode === "custom" ? { customUserAgent: "Bridge/1" } : {}),
        sourceHeaderRules: [{ sourceOrigin: "https://media.example", recipientOrigin: "https://media.example", headers: required }]
      }, source, { origin: "https://media.example", httpsOnly: true }, "https://media.example/video.mp4");
      expect(headers.get("Range")).toBe("bytes=0-63");
      expect(headers.get("If-Range")).toBeNull();
      expect(headers.get("Accept-Encoding")).toBe("identity");
      expect(headers.get("User-Agent")).toBe("Source/1");
      expect(headers.get("Accept")).toBe("video/mp4");
      expect(headers.get("Referer")).toBe(required.Referer);
      expect(headers.has("Cookie")).toBe(false);
    }
    expect(outboundPlaybackHeaders(undefined, privacy).get("User-Agent")).toBe("Mozilla/5.0");
    expect(outboundPlaybackHeaders(undefined, { ...privacy, userAgentMode: "default" }).has("User-Agent")).toBe(false);
    expect(outboundPlaybackHeaders(undefined, { ...privacy, userAgentMode: "custom", customUserAgent: "Bridge/1" })
      .get("User-Agent")).toBe("Bridge/1");
  });

  it("minimizes source headers and omits them across unauthorized redirects while rejecting private targets", async () => {
    const policy = new ExternalUrlPolicy({ resolver: (host) => Promise.resolve(
      [{ address: host === "private.example" ? "127.0.0.1" : "93.184.216.34", family: 4 }]) });
    const pinned = vi.fn<PinnedRequest>().mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: "https://cdn.example/video.mp4" }
    })).mockResolvedValueOnce(new Response("ok"));
    const transport = new DirectTransport(policy, privacy, silentLogger, pinned);
    await transport.request({ url: "https://media.example/video.mp4", method: "GET",
      headers: { Range: "bytes=0-63" }, sourceHeaders: required });
    expect(pinned).toHaveBeenCalledTimes(2);
    for (const [index, call] of pinned.mock.calls.entries()) {
      const headers = new Headers(call[1].headers);
      expect(headers.get("Referer")).toBe(index === 0 ? "https://site.example/" : null);
      expect(headers.get("Range")).toBe("bytes=0-63");
      expect(headers.has("Cookie")).toBe(false);
    }
    const blocked = vi.fn<PinnedRequest>().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "http://private.example/admin" }
    }));
    await expect(new DirectTransport(policy, privacy, silentLogger, blocked).request({
      url: "https://media.example/video.mp4", method: "GET", sourceHeaders: required
    })).rejects.toThrow();
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it("passes source headers through probe and keeps HLS token URLs opaque", async () => {
    const seen: Array<Parameters<OutboundTransport["request"]>[0]> = [];
    const transport: OutboundTransport = {
      id: "fixture", diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }),
      request: fixtureOutboundRequest((request) => {
        seen.push(request);
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/100" }
        }));
      })
    };
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 500, maxCandidates: 2, maxConcurrent: 1
    }, silentLogger);
    const source = { providerId: "addon", type: "https" as const, url: "https://media.example/video.mp4",
      requestHeaders: required };
    await probe.probe([source]);
    expect(seen[0]?.sourceHeaders).toEqual(required);
    expect(new Headers(seen[0]?.headers).get("Range")).toBe("bytes=0-63");
    const manager = new PlaybackManager([]);
    const token = manager.registerHlsResources([{ url: "https://cdn.example/segment.ts", isMediaSegment: true }],
      required, { origin: "https://media.example", httpsOnly: true })[0]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(token).not.toContain("site.example");
    expect(manager.prepareHlsResource(token).requestHeaders).toEqual(required);
  });

  it("carries required headers across HLS variant, audio, key, map and segment probe requests", async () => {
    const seen: Array<Parameters<OutboundTransport["request"]>[0]> = [];
    const transport: OutboundTransport = {
      id: "hls-fixture", diagnostics: () => ({ transport: "hls-fixture", requests: 0, failures: 0, averageLatencyMs: 0 }),
      request: fixtureOutboundRequest((request) => {
        seen.push(request);
        const name = new URL(request.url).pathname.split("/").at(-1);
        const master = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",URI=\"audio.m3u8\"\n"
          + "#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO=\"audio\"\nvariant.m3u8";
        const media = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n"
          + "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
          + "#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts";
        if (name === "master.m3u8" || name === "variant.m3u8" || name === "audio.m3u8") {
          return Promise.resolve(new Response(name === "master.m3u8" ? master
            : name === "audio.m3u8" ? "#EXTM3U\n#EXTINF:4,\naudio.ts" : media, {
            status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
          }));
        }
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { "Content-Type": name === "audio.ts" ? "audio/aac" : "video/mp2t" }
        }));
      })
    };
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
    }, silentLogger);
    const result = await probe.probe([{ providerId: "addon", type: "https",
      url: "https://media.example/master.m3u8", requestHeaders: required }]);
    expect(result[0]?.directHttp?.status).toBe("verified");
    expect(seen.map((request) => new URL(request.url).pathname.split("/").at(-1)))
      .toEqual(["master.m3u8", "audio.m3u8", "audio.ts", "variant.m3u8",
        "init.mp4", "key.bin", "a.ts", "b.ts"]);
    expect(seen.every((request) => JSON.stringify(request.sourceHeaders) === JSON.stringify(required))).toBe(true);
  });
});
