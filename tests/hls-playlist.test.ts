import { fixtureOutboundRequest, type FixtureOutboundRequest } from "./helpers";
import type { Request, Response as ExpressResponse } from "express";
import { describe, expect, it, vi } from "vitest";
import { proxyDirectHttp } from "../src/automatic-stream";
import { hlsMediaReferences, hlsRequiredDependencies, hlsVodDurationSeconds, isHlsContentType, readHlsPlaylist, rewriteHlsPlaylist } from "../src/hls-playlist";
import { DirectTransport, type OutboundTransport, type PinnedRequest } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { HttpPrivacyPolicy } from "../src/network/http-privacy";
import { MAX_HLS_RESOURCE_ENTRIES, PlaybackManager } from "../src/playback/manager";
import { DirectHttpPlaybackBackend } from "../src/playback/backends";
import { silentLogger } from "./helpers";

const privacy: HttpPrivacyPolicy = {
  mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
  acceptCookies: false, userAgentMode: "minimal", maxRedirects: 3
};

function rewriteOptions(): { options: Parameters<typeof rewriteHlsPlaylist>[2]; validated: string[]; registered: string[]; kinds: string[] } {
  const validated: string[] = [];
  const registered: string[] = [];
  const kinds: string[] = [];
  return {
    options: {
      validateResource: (url) => {
        validated.push(url);
        if (new URL(url).hostname === "127.0.0.1") return Promise.reject(new Error("private resource"));
        return Promise.resolve();
      },
      localResourceUrls: (resources) => resources.map(({ url, kind }) => {
        registered.push(url);
        kinds.push(kind);
        return `http://127.0.0.1:7000/hls/resource-${registered.length}`;
      })
    }, validated, registered, kinds
  };
}

function mediaPlaylist(segments: number): string {
  return `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n${Array.from({ length: segments }, (_, index) =>
    `#EXTINF:4,\nsegments/${index}.m4s`).join("\n")}`;
}

function managedRewriteOptions(manager: PlaybackManager): Parameters<typeof rewriteHlsPlaylist>[2] {
  return {
    validateResource: () => Promise.resolve(),
    localResourceUrls: (resources) => manager.registerHlsResources(resources.map(({ url, kind }) => ({
      url, isMediaSegment: kind === "segment"
    }))).map((token) => `http://127.0.0.1:7000/hls/${token}`)
  };
}

function responseCapture(): { response: ExpressResponse; body: () => string; headers: Headers; status: () => number | undefined } {
  const headers = new Headers();
  const chunks: Buffer[] = [];
  let statusCode: number | undefined;
  const response = {
    setHeader: (name: string, value: string | number) => headers.set(name, String(value)),
    removeHeader: (name: string) => headers.delete(name),
    hasHeader: (name: string) => headers.has(name),
    status: (value: number) => { statusCode = value; return response; },
    write: (value: Uint8Array) => { chunks.push(Buffer.from(value)); return true; },
    end: (value?: string) => { if (value) chunks.push(Buffer.from(value)); }
  } as unknown as ExpressResponse;
  return { response, headers, body: () => Buffer.concat(chunks).toString("utf8"), status: () => statusCode };
}

describe("HLS playlist mediation", () => {
  it("ignores ordinary comments across parsing and resource registration, including URI-looking text", async () => {
    const text = '#EXTM3U\r\n# URI=unquoted FAKE_COMMENT_16\r\n#EXTINF:4,display\r\n'
      + '# URI="http://127.0.0.1/private"\r\na.ts\r\n';
    expect(hlsMediaReferences(text, "https://media.example/live/")).toEqual([{ kind: "segment", url: "https://media.example/live/a.ts" }]);
    const { options, registered, kinds } = rewriteOptions();
    expect(await rewriteHlsPlaylist(text, "https://media.example/live/", options)).toBe('#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1:7000/hls/resource-1\n');
    expect(registered).toEqual(["https://media.example/live/a.ts"]); expect(kinds).toEqual(["segment"]);
  });

  it("empties the entire optional title before URI parsing without interpreting its encoded or quoted text", async () => {
    const text = '#EXTM3U\n#EXTINF:04.250000,URI="http://127.0.0.1/private",%46%41%4b%45,\\u0046AKE\na.ts\n';
    const { options, registered } = rewriteOptions();
    expect(await rewriteHlsPlaylist(text, "https://media.example/", options)).toBe('#EXTM3U\n#EXTINF:04.250000,\nhttp://127.0.0.1:7000/hls/resource-1\n');
    expect(registered).toEqual(["https://media.example/a.ts"]);
  });

  it("preserves functional and unknown metadata and characterizes unresolved variable and additional URL handling", async () => {
    const metadata = '#EXT-X-DEFINE:NAME="path",VALUE="FAKE_VARIABLE_16"\n'
      + '#EXT-X-DATERANGE:ID="event",START-DATE="2026-01-01T00:00:00Z",X-ASSET-LIST="https://other.example/FAKE_LIST_16.json"\n'
      + '#EXT-X-VENDOR:VALUE="FAKE_VENDOR_16",SERVER-URI="https://other.example/control"\n';
    const { options, registered } = rewriteOptions();
    const output = await rewriteHlsPlaylist(`#EXTM3U\n${metadata}#EXTINF:4,\n{$path}.ts`, "https://media.example/", options);
    expect(output).toContain(metadata.replace('SERVER-URI="https://other.example/control"', 'SERVER-URI="http://127.0.0.1:7000/hls/resource-1"'));
    // Existing parser does not perform HLS variable expansion, nor route X-ASSET-LIST.
    expect(registered).toEqual(["https://other.example/control", "https://media.example/%7B$path%7D.ts"]);
    expect(output).toContain('X-ASSET-LIST="https://other.example/FAKE_LIST_16.json"');
  });

  it("keeps EXT-X-BYTERANGE media URIs classified as segments", async () => {
    const playlist = "#EXTM3U\n#EXT-X-VERSION:4\n"
      + "#EXTINF:4,\n#EXT-X-BYTERANGE:188@0\nmedia.ts\n"
      + "#EXTINF:4,\n#EXT-X-BYTERANGE:188@188\nmedia.ts\n";

    expect(hlsMediaReferences(
      playlist,
      "https://media.example/movie/index.m3u8"
    )).toEqual([
      { kind: "segment", url: "https://media.example/movie/media.ts" },
      { kind: "segment", url: "https://media.example/movie/media.ts" }
    ]);

    const { options, kinds } = rewriteOptions();

    await rewriteHlsPlaylist(
      playlist,
      "https://media.example/movie/index.m3u8",
      options
    );

    expect(kinds).toEqual(["segment", "segment"]);
  });

  it("resolves and deduplicates required MAP and KEY dependencies with relative paths", () => {
    const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?key=opaque"\n#EXTINF:4,\na.ts\n'
      + '#EXT-X-MAP:URI="init.mp4?key=opaque"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
      + '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nb.ts\n'
      + '#EXT-X-KEY:METHOD=NONE\n#EXT-X-MAP:URI="next.mp4?key=opaque2"\n#EXTINF:4,\nc.ts\n';
    expect(hlsRequiredDependencies(playlist, "https://media.example/movie/index.m3u8")).toEqual([
      { kind: "map", url: "https://media.example/movie/init.mp4?key=opaque" },
      { kind: "key", url: "https://media.example/movie/key.bin" },
      { kind: "map", url: "https://media.example/movie/next.mp4?key=opaque2" }
    ]);
  });

  it("rejects more than 32 distinct preflight dependencies before any network work", () => {
    const playlist = `#EXTM3U\n${Array.from({ length: 33 }, (_, index) =>
      `#EXT-X-MAP:URI="init-${index}.mp4"\n#EXTINF:4,\nsegment-${index}.ts\n`).join("")}`;
    expect(() => hlsRequiredDependencies(playlist, "https://media.example/movie/index.m3u8"))
      .toThrow(/too many required dependencies/);
  });
  it.each([MAX_HLS_RESOURCE_ENTRIES - 2, MAX_HLS_RESOURCE_ENTRIES - 1])(
    "keeps MAP and edge segments valid for %i media segments at the resource-capacity boundary",
    async (segments) => {
      const manager = new PlaybackManager([]);
      const rewritten = await rewriteHlsPlaylist(mediaPlaylist(segments),
        "https://media.example/movie/index.m3u8", managedRewriteOptions(manager));
      const tokens = [...rewritten.matchAll(/\/hls\/([A-Za-z0-9_-]{32})/g)].map((match) => match[1]!);
      expect(tokens).toHaveLength(segments + 1);
      expect(manager.prepareHlsResource(tokens[0]!).url).toBe("https://media.example/movie/init.mp4");
      expect(manager.prepareHlsResource(tokens[1]!).url).toBe("https://media.example/movie/segments/0.m4s");
      expect(manager.prepareHlsResource(tokens.at(-1)!).url)
        .toBe(`https://media.example/movie/segments/${segments - 1}.m4s`);
    }
  );
  it("measures only complete bounded VOD media playlists", async () => {
    const vod = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:60.5,\na.m4s\n#EXTINF:59.5,\nb.m4s\n#EXT-X-ENDLIST\n";
    expect(hlsVodDurationSeconds(vod)).toBe(120);
    expect(hlsVodDurationSeconds(vod.replace("VOD", "EVENT"))).toBeUndefined();
    expect(hlsVodDurationSeconds(vod.replace("#EXT-X-ENDLIST\n", ""))).toBeUndefined();
    expect(hlsVodDurationSeconds(vod.replace("#EXTINF:59.5,\nb.m4s\n", "#EXTINF:59.5,\n"))).toBeUndefined();
    expect(hlsVodDurationSeconds(vod.replace("#EXTINF:60.5,", "#EXTINF:NaN,"))).toBeUndefined();
    expect(hlsVodDurationSeconds(vod.replace("#EXTINF:60.5,", "#EXTINF:9999,"))).toBeUndefined();
    expect(hlsVodDurationSeconds(vod.replace("#EXTINF:59.5,", "#EXT-X-GAP\n#EXTINF:59.5,"))).toBeUndefined();
    await expect(readHlsPlaylist(new Response(vod).body, undefined, Buffer.byteLength(vod) + 1))
      .rejects.toThrow(/length mismatch/);
  });
  it("keeps a 3546-segment VOD playlist's map and every segment valid after bounded batch registration", async () => {
    const manager = new PlaybackManager([]);
    const oldTokens = Array.from({ length: MAX_HLS_RESOURCE_ENTRIES - 3547 + 1 }, (_, index) =>
      manager.registerHlsResource(`https://media.example/old/${index}.m4s`));
    const rewritten = await rewriteHlsPlaylist(mediaPlaylist(3546), "https://media.example/movie/index.m3u8",
      managedRewriteOptions(manager));
    const tokens = [...rewritten.matchAll(/\/hls\/([A-Za-z0-9_-]{32})/g)].map((match) => match[1]!);
    expect(tokens).toHaveLength(3547);
    expect(manager.prepareHlsResource(tokens[0]!)).toMatchObject({
      url: "https://media.example/movie/init.mp4", hlsMediaSegment: false
    });
    expect(manager.prepareHlsResource(tokens[1]!)).toMatchObject({
      url: "https://media.example/movie/segments/0.m4s", hlsMediaSegment: true
    });
    expect(manager.prepareHlsResource(tokens.at(-1)!)).toMatchObject({
      url: "https://media.example/movie/segments/3545.m4s", hlsMediaSegment: true
    });
    for (const token of tokens) manager.prepareHlsResource(token);
    expect(() => manager.prepareHlsResource(oldTokens[0]!)).toThrow(/unknown or expired/);
    expect(manager.prepareHlsResource(oldTokens[1]!)).toMatchObject({
      url: "https://media.example/old/1.m4s"
    });
  });

  it("rejects an over-capacity playlist before changing existing HLS resources", async () => {
    const manager = new PlaybackManager([]);
    const oldToken = manager.registerHlsResource("https://media.example/old.m4s");
    const capture = responseCapture();
    await expect(proxyDirectHttp({ url: "https://media.example/movie/index.m3u8", fileName: "index.m3u8", size: 0 },
      { headers: {} } as Request, capture.response, 100, new AbortController().signal, "GET",
      { id: "fixture", request: fixtureOutboundRequest(() => Promise.resolve(new Response(mediaPlaylist(MAX_HLS_RESOURCE_ENTRIES), {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { rewritePlaylist: (text, parent) => rewriteHlsPlaylist(text, parent, managedRewriteOptions(manager)) }))
      .rejects.toThrow(/too many resources/);
    expect(capture.status()).toBeUndefined();
    expect(capture.body()).toBe("");
    expect(manager.prepareHlsResource(oldToken).url).toBe("https://media.example/old.m4s");
  });

  it("rewrites a valid media playlist's relative and absolute child resources to local opaque URLs", async () => {
    const { options, validated, registered, kinds } = rewriteOptions();
    const rewritten = await rewriteHlsPlaylist(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?temporary=secret"\n#EXTINF:6,\nsegments/part-01.ts\n#EXT-X-MAP:URI="https://cdn.example/init.mp4"`, "https://media.example/live/index.m3u8", options);
    expect(validated).toEqual([
      "https://media.example/live/keys/key.bin?temporary=secret",
      "https://media.example/live/segments/part-01.ts",
      "https://cdn.example/init.mp4"
    ]);
    expect(registered).toEqual(validated);
    expect(kinds).toEqual(["other", "segment", "other"]);
    expect(rewritten).toContain('URI="http://127.0.0.1:7000/hls/resource-1"');
    expect(rewritten).toContain("http://127.0.0.1:7000/hls/resource-2");
    expect(rewritten).not.toContain("media.example");
    expect(rewritten).not.toContain("temporary=secret");
  });

  it("rewrites master and nested media playlist references", async () => {
    const master = rewriteOptions();
    const masterText = await rewriteHlsPlaylist(`#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariants/low.m3u8`, "https://media.example/master.m3u8", master.options);
    expect(master.validated).toEqual(["https://media.example/subs/en.m3u8", "https://media.example/variants/low.m3u8"]);
    expect(masterText).not.toContain("variants/low.m3u8");

    const child = rewriteOptions();
    await expect(rewriteHlsPlaylist(`#EXTM3U\n#EXTINF:4,\nchunk.ts`, master.validated[1]!, child.options)).resolves.toContain("/hls/resource-1");
    expect(child.validated).toEqual(["https://media.example/variants/chunk.ts"]);
  });

  it("fails closed for malformed, unsafe, and private child references", async () => {
    const { options } = rewriteOptions();
    await expect(rewriteHlsPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=unquoted", "https://media.example/a.m3u8", options))
      .rejects.toThrow(/invalid|malformed/i);
    await expect(rewriteHlsPlaylist("#EXTM3U\n#EXTINF:4,\njavascript:alert(1)", "https://media.example/a.m3u8", options))
      .rejects.toThrow(/scheme/i);
    await expect(rewriteHlsPlaylist("#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1/private.ts", "https://media.example/a.m3u8", options))
      .rejects.toThrow(/private/i);
    const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
    await expect(rewriteHlsPlaylist("#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1/private.ts", "https://media.example/a.m3u8", {
      validateResource: async (url) => { await policy.validate(url); },
      localResourceUrls: (resources) => resources.map(() => "http://127.0.0.1:7000/hls/token")
    })).rejects.toThrow(/private|reserved/i);
  });

  it("recognizes only a real HLS header and rejects malformed playlist bodies", async () => {
    expect(isHlsContentType("application/vnd.apple.mpegurl")).toBe(true);
    expect(isHlsContentType("video/mp4")).toBe(false);
    await expect(readHlsPlaylist(new Response("#EXTM3U\n#EXTINF:4,\nchunk.ts").body)).resolves.toContain("#EXTM3U");
    await expect(readHlsPlaylist(new Response("not a playlist").body)).rejects.toThrow(/invalid/i);
    await expect(rewriteHlsPlaylist("#EXTM3U\nnot-a-valid-resource-line", "https://media.example/a.m3u8", rewriteOptions().options))
      .rejects.toThrow(/invalid/i);
  });

  it("keeps normal direct Range forwarding unchanged while allowing an HLS playlist without Range", async () => {
    const request = vi.fn<FixtureOutboundRequest>()
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:4,\nchunk.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2, 3]), {
        status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 2-3/9" }
      }));
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const hls = rewriteOptions();
    const hlsResponse = responseCapture();
    await proxyDirectHttp({ url: "https://media.example/index.m3u8", fileName: "index.m3u8", size: 0 },
      { headers: { range: "bytes=0-0" } } as Request, hlsResponse.response, 100, new AbortController().signal, "GET", transport,
      { rewritePlaylist: (text, parent) => rewriteHlsPlaylist(text, parent, hls.options) });
    expect(hlsResponse.status()).toBe(200);
    expect(hlsResponse.body()).toContain("/hls/resource-1");

    const mp4Response = responseCapture();
    await proxyDirectHttp({ url: "https://media.example/video.mp4", fileName: "video.mp4", size: 9 },
      { headers: { range: "bytes=2-3" } } as Request, mp4Response.response, 100, new AbortController().signal, "GET", transport,
      { rewritePlaylist: (text, parent) => rewriteHlsPlaylist(text, parent, hls.options) });
    expect(mp4Response.status()).toBe(206);
    expect(mp4Response.headers.get("content-range")).toBe("bytes 2-3/9");
    expect(mp4Response.body()).toBe(Buffer.from([2, 3]).toString("utf8"));
  });

  it("proxies an HLS media segment normally when its origin honors Range", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array([2, 3]), {
      status: 206, headers: { "Content-Type": "video/mp2t", "Content-Range": "bytes 2-3/6" }
    }));
    const capture = responseCapture();
    await proxyDirectHttp({ url: "https://media.example/chunk.ts", fileName: "chunk.ts", size: 0 },
      { headers: { range: "bytes=2-3" } } as Request, capture.response, 100, new AbortController().signal, "GET",
      { id: "fixture", request: fixtureOutboundRequest(request), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { rewritePlaylist: (text) => Promise.resolve(text), mediaSegment: true });
    expect(capture.status()).toBe(206);
    expect(capture.headers.get("content-range")).toBe("bytes 2-3/6");
    expect(capture.body()).toBe(Buffer.from([2, 3]).toString("utf8"));
  });

  it("satisfies an HLS media segment Range locally when its origin returns the complete segment", async () => {
    const capture = responseCapture();
    await proxyDirectHttp({ url: "https://media.example/chunk.ts", fileName: "chunk.ts", size: 0 },
      { headers: { range: "bytes=2-4" } } as Request, capture.response, 100, new AbortController().signal, "GET",
      { id: "fixture", request: fixtureOutboundRequest(() => Promise.resolve(new Response("abcdef", {
        status: 200, headers: { "Content-Type": "video/mp2t" }
      }))), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { rewritePlaylist: (text) => Promise.resolve(text), mediaSegment: true });
    expect(capture.status()).toBe(206);
    expect(capture.headers.get("content-range")).toBe("bytes 2-4/6");
    expect(capture.headers.get("content-length")).toBe("3");
    expect(capture.body()).toBe("cde");
  });

  it("returns 416 for an unsatisfiable HLS media segment Range", async () => {
    const capture = responseCapture();
    await proxyDirectHttp({ url: "https://media.example/chunk.ts", fileName: "chunk.ts", size: 0 },
      { headers: { range: "bytes=10-20" } } as Request, capture.response, 100, new AbortController().signal, "GET",
      { id: "fixture", request: fixtureOutboundRequest(() => Promise.resolve(new Response("abcdef", { status: 200 }))),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { rewritePlaylist: (text) => Promise.resolve(text), mediaSegment: true });
    expect(capture.status()).toBe(416);
    expect(capture.headers.get("content-range")).toBe("bytes */6");
    expect(capture.body()).toBe("");
  });

  it("rejects an oversized complete HLS segment instead of buffering it", async () => {
    const capture = responseCapture();
    await expect(proxyDirectHttp({ url: "https://media.example/chunk.ts", fileName: "chunk.ts", size: 0 },
      { headers: { range: "bytes=0-1" } } as Request, capture.response, 100, new AbortController().signal, "GET",
      { id: "fixture", request: fixtureOutboundRequest(() => Promise.resolve(new Response("small", {
        status: 200, headers: { "Content-Length": String(32 * 1024 * 1024 + 1) }
      }))), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { rewritePlaylist: (text) => Promise.resolve(text), mediaSegment: true })).rejects.toThrow(/too large/i);
  });

  it("keeps ordinary direct-file Range semantics strict when an origin returns 200", async () => {
    const capture = responseCapture();
    await expect(proxyDirectHttp({ url: "https://media.example/video.mp4", fileName: "video.mp4", size: 0 },
      { headers: { range: "bytes=2-4" } } as Request, capture.response, 100, new AbortController().signal, "GET",
      { id: "fixture", request: fixtureOutboundRequest(() => Promise.resolve(new Response("abcdef", { status: 200 }))),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { rewritePlaylist: (text) => Promise.resolve(text) })).rejects.toThrow(/did not honor/i);
  });

  it("passes source headers through direct playback and rewritten HLS child requests", async () => {
    const required = { Referer: "https://site.example/watch", Accept: "video/mp4" };
    const seen: Array<Parameters<OutboundTransport["request"]>[0]> = [];
    const transport: OutboundTransport = {
      id: "fixture", diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }),
      request: fixtureOutboundRequest((request) => {
        seen.push(request);
        return Promise.resolve(request.url.endsWith(".m3u8")
          ? new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts", {
            status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
          })
          : new Response(new Uint8Array([1, 2, 3]), {
            status: 200, headers: { "Content-Type": "video/mp2t" }
          }));
      })
    };
    const manager = new PlaybackManager([]);
    const root = responseCapture();
    await proxyDirectHttp({ url: "https://media.example/root.m3u8", fileName: "root.m3u8",
      size: 0, requestHeaders: required }, { headers: {} } as Request, root.response, 100,
    new AbortController().signal, "GET", transport, {
      rewritePlaylist: (text, parent, sourceHeaders, scope) => rewriteHlsPlaylist(text, parent, {
        validateResource: () => Promise.resolve(),
        localResourceUrls: (resources) => manager.registerHlsResources(resources.map(({ url, kind }) => ({
          url, isMediaSegment: kind === "segment"
        })), sourceHeaders, scope).map((token) => "http://127.0.0.1:7000/hls/" + token)
      })
    });
    const localUrl = root.body().match(/http:\/\/127\.0\.0\.1:7000\/hls\/[A-Za-z0-9_-]{32}/)?.[0];
    expect(localUrl).toBeDefined();
    expect(localUrl).not.toContain("site.example");
    const child = manager.prepareHlsResource(localUrl!.split("/").at(-1)!);
    expect(child.requestHeaders).toEqual(required);
    expect(child.sourceHeaderScope?.origin).toBe("https://media.example");
    await proxyDirectHttp({ url: child.url!, fileName: "segment.ts", size: 0,
      requestHeaders: child.requestHeaders!, sourceHeaderScope: child.sourceHeaderScope! }, { headers: {} } as Request, responseCapture().response,
    100, new AbortController().signal, "GET", transport);
    expect(seen.map((request) => request.sourceHeaders)).toEqual([required, required]);
  });

  it("keeps child redirects under the same validated transport and stores only opaque local tokens", async () => {
    const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
    const pinned = vi.fn<PinnedRequest>().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "http://127.0.0.1/private.ts" }
    }));
    const transport = new DirectTransport(policy, privacy, silentLogger, pinned);
    await expect(transport.request({ url: "https://cdn.example/chunk.ts", method: "GET" })).rejects.toThrow(/private|reserved/);
    expect(pinned).toHaveBeenCalledOnce();

    const playback = new PlaybackManager([new DirectHttpPlaybackBackend(transport)]);
    const token = playback.registerHlsResource("https://cdn.example/chunk.ts?temporary=secret");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(playback.prepareHlsResource(token).url).toContain("temporary=secret");
  });
});


describe("redirected HLS playback base", () => {
  it.each([
    ["root", "https://entry.example/redirect?token=hidden", "https://cdn.example/show/master.m3u8"],
    ["child", "https://cdn.example/show/child", "https://media.example/variant/index.m3u8"],
    ["source extension", "https://entry.example/master.m3u8", "https://cdn.example/hls/manifest"]
  ])("rewrites a redirected %s playlist against its validated final URL", async (_kind, original, effectiveUrl) => {
    const rewrite = rewriteOptions();
    const capture = responseCapture();
    const transport: OutboundTransport = {
      id: "fixture",
      request: () => Promise.resolve({
        response: new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts?key=upstream-secret", {
          status: 200, headers: { "Content-Type": "application/octet-stream" }
        }),
        effectiveUrl
      }),
      diagnostics: () => ({ transport: "fixture", requests: 1, failures: 0, averageLatencyMs: 0 })
    };
    await proxyDirectHttp({ url: original, fileName: "playlist", size: 0,
      requestHeaders: { Referer: "https://site.example/private-header-value" } },
    { headers: {} } as Request, capture.response, 100, new AbortController().signal, "GET",
    transport, { rewritePlaylist: (body, parent) => rewriteHlsPlaylist(body, parent, rewrite.options) });
    expect(rewrite.registered).toEqual([new URL("segment.ts?key=upstream-secret", effectiveUrl).toString()]);
    expect(capture.body()).toContain("/hls/resource-1");
    expect(capture.body()).not.toContain("upstream-secret");
    expect(capture.body()).not.toContain("private-header-value");
    expect(capture.body()).not.toContain(effectiveUrl);
    expect(capture.status()).toBe(200);
  });
});
