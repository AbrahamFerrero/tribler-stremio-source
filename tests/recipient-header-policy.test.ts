import { getEventListeners } from "node:events";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { proxyDirectHttp } from "../src/automatic-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "./http-client";
import type { IncomingHttpHeaders } from "node:http";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { silentLogger, testConfig } from "./helpers";
import { DirectTransport, type PinnedRequest } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { HttpPrivacyPolicy } from "../src/network/http-privacy";
import { parseSourceHeaderRules } from "../src/network/http-privacy";
import { normalizeStreamSource } from "../src/streams/normalization";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { PlaybackManager } from "../src/playback/manager";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import * as factory from "../src/streams/factory";
import { createApp } from "../src/app";
import type { TriblerClient } from "../src/tribler-client";
import { loadConfig } from "../src/config";
import { streamDeduplicationKey } from "../src/streams/stream-deduplication";

const sourceHeaders = { Referer: "https://site.example/watch?signature=FAKE_HEADER_14#private",
  Origin: "https://site.example", "User-Agent": "PrivateDevice/14", Accept: "video/mp4",
  Cookie: "FAKE_COOKIE_14", Authorization: "FAKE_AUTH_14" };
const defaults = { accept: "*/*", "accept-encoding": "identity", "user-agent": "Mozilla/5.0" };
const entryHeaders = { ...defaults, accept: "video/mp4", referer: "https://site.example/", origin: "https://site.example" };
const fixtures: DirtyUpstream[] = [];
async function fixture(): Promise<DirtyUpstream> {
  const upstream = new DirtyUpstream(); fixtures.push(upstream); await upstream.listen(); return upstream;
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(fixtures.splice(0).map(upstream => upstream.close())); });

describe("recipient-scoped source headers at protected sockets", () => {
  it("minimizes the initial recipient while preserving signed URLs and bytes", async () => {
    const upstream = await fixture(); const received: IncomingHttpHeaders[] = [];
    const query = "?signature=FAKE_LOCATOR_14";
    const plain = upstream.media("/media/video.mp4", { body: "fixture bytes", contentType: "video/mp4",
      requiredQuery: query, requiredHeaders: { Referer: entryHeaders.referer, Origin: entryHeaders.origin },
      observeHeaders: headers => received.push(headers) });
    const url = plain + query; upstream.allowMediaUrl(url);
    const transport = new DirectTransport(new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() }),
      testConfig().httpPrivacy, silentLogger);
    const result = await transport.request({ url, method: "GET", sourceHeaders });
    expect(await result.response.text()).toBe("fixture bytes");
    const headers = { ...received[0]! }; delete headers.host; delete headers.connection;
    expect(headers).toEqual(entryHeaders);
  });

  it("does not disclose source requirements to an unauthorized origin, and restores them on return", async () => {
    const a = await fixture(), b = await fixture(); const received: IncomingHttpHeaders[] = [];
    const end = a.media("/media/end.mp4", { body: "bytes", observeHeaders: headers => received.push(headers) });
    const middle = b.media("/media/middle", { redirectTo: end, observeHeaders: headers => received.push(headers) });
    const entry = a.media("/media/entry", { redirectTo: middle, observeHeaders: headers => received.push(headers) });
    const transport = new DirectTransport(new ExternalUrlPolicy({ allowedLoopbackUrls: [...a.allowedMediaUrls(), ...b.allowedMediaUrls()] }),
      testConfig().httpPrivacy, silentLogger);
    const result = await transport.request({ url: entry, method: "GET", sourceHeaders }); await result.response.body?.cancel();
    expect(received).toHaveLength(3);
    expect(received.map(headers => headers.referer)).toEqual([entryHeaders.referer, undefined, entryHeaders.referer]);
    expect(received.map(headers => headers.origin)).toEqual([entryHeaders.origin, undefined, entryHeaders.origin]);
    expect(received.map(headers => headers["user-agent"])).toEqual([defaults["user-agent"], defaults["user-agent"], defaults["user-agent"]]);
    expect(received[1]?.accept).toBe("*/*");
  });

  it("sends only locally configured values to an authorized recipient", async () => {
    const a = await fixture(), b = await fixture(); const received: IncomingHttpHeaders[] = [];
    const end = b.media("/media/end.mp4", { body: "bytes", observeHeaders: headers => received.push(headers) });
    const entry = a.media("/media/entry", { redirectTo: end });
    const privacy = { ...testConfig().httpPrivacy, sourceHeaderRules: [{ sourceOrigin: new URL(entry).origin,
      recipientOrigin: new URL(end).origin, headers: { Referer: "https://authorized.example/", "User-Agent": "Compatible/1" } }] } as HttpPrivacyPolicy;
    const transport = new DirectTransport(new ExternalUrlPolicy({ allowedLoopbackUrls: [...a.allowedMediaUrls(), ...b.allowedMediaUrls()] }), privacy, silentLogger);
    const result = await transport.request({ url: entry, method: "GET", sourceHeaders }); await result.response.body?.cancel();
    expect(received[0]?.referer).toBe("https://authorized.example/");
    expect(received[0]?.origin).toBeUndefined(); expect(received[0]?.accept).toBe("*/*");
    expect(received[0]?.["user-agent"]).toBe("Compatible/1");
  });

  it("drops semantically malformed Referer and Origin at the initial recipient", async () => {
    const upstream = await fixture(); const received: IncomingHttpHeaders[] = [];
    const url = upstream.media("/media/video.mp4", { body: "bytes", observeHeaders: headers => received.push(headers) });
    const transport = new DirectTransport(new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() }), testConfig().httpPrivacy, silentLogger);
    const result = await transport.request({ url, method: "GET", sourceHeaders: { Referer: "not a URL", Origin: "https://site.example/private?signature=FAKE_ORIGIN_14" } });
    await result.response.body?.cancel(); expect(received[0]?.referer).toBeUndefined(); expect(received[0]?.origin).toBeUndefined();
  });
});

describe("recipient policy on synthetic public destinations", () => {
  it.each([
    ["https://entry.example", "http://entry.example"],
    ["https://entry.example", "https://entry.example:8443"],
    ["https://entry.example", "https://sibling.entry.example"],
    ["http://entry.example", "https://entry.example"]
  ])("does not equate origins %s and %s", async (entry, next) => {
    const received: Headers[] = [];
    const pinned: PinnedRequest = (_target, init) => {
      received.push(new Headers(init.headers));
      return Promise.resolve(received.length === 1 ? new Response(null, { status: 302, headers: { Location: next + "/video.mp4" } }) : new Response("bytes"));
    };
    const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), testConfig().httpPrivacy, silentLogger, pinned);
    const result = await transport.request({ url: entry + "/entry", method: "GET", sourceHeaders }); await result.response.body?.cancel();
    expect(received[0]?.get("Referer")).toBe(entryHeaders.referer);
    expect(Object.fromEntries(received[1]!)).toEqual(defaults);
  });

  it("retains downgrade protection after an HTTP entry upgrades and returns", async () => {
    const received: Headers[] = [];
    const urls = ["http://entry.example/entry", "https://secure.example/entry", "http://entry.example/end"];
    const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }),
      testConfig().httpPrivacy, silentLogger, (_target, init) => {
        received.push(new Headers(init.headers));
        return Promise.resolve(received.length < urls.length ? new Response(null, { status: 302, headers: { Location: urls[received.length]! } }) : new Response("bytes"));
      });
    const result = await transport.request({ url: urls[0]!, method: "GET", sourceHeaders }); await result.response.body?.cancel();
    expect(Object.fromEntries(received[2]!)).toEqual(defaults);
    expect(result.sourceHeaderScope?.httpsOnly).toBe(true);
  });

  it("does not authorize private destinations even with a local rule", async () => {
    const pinned = vi.fn<PinnedRequest>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }));
    const privacy = { ...testConfig().httpPrivacy, sourceHeaderRules: [{ sourceOrigin: "http://entry.example",
      recipientOrigin: "http://127.0.0.1", headers: { Referer: "https://site.example/" } }] };
    const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), privacy, silentLogger, pinned);
    await expect(transport.request({ url: "http://entry.example/entry", method: "GET", sourceHeaders })).rejects.toThrow(/private|reserved/);
    expect(pinned).toHaveBeenCalledTimes(1);
  });
});

describe("trusted local rules and independent adversarial boundaries", () => {
  it("cleans the proxy timer and abort listener when the entry URL is invalid", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const transport = new DirectTransport(new ExternalUrlPolicy(), testConfig().httpPrivacy, silentLogger);
      const send = vi.spyOn(transport, "request");
      await expect(proxyDirectHttp({ url: "invalid URL", fileName: "video", size: 0 },
        { headers: {} } as ExpressRequest, {} as ExpressResponse, 60_000, controller.signal, "GET", transport))
        .rejects.toThrow(TypeError);
      expect(send).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps permissions tied to the entry across an authorized hop and stops on 403", async () => {
    const received: Headers[] = [];
    const privacy = { ...testConfig().httpPrivacy, sourceHeaderRules: [{ sourceOrigin: "https://entry.example",
      recipientOrigin: "https://authorized.example", headers: { Referer: "https://local.example/exact?token=FAKE_LOCAL_SECRET", "User-Agent": "Compatible/1", Accept: "video/mp4" } }] };
    const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), privacy, silentLogger,
      (_target, init) => {
        received.push(new Headers(init.headers));
        return Promise.resolve(received.length < 3 ? new Response(null, { status: 302, headers: {
          Location: received.length === 1 ? "https://authorized.example/next" : "https://other.example/end"
        } }) : new Response(null, { status: 403 }));
      });
    const result = await transport.request({ url: "https://entry.example/start", method: "GET", sourceHeaders });
    expect(result.response.status).toBe(403); expect(received).toHaveLength(3);
    expect(received[1]?.get("Referer")).toBe(privacy.sourceHeaderRules[0]!.headers.Referer);
    expect(Object.fromEntries(received[2]!)).toEqual(defaults);
  });

  it("rejects malformed rules and distinguishes absent configuration from empty input", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:1");
    vi.stubEnv("HTTP_SOURCE_HEADER_RULES", undefined);
    expect(loadConfig().httpPrivacy.sourceHeaderRules).toBeUndefined();
    const valid = { sourceOrigin: "https://entry.example", recipientOrigin: "https://cdn.example", headers: { Accept: "video/mp4" } };
    for (const raw of ["", "null", "{}", "false", JSON.stringify([{}]),
      JSON.stringify([{ ...valid, extra: true }]), JSON.stringify([{ ...valid, headers: {} }]),
      JSON.stringify([{ ...valid, headers: { Accept: "video/mp4", ACCEPT: "other" } }]),
      JSON.stringify([{ ...valid, headers: { Accept: "bad\r\nvalue" } }]),
      JSON.stringify(Array.from({ length: 33 }, () => valid))]) {
      vi.stubEnv("HTTP_SOURCE_HEADER_RULES", raw);
      expect(loadConfig).toThrow("Invalid HTTP_SOURCE_HEADER_RULES");
    }
  });

  it("copies local rules so later configuration mutation cannot broaden recipients", async () => {
    const rule = { sourceOrigin: "https://entry.example", recipientOrigin: "https://authorized.example", headers: { Referer: "https://safe.example/" } };
    const received: Headers[] = [];
    const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }),
      { ...testConfig().httpPrivacy, sourceHeaderRules: [rule] }, silentLogger,
      (_target, init) => { received.push(new Headers(init.headers)); return Promise.resolve(new Response("bytes")); });
    rule.recipientOrigin = "https://attacker.example"; rule.headers.Referer = sourceHeaders.Referer;
    const result = await transport.request({ url: "https://attacker.example/video.mp4", method: "GET", sourceHeaders,
      sourceHeaderScope: { origin: "https://entry.example", httpsOnly: true } }); await result.response.body?.cancel();
    expect(Object.fromEntries(received[0]!)).toEqual(defaults);
  });

  it("copies HLS requirements and refuses header inheritance without entry context", () => {
    const manager = new PlaybackManager([]), headers = { Referer: sourceHeaders.Referer };
    const resources = [{ url: "https://child.example/a.ts", isMediaSegment: true }];
    const scope = { origin: "https://entry.example", httpsOnly: true };
    const token = manager.registerHlsResources(resources, headers, scope)[0]!;
    headers.Referer = "https://attacker.example/"; scope.origin = "https://child.example";
    expect(manager.prepareHlsResource(token).requestHeaders?.Referer).toBe(sourceHeaders.Referer);
    expect(manager.prepareHlsResource(token).sourceHeaderScope?.origin).toBe("https://entry.example");
    const noScope = manager.registerHlsResources(resources, headers)[0]!;
    expect(manager.prepareHlsResource(noScope).requestHeaders).toBeUndefined();
  });

  it("does not reinterpret Origin paths, opaque origins or credentials as valid origins", async () => {
    for (const origin of ["null", "https://site.example/a/..", "https://u:p@site.example", "https://site.example?", "file:///", "https://site.example/#"]) {
      const received: Headers[] = [];
      const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), testConfig().httpPrivacy, silentLogger,
        (_target, init) => { received.push(new Headers(init.headers)); return Promise.resolve(new Response("bytes")); });
      const result = await transport.request({ url: "https://entry.example/video.mp4", method: "GET", sourceHeaders: { Origin: origin, Referer: "https://u:p@site.example/private" } });
      await result.response.body?.cancel(); expect(received[0]?.has("Origin")).toBe(false); expect(received[0]?.has("Referer")).toBe(false);
    }
  });

  it("validates local rules at startup without reflecting rejected private values", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:1");
    const valid = [{ sourceOrigin: "https://entry.example:443", recipientOrigin: "https://cdn.example/", headers: { Referer: "https://site.example/watch?signature=FAKE_LOCAL_14", Origin: "https://site.example/", "User-Agent": "Compatible/1" } }];
    vi.stubEnv("HTTP_SOURCE_HEADER_RULES", JSON.stringify(valid));
    expect(loadConfig().httpPrivacy.sourceHeaderRules?.[0]?.recipientOrigin).toBe("https://cdn.example");
    expect(loadConfig().httpPrivacy.sourceHeaderRules?.[0]?.headers.Origin).toBe("https://site.example");
    for (const value of ["FAKE_LOCAL_14", [{ ...valid[0], recipientOrigin: "http://cdn.example" }], [{ ...valid[0], headers: { Authorization: "FAKE_LOCAL_14" } }], [{ ...valid[0], headers: { Origin: "null" } }], [valid[0], valid[0]], [{ ...valid[0], headers: { Referer: "https://u:p@site.example/" } }]]) {
      vi.stubEnv("HTTP_SOURCE_HEADER_RULES", typeof value === "string" ? value : JSON.stringify(value));
      expect(loadConfig).toThrow("Invalid HTTP_SOURCE_HEADER_RULES");
    }
    expect(() => parseSourceHeaderRules([{ ...valid[0], headers: { Referer: sourceHeaders.Referer } }])).toThrow("Invalid HTTP_SOURCE_HEADER_RULES");
  });
});

describe("probe and public HLS playback recipient scope", () => {
  it("keeps distinct requirements and signed locators separate without changing probe cache reuse", async () => {
    const upstream = await fixture(); const received: IncomingHttpHeaders[] = [];
    const plain = upstream.media("/media/cache.mp4", { body: Buffer.from([1, 2, 3]), contentType: "video/mp4", range: "honor",
      observeHeaders: headers => received.push(headers) });
    const signed = plain + "?signature=FAKE_CACHE_14"; upstream.allowMediaUrl(signed);
    const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
    const transport = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger);
    const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 1000, maxCandidates: 3, maxConcurrent: 1 }, silentLogger);
    const sources = [
      { Referer: "https://one.example/private?signature=FAKE_CACHE_HEADER_14" },
      { Referer: "https://two.example/private" },
      { Referer: "https://one.example/private?signature=FAKE_CACHE_HEADER_14" }
    ].map((headers, index) => normalizeStreamSource({ type: "http", url: index === 2 ? signed : plain, requestHeaders: headers }, "synthetic")!);
    expect(new Set(sources.map(streamDeduplicationKey)).size).toBe(3);
    const first = await probe.probe(sources); const second = await probe.probe(sources);
    expect(first.every(source => source.directHttp?.verified)).toBe(true);
    expect(second.map(source => source.directHttp)).toEqual(first.map(source => source.directHttp));
    expect(probe.diagnostics()).toMatchObject({ requests: 3, cacheHits: 3 });
    expect(received.map(headers => headers.referer)).toEqual(["https://one.example/", "https://two.example/", "https://one.example/"]);
  });

  it("does not lose HTTPS history when an upgraded playlist points back to its HTTP entry origin", async () => {
    const seen: Array<{ path: string; headers: Headers }> = [];
    const entry = "http://entry.example/master.m3u8", secure = "https://secure.example/master.m3u8", segment = "http://entry.example/segment.ts";
    const transport = new DirectTransport(new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), testConfig().httpPrivacy, silentLogger,
      (target, init) => {
        const headers = new Headers(init.headers); seen.push({ path: target.url.href, headers });
        if (target.url.href === entry) return Promise.resolve(new Response(null, { status: 302, headers: { Location: secure } }));
        if (target.url.href === secure) return Promise.resolve(new Response(`#EXTM3U\n#EXTINF:4,\n${segment}`, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
        return Promise.resolve(headers.has("Referer") ? new Response(null, { status: 403 }) : new Response("segment bytes", { headers: { "Content-Type": "video/mp2t" } }));
      });
    const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
    const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 1000, maxCandidates: 1, maxConcurrent: 1 }, silentLogger);
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "synthetic", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve([{ providerId: "synthetic", type: "http", url: entry, requestHeaders: sourceHeaders }]) });
    vi.spyOn(factory, "createStreamResolver").mockReturnValue(new StreamResolver(registry, policy, probe));
    const app = createApp(testConfig(), silentLogger, undefined, [], policy, transport).app;
    const discovery = await request(app).get("/stream/movie/tt9999999999.json");
    expect((discovery.body as { streams: Array<{ url: string }> }).streams).toHaveLength(1); expect(probe.diagnostics().verified).toBe(1);
    const root = await request(app).get(new URL((discovery.body as { streams: Array<{ url: string }> }).streams[0]!.url).pathname); expect(root.status).toBe(200);
    const child = root.text.match(/http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/)?.[0]; expect(child).toBeDefined();
    const played = await request(app).get(new URL(child!).pathname); expect(played.status).toBe(200);
    const childRequests = seen.filter(item => item.path === segment); expect(childRequests).toHaveLength(2);
    expect(childRequests.every(item => !item.headers.has("Referer") && !item.headers.has("Origin"))).toBe(true);
  });

  it.each([false, true])("cross-origin HLS has exact recipient headers (authorized=%s)", async authorized => {
    const a = await fixture(), b = await fixture(), c = await fixture();
    const observed: Array<{ owner: string; headers: IncomingHttpHeaders }> = [];
    const needed = { Referer: entryHeaders.referer, Origin: entryHeaders.origin };
    const observer = (owner: string) => (headers: IncomingHttpHeaders) => observed.push({ owner, headers });
    const query = "?signature=FAKE_HLS_LOCATOR_14";
    const signed = (upstream: DirtyUpstream, path: string, body: string, contentType: string) => {
      const plain = upstream.media(path, { body, contentType, requiredQuery: query,
        ...(upstream !== a ? { requiredHeaders: needed } : {}), observeHeaders: observer(upstream === a ? "entry" : "child") });
      upstream.allowMediaUrl(plain + query); return plain + query;
    };
    const audioBytes = signed(c, "/media/audio.ts", "audio bytes", "audio/aac");
    const audio = signed(b, "/media/audio.m3u8", `#EXTM3U\n#EXTINF:4,\n${audioBytes}`, "application/vnd.apple.mpegurl");
    const map = signed(c, "/media/init.mp4", "map bytes", "video/mp4");
    const key = signed(c, "/media/key.bin", "key bytes", "application/octet-stream");
    const segment = signed(c, "/media/segment.ts", "segment bytes", "video/mp2t");
    const variant = signed(b, "/media/variant.m3u8", `#EXTM3U\n#EXT-X-MAP:URI="${map}"\n#EXT-X-KEY:METHOD=AES-128,URI="${key}"\n#EXTINF:4,\n${segment}`, "application/vnd.apple.mpegurl");
    const root = signed(a, "/media/master.m3u8", `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="${audio}"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\n${variant}`, "application/vnd.apple.mpegurl");
    const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: [...a.allowedMediaUrls(), ...b.allowedMediaUrls(), ...c.allowedMediaUrls()] });
    const privacy = { ...testConfig().httpPrivacy, sourceHeaderRules: authorized ? [b, c].map(upstream => ({
      sourceOrigin: new URL(root).origin, recipientOrigin: new URL(upstream.url("/")).origin, headers: needed
    })) : [] };
    const entries: unknown[] = [];
    const log = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (message: string, context: unknown) => entries.push({ message, context })])) as unknown as typeof silentLogger;
    const transport = new DirectTransport(policy, privacy, log);
    const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 1000, maxCandidates: 1, maxConcurrent: 1 }, log);
    const forged = { providerId: "synthetic", type: "http", url: root, requestHeaders: sourceHeaders,
      sourceHeaderScope: { origin: new URL(variant).origin, httpsOnly: false }, sourceHeaderRules: privacy.sourceHeaderRules };
    const normalized = normalizeStreamSource(forged, "synthetic")!;
    expect(normalized.sourceHeaderScope).toBeUndefined();
    const registry = new StreamProviderRegistry(1000, log);
    registry.register({ id: "synthetic", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve([forged as unknown as typeof normalized]) });
    const resolver = new StreamResolver(registry, policy, probe);
    vi.spyOn(factory, "createStreamResolver").mockReturnValue(resolver);
    const client = { listDownloads: () => Promise.resolve([]) } as unknown as TriblerClient;
    const app = createApp(testConfig({ httpPrivacy: privacy }), log, client, [], policy, transport).app;
    const discovery = await request(app).get("/stream/movie/tt9999999999.json");
    expect(discovery.status).toBe(200);
    expect((discovery.body as { streams: Array<{ url: string }> }).streams).toHaveLength(authorized ? 1 : 0);
    if (authorized) {
      const url = new URL((discovery.body as { streams: Array<{ url: string }> }).streams[0]!.url);
      const visited: string[] = [];
      const visit = async (path: string, depth = 0): Promise<void> => {
        expect(depth).toBeLessThan(4);
        const result = await request(app).get(path); expect(result.status).toBe(200); visited.push(path);
        if (String(result.headers["content-type"]).includes("mpegurl")) {
          expect(result.text).not.toContain("FAKE_HLS_LOCATOR_14");
          const links = [...result.text.matchAll(/http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/g)];
          for (const link of links) await visit(new URL(link[0]).pathname, depth + 1);
        }
      };
      await visit(url.pathname); expect(visited).toHaveLength(7);
      expect(probe.diagnostics().verified).toBe(1);
      expect(c.count("/media/key.bin")).toBe(2); expect(c.count("/media/init.mp4")).toBe(2);
      expect(c.count("/media/segment.ts")).toBe(2); expect(c.count("/media/audio.ts")).toBe(2);
    } else {
      expect(probe.diagnostics().verified).toBe(0);
      expect(b.count("/media/audio.m3u8")).toBe(1); expect(c.count("/media/key.bin")).toBe(0);
    }
    for (const { owner, headers } of observed) {
      expect(headers.referer).toBe(owner === "entry" || authorized ? needed.Referer : undefined);
      expect(headers.origin).toBe(owner === "entry" || authorized ? needed.Origin : undefined);
      expect(headers["user-agent"]).toBe("Mozilla/5.0"); expect(headers.cookie).toBeUndefined(); expect(headers.authorization).toBeUndefined();
    }
    const health = await request(app).get("/health");
    expect((health.body as { httpPrivacy: unknown }).httpPrivacy).toMatchObject({ referer: false, refererIsDefault: true, automaticDowngrade: false });
    const publicText = JSON.stringify([discovery.body, health.body, entries]);
    for (const canary of ["FAKE_HLS_LOCATOR_14", "FAKE_HEADER_14", "FAKE_COOKIE_14", "FAKE_AUTH_14", "PrivateDevice/14"]) expect(publicText.includes(canary)).toBe(false);
  });
});
