import { describe, expect, it, vi } from "vitest";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { normalizeStreamSource } from "../src/streams/normalization";
import { streamSummary, rankedStreamDescription } from "../src/streams/presentation";
import { loadStreamRankingPolicy } from "../src/streams/ranking-policy";
import { scoreStream, streamScoreComponents } from "../src/streams/scoring";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { effectiveStreamSize } from "../src/streams/details";
import { fixtureOutboundRequest, silentLogger, type FixtureOutboundRequest } from "./helpers";
import type { NormalizedStreamSource } from "../src/streams/types";

const mib = 1024 ** 2;
const total = 814 * mib;
const source: NormalizedStreamSource = { providerId: "fixture", type: "https",
  url: "https://media.example/video.mkv", resolution: "1080p" };
const policy = loadStreamRankingPolicy();
policy.quality["1080p"] = 90;

function setup(response: () => Response) {
  const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(response()));
  const probe = new DirectStreamProbe({ id: "fixture", request: fixtureOutboundRequest(request),
    diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
  { enabled: true, timeoutMs: 500, maxCandidates: 8, maxConcurrent: 1 }, silentLogger, () => 0);
  return { request, probe };
}

function range(headers: Record<string, string> = {}, length = 64) {
  return new Response(new Uint8Array(length), { status: 206, headers: {
    "Content-Type": "video/x-matroska", "Content-Range": `bytes 0-63/${total}`,
    "Content-Length": "64", ...headers
  } });
}

describe("effective audiovisual size", () => {
  it("uses a coherent verified 206 total in the summary, scorer and F with the effective JSON policy", async () => {
    const { probe, request } = setup(() => range());
    const [observed] = await probe.probe([source]);
    const stream = { ...observed!, directHttp: { ...observed!.directHttp!, responseHeaderLatencyMs: 700 } };
    expect(stream.sizeBytes).toBeUndefined();
    expect(stream.directHttp.observedSizeBytes).toBe(total);
    expect(streamSummary(stream)).toBe("HTTPS✓ · 1080p · 814MiB · 0.7s");
    expect(streamScoreComponents(stream, policy).size).toBe(2);
    expect(scoreStream(stream, policy)).toBe(240);
    expect(rankedStreamDescription(stream, 1, policy)).toBe(
      "#1 · Score 240\nAvail +120 · Res +90 · Size +2 · Codec +0 · Meta +0 · Net +28");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid range", { "Content-Range": "bytes 1-63/100" }, 63],
    ["range exceeds existing requested boundary", { "Content-Range": `bytes 0-127/${total}` }, 64],
    ["unsafe total", { "Content-Range": "bytes 0-63/9007199254740992" }, 64],
    ["contradictory length", { "Content-Length": "65" }, 64],
    ["malformed length", { "Content-Length": "unknown" }, 64],
    ["encoded", { "Content-Encoding": "gzip" }, 64],
    ["empty encoding", { "Content-Encoding": "" }, 64],
    ["empty body", {}, 0],
    ["short prefix", {}, 3],
    ["prefix exceeds interval", { "Content-Range": `bytes 0-0/${total}`, "Content-Length": "1" }, 64]
  ] as const)("does not promote %s to an audiovisual size", async (_name, headers, length) => {
    const { probe, request } = setup(() => range(headers, length));
    const [stream] = await probe.probe([source]);
    expect(streamScoreComponents(stream!).size).toBe(0);
    expect(streamSummary(stream!)).not.toMatch(/MiB|GiB|MB|GB/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("accepts absent Content-Length and identity encoding with a bounded prefix", async () => {
    const { probe } = setup(() => {
      const response = range({ "Content-Encoding": "identity" });
      response.headers.delete("content-length");
      return response;
    });
    expect(streamScoreComponents((await probe.probe([source]))[0]!).size).toBe(2);
  });

  it("keeps unverified 200 Content-Length diagnostic only", async () => {
    const { probe } = setup(() => new Response(new Uint8Array(64), {
      headers: { "Content-Type": "video/mp4", "Content-Length": String(total) }
    }));
    const [stream] = await probe.probe([source]);
    expect(stream!.directHttp).toMatchObject({ verified: false, observedSizeBytes: total });
    expect(streamScoreComponents(stream!).size).toBe(0);
    expect(streamSummary(stream!)).not.toContain("814");
  });

  it("never uses playlist length, while preserving an explicit provider size", async () => {
    const playlist = "#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
    const { probe, request } = setup(() => new Response(playlist, { headers: {
      "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": String(playlist.length)
    } }));
    request.mockImplementation(({ url }) => Promise.resolve(url.endsWith(".ts")
      ? new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp2t" } })
      : new Response(playlist, { headers: { "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Length": String(playlist.length) } })));
    const [stream] = await probe.probe([{ ...source, url: "https://media.example/index.m3u8" }]);
    expect(stream!.directHttp).toMatchObject({ status: "verified", hls: true, observedSizeBytes: playlist.length });
    expect(streamScoreComponents(stream!).size).toBe(0);
    expect(effectiveStreamSize(stream!)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    const hls = { ...source, directHttp: { status: "verified" as const, verified: true,
      rangeSupported: false, hls: true, observedSizeBytes: total } };
    expect(streamSummary(hls)).not.toContain("814");
    expect(streamScoreComponents(hls).size).toBe(0);
    expect(streamSummary({ ...hls, sizeBytes: 20 * 1024 ** 3 })).toContain("20.0GiB");
  });

  it("retains declared precedence and separates conflicting observations", async () => {
    const { probe } = setup(() => range());
    const [stream] = await probe.probe([{ ...source, sizeBytes: 20 * 1024 ** 3 }]);
    expect(stream!.sizeBytes).toBe(20 * 1024 ** 3);
    expect(stream!.directHttp!.observedSizeBytes).toBe(total);
    expect(streamSummary(stream!)).toContain("20.0GiB");
    expect(streamScoreComponents(stream!).size).toBeCloseTo(12 - Math.log2(20 / 16) * 32);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "treats invalid declared size %s as unknown", (sizeBytes) => {
      for (const type of ["https", "magnet"] as const) {
        const stream = { ...source, type, sizeBytes };
        expect(streamScoreComponents(stream).size).toBe(0);
        expect(streamSummary(stream)).not.toMatch(/MiB|GiB|MB|GB/);
      }
    });

  it("does not accept provider-supplied probe evidence", () => {
    const normalized = normalizeStreamSource({ ...source, directHttp: { status: "verified", verified: true,
      rangeSupported: true, responseStatus: 206, observedSizeBytes: total, sizeEvidence: "initial_range_206" }
    }, "fixture")!;
    expect(normalized.directHttp).toBeUndefined();
    expect(streamScoreComponents(normalized).size).toBe(0);
  });

  it("requires explicit evidence and a successful probe, even for legacy verified observations", async () => {
    const { probe } = setup(() => range());
    const [stream] = await probe.probe([source]);
    const evidence = stream!.directHttp!;
    expect(evidence.sizeEvidence).toBe("initial_range_206");
    for (const fields of [{}, { verified: false },
      { status: "timeout" as const }, { responseStatus: 200 }, { rangeSupported: false },
      { hls: true }, { archiveFormat: "zip" as const }, { documentFormat: "html" as const },
      { observedSizeBytes: 0 }, { observedSizeBytes: 0.5 }, { observedSizeBytes: Infinity }]) {
      const invalid = { ...stream!, directHttp: { ...evidence, ...fields } };
      if (Object.keys(fields).length === 0) delete invalid.directHttp.sizeEvidence;
      expect(effectiveStreamSize(invalid)).toBeUndefined();
      expect(streamScoreComponents(invalid).size).toBe(0);
      expect(streamSummary(invalid)).not.toMatch(/MiB|GiB/);
    }
    expect(effectiveStreamSize({ ...stream!, sizeBytes: -1 })).toBe(total);
    expect(effectiveStreamSize({ ...stream!, type: "torrent" })).toBeUndefined();
  });

  it.each([false, true])("breaks equal scores by effective size, including declared precedence=%s", async (declared) => {
    const sizes = declared ? [total, 900 * mib] : [900 * mib, total];
    let index = 0;
    const { probe, request } = setup(() => range({ "Content-Range": `bytes 0-63/${sizes[index++]}` }));
    const registry = new StreamProviderRegistry(500, silentLogger);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => Promise.resolve(sizes.map((_, i) => ({ ...source, url: `https://media.example/${i}.mkv`,
        ...(declared && i === 0 ? { sizeBytes: 1024 ** 3 } : {}) }))) });
    const urlPolicy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
    const streams = await new StreamResolver(registry, urlPolicy, probe, undefined, policy).resolve({
      id: "synthetic", kind: "movie", title: "Synthetic", externalIds: {}
    });
    expect(streams.map(s => s.url)).toEqual(["https://media.example/1.mkv", "https://media.example/0.mkv"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
