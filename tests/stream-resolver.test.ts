import { fixtureOutboundRequest, type FixtureOutboundRequest } from "./helpers";
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectTransport, type PinnedRequest } from "../src/network/outbound-transport";
import type { HttpPrivacyPolicy } from "../src/network/http-privacy";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver, type StreamCandidateRef, type StreamRejection } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import type { OutboundTransport } from "../src/network/outbound-transport";
import type { NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { silentLogger } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";
import { IdentityPrecisionEvaluation } from "../src/streams/identity-precision-evaluation";
import { logger } from "../src/logger";

// These fixture identities, localized labels and provider/release names are invented.
// Alternate labels do not assert a trusted alias relation; no remote corpus is used.
const item = { id: "movie", kind: "movie" as const, title: "Movie", externalIds: {} };
const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
const strictPrivacy: HttpPrivacyPolicy = {
  mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
  acceptCookies: false, userAgentMode: "minimal", maxRedirects: 3
};

function directProbeFor(response: Response | Response[] | Error, enabled = true): { probe: DirectStreamProbe; request: ReturnType<typeof vi.fn> } {
  let responseIndex = 0;
  const request = vi.fn<FixtureOutboundRequest>().mockImplementation(() => {
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(Array.isArray(response) ? response[responseIndex++] ?? response.at(-1)! : response);
  });
  const transport: OutboundTransport = {
    id: "fake", request: fixtureOutboundRequest(request),
    diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 })
  };
  return {
    probe: new DirectStreamProbe(transport, { enabled, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 2 }, silentLogger),
    request
  };
}

function opaqueRegistry(url = "https://media.example/opaque-token", filename?: string): StreamProviderRegistry {
  const registry = new StreamProviderRegistry(100, silentLogger);
  registry.register({
    id: "opaque", name: "Opaque", isEnabled: () => true,
    resolve: () => Promise.resolve([{ providerId: "opaque", type: "https", url, ...(filename ? { filename } : {}) }])
  });
  return registry;
}

describe("stream provider registry and resolver", () => {
  it.each(["absent", "disabled", "unmeasurable", "timeout"])(
    "keeps the approved weak-text fallback when probe is %s", async state => {
      const registry = new StreamProviderRegistry(100, silentLogger);
      registry.register({ id: "runtime", name: "Runtime", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "runtime", type: "https", url: "https://media.example/video.mp4",
          title: "Server 1\n00:20:00" }]) });
      const { probe, request } = directProbeFor(state === "timeout" ? new DOMException("Synthetic timeout", "TimeoutError")
        : new Response(new Uint8Array([1]), { status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/100" } }),
      state !== "disabled");
      const rejection = vi.fn();
      const resolver = new StreamResolver(registry, policy, state === "absent" ? undefined : probe,
        { stage: () => undefined, rejection });
      await expect(resolver.resolve({ ...item, runtimeSeconds: 6420 })).resolves.toEqual([]);
      expect(request).toHaveBeenCalledTimes(state === "absent" || state === "disabled" ? 0 : 1);
      expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
      expect(rejection).not.toHaveBeenCalled();
    }
  );

  it("does not defer a decisive ID conflict along with weak duration text", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "runtime", name: "Runtime", isEnabled: () => true,
      resolve: () => Promise.resolve([{ providerId: "runtime", type: "https", url: "https://media.example/video.mp4",
        title: "Server 1\n00:20:00", metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } }]) });
    const { probe, request } = directProbeFor(new Response(null));
    const resolver = new StreamResolver(registry, policy, probe);
    await expect(resolver.resolve({ ...item, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } })).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
  });

  it("preserves Starfarer recall across localized, generic, opaque, HTTP and unverified sources", async () => {
    const titles = ["The Starfarer (1984) 1080p", "Starfarer", "O Navegante das Estrelas",
      "480p (Audio Original)", "Server 1", "The_Starfarer_1984_RM4K_1080p_BluRay_x265_10bit_FixtureWeaver_part002.mkv"];
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => Promise.resolve(titles.map((title, index) => ({
        providerId: "fixture", type: index === 1 ? "http" as const : "https" as const,
        url: `${index === 1 ? "http" : "https"}://media.example/${index === 4 ? "opaque" : `${index}.mkv`}`, title
      }))) });
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url }) => Promise.resolve(
      url.includes("/1.mkv") ? new Response(null, { status: 503 })
        : new Response(new Uint8Array([1]), { status: 206,
          headers: { "Content-Type": "video/x-matroska", "Content-Range": "bytes 0-0/100" } })
    ));
    const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 500, maxCandidates: 8, maxConcurrent: 1
    }, silentLogger);
    const resolver = new StreamResolver(registry, policy, probe);
    const streams = await resolver.resolve({ id: "tt9900000004", kind: "movie", title: "The Starfarer",
      year: 1984, runtimeSeconds: 107 * 60, externalIds: { imdb: "tt9900000004" } });
    expect(streams.map((source) => source.title)).toEqual(expect.arrayContaining(titles));
    expect(streams).toHaveLength(titles.length);
    expect(streams.find((source) => source.title === "Starfarer")?.directHttp?.verified).toBe(false);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(0);
    expect(streams.every((source) => source.directHttp?.actualRuntimeSeconds === undefined)).toBe(true);
  });

  it.each(["mp4", "hls"] as const)(
    "rejects measured 20-minute %s media and lets compatible measurement override weak 20-minute text", async (format) => {
      const registry = new StreamProviderRegistry(100, silentLogger);
      const extension = format === "mp4" ? "mp4" : "m3u8";
      registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
        resolve: () => Promise.resolve([20, 106].map((minutes) => ({
          providerId: "fixture", type: "https" as const,
          url: `https://media.example/${minutes}.${extension}?token=FAKE_PRIVATE_TRACE_QUERY`,
          title: "Starfarer\n00:20:00"
        }))) });
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation(({ url, headers }) => {
        if (url.endsWith(".ts")) return Promise.resolve(new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "video/mp2t" }
        }));
        const minutes = url.includes("/20.") ? 20 : 106;
        if (format === "hls") {
          // Two bounded segments provide complete VOD duration, including the normal movie.
          const segmentSeconds = minutes * 30;
          return Promise.resolve(new Response(`#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:${segmentSeconds}\n`
            + `#EXTINF:${segmentSeconds},\nsegment-1.ts\n#EXTINF:${segmentSeconds},\nsegment-2.ts\n#EXT-X-ENDLIST\n`,
          { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
        }
        const media = mp4Fixture(minutes * 60);
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range")!)!;
        const start = Number(range[1]), end = Math.min(Number(range[2]), media.length - 1);
        return Promise.resolve(new Response(Uint8Array.from(media.subarray(start, end + 1)), {
          status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${media.length}` }
        }));
      });
      const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
      const probe = new DirectStreamProbe(transport, {
        enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
      }, silentLogger);
      const requested = { id: "tt9900000004", kind: "movie" as const, title: "The Starfarer",
        year: 1984, runtimeSeconds: 107 * 60, externalIds: { imdb: "tt9900000004" } };
      const audit = new IdentityPrecisionEvaluation(["fixture"]);
      const auditTrace = audit.itemTrace(requested);
      let lastStage = "";
      let badRef: StreamCandidateRef | undefined;
      let goodRef: StreamCandidateRef | undefined;
      const events: StreamRejection[] = [];
      const resolver = new StreamResolver(registry, policy, probe, {
        stage: (stage, sources, refs) => {
          lastStage = stage;
          auditTrace.stage(stage, sources);
          if (stage === "probed") {
            badRef = refs?.[0]; goodRef = refs?.[1];
            expect(sources[0]?.directHttp?.actualRuntimeSeconds).toBe(1200);
            expect(sources.map(getBridgeIdentityState)).toEqual([undefined, undefined]);
          }
        },
        rejection: event => {
          expect(lastStage).toBe("probed");
          expect(event.candidate).toBe(badRef);
          expect(event.candidate).not.toBe(goodRef);
          expect(Object.isFrozen(event.candidate)).toBe(true);
          expect(JSON.stringify(event)).toBe('{"candidate":{},"stage":"admitted","reason":"MEASURED_RUNTIME_CONTRADICTION","identityState":"CONTRADICTION"}');
          events.push(event);
        }
      });
      const streams = await resolver.resolve(requested);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.url).toContain("/106.");
      expect(streams[0]?.directHttp).toMatchObject({ verified: true, actualRuntimeSeconds: 106 * 60,
        runtimeEvidence: format === "mp4" ? "mp4_mvhd" : "hls_vod" });
      expect(audit.report().providers[0]?.stages.probed).toMatchObject({ CONTRADICTION: 1, UNKNOWN: 1 });
      expect(audit.report().providers[0]?.stages.final).toMatchObject({ CONTRADICTION: 0, UNKNOWN: 1 });
      expect(events).toHaveLength(1); // Backfill predicate must not emit a second rejection.
      expect(streams.map(getBridgeIdentityState)).toEqual(["UNKNOWN"]);
      expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
      const requests = request.mock.calls.length;
      const cached = await resolver.resolve(requested);
      expect(cached.map(source => source.url)).toEqual(streams.map(source => source.url));
      expect(cached.map(getBridgeIdentityState)).toEqual(["UNKNOWN"]);
      expect(request).toHaveBeenCalledTimes(requests);
      expect(events).toHaveLength(2);
      expect(events[1]!.candidate).not.toBe(events[0]!.candidate);
    });

  it("removes an episodic video release from a movie request before direct probing", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const wrong = "N.E.R.A.S04E18.480p.WEB-DL.HIN-ENG.x264.ESub-FixtureForge.mkv";
    const good = "Glass.Signals.1994.1080p.10bit.BluRay.mkv";
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "fixture", type: "https", url: "https://media.example/opaque-1", title: wrong },
        { providerId: "fixture", type: "https", url: "https://media.example/opaque-2",
          title: good, filename: good }
      ]) });
    const { probe, request } = directProbeFor(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/100" }
    }));
    const resolver = new StreamResolver(registry, policy, probe);
    const streams = await resolver.resolve({ id: "tt9900000002", kind: "movie", title: "Glass Signals",
      year: 1994, externalIds: { imdb: "tt9900000002" } });
    expect(request).toHaveBeenCalledOnce();
    expect(streams.map((source) => source.title)).toEqual([good]);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
  });

  it("excludes synthetic contradictory movie filenames before direct probing", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const wrong = [
      "[FixtureCloud] [1.57 GB] Neral.1985.DC.1080p.10bit.BluRay.HIN-ENG.x265.ESub-FixtureReels.invalid.mkv\nfixturecloud | FixtureDock\nFX",
      "[FixtureCloud] [1.66 GB] Coastal.Neral.1991.1080p.x264.WEBRip.Hindi.English.ESubs.-.FixtureReels.example.mkv\nHindi\nfixturecloud | FixtureDock\nFX",
      "[FixtureCloud] [815.28 MB] Coastal.Neral.1991.720p.x264.WEBRip.Hindi.English.ESubs.-.FixtureReels.example.mkv\nHindi\nfixturecloud | FixtureDock\nFX"
    ];
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => Promise.resolve([
        ...wrong.map((title, index) => ({ providerId: "fixture", type: "https" as const,
          url: `https://media.example/opaque-${index}`, title })),
        { providerId: "fixture", type: "https" as const,
          url: "https://media.example/good.mp4", title: "Some.Localized.Title.2013.1080p.WEB-DL.mp4",
          filename: "Some.Localized.Title.2013.1080p.WEB-DL.mp4" }
      ]) });
    const { probe, request } = directProbeFor(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/100" }
    }));
    const resolver = new StreamResolver(registry, policy, probe);
    const streams = await resolver.resolve({ id: "neral", kind: "movie",
      title: "Neral: A Lone Navigator", year: 2013, externalIds: {} });
    expect(request).toHaveBeenCalledOnce();
    expect(streams.map((source) => source.title)).toEqual(["Some.Localized.Title.2013.1080p.WEB-DL.mp4"]);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(3);
  });

  it("keeps Amber Lanterns (2015) out of the Amber Voyages (2017) final streams", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const magnet = (character: string) => `magnet:?xt=urn:btih:${character.repeat(40)}`;
    registry.register({
      id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "fixture", type: "magnet", magnet: magnet("a"), title: "Amber Lanterns (2015)" },
        { providerId: "fixture", type: "magnet", magnet: magnet("b"), title: "Amber Voyages (2017)",
          metadata: { identity: { kind: "movie", title: "AMBER VOYAGES", year: 2017 } } },
        { providerId: "fixture", type: "magnet", magnet: magnet("c"), title: "Unidentified release",
          metadata: { identity: { year: 0 } } },
        { providerId: "fixture", type: "magnet", magnet: magnet("d"),
          metadata: { identity: { externalIds: { imdb: "tt9999999" } } } },
        { providerId: "fixture", type: "magnet", magnet: magnet("e"),
          metadata: { identity: { kind: "movie", title: "Amber Lanterns", year: 2015 } } }
      ])
    });
    const resolver = new StreamResolver(registry, policy);
    const streams = await resolver.resolve({
      id: "tt1234567", kind: "movie", title: "Amber Voyages", year: 2017,
      externalIds: { imdb: "tt1234567" }
    });
    expect(streams.map((source) => source.infoHash).sort()).toEqual(["b".repeat(40), "c".repeat(40)]);
    expect(resolver.diagnostics()[0]).toMatchObject({ status: "ok", identityRejections: 3 });
  });

  it("rejects explicit episode and media-kind contradictions while leaving missing evidence eligible", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const magnet = (character: string) => `magnet:?xt=urn:btih:${character.repeat(40)}`;
    registry.register({
      id: "episodes", name: "Episodes", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "episodes", type: "magnet", magnet: magnet("a"),
          metadata: { identity: { kind: "episode", season: 1, episode: 3 } } },
        { providerId: "episodes", type: "magnet", magnet: magnet("b"),
          metadata: { identity: { type: "movie" } } },
        { providerId: "episodes", type: "magnet", magnet: magnet("c"),
          metadata: { identity: { kind: "series", season: 1, episode: 2 } } },
        { providerId: "episodes", type: "magnet", magnet: magnet("d"), title: "Some other release" }
      ])
    });
    const streams = await new StreamResolver(registry, policy).resolve({
      id: "tt1234567:1:2", kind: "episode", title: "", season: 1, episode: 2,
      externalIds: { imdb: "tt1234567" }
    });
    expect(streams.map((source) => source.infoHash).sort()).toEqual(["c".repeat(40), "d".repeat(40)]);
  });

  it("rejects a different structured movie prefix while keeping matching and generic stream labels", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const labels = [
      "Tavin Meets Luma (2020) ...",
      "Tavin Meets Luma (2020) · 1080p",
      "Tavin Meets Luma (2020) - 1080p",
      "Luma (2011) 1080p HEVC",
      "루마리 (2011) 1080p", "Lumari (2011) 1080p", "Other Title (2011) 1080p",
      "Luma 1080p", "1080p HEVC", "Server 1", "Direct", "English"
    ];
    registry.register({
      id: "labels", name: "Labels", isEnabled: () => true,
      resolve: () => Promise.resolve(labels.map((title, index) => ({
        providerId: "labels", type: "magnet" as const,
        magnet: `magnet:?xt=urn:btih:${["a", "b", "c", "d", "e", "f", "1", "2", "3", "4", "5", "6"][index]!.repeat(40)}`, title
      })))
    });
    const streams = await new StreamResolver(registry, policy).resolve({
      id: "luma", kind: "movie", title: "Luma", year: 2011, externalIds: {}
    });
    expect(streams.map((source) => source.title).sort()).toEqual(labels.slice(3).sort());
  });

  it("keeps different titles and years eligible without a requested year, but rejects a different IMDb ID", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "identity", name: "Identity", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "identity", type: "magnet", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
          title: "Tavin Meets Luma (2020) 1080p" },
        { providerId: "identity", type: "magnet", magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
          metadata: { identity: { externalIds: { imdb: "tt9999999" } } } },
        { providerId: "identity", type: "magnet", magnet: `magnet:?xt=urn:btih:${"c".repeat(40)}`,
          title: "Server 1" }
      ]) });
    const streams = await new StreamResolver(registry, policy).resolve({
      id: "tt9900000005", kind: "movie", title: "Luma", externalIds: { imdb: "tt9900000005" }
    });
    expect(streams.map((source) => source.title)).toEqual(["Tavin Meets Luma (2020) 1080p", "Server 1"]);
    expect(registry.status()[0]?.identityRejections).toBe(1);
  });

  it("does not let one candidate year claim hide a conflicting structured release year", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "years", name: "Years", isEnabled: () => true,
      resolve: () => Promise.resolve([{ providerId: "years", type: "magnet",
        magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
        title: "Another Name (2020) 1080p", metadata: { identity: { year: 2011 } } }]) });
    await expect(new StreamResolver(registry, policy).resolve({
      id: "tt9900000005", kind: "movie", title: "Luma", year: 2011,
      externalIds: { imdb: "tt9900000005" }
    })).resolves.toEqual([]);
  });

  it("isolates failures, ignores disabled providers and deduplicates results", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const working: StreamProvider = {
      id: "working", name: "Working", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "working", type: "https", url: "https://media.example/video.mp4", quality: "720p" },
        { providerId: "working", type: "https", url: "https://media.example/video.mp4", quality: "1080p" }
      ])
    };
    registry.register(working);
    registry.register({
      id: "broken", name: "Broken", isEnabled: () => true,
      resolve: () => Promise.reject(new Error("sanitized failure"))
    });
    registry.register({
      id: "disabled", name: "Disabled", isEnabled: () => false,
      resolve: () => Promise.reject(new Error("must not run"))
    });
    const resolver = new StreamResolver(registry, policy);
    const streams = await resolver.resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.quality).toBe("1080p");
    expect(resolver.diagnostics().find((entry) => entry.id === "broken")?.status).toBe("error");
    expect(resolver.diagnostics().find((entry) => entry.id === "disabled")?.status).toBe("disabled");
  });

  it("times out a provider without blocking a healthy provider", async () => {
    const registry = new StreamProviderRegistry(15, silentLogger);
    registry.register({
      id: "slow", name: "Slow", isEnabled: () => true,
      resolve: () => new Promise(() => undefined)
    });
    registry.register({
      id: "fast", name: "Fast", isEnabled: () => true,
      resolve: () => Promise.resolve([{ providerId: "fast", type: "magnet", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}` }])
    });
    const resolver = new StreamResolver(registry, policy);
    const streams = await resolver.resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.providerId).toBe("fast");
    expect(resolver.diagnostics().find(entry => entry.id === "slow")).toMatchObject({
      status: "error", lastError: "Provider timed out or was cancelled"
    });
    expect(resolver.diagnostics().find(entry => entry.id === "slow")?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each(["hostile-name", "unreadable-error", "non-error"])(
    "keeps closed failure diagnostics and a healthy queued provider for %s", async variant => {
      const captured: string[] = [];
      const warning = vi.spyOn(console, "warn").mockImplementation(line => captured.push(String(line)));
      const readErrorField = vi.fn(() => { throw new Error("Unexpected error field access"); });
      const failure = variant === "non-error" ? { private: "SYNTHETIC_PROVIDER_PRIVATE_VALUE" }
        : new Error("SYNTHETIC_PROVIDER_PRIVATE_VALUE", { cause: "SYNTHETIC_PROVIDER_PRIVATE_VALUE" });
      if (variant === "hostile-name") {
        Object.assign(failure, { name: "SYNTHETIC_PROVIDER_PRIVATE_VALUE", stack: "SYNTHETIC_PROVIDER_PRIVATE_VALUE" });
      } else if (variant === "unreadable-error") {
        // Node 20 can materialize the existing stack while redefining it, reading name/message.
        // Replace stack before those fields become hostile; all four getters must remain unread.
        for (const field of ["stack", "name", "message", "cause"]) {
          Object.defineProperty(failure, field, { get: readErrorField });
        }
      }
      try {
        const registry = new StreamProviderRegistry(100, logger, 1);
        registry.register({ id: "broken", name: "Broken", isEnabled: () => true,
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise untrusted non-Error rejection values.
          resolve: () => Promise.reject(failure) });
        registry.register({ id: "healthy", name: "Healthy", isEnabled: () => true,
          resolve: () => Promise.resolve([{ providerId: "healthy", type: "https", url: "https://media.example/video.mp4" }]) });
        const resolver = new StreamResolver(registry, policy);
        expect((await resolver.resolve(item)).map(source => source.providerId)).toEqual(["healthy"]);
        expect(resolver.diagnostics().find(entry => entry.id === "broken")).toMatchObject({
          status: "error", lastError: "Provider failed", identityRejections: 0
        });
        expect(resolver.diagnostics().find(entry => entry.id === "broken")?.latencyMs).toBeGreaterThanOrEqual(0);
        expect(resolver.diagnostics().find(entry => entry.id === "healthy")).toMatchObject({ status: "ok" });
        expect(captured).toHaveLength(1);
        expect(JSON.parse(captured[0]!)).toMatchObject({
          level: "warn", message: "Stream provider failed", provider: "broken", error: "Provider failed"
        });
        expect(JSON.stringify([captured, resolver.diagnostics()]).includes("SYNTHETIC_PROVIDER_PRIVATE_VALUE")).toBe(false);
        expect(readErrorField).not.toHaveBeenCalled();
      } finally { warning.mockRestore(); }
    }
  );

  it("keeps cancellation diagnostics closed without reading a hostile abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("SYNTHETIC_CANCEL_PRIVATE_VALUE");
    reason.name = "SYNTHETIC_CANCEL_PRIVATE_VALUE";
    let receivedSignal: AbortSignal | undefined;
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "cancelled", name: "Cancelled", isEnabled: () => true,
      resolve: (_item, context) => {
        receivedSignal = context?.signal;
        controller.abort(reason);
        return new Promise(() => undefined);
      } });
    const resolver = new StreamResolver(registry, policy);
    await expect(resolver.resolve(item, controller.signal)).resolves.toEqual([]);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe(reason);
    expect(resolver.diagnostics()[0]).toMatchObject({
      status: "error", lastError: "Provider timed out or was cancelled"
    });
    expect(resolver.diagnostics()[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(resolver.diagnostics()).includes("SYNTHETIC_CANCEL_PRIVATE_VALUE")).toBe(false);
  });

  it("honors a provider-specific timeout above the shared provider timeout", async () => {
    const registry = new StreamProviderRegistry(10, silentLogger);
    registry.register({
      id: "external", name: "External", timeoutMs: 60, isEnabled: () => true,
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [{ providerId: "external", type: "magnet", magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}` }];
      }
    });
    const streams = await new StreamResolver(registry, policy).resolve(item);
    expect(streams).toHaveLength(1);
  });

  it("rejects localhost URLs returned by a provider", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({
      id: "untrusted", name: "Untrusted", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "untrusted", type: "http", url: "http://127.0.0.1:7100/video.mp4" }
      ])
    });
    const rejection = vi.fn();
    await expect(new StreamResolver(registry, policy, undefined, { stage: () => undefined, rejection }).resolve(item)).resolves.toEqual([]);
    expect(rejection).not.toHaveBeenCalled();
  });

  it("can disable and re-enable a registered provider", () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "toggle", name: "Toggle", isEnabled: () => true, resolve: () => Promise.resolve([]) });
    registry.setEnabled("toggle", false);
    expect(registry.active()).toHaveLength(0);
    expect(registry.status()[0]?.enabled).toBe(false);
    expect(registry.status()[0]?.status).toBe("disabled");
    registry.setEnabled("toggle", true);
    expect(registry.active()).toHaveLength(1);
  });

  it("sorts ties by seeds, then size, while preserving original order for full ties", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const hashes = ["a", "b", "c", "d"].map((character) => character.repeat(40));
    registry.register({
      id: "stable", name: "Stable", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "stable", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[0]}`, quality: "1080p", seeds: 10, sizeBytes: 8_000 },
        { providerId: "stable", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[1]}`, quality: "1080p", seeds: 10, sizeBytes: 4_000 },
        { providerId: "stable", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[2]}`, quality: "1080p", seeds: 20, sizeBytes: 8_000 },
        { providerId: "stable", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[3]}`, quality: "1080p" }
      ])
    });
    const resolver = new StreamResolver(registry, policy);
    const first = await resolver.resolve(item);
    const second = await resolver.resolve(item);
    expect(first.map((source) => source.infoHash)).toEqual([hashes[2], hashes[1], hashes[0], hashes[3]]);
    expect(second.map((source) => source.infoHash)).toEqual(first.map((source) => source.infoHash));
  });

  it("puts a practical torrent before larger well-seeded releases", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const hashes = ["1", "2", "3"].map((character) => character.repeat(40));
    registry.register({
      id: "choices", name: "Choices", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "choices", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[0]}`,
          quality: "2160p REMUX", sizeBytes: 70 * 1024 ** 3, seeds: 300 },
        { providerId: "choices", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[1]}`,
          quality: "1080p", sizeBytes: 20 * 1024 ** 3, seeds: 300 },
        { providerId: "choices", type: "magnet", magnet: `magnet:?xt=urn:btih:${hashes[2]}`,
          quality: "1080p", codec: "HEVC", sizeBytes: 5 * 1024 ** 3, seeds: 80 }
      ])
    });
    const streams = await new StreamResolver(registry, policy).resolve(item);
    expect(streams[0]?.infoHash).toBe(hashes[2]);
    expect(streams).toHaveLength(3);
  });

  it("keeps explicit file indexes distinct within a multi-file episodic torrent", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const hash = "4".repeat(40);
    registry.register({
      id: "episodes", name: "Episodes", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "episodes", type: "magnet", magnet: `magnet:?xt=urn:btih:${hash}`, fileIndex: 2 },
        { providerId: "episodes", type: "magnet", magnet: `magnet:?xt=urn:btih:${hash}`, fileIndex: 3 }
      ])
    });
    const episode = { id: "tt1234567:1:2", kind: "episode" as const, title: "",
      externalIds: { imdb: "tt1234567" }, season: 1, episode: 2,
      stremio: { type: "series", videoId: "tt1234567:1:2" } };
    const streams = await new StreamResolver(registry, policy).resolve(episode);
    expect(streams.map((source) => source.fileIndex)).toEqual([2, 3]);
  });

  it("probes validated direct candidates through a supplied transport before final ranking", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({
      id: "mixed", name: "Mixed", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "mixed", type: "magnet", magnet: `magnet:?xt=urn:btih:${"e".repeat(40)}`,
          quality: "1080p", sizeBytes: 8 * 1024 ** 3, seeds: 20 },
        { providerId: "mixed", type: "https", url: "https://media.example/video.mp4",
          quality: "1080p", sizeBytes: 8 * 1024 ** 3 }
      ])
    });
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Range": "bytes 0-0/1", "Content-Type": "video/mp4" }
    }));
    const transport: OutboundTransport = {
      id: "fake", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    const directProbe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 100, maxCandidates: 2, maxConcurrent: 1
    }, silentLogger);
    const streams = await new StreamResolver(registry, policy, directProbe).resolve(item);
    expect(request).toHaveBeenCalledOnce();
    expect(streams[0]?.type).toBe("https");
    expect(streams[0]?.directHttp).toMatchObject({ verified: true, rangeSupported: true });
  });

  it("keeps verified 720p and 480p HTTPS together above ten weak 1080p torrents", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "mixed-ranking", name: "Mixed ranking", isEnabled: () => true,
      resolve: () => Promise.resolve([
        ...(["720p", "480p"] as const).map((quality) => ({
          providerId: "mixed-ranking", type: "https" as const,
          url: `https://media.example/${quality}.mp4`, quality, sizeBytes: 1024 ** 3
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          providerId: "mixed-ranking", type: "magnet" as const,
          magnet: `magnet:?xt=urn:btih:${(index + 1).toString(16).padStart(40, "0")}`,
          quality: "1080p", seeds: index % 5 + 1, sizeBytes: 5 * 1024 ** 3
        }))
      ])
    });
    const transport: OutboundTransport = {
      id: "fixture",
      request: fixtureOutboundRequest(() => Promise.resolve(new Response(new Uint8Array([1]), {
        status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/1024" }
      }))),
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    const probe = new DirectStreamProbe(transport,
      { enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 2 }, silentLogger);
    const ranking: Array<{ transport: string; score: number; providerId?: string }> = [];
    const streams = await new StreamResolver(registry, policy, probe, {
      stage: () => undefined,
      ranking: (candidates) => ranking.push(...candidates)
    }).resolve(item);
    expect(streams).toHaveLength(12);
    expect(streams.slice(0, 2).map((source) => source.type)).toEqual(["https", "https"]);
    expect(streams.slice(0, 2).map((source) => source.quality)).toEqual(["720p", "480p"]);
    expect(streams.slice(2).every((source) => source.type === "magnet")).toBe(true);
    expect(ranking[0]).toMatchObject({ transport: "https", providerId: "mixed-ranking" });
    expect(ranking[0]?.score).toBeGreaterThan(ranking[2]?.score ?? 0);
    expect(JSON.stringify(ranking)).not.toContain("media.example");
  });

  it("retains a known direct video after timeout, 503 or 429, but excludes a completed 404", async () => {
    const url = "https://media.example/video.mp4";
    const timedOut = directProbeFor(new DOMException("timed out", "TimeoutError"));
    const uncertain = await new StreamResolver(opaqueRegistry(url), policy, timedOut.probe).resolve(item);
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.directHttp).toMatchObject({ status: "timeout", verified: false });
    const temporaryNetwork = directProbeFor(new Error("connection reset"));
    const networkRetained = await new StreamResolver(opaqueRegistry(url), policy, temporaryNetwork.probe).resolve(item);
    expect(networkRetained).toHaveLength(1);
    expect(networkRetained[0]?.directHttp).toMatchObject({ status: "unreachable", verified: false });
    const transient = directProbeFor(new Response(null, { status: 503 }));
    const retained = await new StreamResolver(opaqueRegistry(url), policy, transient.probe).resolve(item);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.directHttp).toMatchObject({ responseStatus: 503, verified: false });
    const rateLimited = directProbeFor(new Response(null, { status: 429 }));
    const retryable = await new StreamResolver(opaqueRegistry(url), policy, rateLimited.probe).resolve(item);
    expect(retryable).toHaveLength(1);
    expect(retryable[0]?.directHttp).toMatchObject({ responseStatus: 429, verified: false });
    const missing = directProbeFor(new Response(null, { status: 404 }));
    await expect(new StreamResolver(opaqueRegistry(url), policy, missing.probe).resolve(item)).resolves.toEqual([]);
  });

  it("excludes a known MP4 path after an explicit HTTP 428 probe failure", async () => {
    const { probe } = directProbeFor(new Response(null, { status: 428 }));
    const streams = await new StreamResolver(opaqueRegistry("https://media.example/video.mp4"), policy, probe).resolve(item);
    expect(streams).toEqual([]);
  });

  it("keeps prioritized probing bounded while rejecting bad and unprobed siblings", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "priority", name: "Priority", isEnabled: () => true,
      resolve: () => Promise.resolve([
        { providerId: "priority", type: "https", url: "https://media.example/opaque" },
        { providerId: "priority", type: "https", url: "https://media.example/bad.mp4" },
        { providerId: "priority", type: "https", url: "https://media.example/good.mp4" },
        { providerId: "priority", type: "https", url: "https://media.example/late.mp4" }
      ]) });
    const request = vi.fn<FixtureOutboundRequest>().mockImplementation((outbound) => Promise.resolve(
      outbound.url.endsWith("bad.mp4") ? new Response(null, { status: 404 })
        : new Response(new Uint8Array(16), { status: 206,
          headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "video/mp4" } })
    ));
    const transport: OutboundTransport = { id: "fake", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 }) };
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 500, maxCandidates: 1, maxConcurrent: 1
    }, silentLogger);
    const rejection = vi.fn();
    const streams = await new StreamResolver(registry, policy, probe, { stage: () => undefined, rejection }).resolve(item);
    expect(rejection).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([outbound]) => outbound.url)).toEqual([
      "https://media.example/bad.mp4", "https://media.example/good.mp4"
    ]);
    expect(streams.map(({ url }) => url)).toEqual(["https://media.example/good.mp4"]);
    expect(probe.diagnostics().requests).toBe(2);
  });

  it("excludes a slice-expired video filename while admitting a later verified candidate", async () => {
    vi.useFakeTimers();
    try {
      const registry = new StreamProviderRegistry(100, silentLogger);
      registry.register({ id: "budget", name: "Budget fixture", isEnabled: () => true,
        resolve: () => Promise.resolve([
          { providerId: "budget", type: "https", url: "https://media.example/first.mp4" },
          { providerId: "budget", type: "https", url: "https://media.example/second.mp4" }
        ]) });
      let markStarted = (): void => undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const request = vi.fn<FixtureOutboundRequest>().mockImplementation((_outbound, signal) => {
        if (request.mock.calls.length > 1) return Promise.resolve(new Response(new Uint8Array(16), {
          status: 206, headers: { "Content-Range": "bytes 0-15/100", "Content-Type": "video/mp4" }
        }));
        markStarted();
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(
          signal.reason instanceof Error ? signal.reason : new Error("probe aborted")
        ), { once: true }));
      });
      const transport: OutboundTransport = { id: "fixture", request: fixtureOutboundRequest(request),
        diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) };
      const probe = new DirectStreamProbe(transport, {
        enabled: true, timeoutMs: 50, maxCandidates: 2, maxConcurrent: 1
      }, silentLogger);
      const pending = new StreamResolver(registry, policy, probe).resolve(item);
      await started;
      await vi.advanceTimersByTimeAsync(50);
      expect((await pending).map(({ url }) => url)).toEqual(["https://media.example/second.mp4"]);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes a misleading MKV after a valid byte range exposes ZIP payload bytes", async () => {
    const { probe, request } = directProbeFor(new Response(new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]), { status: 206, headers: {
      "Content-Range": "bytes 0-15/920441036", "Content-Type": "application/x-zip"
    } }));
    const streams = await new StreamResolver(opaqueRegistry("https://media.example/movie.mkv"), policy, probe).resolve(item);
    expect(request).toHaveBeenCalledOnce();
    expect(streams).toEqual([]);
  });

  it("keeps known video filenames with non-ZIP bytes despite generic or absent MIME", async () => {
    for (const contentType of ["video/mp4", "application/octet-stream", "application/x-zip", undefined]) {
      const headers = { "Content-Range": "bytes 0-15/920441036",
        ...(contentType ? { "Content-Type": contentType } : {}) };
      const { probe } = directProbeFor(new Response(new Uint8Array(16), { status: 206, headers }));
      const streams = await new StreamResolver(opaqueRegistry("https://media.example/movie.mkv"), policy, probe).resolve(item);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.directHttp).toMatchObject({ verified: true, rangeSupported: true, responseStatus: 206 });
      expect(streams[0]?.directHttp?.archiveFormat).toBeUndefined();
    }
  });

  it("keeps a recognised direct video path without requiring a probe", async () => {
    const streams = await new StreamResolver(opaqueRegistry("https://media.example/video.mp4"), policy).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.url).toBe("https://media.example/video.mp4");
  });

  it("rejects opaque direct URLs when the probe is disabled", async () => {
    const { probe, request } = directProbeFor(new Response(null, { status: 200 }), false);
    await expect(new StreamResolver(opaqueRegistry(), policy, probe).resolve(item)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("admits HLS after Range 403 and a successful no-Range playlist and media path", async () => {
    const { probe, request } = directProbeFor([
      new Response(null, { status: 403 }),
      new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }),
      new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp2t" } })
    ]);
    const streams = await new StreamResolver(opaqueRegistry(), policy, probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.directHttp).toMatchObject({ status: "verified", hls: true, verified: true, rangeSupported: false });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("admits opaque video media after Range 416 and a successful no-Range GET", async () => {
    const { probe, request } = directProbeFor([
      new Response(null, { status: 416 }),
      new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp4" } })
    ]);
    const streams = await new StreamResolver(opaqueRegistry(), policy, probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.directHttp).toMatchObject({ status: "reachable", verified: false, rangeSupported: false, responseStatus: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["403", () => new Response(null, { status: 403 })],
    ["404", () => new Response(null, { status: 404 })],
    ["HTML", () => new Response("<html>error</html>", { headers: { "Content-Type": "video/mp4" } })],
    ["JSON", () => new Response('{"error":true}', { headers: { "Content-Type": "video/mp4" } })],
    ["ZIP", () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { "Content-Type": "video/mp4" } })]
  ] as const)("rejects a known video URL when the Range compatibility fallback provides %s", async (_label, response) => {
    const { probe, request } = directProbeFor([new Response(null, { status: 403 }), response()]);
    await expect(new StreamResolver(opaqueRegistry("https://media.example/video.mp4"), policy, probe).resolve(item)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a probed HLS playlist in the final stream output without treating it as an MP4", async () => {
    const { probe } = directProbeFor([
      new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response(new Uint8Array([0]), { status: 200, headers: { "Content-Type": "video/mp2t" } })
    ]);
    const streams = await new StreamResolver(opaqueRegistry("https://media.example/live/index.m3u8"), policy, probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.directHttp).toMatchObject({ hls: true, verified: true, rangeSupported: false });
  });

  it.each([
    "https://media.example/live/index.m3u8",
    "https://media.example/live/index.mp4"
  ])("excludes %s when early HLS media works but the later segment fails", async (url) => {
    const { probe, request } = directProbeFor([
      new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response("#EXTM3U\n#EXTINF:4,\nearly.ts\n#EXTINF:4,\nlater.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "video/mp2t" } }),
      new Response(null, { status: 404 })
    ]);
    await expect(new StreamResolver(opaqueRegistry(url), policy, probe).resolve(item)).resolves.toEqual([]);
    expect(request.mock.calls.map(([outbound]) => new URL((outbound as { url: string }).url).pathname)).toEqual([
      new URL(url).pathname, "/live/media.m3u8", "/live/early.ts", "/live/later.ts"
    ]);
  });

  it("admits a media playlist after early and later segments both provide media", async () => {
    const { probe, request } = directProbeFor([
      new Response("#EXTM3U\n#EXTINF:4,\nearly.ts\n#EXTINF:4,\nlater.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "video/mp2t" } }),
      new Response(new Uint8Array([2]), { status: 200, headers: { "Content-Type": "video/mp2t" } })
    ]);
    const streams = await new StreamResolver(opaqueRegistry("https://media.example/live/index.m3u8"), policy, probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.directHttp).toMatchObject({ hls: true, verified: true });
    expect(request.mock.calls.map(([outbound]) => new URL((outbound as { url: string }).url).pathname)).toEqual([
      "/live/index.m3u8", "/live/early.ts", "/live/later.ts"
    ]);
  });

  it("admits a master playlist only after its variant progresses through media segments", async () => {
    const { probe, request } = directProbeFor([
      new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant/media.m3u8", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response("#EXTM3U\n#EXTINF:4,\nfirst.ts\n#EXTINF:4,\nlast.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "video/mp2t" } }),
      new Response(new Uint8Array([2]), { status: 200, headers: { "Content-Type": "video/mp2t" } })
    ]);
    const streams = await new StreamResolver(opaqueRegistry("https://media.example/master.m3u8"), policy, probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.directHttp).toMatchObject({ hls: true, verified: true });
    expect(request.mock.calls.map(([outbound]) => new URL((outbound as { url: string }).url).pathname)).toEqual([
      "/master.m3u8", "/variant/media.m3u8", "/variant/first.ts", "/variant/last.ts"
    ]);
  });

  it("excludes HLS when the later segment returns HTML instead of media", async () => {
    const { probe, request } = directProbeFor([
      new Response("#EXTM3U\n#EXTINF:4,\nearly.ts\n#EXTINF:4,\nlater.ts", {
        status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      }),
      new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "video/mp2t" } }),
      new Response("<html>expired</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    ]);
    await expect(new StreamResolver(opaqueRegistry("https://media.example/live/index.m3u8"), policy, probe).resolve(item))
      .resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not use a video filename to admit an HLS URL after its playlist probe fails", async () => {
    const { probe } = directProbeFor(new Response("not a playlist", {
      status: 200, headers: { "Content-Type": "video/mp4" }
    }));
    await expect(new StreamResolver(
      opaqueRegistry("https://media.example/live/index.m3u8", "movie.mp4"), policy, probe
    ).resolve(item)).resolves.toEqual([]);
  });

  it.each([
    ["200 video with parameters", 200, { "Content-Type": "video/mp4; charset=binary" }, false],
    ["206 upper-case video", 206, { "Content-Type": "VIDEO/MP4", "Content-Range": "bytes 0-0/9" }, true]
  ])("admits opaque direct URLs after %s", async (_name, status, headers, rangeSupported) => {
    const body = status === 206 ? new Uint8Array([0]) : null;
    const { probe } = directProbeFor(new Response(body, { status, headers }));
    const streams = await new StreamResolver(opaqueRegistry(), policy, probe).resolve(item);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      providerId: "opaque", type: "https",
      directHttp: { contentType: "video/mp4", responseStatus: status, rangeSupported }
    });
  });

  it.each([
    ["text/html", { "Content-Type": "text/html" }],
    ["application/json", { "Content-Type": "application/json" }],
    ["missing MIME", {}],
    ["octet stream", { "Content-Type": "application/octet-stream" }]
  ])("rejects opaque URLs with %s", async (_name, headers) => {
    const { probe } = directProbeFor(new Response(null, { status: 200, headers }));
    await expect(new StreamResolver(opaqueRegistry(), policy, probe).resolve(item)).resolves.toEqual([]);
  });

  it("rejects dangerous explicit filenames and URL paths before probing", async () => {
    const { probe, request } = directProbeFor(new Response(null, { status: 200, headers: { "Content-Type": "video/mp4" } }));
    await expect(new StreamResolver(opaqueRegistry("https://media.example/opaque-token", "movie.exe"), policy, probe).resolve(item))
      .resolves.toEqual([]);
    await expect(new StreamResolver(opaqueRegistry("https://media.example/payload.exe"), policy, probe).resolve(item))
      .resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects opaque direct URLs when their probe times out", async () => {
    const { probe } = directProbeFor(new DOMException("timed out", "TimeoutError"));
    await expect(new StreamResolver(opaqueRegistry(), policy, probe).resolve(item)).resolves.toEqual([]);
  });

  it("reuses cached MIME evidence when resolving the same opaque URL", async () => {
    const { probe, request } = directProbeFor(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/9" }
    }));
    const resolver = new StreamResolver(opaqueRegistry(), policy, probe);
    await expect(resolver.resolve(item)).resolves.toHaveLength(1);
    await expect(resolver.resolve(item)).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledOnce();
    expect(probe.diagnostics()).toMatchObject({ cacheHits: 1, requests: 1 });
  });

  it("admits a public redirect only after DirectTransport revalidates its final video response", async () => {
    const pinned = vi.fn<PinnedRequest>().mockImplementation((target) => {
      if (target.url.hostname === "media.example") {
        return Promise.resolve(new Response(null, {
          status: 302, headers: { Location: "https://cdn.example/download/opaque-token" }
        }));
      }
      return Promise.resolve(new Response(new Uint8Array([0]), {
        status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/9" }
      }));
    });
    const direct = new DirectTransport(policy, strictPrivacy, silentLogger, pinned);
    const probe = new DirectStreamProbe(direct, { enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 1 }, silentLogger);
    await expect(new StreamResolver(opaqueRegistry(), policy, probe).resolve(item)).resolves.toHaveLength(1);
    expect(pinned).toHaveBeenCalledTimes(2);
    expect(pinned.mock.calls.map(([target]) => target.url.hostname)).toEqual(["media.example", "cdn.example"]);
  });

  it.each([
    ["blocked redirect target", "http://127.0.0.1/private", 1],
    ["redirect traversal limit", "https://media.example/video.mp4", 4],
    ["missing redirect destination", undefined, 1],
    ["invalid redirect destination", "http://[", 1]
  ])("rejects a known video filename after %s", async (_reason, location, requests) => {
    const pinned = vi.fn<PinnedRequest>().mockImplementation(() => Promise.resolve(new Response(null, {
      status: 302, ...(location ? { headers: { Location: location } } : {})
    })));
    const direct = new DirectTransport(policy, strictPrivacy, silentLogger, pinned);
    const probe = new DirectStreamProbe(direct, { enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 1 }, silentLogger);
    const candidate = { providerId: "opaque", type: "https" as const, url: "https://media.example/video.mp4" };
    const observed = await probe.probe([candidate]);
    expect(observed[0]?.directHttp).toMatchObject({
      status: "route_rejected", verified: false, rangeSupported: false
    });
    expect(observed[0]?.directHttp?.responseStatus).toBeUndefined();
    await expect(new StreamResolver(opaqueRegistry(candidate.url), policy, probe).resolve(item)).resolves.toEqual([]);
    expect(pinned).toHaveBeenCalledTimes(requests);
  });

  it.each(["sparse", "title concern", "independent ID", "original resource"] as const)(
    "preserves only qualified UNKNOWN after a blocked redirect: %s", async evidence => {
      const pinned = vi.fn<PinnedRequest>().mockResolvedValue(new Response(null, {
        status: 302, headers: { Location: "http://127.0.0.1/private/S03E04.mp4" }
      }));
      const direct = new DirectTransport(policy, strictPrivacy, silentLogger, pinned);
      const probe = new DirectStreamProbe(direct, { enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 1 }, silentLogger);
      const registry = new StreamProviderRegistry(100, silentLogger);
      registry.register({ id: "blocked", name: "Blocked", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "blocked", type: "https",
          url: evidence === "original resource" ? "https://media.example/Movie.1994.mp4" : "https://media.example/opaque",
          ...(evidence === "title concern" ? { metadata: { identity: { title: "Other Work", year: 1994 } } }
            : evidence === "independent ID" ? { metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } } : {}) }]) });
      let observed: NormalizedStreamSource | undefined;
      const resolver = new StreamResolver(registry, policy, probe, { stage: (stage, sources) => {
        if (stage === "probed") observed = sources[0];
      } });
      await expect(resolver.resolve({ ...item, year: 1994, externalIds: { imdb: "tt9999999999" } })).resolves.toEqual([]);
      expect(observed).toBeDefined();
      expect(getBridgeIdentityState(observed!)).toBe(evidence === "sparse" ? "UNKNOWN" : undefined);
      expect(resolver.diagnostics()[0]?.identityRejections).toBe(0);
      expect(pinned).toHaveBeenCalledOnce();
    }
  );

  it("queries every enabled provider beyond the execution limit", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger, 2);
    const queried: string[] = [];
    for (const id of ["one", "two", "three", "four", "five"]) {
      registry.register({ id, name: id, isEnabled: () => true, resolve: () => { queried.push(id); return Promise.resolve([]); } });
    }
    expect(registry.active()).toHaveLength(5);
    await registry.resolveAll(item);
    expect(queried).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("limits simultaneous provider executions without limiting independent resolves", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger, 2);
    let running = 0;
    let peak = 0;
    const queried: string[] = [];
    for (const id of ["one", "two", "three", "four", "five"]) {
      registry.register({ id, name: id, isEnabled: () => true, resolve: async () => {
        queried.push(id); running += 1; peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return [];
      } });
    }
    await Promise.all([registry.resolveAll(item), registry.resolveAll(item)]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(queried).toHaveLength(10);
  });

  it("continues queued providers after a failure or timeout", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger, 1);
    const queried: string[] = [];
    registry.register({ id: "fails", name: "Fails", isEnabled: () => true, resolve: () => {
      queried.push("fails"); return Promise.reject(new Error("fixture failure"));
    } });
    registry.register({ id: "times-out", name: "Times out", isEnabled: () => true, timeoutMs: 5, resolve: () => {
      queried.push("times-out"); return new Promise(() => undefined);
    } });
    registry.register({ id: "queued", name: "Queued", isEnabled: () => true, resolve: () => {
      queried.push("queued"); return Promise.resolve([]);
    } });
    await expect(registry.resolveAll(item)).resolves.toEqual([]);
    expect(queried).toEqual(["fails", "times-out", "queued"]);
    expect(registry.status().filter((entry) => entry.status === "error").map((entry) => entry.id)).toEqual(["fails", "times-out"]);
  });
});
