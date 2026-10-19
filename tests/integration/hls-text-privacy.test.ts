import request from "../http-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirtyUpstream, type UpstreamReply } from "../acceptance/dirty-upstream";
import { createApp } from "../../src/app";
import type { CatalogProvider } from "../../src/catalog/types";
import type { TriblerClient } from "../../src/tribler-client";
import { DirectTransport } from "../../src/network/outbound-transport";
import { ExternalUrlPolicy, requestPinned } from "../../src/network/url-policy";
import { hlsMediaReferences, hlsVodDurationSeconds } from "../../src/hls-playlist";
import { silentLogger, testConfig } from "../helpers";

const fixtures: DirtyUpstream[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });
const localUrl = /http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/g;
const normalized = (text: string): string => text.replace(localUrl, "LOCAL");
const urls = (text: string): string[] => [...text.matchAll(localUrl)].map(match => new URL(match[0]).pathname);

async function setup() {
  const upstream = new DirtyUpstream(); fixtures.push(upstream); await upstream.listen();
  const requiredHeaders = { "user-agent": "Mozilla/5.0" };
  const media = (path: string, reply: UpstreamReply): string => upstream.media(path, { ...reply, requiredHeaders });
  const segment = media("/media/segment.ts", { body: "abcdef", contentType: "video/mp2t", range: "honor", requiredQuery: "?signature=FAKE_RESOURCE_16" });
  const signedSegment = `${segment}?signature=FAKE_RESOURCE_16`;
  upstream.allowMediaUrl(signedSegment);
  const key = media("/media/key.bin", { body: Buffer.alloc(16, 7), contentType: "application/octet-stream" });
  const map = media("/media/init.mp4", { body: "synthetic-init", contentType: "video/mp4" });
  const body = `#EXTM3U\n#EXT-X-VERSION:6\n# ordinary FAKE_COMMENT_16 https://private.example/?signed=16\n`
    + `#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:37\n#EXT-X-DISCONTINUITY-SEQUENCE:2\n#EXT-X-PLAYLIST-TYPE:VOD\n`
    + `#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n#EXT-X-KEY:METHOD=AES-128,URI="${key}",IV=0x00000000000000000000000000000025\n`
    + `#EXT-X-MAP:URI="${map}",BYTERANGE="14@0"\n#EXTINF:4.250000,FAKE_TITLE_16,%46%41%4b%45,https://private.example/?signed=16\n`
    + `#EXT-X-BYTERANGE:6@0\n${signedSegment}\n#EXT-X-ENDLIST\n`;
  const videoReply: UpstreamReply = { body, contentType: "application/vnd.apple.mpegurl", range: "ignore", responseHeaders: { ETag: '"FAKE_PLAYLIST_ETAG_16"' } };
  const video = media("/media/video.mp4", videoReply);
  // media() copies reply fields; retain a registered mutable live reply separately.
  const liveReply: UpstreamReply = { ...videoReply, requiredHeaders };
  const live = upstream.media("/media/live.mp4", liveReply);
  const audio = media("/media/audio.m3u8", { body: body.replace("4.250000", "4.000000"), contentType: "application/vnd.apple.mpegurl" });
  const session = media("/media/session.json", { body: '{"display":"FAKE_SESSION_BODY_16"}', contentType: "application/json" });
  const masterBody = `#EXTM3U\n# master FAKE_MASTER_COMMENT_16\n`
    + `#EXT-X-SESSION-DATA:DATA-ID="org.example.display",VALUE="FAKE_SESSION_VALUE_16"\n`
    + `#EXT-X-SESSION-DATA:DATA-ID="org.example.external",URI="${session}"\n`
    + `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="FAKE_AUDIO_NAME_16",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="${audio}"\n`
    + `#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="audio"\n${video}\n`;
  const master = media("/media/master.mp4", { body: masterBody, contentType: "application/vnd.apple.mpegurl" });
  const catalog: CatalogProvider = {
    definition: { id: "text-privacy", type: "movie", name: "Synthetic HLS" }, owns: id => id === "synthetic:hls-text",
    list: () => Promise.resolve([]), get: () => Promise.resolve({ id: "synthetic:hls-text", type: "movie", name: "Synthetic HLS" }),
    getDirectStreams: () => Promise.resolve([video, master, live].map(url => ({ url, fileName: "fixture.mp4", size: 0 }))),
    supportsTriblerFallback: () => Promise.resolve(false), getTorrentSource: () => Promise.reject(new Error("No fixture torrent"))
  };
  const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = testConfig({ managedDownloadsStateFile: ".cache/pr16-unused-state.json" });
  const destinations: string[] = [];
  const transport = new DirectTransport(policy, config.httpPrivacy, silentLogger, (target, init) => {
    destinations.push(target.url.href); return requestPinned(target, init);
  });
  const { app } = createApp(config, log, { listDownloads: () => Promise.resolve([]) } as unknown as TriblerClient, catalog, policy, transport);
  const discovery = await request(app).get("/stream/movie/synthetic%3Ahls-text.json");
  expect(discovery.status).toBe(200);
  const paths = (discovery.body as { streams: Array<{ url: string }> }).streams.map(stream => new URL(stream.url).pathname);
  expect(paths).toHaveLength(3);
  const expectedBody = body.replace(key, "LOCAL").replace(map, "LOCAL").replace(signedSegment, "LOCAL");
  const expectedMaster = masterBody.replace(session, "LOCAL").replace(audio, "LOCAL").replace(video, "LOCAL");
  return { app, upstream, paths, body, expectedBody, expectedMaster, liveReply, destinations, log };
}

describe("HLS text privacy through protected public routes", () => {
  it("minimizes exact source and nested video/audio text while preserving dependencies, bytes and HTTP behavior", async () => {
    const { app, upstream, paths, expectedBody, expectedMaster, liveReply, destinations, log } = await setup();
    const source = await request(app).get(paths[0]!);
    const master = await request(app).get(paths[1]!);
    expect(master.status, JSON.stringify(upstream.hits)).toBe(200);
    const children = urls(master.text);
    expect(children).toHaveLength(3);
    const audio = await request(app).get(children[1]!);
    const video = await request(app).get(children[2]!);
    const expected = expectedBody.split("\n").filter(line => !line.startsWith("# ordinary"))
      .map(line => line.startsWith("#EXTINF:") ? line.slice(0, line.indexOf(",") + 1) : line).join("\n");
    // Check functional behavior before RED privacy assertions, on the actual baseline.
    for (const playlist of [source, video, audio]) {
      expect(playlist.status).toBe(200);
      expect(playlist.headers["cache-control"]).toBe("no-store");
      expect(playlist.headers.etag).toBeUndefined();
      expect(playlist.headers["content-length"]).toBe(String(Buffer.byteLength(playlist.text)));
      expect(playlist.text).not.toContain("FAKE_RESOURCE_16");
      const resources = urls(playlist.text); expect(resources).toHaveLength(3);
      const key = await request(app).get(resources[0]!); expect(key.status).toBe(200); expect(key.body).toEqual(Buffer.alloc(16, 7));
      const map = await request(app).get(resources[1]!); expect(map.status).toBe(200); expect(map.body).toEqual(Buffer.from("synthetic-init"));
      const segment = await request(app).get(resources[2]!); expect(segment.status).toBe(200); expect(segment.body).toEqual(Buffer.from("abcdef"));
      const range = await request(app).get(resources[2]!).set("Range", "bytes=2-4");
      expect(range.status).toBe(206); expect(range.body).toEqual(Buffer.from("cde")); expect(range.headers["content-range"]).toBe("bytes 2-4/6");
      const head = await request(app).head(resources[2]!); expect(head.status).toBe(200); expect(head.headers["content-length"]).toBe("6");
    }
    const session = await request(app).get(children[0]!); expect(session.status).toBe(200); expect(session.body).toEqual({ display: "FAKE_SESSION_BODY_16" });
    const head = await request(app).head(paths[0]!); expect(head.status).toBe(200); expect(head.text).toBeUndefined(); expect(head.headers["content-length"]).toBeUndefined();
    const rangedPlaylist = await request(app).get(paths[0]!).set("Range", "bytes=0-10");
    expect(rangedPlaylist.status).toBe(200); expect(normalized(rangedPlaylist.text)).toBe(normalized(source.text));
    expect(destinations.every(url => upstream.allowedMediaUrls().includes(url))).toBe(true);
    expect(upstream.hits).toHaveLength(22);
    liveReply.body = '#EXTM3U\n#EXTINF:4,FAKE_ERROR_TITLE_16\nhttp://127.0.0.1:1/private?signature=FAKE_ERROR_LOCATOR_16';
    const failed = await request(app).get(paths[2]!); expect(failed.status).toBe(502);
    const diagnostics = await request(app).get("/providers"); expect(diagnostics.status).toBe(200);
    expect(JSON.stringify([failed.body, diagnostics.body, ...Object.values(log).map(method => method.mock.calls)])).not.toContain("FAKE_");
    expect(upstream.hits).toHaveLength(23); // One failed playlist; no request to its forbidden child.
    expect(hlsVodDurationSeconds(source.text)).toBe(4.25);
    expect(hlsMediaReferences(source.text, "http://player.example/")).toHaveLength(1);
    expect.soft(normalized(source.text)).toBe(expected);
    expect.soft(normalized(video.text)).toBe(expected);
    expect.soft(normalized(audio.text)).toBe(expected.replace("4.250000", "4.000000"));
    expect.soft(normalized(master.text)).toBe(expectedMaster.replace("# master FAKE_MASTER_COMMENT_16\n", ""));
  });

  it("minimizes live reloads without altering sequence, discontinuity, duration or request budgets", async () => {
    const { app, upstream, paths, liveReply, body } = await setup();
    liveReply.body = body.replace("#EXT-X-PLAYLIST-TYPE:VOD\n", "").replace("#EXT-X-ENDLIST\n", "");
    const first = await request(app).get(paths[2]!);
    liveReply.body = String(liveReply.body).replace("MEDIA-SEQUENCE:37", "MEDIA-SEQUENCE:38").replace("4.250000", "4.125000");
    const next = await request(app).get(paths[2]!);
    expect(first.status).toBe(200); expect(next.status).toBe(200);
    expect(next.text).toContain("#EXT-X-MEDIA-SEQUENCE:38\n#EXT-X-DISCONTINUITY-SEQUENCE:2");
    expect(hlsVodDurationSeconds(next.text)).toBeUndefined();
    expect(upstream.hits).toHaveLength(2);
    expect.soft(first.text).toContain("#EXTINF:4.250000,\n");
    expect.soft(next.text).toContain("#EXTINF:4.125000,\n");
    expect.soft(first.text + next.text).not.toContain("FAKE_COMMENT_16");
  });
});
