import { describe, expect, it, vi } from "vitest";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StreamProviderRegistry, StreamResolver, getBridgeIdentityState } from "../src/streams/resolver";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { OutboundTransport } from "../src/network/outbound-transport";
import type { NormalizedStreamSource } from "../src/streams/types";
import { fixtureOutboundRequest, silentLogger, type FixtureOutboundRequest } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";

const source = (name: string, providerId = "a"): NormalizedStreamSource => ({
  providerId, type: "https", url: `https://media.example/${name}.mp4`
});
const verified = () => new Response(new Uint8Array([1]), {
  status: 206, headers: { "Content-Range": "bytes 0-0/100", "Content-Type": "video/mp4" }
});
function fixture(request: FixtureOutboundRequest, options = { maxCandidates: 48, maxConcurrent: 32, timeoutMs: 4000 },
  now: () => number = Date.now) {
  const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
    diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
  return new DirectStreamProbe(transport, { enabled: true, ...options }, silentLogger, now);
}

describe("cache-first direct probing (synthetic component fixtures)", () => {
  it("recovers HTTP and HTTPS beyond the cut while retaining all 48 new slots and provider turns", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(verified()));
    const probe = fixture(request);
    const cached = [source("cached-https"), { ...source("cached-http"), type: "http" as const,
      url: "http://media.example/cached-http.mp4" }];
    await probe.probe(cached);
    request.mockClear();
    const fresh = Array.from({ length: 49 }, (_, index) => source(`fresh-${index}`, index < 25 ? "a" : "b"));
    const input = [...fresh, ...cached];
    const starts = vi.fn();
    const output = await probe.probe(input, undefined, undefined, starts);
    expect(output.slice(-2).map(entry => entry.directHttp?.status)).toEqual(["verified", "verified"]);
    expect(output.slice(0, 49).filter(entry => entry.directHttp?.verified)).toHaveLength(48);
    expect(output[24]?.directHttp).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(48);
    expect(starts).toHaveBeenCalledTimes(48);
    expect(starts.mock.calls.slice(0, 4)).toEqual([["a"], ["b"], ["a"], ["b"]]);
    expect(output.map(entry => entry.url)).toEqual(input.map(entry => entry.url));
    expect(input.every(entry => entry.directHttp === undefined)).toBe(true);
    expect(probe.diagnostics()).toMatchObject({ requests: 50, cacheHits: 2 });
  });

  it.each(["verified", "reachable", "timeout", "unreachable"] as const)(
    "preserves cached %s and expires it at its existing TTL without renewing on a hit", async status => {
      let time = 0;
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => {
        if (status === "timeout") return Promise.reject(new DOMException("Synthetic timeout", "TimeoutError"));
        return Promise.resolve(status === "verified" ? verified()
          : new Response(new Uint8Array([1]), { status: status === "reachable" ? 200 : 503,
            headers: { "Content-Type": "video/mp4" } }));
      });
      const probe = fixture(request, { maxCandidates: 1, maxConcurrent: 1, timeoutMs: 500 }, () => time);
      const cached = source("cached"), fresh = source("fresh");
      const first = (await probe.probe([cached]))[0]?.directHttp;
      expect(first).toMatchObject({ status, verified: status === "verified" });
      const ttl = status === "verified" || status === "reachable" ? 120_000 : 30_000;
      time = ttl - 1;
      const warm = await probe.probe([fresh, cached]);
      expect(warm[1]?.directHttp).toEqual(first);
      expect(request).toHaveBeenCalledTimes(2);
      time = ttl;
      const expired = await probe.probe([source("another"), cached]);
      expect(expired[1]?.directHttp).toBeUndefined();
      expect(probe.diagnostics().cacheHits).toBe(1);
    }
  );

  it("does not charge cached entries inside the initial cut against the 48 new attempts", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(verified()));
    const probe = fixture(request);
    const cached = source("cached-prefix");
    await probe.probe([cached]);
    request.mockClear();
    const fresh = Array.from({ length: 49 }, (_, index) => source(`fresh-${index}`));
    const output = await probe.probe([cached, ...fresh]);
    expect(output.slice(0, 49).every(entry => entry.directHttp?.verified)).toBe(true);
    expect(output[49]?.directHttp).toBeUndefined();
    expect(request.mock.calls.map(([outbound]) => outbound.url)).toEqual(fresh.slice(0, 48).map(entry => entry.url));
  });

  it("separates exact URLs and source headers while accepting equivalent header order", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(verified()));
    const probe = fixture(request, { maxCandidates: 1, maxConcurrent: 1, timeoutMs: 500 });
    const cached = { ...source("headers"), requestHeaders: { Referer: "https://origin.example/", Origin: "https://origin.example" } };
    await probe.probe([cached]);
    const changed = { ...cached, requestHeaders: { ...cached.requestHeaders, Referer: "https://different.example/" } };
    const differentUrl = { ...cached, url: `${cached.url}?token=SYNTHETIC_QUERY` };
    const reordered = { ...cached, requestHeaders: { Origin: cached.requestHeaders.Origin, Referer: cached.requestHeaders.Referer } };
    const warm = await probe.probe([source("fresh"), changed, differentUrl, reordered]);
    expect(warm.map(entry => entry.directHttp?.status)).toEqual(["verified", undefined, undefined, "verified"]);
    expect(request).toHaveBeenCalledTimes(2);
    await probe.probe([changed]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[0].sourceHeaders).toEqual(changed.requestHeaders);
  });

  it("retains LRU eviction and refreshes recency when recovering a late hit", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(verified()));
    const probe = fixture(request);
    const entries = Array.from({ length: 500 }, (_, index) => source(`lru-${index}`));
    for (let offset = 0; offset < entries.length; offset += 48) await probe.probe(entries.slice(offset, offset + 48));
    await probe.probe([entries[0]!]);
    await probe.probe([source("overflow")]);
    const before = request.mock.calls.length;
    await probe.probe([entries[0]!, entries[1]!]);
    expect(request.mock.calls.slice(before).map(([outbound]) => outbound.url)).toEqual([entries[1]!.url]);
  });

  it("caps deterministic backfill at 2x fresh slots even with cached rejections", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(new Response(null, { status: 428 })));
    const probe = fixture(request, { maxCandidates: 2, maxConcurrent: 1, timeoutMs: 500 });
    const cached = source("cached-rejection");
    await probe.probe([cached]);
    request.mockClear();
    const fresh = Array.from({ length: 6 }, (_, index) => source(`reject-${index}`));
    const backfill = vi.fn((entry: NormalizedStreamSource) => entry.directHttp?.responseStatus === 428);
    const result = await probe.probe([cached, ...fresh], undefined, backfill);
    expect(request.mock.calls.map(([outbound]) => outbound.url)).toEqual(fresh.slice(0, 4).map(entry => entry.url));
    expect(backfill).toHaveBeenCalledTimes(4);
    expect(result.map(entry => entry.directHttp?.status)).toEqual([
      "unreachable", "unreachable", "unreachable", "unreachable", "unreachable", undefined, undefined
    ]);
  });

  it("bounds concurrency and the shared deadline for 48 fresh slots alongside a late cache hit", async () => {
    vi.useFakeTimers();
    try {
      let active = 0, peak = 0;
      const request = vi.fn<FixtureOutboundRequest>().mockResolvedValueOnce(verified())
        .mockImplementation((_outbound, signal) => new Promise((_resolve, reject) => {
          peak = Math.max(peak, ++active);
          signal?.addEventListener("abort", () => {
            active -= 1;
            reject(signal.reason instanceof Error ? signal.reason : new Error("Synthetic abort"));
          }, { once: true });
        }));
      const probe = fixture(request);
      const cached = source("cached");
      await probe.probe([cached]);
      request.mockClear();
      const starts = vi.fn();
      const pending = probe.probe([...Array.from({ length: 60 }, (_, index) => source(`slow-${index}`)), cached],
        undefined, entry => entry.directHttp?.responseStatus === 428, starts);
      await vi.advanceTimersByTimeAsync(4000);
      const output = await pending;
      expect(output.at(-1)?.directHttp?.status).toBe("verified");
      expect(output.slice(0, 48).every(entry => entry.directHttp?.status === "budget_exhausted")).toBe(true);
      expect(output.slice(48, 60).every(entry => entry.directHttp === undefined)).toBe(true);
      expect(request).toHaveBeenCalledTimes(48);
      expect(starts).toHaveBeenCalledTimes(48);
      expect(peak).toBe(32);
      expect(active).toBe(0);
      await vi.advanceTimersByTimeAsync(4000);
      expect(request).toHaveBeenCalledTimes(48);
    } finally { vi.useRealTimers(); }
  });

  it("honors caller cancellation even when every source is cached", async () => {
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(verified()));
    const probe = fixture(request);
    const cached = source("cached");
    await probe.probe([cached]);
    const caller = new AbortController();
    caller.abort(new Error("Synthetic cancellation"));
    await expect(probe.probe([cached], caller.signal)).rejects.toThrow("Synthetic cancellation");
    expect(request).toHaveBeenCalledOnce();
  });
});

it("reapplies current Identity, runtime and URL policy to late cached sources (resolver integration)", async () => {
  const media = mp4Fixture(6420);
  const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => Promise.resolve(new Response(Uint8Array.from(media.subarray(0, 64)), {
    status: 206, headers: { "Content-Range": `bytes 0-63/${media.length}`, "Content-Type": "video/mp4" }
  })));
  const probe = fixture(request, { maxCandidates: 1, maxConcurrent: 1, timeoutMs: 500 });
  const cached = source("cached");
  let entries = [cached];
  const registry = new StreamProviderRegistry(500, silentLogger);
  registry.register({ id: "a", name: "Synthetic", isEnabled: () => true, resolve: () => Promise.resolve(entries) });
  const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
  const validate = vi.spyOn(policy, "validate");
  const resolver = new StreamResolver(registry, policy, probe);
  const item = { id: "synthetic", title: "Synthetic Meridian", kind: "movie" as const,
    runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
  const first = await resolver.resolve(item);
  expect(first).toHaveLength(1);
  entries = [source("fresh"), cached];
  const warm = await resolver.resolve(item);
  expect(warm.map(entry => entry.url)).toEqual(entries.map(entry => entry.url));
  expect(warm[1]?.directHttp).toMatchObject({ verified: true, actualRuntimeSeconds: 6420 });
  expect(getBridgeIdentityState(warm[1]!)).toBe("UNKNOWN");
  expect(request).toHaveBeenCalledTimes(2);
  expect(await resolver.resolve({ ...item, runtimeSeconds: 1200 })).toEqual([]);
  entries = [{ ...cached, metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } }];
  expect(await resolver.resolve(item)).toEqual([]);
  entries = [cached];
  validate.mockRejectedValueOnce(new Error("Synthetic current URL policy rejection"));
  expect(await resolver.resolve(item)).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
  expect((await resolver.resolve(item))[0]?.directHttp?.verified).toBe(true);
  expect(probe.diagnostics().cacheHits).toBe(4);
});
