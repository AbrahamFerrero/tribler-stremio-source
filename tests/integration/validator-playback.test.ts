import type { Response as TestResponse } from "supertest";
import request from "../http-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { gzipSync } from "node:zlib";
import { DirtyUpstream, type UpstreamReply } from "../acceptance/dirty-upstream";
import { createApp } from "../../src/app";
import type { CatalogProvider } from "../../src/catalog/types";
import type { TriblerClient } from "../../src/tribler-client";
import { DirectTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy, requestPinned } from "../../src/network/url-policy";
import { encodeStreamId } from "../../src/automatic-stream";
import { PlaybackManager } from "../../src/playback/manager";
import type { PlayableStream } from "../../src/playback/types";
import { silentLogger, testConfig } from "../helpers";

const rawTag = '"FAKE_PRIVATE_VALIDATOR_15"';
const date = "Tue, 13 Oct 2026 01:00:00 GMT";
const fixtures: DirtyUpstream[] = [];
async function fixture(): Promise<DirtyUpstream> { const upstream = new DirtyUpstream(); fixtures.push(upstream); await upstream.listen(); return upstream; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(upstream => upstream.close())); });
const reply = (observeHeaders?: UpstreamReply["observeHeaders"]): UpstreamReply => ({ body: "abcdef", contentType: "video/mp4", range: "honor", respectIfRange: true,
  responseHeaders: { ETag: rawTag, "Last-Modified": date, "Content-Disposition": 'inline; filename="FAKE_PRIVATE_NAME_15.mp4"' },
  ...(observeHeaders ? { observeHeaders } : {}) });
const bytes = (response: TestResponse): Buffer => Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? "");
async function bridge(urls: string[], upstreams = fixtures, options: Partial<ReturnType<typeof testConfig>> = {}) {
  const id = "synthetic:validator";
  const catalog: CatalogProvider = { definition: { id: "validator", type: "movie", name: "Synthetic validator" }, owns: item => item === id,
    list: () => Promise.resolve([]), get: () => Promise.resolve({ id, type: "movie", name: "Synthetic validator" }),
    getDirectStreams: () => Promise.resolve(urls.map(url => ({ url, fileName: "fixture.mp4", size: 0 }))),
    supportsTriblerFallback: () => Promise.resolve(false), getTorrentSource: () => Promise.reject(new Error("No fixture torrent")) };
  const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstreams.flatMap(upstream => upstream.allowedMediaUrls()) });
  const config = testConfig({ managedDownloadsStateFile: ".cache/pr15-unused-state.json", ...options });
  const wire: Array<{ url: string; status: number; headers: Headers }> = [];
  const transport = new DirectTransport(policy, config.httpPrivacy, silentLogger, async (target, init) => {
    const response = await requestPinned(target, init); wire.push({ url: target.url.href, status: response.status, headers: new Headers(init.headers) }); return response;
  });
  const built = createApp(config, silentLogger, { listDownloads: () => Promise.resolve([]) } as unknown as TriblerClient, catalog, policy, transport);
  const discovery = await request(built.app).get(`/stream/movie/${encodeURIComponent(id)}.json`);
  expect(discovery.status).toBe(200);
  const streams = (discovery.body as { streams: Array<{ url: string }> }).streams;
  expect(streams).toHaveLength(urls.length);
  return { ...built, wire, paths: streams.map(stream => new URL(stream.url).pathname), auto: `/auto/${encodeStreamId(id)}/fixture.mp4` };
}

describe("token-scoped validators through public protected playback", () => {
  it("renews a nested HLS tree through public routes, including late keys, maps, seek and idle rejection", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const upstream = await fixture();
    const early = upstream.media("/media/early.ts", { body: "early", contentType: "video/mp2t" });
    const late = upstream.media("/media/late.ts", { body: "late", contentType: "video/mp2t" });
    const key = upstream.media("/media/key.bin", { body: "synthetic-key", contentType: "application/octet-stream" });
    const map = upstream.media("/media/init.mp4", { body: "synthetic-init", contentType: "video/mp4" });
    const media = upstream.media("/media/media.m3u8", { body: `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${key}"\n#EXT-X-MAP:URI="${map}"\n#EXTINF:4,\n${early}\n#EXTINF:4,\n${late}\n#EXT-X-ENDLIST`, contentType: "application/vnd.apple.mpegurl" });
    const variant = upstream.media("/media/variant.m3u8", { body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n${media}`, contentType: "application/vnd.apple.mpegurl" });
    const root = upstream.media("/media/root.m3u8", { body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n${variant}`, contentType: "application/vnd.apple.mpegurl" });
    // Enter at the playback boundary; qualification/discovery is outside this lifecycle test.
    const registered = vi.spyOn(PlaybackManager.prototype, "register");
    const bootstrap = upstream.media("/media/bootstrap.mp4", reply());
    const { app } = await bridge([bootstrap], fixtures, { httpStreamTokenTtlMs: 100 });
    const manager = registered.mock.contexts[0] as PlaybackManager;
    const sourcePath = `/source/${manager.register({ providerId: "fixture", type: "http", url: root })}/fixture.m3u8`;
    const children = (text: string): string[] => [...text.matchAll(/http:\/\/127\.0\.0\.1:7000(\/hls\/[A-Za-z0-9_-]{32})/g)].map(match => match[1]!);
    const masterResponse = await request(app).get(sourcePath); expect(masterResponse.status).toBe(200);
    const variantPath = children(masterResponse.text)[0]!;
    const variantResponse = await request(app).get(variantPath); expect(variantResponse.status).toBe(200);
    const mediaPath = children(variantResponse.text)[0]!;
    const mediaResponse = await request(app).get(mediaPath); expect(mediaResponse.status).toBe(200);
    const [keyPath, mapPath, earlyPath, latePath] = children(mediaResponse.text);
    for (const time of [90, 180, 270]) { now = time; expect((await request(app).get(earlyPath!)).status).toBe(200); }
    for (const path of [latePath, keyPath, mapPath, earlyPath, variantPath, mediaPath, sourcePath]) expect((await request(app).get(path!)).status).toBe(200);
    now = 370;
    const rejected = await Promise.all([request(app).get(earlyPath!), request(app).get(latePath!), request(app).get(sourcePath)]);
    expect(rejected.map(response => response.status)).toEqual([400, 400, 400]);
    expect((await request(app).get(mediaPath)).status).toBe(400);
  });

  it.each(["expiry", "eviction"])("refuses delayed HLS registration after parent %s", async mode => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const upstream = await fixture();
    const segment = upstream.media("/media/delayed.ts", { body: "segment", contentType: "video/mp2t" });
    let release!: () => void;
    const bodyGate = new Promise<void>(resolve => { release = resolve; });
    const delayed = upstream.media("/media/delayed.m3u8", { body: `#EXTM3U\n#EXTINF:4,\n${segment}`, contentType: "application/vnd.apple.mpegurl", bodyGate });
    const root = upstream.media("/media/delayed-root.m3u8", { body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n${delayed}`, contentType: "application/vnd.apple.mpegurl" });
    const registered = vi.spyOn(PlaybackManager.prototype, "register");
    const bootstrap = upstream.media("/media/delayed-bootstrap.mp4", reply());
    const { app, wire } = await bridge([bootstrap], fixtures, { httpStreamTokenTtlMs: 100, httpStreamTokenMaxEntries: 1 });
    const manager = registered.mock.contexts[0] as PlaybackManager;
    const token = manager.register({ providerId: "fixture", type: "http", url: root });
    const master = await request(app).get(`/source/${token}/fixture.m3u8`);
    const childPath = new URL(master.text.match(/http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/)![0]).pathname;
    const count = wire.length;
    const pending = request(app).get(childPath).then(response => response);
    try {
      await vi.waitFor(() => expect(wire).toHaveLength(count + 1));
      if (mode === "expiry") now = 100;
      else manager.register({ providerId: "fixture", type: "http", url: bootstrap });
    } finally { release(); }
    const result = await pending;
    expect(result.status).toBe(400); expect(result.text).not.toContain("/hls/");
    expect((await request(app).get(childPath)).status).toBe(400);
  });

  it("returns an opaque validator and sends it only to its exact representation across redirects", async () => {
    const a = await fixture(), b = await fixture(); const received: Array<{ owner: string; headers: IncomingHttpHeaders }> = [];
    const end = b.media("/media/end.mp4", reply(headers => received.push({ owner: "end", headers })));
    const entry = a.media("/media/entry.mp4", { redirectTo: end, observeHeaders: headers => received.push({ owner: "entry", headers }) });
    const { app, paths } = await bridge([entry]); const full = await request(app).get(paths[0]!);
    expect(bytes(full).toString()).toBe("abcdef");
    received.length = 0;
    const resumed = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag));
    expect(resumed.status).toBe(206); expect(bytes(resumed).toString()).toBe("cde"); expect(resumed.headers["content-range"]).toBe("bytes 2-4/6"); expect(resumed.headers["content-length"]).toBe("3");
    expect(received.map(hit => hit.headers["if-range"])).toEqual([undefined, rawTag]);
    expect(received.map(hit => hit.headers.range)).toEqual([undefined, "bytes=2-4"]);
    expect(full.headers.etag).toMatch(/^"[A-Za-z0-9_-]{32}"$/);
    expect(full.headers.etag).not.toBe(rawTag); expect(full.headers["last-modified"]).toBeUndefined(); expect(full.headers["content-disposition"]).toBeUndefined();
  });

  it("does not let another token authorize a validator even for the identical source", async () => {
    const upstream = await fixture(); const received: IncomingHttpHeaders[] = [];
    const url = upstream.media("/media/same.mp4", reply(headers => received.push(headers)));
    const { app, paths } = await bridge([url]);
    const discovery = await request(app).get("/stream/movie/synthetic%3Avalidator.json");
    const secondPath = new URL((discovery.body as { streams: Array<{ url: string }> }).streams[0]!.url).pathname;
    expect(paths[0]).not.toBe(secondPath);
    const first = await request(app).get(paths[0]!);
    const second = await request(app).get(secondPath);
    const replay = await request(app).get(secondPath).set("Range", "bytes=2-4").set("If-Range", String(first.headers.etag));
    expect(replay.status).toBe(200); expect(bytes(replay).toString()).toBe("abcdef");
    expect(received.at(-1)?.["if-range"]).toBeUndefined(); expect(received.at(-1)?.range).toBeUndefined();
    expect(first.headers.etag).not.toBe(second.headers.etag);
  });

  it("streams a complete changed direct representation instead of converting its 200 into failure", async () => {
    const upstream = await fixture(); const current = reply(); const url = upstream.media("/media/change.mp4", current);
    const { app, paths, wire } = await bridge([url]); const full = await request(app).get(paths[0]!);
    current.body = "UVWXYZ"; current.responseHeaders = { ETag: '"FAKE_CHANGED_15"' };
    const changed = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag));
    expect(wire.at(-1)?.status).toBe(200); expect(changed.status).toBe(200); expect(bytes(changed).toString()).toBe("UVWXYZ");
    expect(changed.headers["content-range"]).toBeUndefined(); expect(changed.headers["content-length"]).toBe("6");
  });

  it.each(["bytes=2-4", "bytes=99-100"])("does not fabricate HLS partial bytes or 416 after a conditional mismatch (%s)", async range => {
    const upstream = await fixture(); const current = { ...reply(), contentType: "video/mp2t" };
    const segment = upstream.media("/media/segment.ts", current);
    const root = upstream.media("/media/master.m3u8", { body: `#EXTM3U\n#EXTINF:4,\n${segment}`, contentType: "application/vnd.apple.mpegurl" });
    const { app, paths, wire } = await bridge([root]); const playlist = await request(app).get(paths[0]!);
    const child = new URL(playlist.text.match(/http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/)![0]).pathname;
    const full = await request(app).get(child); current.body = "UVWXYZ"; current.responseHeaders = { ETag: '"FAKE_CHANGED_15"' };
    const changed = await request(app).get(child).set("Range", range).set("If-Range", String(full.headers.etag));
    expect(wire.at(-1)?.status).toBe(200); expect(changed.status).toBe(200); expect(bytes(changed).toString()).toBe("UVWXYZ"); expect(changed.headers["content-range"]).toBeUndefined();
  });

  it.each([rawTag, date, "not-a-validator", `"${"x".repeat(600)}"`, `W/${rawTag}`])("restarts without forwarding an unissued validator", async validator => {
    const upstream = await fixture(); const received: IncomingHttpHeaders[] = [];
    const url = upstream.media("/media/untrusted.mp4", reply(headers => received.push(headers)));
    const { app, paths } = await bridge([url]); const full = await request(app).get(paths[0]!); expect(full.status).toBe(200);
    const result = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", validator);
    expect(result.status).toBe(200); expect(bytes(result).toString()).toBe("abcdef");
    expect(received.at(-1)?.["if-range"]).toBeUndefined(); expect(received.at(-1)?.range).toBeUndefined();
  });

  it("rejects a contradictory upstream 206 before forwarding its incorrect bytes", async () => {
    const upstream = await fixture(); const url = upstream.media("/media/wrong.mp4", { body: "abc", status: 206, contentType: "video/mp4", responseHeaders: { "Content-Range": "bytes 0-2/6" } });
    const { app, paths } = await bridge([url]); const result = await request(app).get(paths[0]!).set("Range", "bytes=2-4");
    expect(result.status).toBe(502); expect(bytes(result).toString()).not.toBe("abc");
  });

  it("preserves a validated upstream 416 with no reflected error body or validators", async () => {
    const upstream = await fixture(); const url = upstream.media("/media/unsatisfied.mp4", reply());
    const { app, paths } = await bridge([url]); const result = await request(app).get(paths[0]!).set("Range", "bytes=99-100");
    expect(result.status).toBe(416); expect(result.headers["content-range"]).toBe("bytes */6"); expect(result.headers["content-length"]).toBe("0"); expect(bytes(result).length).toBe(0); expect(result.headers.etag).toBeUndefined();
  });

  it("omits transformed playlist validators and avoids advertising original HEAD representation metadata", async () => {
    const upstream = await fixture(); const segment = upstream.media("/media/segment.ts", { body: "abcdef", contentType: "video/mp2t" });
    const text = `#EXTM3U\n#EXTINF:4,\n${segment}`;
    const root = upstream.media("/media/master.m3u8", { ...reply(), body: text, range: "ignore", contentType: "application/vnd.apple.mpegurl" });
    const { app, paths } = await bridge([root]); const get = await request(app).get(paths[0]!); const head = await request(app).head(paths[0]!);
    expect(get.status).toBe(200); expect(get.text).toContain("/hls/"); expect(get.headers["content-length"]).toBe(String(Buffer.byteLength(get.text)));
    for (const result of [get, head]) { expect(result.headers.etag).toBeUndefined(); expect(result.headers["last-modified"]).toBeUndefined(); expect(result.headers["content-disposition"]).toBeUndefined(); expect(result.headers["cache-control"]).toBe("no-store"); }
    expect(head.headers["content-length"]).toBeUndefined(); expect(head.headers["content-range"]).toBeUndefined(); expect(head.headers["accept-ranges"]).toBeUndefined();
  });

  it("gives the automatic catalog route a full-response fallback without validator authority", async () => {
    const upstream = await fixture(); const received: IncomingHttpHeaders[] = [];
    const url = upstream.media("/media/auto.mp4", reply(headers => received.push(headers))); const { app, auto } = await bridge([url]);
    const result = await request(app).get(auto).set("Range", "bytes=2-4").set("If-Range", rawTag);
    expect(result.status).toBe(200); expect(bytes(result).toString()).toBe("abcdef"); expect(result.headers.etag).toBeUndefined();
    expect(received.at(-1)?.["if-range"]).toBeUndefined(); expect(received.at(-1)?.range).toBeUndefined();
  });
});

describe("independent representation and byte-integrity interactions", () => {
  it.each([`W/${rawTag}`, `"${"x".repeat(600)}"`, undefined])("does not expose or promote weak, oversized or date-only upstream metadata", async etag => {
    const upstream = await fixture(); const url = upstream.media("/media/strength.mp4", { ...reply(), responseHeaders: { "Last-Modified": date, ...(etag ? { ETag: etag } : {}) } });
    const { app, paths } = await bridge([url]); const result = await request(app).get(paths[0]!);
    expect(result.status).toBe(200); expect(bytes(result).toString()).toBe("abcdef"); expect(result.headers.etag).toBeUndefined(); expect(result.headers["last-modified"]).toBeUndefined();
  });

  it("streams a full response when a valid origin chooses to ignore a conditional Range", async () => {
    const upstream = await fixture(); const current = reply(); const url = upstream.media("/media/ignore.mp4", current);
    const { app, paths, wire } = await bridge([url]); const full = await request(app).get(paths[0]!); current.range = "ignore";
    const restarted = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag));
    expect(wire).toHaveLength(2); expect(wire.at(-1)?.headers.get("If-Range")).toBe(rawTag); expect(restarted.status).toBe(200); expect(bytes(restarted).toString()).toBe("abcdef");
  });

  it("validates an unframed bounded partial completely and refuses an unbounded framing branch", async () => {
    const upstream = await fixture(); const current: UpstreamReply = { body: "cde", status: 206, chunked: true, contentType: "video/mp4", responseHeaders: { "Content-Range": "bytes 2-4/6" } };
    const url = upstream.media("/media/bounded.mp4", current); const { app, paths } = await bridge([url]);
    const valid = await request(app).get(paths[0]!).set("Range", "bytes=2-4"); expect(valid.status).toBe(206); expect(bytes(valid).toString()).toBe("cde"); expect(valid.headers["content-length"]).toBe("3");
    current.responseHeaders = { "Content-Range": "bytes 0-33554432/33554433" };
    const refused = await request(app).get(paths[0]!).set("Range", "bytes=0-"); expect(refused.status).toBe(502); expect(bytes(refused).toString()).not.toBe("cde");
  });

  it("does not restore authority at a new redirect target even if it uses the same ETag and length", async () => {
    const a = await fixture(), b = await fixture(), c = await fixture(); const received: IncomingHttpHeaders[] = [];
    const first = b.media("/media/first.mp4", reply());
    const second = c.media("/media/second.mp4", { ...reply(headers => received.push(headers)), body: "UVWXYZ" });
    const gateway: UpstreamReply = { redirectTo: first }; const entry = a.media("/media/entry.mp4", gateway);
    const { app, paths } = await bridge([entry]); const old = await request(app).get(paths[0]!); gateway.redirectTo = second;
    const moved = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(old.headers.etag));
    expect(moved.status).toBe(200); expect(bytes(moved).toString()).toBe("UVWXYZ");
    expect(received.at(-1)?.range).toBeUndefined(); expect(received.at(-1)?.["if-range"]).toBeUndefined();
  });

  it("does not reuse a proof when the source's request requirements change", async () => {
    const upstream = await fixture(); const current = reply();
    current.observeHeaders = headers => { current.body = headers.accept === "video/variant" ? "UVWXYZ" : "abcdef"; };
    const url = upstream.media("/media/selection.mp4", current);
    const registered = vi.spyOn(PlaybackManager.prototype, "register");
    const { app, paths, wire } = await bridge([url]); const old = await request(app).get(paths[0]!);
    registered.mock.calls[0]![0].requestHeaders = { Accept: "video/variant" };
    const changed = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(old.headers.etag));
    expect(changed.status).toBe(200); expect(bytes(changed).toString()).toBe("UVWXYZ"); expect(changed.headers.etag).not.toBe(old.headers.etag);
    expect(wire.at(-1)?.headers.get("If-Range")).toBeNull(); expect(wire.at(-1)?.headers.get("Range")).toBeNull();
  });

  it("does not promote an incomparable Vary selector to byte-continuity authority", async () => {
    const upstream = await fixture(); const url = upstream.media("/media/vary.mp4", { ...reply(), responseHeaders: { ETag: rawTag, Vary: "*" } });
    const { app, paths, wire } = await bridge([url]); const full = await request(app).get(paths[0]!); expect(full.headers.etag).toBeUndefined();
    const range = await request(app).get(paths[0]!).set("Range", "bytes=2-4"); expect(range.status).toBe(206); expect(bytes(range).toString()).toBe("cde");
    const conditional = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", rawTag);
    expect(conditional.status).toBe(200); expect(wire.at(-1)?.headers.get("If-Range")).toBeNull();
  });

  it("does not let a slow older GET overwrite the later representation's validator", async () => {
    let release!: () => void; const bodyGate = new Promise<void>(resolve => { release = resolve; });
    const upstream = await fixture(); const current = { ...reply(), bodyGate };
    let firstRequested!: () => void; const firstSeen = new Promise<void>(resolve => { firstRequested = resolve; });
    current.observeHeaders = () => firstRequested(); const url = upstream.media("/media/race.mp4", current);
    const { app, paths, wire } = await bridge([url], fixtures, { directHttpTimeoutMs: 1_000 });
    const slow = request(app).get(paths[0]!).then(response => response); await firstSeen;
    upstream.media("/media/race.mp4", { ...reply(), body: "UVWXYZ", responseHeaders: { ETag: '"FAKE_CHANGED_15"' } });
    const newer = await request(app).get(paths[0]!); release(); const older = await slow;
    expect(bytes(older).toString()).toBe("abcdef"); expect(bytes(newer).toString()).toBe("UVWXYZ"); expect(older.headers.etag).toBeUndefined();
    const resume = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(newer.headers.etag));
    expect(resume.status).toBe(206); expect(bytes(resume).toString()).toBe("WXY"); expect(wire.at(-1)?.headers.get("If-Range")).toBe('"FAKE_CHANGED_15"');
  });

  it("does not mint a GET representation merely from a newer HEAD observation", async () => {
    const upstream = await fixture(); const current = reply(); const url = upstream.media("/media/head.mp4", current);
    const { app, paths, wire } = await bridge([url]); const head = await request(app).head(paths[0]!); expect(head.headers.etag).toBeUndefined();
    const full = await request(app).get(paths[0]!); current.body = "UVWXYZ"; current.responseHeaders = { ETag: '"FAKE_CHANGED_15"' };
    const changedHead = await request(app).head(paths[0]!); expect(changedHead.headers.etag).toBeUndefined();
    const restart = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag));
    expect(restart.status).toBe(200); expect(bytes(restart).toString()).toBe("UVWXYZ"); expect(wire.at(-1)?.headers.get("If-Range")).toBeNull();
  });

  it("does not issue reusable metadata when token lifetime ends during a response", async () => {
    let now = 1_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const upstream = await fixture(); const current = reply(); const url = upstream.media("/media/expiry.mp4", current);
    const { app, paths, wire } = await bridge([url], fixtures, { httpStreamTokenTtlMs: 100 });
    const full = await request(app).get(paths[0]!); current.observeHeaders = () => { now = 2_000; };
    const expired = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag));
    expect(expired.status).toBe(502); expect(expired.headers.etag).not.toBe(full.headers.etag); expect(bytes(expired).toString()).not.toBe("cde");
    const count = wire.length; const again = await request(app).get(paths[0]!); expect(again.status).toBe(400); expect(wire).toHaveLength(count);
  });

  it.each([undefined, `W/${rawTag}`])("refuses a conditional 206 without matching strong proof", async etag => {
    const upstream = await fixture(); const current = reply(); const url = upstream.media("/media/missing.mp4", current);
    const { app, paths } = await bridge([url]); const full = await request(app).get(paths[0]!);
    current.respectIfRange = false; current.responseHeaders = etag ? { ETag: etag } : {};
    const unsafe = await request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag));
    expect(unsafe.status).toBe(502); expect(bytes(unsafe).toString()).not.toBe("cde");
    const plain = await request(app).get(paths[0]!).set("Range", "bytes=2-4"); expect(plain.status).toBe(206); expect(bytes(plain).toString()).toBe("cde");
  });

  it("refuses a framed continuation when the token expires between headers and first bytes", async () => {
    let now = 1_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const upstream = await fixture(); const url = upstream.media("/media/late-expiry.mp4", reply());
    const { app, paths, wire } = await bridge([url], fixtures, { httpStreamTokenTtlMs: 100 });
    const full = await request(app).get(paths[0]!);
    let release!: () => void; const bodyGate = new Promise<void>(resolve => { release = resolve; });
    upstream.media("/media/late-expiry.mp4", { ...reply(), bodyGate });
    const pending = request(app).get(paths[0]!).set("Range", "bytes=2-4").set("If-Range", String(full.headers.etag)).then(response => response);
    // Observe real response headers while the upstream withholds the framed body.
    await vi.waitFor(() => expect(wire).toHaveLength(2));
    now = 2_000; release();
    const result = await pending;
    expect(result.status).toBe(502); expect(bytes(result).toString()).not.toBe("cde");
  });

  it.each(["bytes=-2", "bytes=2-"])("preserves supported unconditional and conditional seeks (%s)", async range => {
    const upstream = await fixture(); const url = upstream.media("/media/seek.mp4", reply()); const { app, paths } = await bridge([url]);
    const full = await request(app).get(paths[0]!); const expected = range === "bytes=-2" ? "ef" : "cdef";
    for (const conditional of [false, true]) { let call = request(app).get(paths[0]!).set("Range", range); if (conditional) call = call.set("If-Range", String(full.headers.etag)); const result = await call;
      expect(result.status).toBe(206); expect(bytes(result).toString()).toBe(expected); expect(result.headers["content-length"]).toBe(String(expected.length)); }
  });

  it("restarts multipart requests with complete bytes rather than promising unsupported partial integrity", async () => {
    const upstream = await fixture(); const url = upstream.media("/media/multi.mp4", reply()); const { app, paths, wire } = await bridge([url]);
    const result = await request(app).get(paths[0]!).set("Range", "bytes=0-1,4-5");
    expect(result.status).toBe(200); expect(bytes(result).toString()).toBe("abcdef"); expect(wire.at(-1)?.headers.has("Range")).toBe(false);
  });

  it.each(["ab", "abcd"])("rejects an unframed partial body's incorrect length before forwarding bytes", async body => {
    const upstream = await fixture(); const url = upstream.media("/media/chunked.mp4", { body, status: 206, chunked: true, contentType: "video/mp4", responseHeaders: { "Content-Range": "bytes 2-4/6" } });
    const { app, paths } = await bridge([url]); const result = await request(app).get(paths[0]!).set("Range", "bytes=2-4"); expect(result.status).toBe(502); expect(bytes(result).toString()).not.toBe(body);
  });

  it("keeps private binding data out of generic object serialization", async () => {
    const upstream = await fixture(); const url = upstream.media("/media/private.mp4", reply()); const spy = vi.spyOn(PlaybackManager.prototype, "prepare");
    const { app, paths } = await bridge([url]); const full = await request(app).get(paths[0]!); expect(full.status).toBe(200);
    const prepared = await spy.mock.results[0]!.value as PlayableStream;
    expect(JSON.stringify(prepared.representation)).toBe("{}");
  });

  it("does not slice an encoded ignored-Range HLS segment as if it were original media bytes", async () => {
    const upstream = await fixture();
    const segment = upstream.media("/media/encoded.ts", { body: gzipSync("abcdef"), contentType: "video/mp2t", range: "ignore",
      responseHeaders: { "Content-Encoding": "gzip" } });
    const root = upstream.media("/media/encoded.m3u8", { body: `#EXTM3U\n#EXTINF:4,\n${segment}`, contentType: "application/vnd.apple.mpegurl" });
    const { app, paths } = await bridge([root]); const playlist = await request(app).get(paths[0]!);
    const child = new URL(playlist.text.match(/http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/)![0]).pathname;
    const result = await request(app).get(child).set("Range", "bytes=2-4");
    // Existing HLS route classifies unsupported operations as 400; no media continuation is emitted.
    expect(result.status).toBe(400); expect(result.headers["content-range"]).toBeUndefined();
  });
});
