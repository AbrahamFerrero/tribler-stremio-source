import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectTransport, type OutboundTransport } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { effectiveStreamSize } from "../src/streams/details";
import { normalizeStreamSource } from "../src/streams/normalization";
import { rankedStreamDescription, streamSummary } from "../src/streams/presentation";
import { defaultStreamRankingPolicy, parseStreamRankingPolicy } from "../src/streams/ranking-policy";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver, type StreamResolverTrace } from "../src/streams/resolver";
import { scoreStream, streamScoreComponents } from "../src/streams/scoring";
import type { DirectHttpProbeMetadata, NormalizedStreamSource } from "../src/streams/types";
import { fixtureOutboundRequest, silentLogger, testConfig, type FixtureOutboundRequest } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";

const options = { enabled: true, timeoutMs: 5000, maxCandidates: 8, maxConcurrent: 1 };
const source = (name = "opaque.mp4"): NormalizedStreamSource => ({ providerId: "fixture", type: "https",
  url: `https://media.example/${name}`, resolution: "1080p", codec: "H.264" });
const policy = () => new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
const playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n";

function fixture(request: FixtureOutboundRequest, now: () => number, log = silentLogger) {
  const network = vi.fn(fixtureOutboundRequest(request));
  const transport: OutboundTransport = { id: "fixture", request: network,
    diagnostics: () => ({ transport: "fixture", requests: network.mock.calls.length, failures: 0, averageLatencyMs: 0 }) };
  return { probe: new DirectStreamProbe(transport, options, log, now), transport, network };
}

// A reader boundary advances the clock only when the probe consumes bytes.
// A real ReadableStream can prefetch before the response is returned.
function response(bytes: Uint8Array, read: () => void, status = 206, headers: Record<string, string> = {}) {
  let consumed = false;
  const cancel = () => Promise.resolve();
  const body = { getReader: () => ({ cancel, read: () => {
    read();
    const part = consumed ? { done: true as const, value: undefined } : { done: false as const, value: bytes };
    consumed = true;
    return Promise.resolve(part);
  } }), cancel } as unknown as ReadableStream<Uint8Array>;
  return { status, ok: status >= 200 && status < 300, body,
    headers: new Headers({ "Content-Type": "video/mp4", ...(status === 206
      ? { "Content-Range": `bytes 0-${Math.min(63, bytes.length - 1)}/${bytes.length}` } : {}), ...headers }) } as Response;
}

function measured(latency: number | undefined, fields: Partial<DirectHttpProbeMetadata> = {}): NormalizedStreamSource {
  return { ...source(), directHttp: { status: "verified", verified: true, rangeSupported: true,
    ...(latency !== undefined ? { responseHeaderLatencyMs: latency } : {}), ...fields } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("response header latency (synthetic component boundaries)", () => {
  it("captures 206 headers at 100ms before the prefix finishes at 700ms, including logs", async () => {
    let clock = 0;
    const info = vi.fn();
    const { probe, network } = fixture(() => {
      clock = 100;
      return Promise.resolve(response(new Uint8Array(64), () => { clock = 700; }));
    }, () => clock, { ...silentLogger, info });
    const [observed] = await probe.probe([source()]);
    expect(observed!.directHttp).toMatchObject({ status: "verified", responseHeaderLatencyMs: 100 });
    expect(observed!.directHttp).not.toHaveProperty("firstByteLatencyMs");
    expect(clock).toBe(700);
    expect(network).toHaveBeenCalledOnce();
    expect(effectiveStreamSize(observed!)).toBe(64);
    expect(streamScoreComponents(observed!).transport).toBe(43);
    expect(streamSummary(observed!)).toContain("0.1s");
    expect(info).toHaveBeenCalledWith("Direct HTTP probe completed", expect.objectContaining({ responseHeaderLatencyMs: 100 }));
  });

  it("excludes optional MP4 inspection requests from the root header measurement", async () => {
    let clock = 0;
    const bytes = Uint8Array.from(mp4Fixture(4, "tail"));
    const { probe, network } = fixture(({ headers }) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("Range")!)!;
      const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
      clock = start === 0 ? 100 : 700;
      return Promise.resolve(new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
        "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${bytes.length}`
      } }));
    }, () => clock);
    const [observed] = await probe.probe([source()]);
    expect(observed!.directHttp).toMatchObject({ status: "verified", responseHeaderLatencyMs: 100,
      actualRuntimeSeconds: 4, runtimeEvidence: "mp4_mvhd" });
    expect(network.mock.calls.length).toBeGreaterThan(1);
    expect(clock).toBe(700);
  });

  it("keeps root HLS latency at 100ms when playlist and segment verification finish at 700ms", async () => {
    let clock = 0;
    const { probe, network } = fixture(({ url }) => {
      if (url.endsWith(".ts")) {
        clock = 700;
        return Promise.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp2t" } }));
      }
      clock = 100;
      return Promise.resolve(response(new TextEncoder().encode(playlist), () => { clock = 400; }, 200,
        { "Content-Type": "application/vnd.apple.mpegurl" }));
    }, () => clock);
    const [observed] = await probe.probe([source("opaque.m3u8")]);
    expect(observed!.directHttp).toMatchObject({ status: "verified", hls: true, responseHeaderLatencyMs: 100 });
    expect(clock).toBe(700);
    expect(network).toHaveBeenCalledTimes(2);
    expect(streamScoreComponents(observed!).transport).toBe(28);
  });

  it("includes the entire validated redirect chain before the effective response headers", async () => {
    let clock = 0;
    const pinned = vi.fn().mockImplementation(({ url }: { url: URL }) => {
      clock += url.pathname === "/entry.mp4" ? 80 : 120;
      return Promise.resolve(url.pathname === "/entry.mp4"
        ? new Response(null, { status: 302, headers: { Location: "/opaque.mp4" } })
        : response(new Uint8Array(64), () => { clock = 700; }));
    });
    const transport = new DirectTransport(policy(), testConfig().httpPrivacy, silentLogger, pinned);
    const probe = new DirectStreamProbe(transport, options, silentLogger, () => clock);
    const [observed] = await probe.probe([source("entry.mp4")]);
    expect(observed!.directHttp).toMatchObject({ status: "verified", responseHeaderLatencyMs: 200 });
    expect(pinned).toHaveBeenCalledTimes(2);
    expect(streamScoreComponents(observed!).transport).toBe(43);
  });

  it.each([403, 416, 206])("includes Range fallback work for initial HTTP %s", async status => {
    let clock = 0, calls = 0;
    const { probe, network } = fixture(({ headers, url }) => {
      if (url.endsWith(".ts")) {
        clock = 700;
        return Promise.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp2t" } }));
      }
      calls += 1;
      if (calls === 1) {
        clock = 100;
        return Promise.resolve(new Response(null, { status, headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
      }
      expect(new Headers(headers).has("Range")).toBe(false);
      clock = 300;
      return Promise.resolve(new Response(playlist, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
    }, () => clock);
    const [observed] = await probe.probe([source("opaque.m3u8")]);
    expect(observed!.directHttp).toMatchObject({ status: "verified", hls: true, responseHeaderLatencyMs: 300 });
    expect(network).toHaveBeenCalledTimes(3);
    expect(streamScoreComponents(observed!).transport).toBe(13);
  });

  it("reuses the original cached measurement, expires it and separates URL/headers", async () => {
    let clock = 0;
    const now = vi.fn(() => clock);
    const { probe, network } = fixture(() => {
      clock += 100;
      return Promise.resolve(response(new Uint8Array(64), () => { clock += 600; }));
    }, now);
    const input = { ...source(), requestHeaders: { Referer: "https://origin.example/" } };
    const first = (await probe.probe([input]))[0]!;
    expect(first.directHttp?.responseHeaderLatencyMs).toBe(100);
    clock += 119_999;
    const clockReads = now.mock.calls.length;
    const warm = (await probe.probe([input]))[0]!;
    expect(warm.directHttp).toBe(first.directHttp);
    expect(network).toHaveBeenCalledOnce();
    // Cache lookup reads the clock for expiry; it does not start a new measurement.
    expect(now).toHaveBeenCalledTimes(clockReads + 1);
    clock += 1;
    expect((await probe.probe([input]))[0]!.directHttp?.responseHeaderLatencyMs).toBe(100);
    expect(network).toHaveBeenCalledTimes(2);
    await probe.probe([{ ...input, requestHeaders: { Referer: "https://other.example/" } }]);
    await probe.probe([{ ...input, url: `${input.url}?fixture=other` }]);
    expect(network).toHaveBeenCalledTimes(4);
  });

  it.each([NaN, Infinity, -Infinity, -1])("omits an invalid measured duration %s without losing verification", async end => {
    let clock = 10;
    const { probe } = fixture(() => {
      clock = end;
      return Promise.resolve(response(new Uint8Array(64), () => { clock = 700; }));
    }, () => clock);
    const [observed] = await probe.probe([source()]);
    expect(observed!.directHttp?.verified).toBe(true);
    expect(observed!.directHttp).not.toHaveProperty("responseHeaderLatencyMs");
    expect(streamScoreComponents(observed!).transport).toBe(18);
    expect(streamSummary(observed!)).not.toMatch(/\d+\.\ds/);
  });

  it.each(["timeout", "budget_exhausted", "abort"] as const)("preserves %s after headers arrive without spurious latency", async outcome => {
    vi.useFakeTimers();
    let clock = 0;
    const caller = new AbortController();
    const { probe } = fixture((_outbound, signal) => {
      clock = 100;
      const body = { getReader: () => ({ cancel: () => Promise.resolve(), read: () =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason instanceof Error
            ? signal!.reason : new Error("fixture aborted")), { once: true });
          if (outcome === "timeout") reject(new DOMException("fixture timeout", "TimeoutError"));
          if (outcome === "abort") caller.abort(new Error("fixture cancelled"));
        }) }) } as unknown as ReadableStream<Uint8Array>;
      return Promise.resolve({ status: 206, headers: new Headers({ "Content-Range": "bytes 0-63/100" }), body } as Response);
    }, () => clock);
    const pending = probe.probe([source()], caller.signal);
    if (outcome === "abort") await expect(pending).rejects.toThrow("fixture cancelled");
    else {
      if (outcome === "budget_exhausted") await vi.advanceTimersByTimeAsync(options.timeoutMs);
      const [observed] = await pending;
      expect(observed!.directHttp).toMatchObject({ status: outcome, verified: false });
      expect(observed!.directHttp).not.toHaveProperty("responseHeaderLatencyMs");
      expect(streamScoreComponents(observed!).transport).toBe(0);
    }
  });

  it("does not accept provider-supplied header measurements", () => {
    const normalized = normalizeStreamSource({ ...measured(0), responseHeaderLatencyMs: 0 }, "fixture")!;
    expect(normalized.directHttp).toBeUndefined();
    expect(streamScoreComponents(normalized).transport).toBe(0);
  });
});

describe("header latency consumers", () => {
  it.each([[0, 25], [200, 25], [200.01, 10], [1000, 10], [1000.01, 3], [2500, 3], [2500.01, -8]])(
    "uses the unchanged JSON band for %sms", (latency, points) => {
      expect(streamScoreComponents(measured(latency)).transport).toBe(18 + points);
    });

  it.each([undefined, NaN, Infinity, -Infinity, -1])("does not score or display invalid latency %s", latency => {
    const input = measured(latency);
    expect(streamScoreComponents(input).transport).toBe(18);
    expect(streamSummary(input)).not.toMatch(/(?:NaN|Infinity|\d+\.\ds)/);
  });

  it.each(["reachable", "timeout", "budget_exhausted", "unreachable", "unknown"] as const)(
    "%s has no latency or network bonus", status => {
      expect(streamScoreComponents(measured(100, { status, verified: false })).transport).toBe(0);
    });

  it("uses the same measurement in summary, Net and F under the effective JSON policy", () => {
    const custom = structuredClone(defaultStreamRankingPolicy);
    custom.direct.latencyMs[0]!.score = 30;
    custom.quality["1080p"] = 45;
    const input = measured(100);
    for (const ranking of [defaultStreamRankingPolicy, parseStreamRankingPolicy(custom)]) {
      const net = ranking === defaultStreamRankingPolicy ? 43 : 48;
      const total = ranking === defaultStreamRankingPolicy ? 212 : 220;
      expect(streamScoreComponents(input, ranking).transport).toBe(net);
      expect(scoreStream(input, ranking)).toBe(total);
      expect(rankedStreamDescription(input, 1, ranking)).toContain(`Net +${net}`);
      expect(rankedStreamDescription(input, 1, ranking)).toContain(`Score ${total}`);
      expect(streamSummary(input)).toContain("0.1s");
    }
  });

  it("reverses final order only through latency, within the same Identity group, and migrates trace semantics", async () => {
    let clock = 0;
    const durations = new Map<string, number>();
    const { probe } = fixture(({ url }) => {
      const start = clock;
      const slowVerification = url.includes("slow-verification");
      clock += slowVerification ? 100 : 300;
      return Promise.resolve(response(new Uint8Array(64), () => {
        clock = start + (slowVerification ? 2700 : 300);
        durations.set(url, clock - start);
      }));
    }, () => clock);
    const inputs = [source("slow-verification.mp4"), source("fast-verification.mp4")];
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve(inputs) });
    const ranking = vi.fn<NonNullable<StreamResolverTrace["ranking"]>>();
    const resolver = new StreamResolver(registry, policy(), probe, { stage: () => undefined, ranking });
    const final = await resolver.resolve({ id: "synthetic", title: "Synthetic Meridian", kind: "movie", externalIds: {} });
    expect(final.map(getBridgeIdentityState)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(final.map(entry => entry.url)).toEqual(inputs.map(entry => entry.url));
    expect(final.map(entry => entry.directHttp?.responseHeaderLatencyMs)).toEqual([100, 300]);
    expect(streamScoreComponents(final[0]!).transport).toBe(43);
    expect(streamScoreComponents(final[1]!).transport).toBe(28);
    expect(scoreStream(final[0]!) - scoreStream(final[1]!)).toBe(15);
    const historical = final.map(entry => ({ ...entry, directHttp: { ...entry.directHttp!,
      responseHeaderLatencyMs: durations.get(entry.url!)! } }));
    expect(historical.map(entry => streamScoreComponents(entry).transport)).toEqual([10, 28]);
    expect(scoreStream(historical[1]!) - scoreStream(historical[0]!)).toBe(18);
    expect([...historical].sort((a, b) => scoreStream(b) - scoreStream(a)).map(entry => entry.url))
      .toEqual([inputs[1]!.url, inputs[0]!.url]);
    expect(ranking.mock.calls[0]![0].map(entry => entry.responseHeaderLatencyMs)).toEqual([100, 300]);
  });
});
