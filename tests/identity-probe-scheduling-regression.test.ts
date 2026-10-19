import { expect, it } from "vitest";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { StreamResolver, StreamProviderRegistry, getBridgeIdentityState, type StreamResolverTrace, type StreamRejection } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { DirectTransport } from "../src/network/outbound-transport";
import { ExternalUrlPolicy, requestPinned } from "../src/network/url-policy";
import { silentLogger, testConfig } from "./helpers";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { observePipeline } from "./identity-qa/harness";

it("preserves a compatible sibling when deferred duration text would exhaust bounded backfill", async () => {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  try {
    const item: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
      year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
    const media = (name: string, seconds: number) => upstream.media(`/media/${name}.mp4`, {
      body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor"
    });
    const rejected = [media("wrong-one", 1200), media("wrong-two", 1200)];
    const healthy = media("healthy", 6420);
    const provider: StreamProvider = { id: "synthetic", name: "Synthetic fixture", isEnabled: () => true,
      resolve: () => Promise.resolve([
        ...rejected.map(url => ({ providerId: "synthetic", type: "http" as const, url, title: "Server 1\n00:20:00" })),
        { providerId: "synthetic", type: "http" as const, url: healthy }
      ]) };
    // Same budget as the release A/B control: one initial slot, at most two attempts.
    // Assert public survival through the real resolver/probe/addon harness, with no identity-rule oracle.
    const observed = await observePipeline(item, upstream, [provider], {
      probeOptions: { enabled: true, maxCandidates: 1, maxConcurrent: 1, timeoutMs: 1000 },
      target: { providerId: "synthetic", url: healthy }
    });
    expect(observed.stages.provider).toBe(3);
    expect(observed.dimensions.resourcePublicStreams).toBe(1);
    expect(observed.stages.final).toBe(1);
  } finally { await upstream.close(); }
});

const requested: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const weakText = "Server 1\n00:20:00";
const source = (url: string, extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource =>
  ({ providerId: "a", type: "http", url, ...extra });

async function competition(run: (fixture: {
  media(name: string, seconds?: number): string;
  resolve(sources: NormalizedStreamSource[], item?: NormalizedMediaItem,
    options?: { slots?: number; reuseProbe?: boolean; timeoutUrl?: string }): Promise<{
      snapshots: Map<Parameters<StreamResolverTrace["stage"]>[0], readonly NormalizedStreamSource[]>;
      final: NormalizedStreamSource[]; starts: string[]; requests: string[]; peakRequests: number;
      events: StreamRejection[]; cacheHits: number;
    }>;
}) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  const wireRequests: string[] = [];
  let active = 0, peak = 0;
  let cachedProbe: DirectStreamProbe | undefined;
  try {
    await run({
      media: (name, seconds) => upstream.media(`/media/${name}${name.endsWith(".torrent") ? "" : ".mp4"}`, {
        body: seconds === undefined ? Buffer.from([1]) : mp4Fixture(seconds), contentType: "video/mp4", range: "honor"
      }),
      resolve: async (sources, item = requested, options = {}) => {
        const slots = options.slots ?? 1;
        const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
        const direct = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger, async (target, init) => {
          if (target.url.toString() === options.timeoutUrl) throw new DOMException("Synthetic early timeout", "TimeoutError");
          return requestPinned(target, init);
        });
        const transport = { id: direct.id, diagnostics: () => direct.diagnostics(), request: async (...args: Parameters<DirectTransport["request"]>) => {
          wireRequests.push(args[0].url); peak = Math.max(peak, ++active);
          try { return await direct.request(...args); } finally { active -= 1; }
        } };
        const probe = options.reuseProbe && cachedProbe ? cachedProbe : new DirectStreamProbe(transport,
          { enabled: true, timeoutMs: 1000, maxCandidates: slots, maxConcurrent: Math.min(2, slots) }, silentLogger);
        cachedProbe = probe;
        const registry = new StreamProviderRegistry(1000, silentLogger, 2);
        for (const id of new Set(sources.map(entry => entry.providerId))) registry.register({
          id, name: "Synthetic fixture", isEnabled: () => true, resolve: () => Promise.resolve(sources.filter(entry => entry.providerId === id))
        });
        const snapshots = new Map<Parameters<StreamResolverTrace["stage"]>[0], readonly NormalizedStreamSource[]>();
        const starts: string[] = [], events: StreamRejection[] = [];
        const trace: StreamResolverTrace = { stage: (stage, entries) => { snapshots.set(stage, entries); },
          probeNetworkStart: id => { starts.push(id); }, rejection: event => { events.push(event); } };
        const before = wireRequests.length, cacheBefore = probe.diagnostics().cacheHits;
        peak = 0;
        const final = await new StreamResolver(registry, policy, probe, trace).resolve(item);
        return { snapshots, final, starts, events, requests: wireRequests.slice(before), peakRequests: peak,
          cacheHits: probe.diagnostics().cacheHits - cacheBefore };
      }
    });
  } finally { await upstream.close(); }
}

it.each([2, 4])("protects ordinary siblings with %i initial slots despite a full deferred 2x prefix", async slots => {
  await competition(async fixture => {
    const deferred = Array.from({ length: slots * 2 }, (_, index) => source(fixture.media(`deferred-${index}`, 1200), { title: weakText }));
    const healthy = Array.from({ length: slots }, (_, index) => source(fixture.media(`healthy-${index}`, 6420)));
    const result = await fixture.resolve([...deferred, ...healthy], requested, { slots });
    expect(new Set(result.requests)).toEqual(new Set(healthy.map(entry => entry.url)));
    expect(result.starts).toHaveLength(slots);
    expect(result.peakRequests).toBeLessThanOrEqual(2);
    expect(result.snapshots.get("admitted")?.map(entry => entry.url)).toEqual(healthy.map(entry => entry.url));
    expect(new Set(result.final.map(entry => entry.url))).toEqual(new Set(healthy.map(entry => entry.url)));
    expect(result.events).toEqual([]);
    expect(result.final.map(getBridgeIdentityState)).toEqual(healthy.map(() => "UNKNOWN"));
  });
});

it("preserves ordinary priority across fixed arrival orders and rescues compatible text when capacity exists", async () => {
  await competition(async fixture => {
    const rescued = source(fixture.media("rescued", 6420), { title: weakText });
    const bad = source(fixture.media("bad", 1200), { title: weakText });
    const healthy = source(fixture.media("healthy", 6420));
    for (const entries of [[rescued, bad, healthy], [healthy, rescued, bad], [bad, healthy, rescued]]) {
      const small = await fixture.resolve(entries);
      expect(small.requests).toEqual([healthy.url]);
      expect(small.final.map(entry => entry.url)).toEqual([healthy.url]);
      const larger = await fixture.resolve(entries, requested, { slots: 2 });
      expect(new Set(larger.final.map(entry => entry.url))).toEqual(new Set([healthy.url, rescued.url]));
      expect(larger.starts.length).toBeLessThanOrEqual(4);
    }
  });
});

it("keeps provider turns independent while distributing real rejections and deferred candidates", async () => {
  await competition(async fixture => {
    const aBad = [0, 1].map(index => source(fixture.media(`a-deferred-${index}`, 1200), { title: weakText }));
    const aGood = source(fixture.media("a-healthy", 6420));
    const bBad = source(fixture.media("b-wrong", 1200), { providerId: "b" });
    const bGood = source(fixture.media("b-healthy", 6420), { providerId: "b" });
    for (const [entries, attempts] of [[[...aBad, aGood, bBad, bGood], 4], [[bBad, bGood, ...aBad, aGood], 3]] as const) {
      const result = await fixture.resolve([...entries], requested, { slots: 2 });
      expect(new Set(result.requests.slice(0, 2))).toEqual(new Set([aGood.url, bBad.url]));
      expect(new Set(result.starts.slice(0, 2))).toEqual(new Set(["a", "b"]));
      expect(new Set(result.final.map(entry => entry.url))).toEqual(new Set([aGood.url, bGood.url]));
      expect(result.starts).toHaveLength(attempts);
      expect(result.peakRequests).toBeLessThanOrEqual(2);
      expect(getBridgeIdentityState(result.snapshots.get("probed")!.find(entry => entry.url === bBad.url)!)).toBe("CONTRADICTION");
    }
  });
});

it("exhausts exactly the existing 2x backfill allowance without inspecting late ordinary or deferred sources", async () => {
  await competition(async fixture => {
    for (const slots of [1, 2, 4]) {
      const deferred = source(fixture.media(`deferred-${slots}`, 1200), { title: weakText });
      const wrong = Array.from({ length: slots * 2 }, (_, index) => source(fixture.media(`wrong-${slots}-${index}`, 1200)));
      const late = source(fixture.media(`late-${slots}`, 6420));
      const result = await fixture.resolve([deferred, ...wrong, late], requested, { slots });
      expect(new Set(result.requests)).toEqual(new Set(wrong.map(entry => entry.url)));
      expect(result.starts).toHaveLength(slots * 2);
      expect(result.events).toHaveLength(slots * 2);
      expect(new Set(result.events.map(event => event.candidate)).size).toBe(slots * 2);
      expect(result.snapshots.get("probed")!.find(entry => entry.url === late.url)?.directHttp).toBeUndefined();
      expect(result.snapshots.get("admitted")).toEqual([]);
      expect(result.final).toEqual([]);
    }
  });
});

it("keeps uncertain ordinary media separate from verified identity evidence under competition", async () => {
  await competition(async fixture => {
    const deferred = source(fixture.media("deferred", 1200), { title: weakText });
    const timeout = source(fixture.media("timeout", 6420));
    const inconclusive = source(fixture.media("inconclusive"));
    const verified = source(fixture.media("verified", 6420));
    const result = await fixture.resolve([deferred, timeout, inconclusive, verified], requested, { slots: 3, timeoutUrl: timeout.url! });
    expect(new Set(result.requests)).toEqual(new Set([timeout.url, inconclusive.url, verified.url]));
    expect(new Set(result.final.map(entry => entry.url))).toEqual(new Set([timeout.url, inconclusive.url, verified.url]));
    const timed = result.final.find(entry => entry.url === timeout.url)!;
    expect(timed.directHttp).toMatchObject({ status: "timeout", verified: false });
    expect(timed.directHttp?.actualRuntimeSeconds).toBeUndefined();
    const unmeasured = result.final.find(entry => entry.url === inconclusive.url)!;
    expect(unmeasured.directHttp?.actualRuntimeSeconds).toBeUndefined();
    expect(result.final.find(entry => entry.url === verified.url)?.directHttp).toMatchObject({ verified: true, actualRuntimeSeconds: 6420 });
    expect(result.final.map(getBridgeIdentityState)).not.toContain("CORROBORATED");
    expect(result.events).toEqual([]);
  });
});

it("reuses cached measurements without carrying request-specific rejection or confidence into another resolve", async () => {
  await competition(async fixture => {
    const bad = source(fixture.media("cached-wrong", 1200), { title: weakText });
    const healthy = source(fixture.media("healthy", 6420));
    const first = await fixture.resolve([bad], requested, { slots: 2 });
    expect(first.events).toHaveLength(1);
    const second = await fixture.resolve([bad, healthy], requested, { slots: 2, reuseProbe: true });
    expect(second.requests).toEqual([healthy.url]);
    expect(second.cacheHits).toBe(1);
    expect(second.final.map(entry => entry.url)).toEqual([healthy.url]);
    expect(second.events[0]?.candidate).not.toBe(first.events[0]?.candidate);
    const changedRequest = await fixture.resolve([bad, healthy], { ...requested, runtimeSeconds: 1200 }, { slots: 2, reuseProbe: true });
    expect(changedRequest.starts).toEqual([]);
    expect(changedRequest.cacheHits).toBe(2);
    expect(changedRequest.final.map(entry => entry.url)).toEqual([bad.url]);
    expect(changedRequest.final.map(getBridgeIdentityState)).toEqual(["UNKNOWN"]);
    expect(getBridgeIdentityState(changedRequest.snapshots.get("probed")!.find(entry => entry.url === healthy.url)!)).toBe("CONTRADICTION");
  });
});

it("prioritizes the actual dedupe representative without merging equivalent candidates' identity evidence", async () => {
  await competition(async fixture => {
    const shared = fixture.media("shared", 6420), separate = fixture.media("separate", 6420);
    const weakClaim = source(shared, { title: weakText, metadata: { identity: { externalIds: { imdb: requested.externalIds.imdb } } } });
    const ordinaryCopy = source(shared), ordinary = source(separate);
    for (const [entries, expected] of [[[weakClaim, ordinaryCopy, ordinary], separate], [[ordinaryCopy, weakClaim, ordinary], shared]] as const) {
      const result = await fixture.resolve([...entries]);
      expect(result.snapshots.get("normalized")).toHaveLength(3);
      expect(result.snapshots.get("deduplicated")).toHaveLength(2);
      expect(result.requests).toEqual([expected]);
      expect(result.final.map(entry => entry.url)).toEqual([expected]);
      if (expected === shared) {
        expect(result.final[0]?.metadata?.identity).toBeUndefined();
        expect(getBridgeIdentityState(result.final[0]!)).toBe("UNKNOWN");
      }
    }
  });
});

it("does not defer decisive identity conflicts along with weak duration text", async () => {
  await competition(async fixture => {
    const badUrl = fixture.media("structural", 6420), goodUrl = fixture.media("healthy", 6420);
    for (const evidence of [
      { metadata: { identity: { externalIds: { imdb: "tt9999999998" } } } },
      { metadata: { identity: { year: 1987 } } },
      { metadata: { identity: { kind: "episode", season: 2, episode: 9 } } },
      { filename: "Synthetic.S03E04.mp4" }
    ]) {
      const result = await fixture.resolve([source(badUrl, { title: weakText, ...evidence }), source(goodUrl)]);
      expect(result.snapshots.get("normalized")?.map(entry => entry.url)).toEqual([goodUrl]);
      expect(result.requests).toEqual([goodUrl]);
      expect(result.final.map(entry => entry.url)).toEqual([goodUrl]);
    }
  });
});

it("keeps exact-episode runtime absence and structural conflicts distinct from movie deferral", async () => {
  await competition(async fixture => {
    const item: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Episode",
      season: 2, episode: 9, externalIds: {} };
    const bad = source(fixture.media("measured", 6420), { title: weakText });
    const good = source(fixture.media("healthy", 1800));
    const wrongCoordinates = source(fixture.media("wrong-coordinates", 1800), { title: weakText, filename: "Synthetic.S03E04.mp4" });
    const missingRuntime = await fixture.resolve([wrongCoordinates, bad, good], item, { slots: 2 });
    expect(missingRuntime.snapshots.get("normalized")?.map(entry => entry.url)).toEqual([bad.url, good.url]);
    expect(new Set(missingRuntime.final.map(entry => entry.url))).toEqual(new Set([bad.url, good.url]));
    expect(missingRuntime.events).toEqual([{ candidate: {}, stage: "normalized",
      reason: "EPISODE_COORDINATE_CONFLICT", identityState: "CONTRADICTION" }]);
    expect(missingRuntime.final.map(getBridgeIdentityState)).not.toContain("CORROBORATED");
    const exactRuntime = await fixture.resolve([wrongCoordinates, bad, good], { ...item, runtimeSeconds: 1800 });
    expect(exactRuntime.requests).toEqual([bad.url, good.url]);
    expect(exactRuntime.final.map(entry => entry.url)).toEqual([good.url]);
    expect(exactRuntime.events.map(event => [event.stage, event.reason])).toEqual([
      ["normalized", "EPISODE_COORDINATE_CONFLICT"], ["admitted", "MEASURED_RUNTIME_CONTRADICTION"]
    ]);
  });
});

it("keeps magnet and torrent candidates outside HTTP scheduling while retaining admitted outputs", async () => {
  await competition(async fixture => {
    const deferred = [0, 1].map(index => source(fixture.media(`deferred-${index}`, 1200), { title: weakText }));
    const healthy = source(fixture.media("healthy", 6420));
    const magnet: NormalizedStreamSource = { providerId: "a", type: "magnet", magnet: "magnet:?xt=urn:btih:" + "a".repeat(40) };
    const torrent = source(fixture.media("fixture.torrent"), { type: "torrent" });
    const result = await fixture.resolve([...deferred, magnet, torrent, healthy]);
    expect(result.requests).toEqual([healthy.url]);
    expect(result.snapshots.get("admitted")?.map(entry => entry.type).sort()).toEqual(["http", "magnet", "torrent"]);
    expect(result.final.map(entry => entry.type).sort()).toEqual(["http", "magnet", "torrent"]);
    expect(result.final.find(entry => entry.type === "http")?.url).toBe(healthy.url);
    expect(result.final.find(entry => entry.type === "magnet")?.infoHash).toBe("a".repeat(40));
    expect(result.final.find(entry => entry.type === "torrent")?.url).toBe(torrent.url);
    expect(result.final.filter(entry => entry.type !== "http").every(entry => entry.directHttp === undefined)).toBe(true);
  });
});
