import { describe, expect, it, vi } from "vitest";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { DirectTransport } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { observePipeline, publicIdentityState } from "./identity-qa/harness";
import { silentLogger, testConfig } from "./helpers";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };
const provider = (id: string, sources: Omit<NormalizedStreamSource, "providerId">[]): StreamProvider => ({
  id, name: "Synthetic provider", isEnabled: () => true,
  resolve: () => Promise.resolve(sources.map(source => ({ ...source, providerId: id })))
});
async function fixture(run: (upstream: DirtyUpstream) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  try { await run(upstream); } finally { await upstream.close(); }
}
function media(upstream: DirtyUpstream, name: string, seconds = 6420): string {
  return upstream.media(`/media/${name}`, { body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor" });
}

describe("conservative admitted UNKNOWN through resolver, probe and createAddon", () => {
  it.each(["qualified", "presentation", "missing-year", "matching-title", "id", "wrong-id",
    "wrong-year", "wrong-kind", "wrong-runtime", "resource-year", "document"] as const)(
    "structured title concern keeps %s admission and confidence boundaries", async mode => {
    await fixture(async upstream => {
      const name = mode === "resource-year" ? "opaque.1987.mp4" : "opaque.mp4";
      const mediaUrl = mode === "document" ? upstream.media(`/media/${name}`, {
        body: "<html>synthetic document</html>", contentType: "text/html" })
        : media(upstream, name, mode === "wrong-runtime" ? 1200 : 6420);
      const url = mediaUrl + "?token=synthetic-title-private-query";
      upstream.allowMediaUrl(url);
      const sibling = media(upstream, "healthy.mp4");
      const identity = { title: mode === "matching-title" ? movie.title : "Synthetic Aurora",
        ...(mode === "missing-year" ? {} : { year: mode === "wrong-year" ? 1987 : 1994 }),
        ...(mode === "wrong-kind" ? { kind: "series" } : {}),
        ...(["id", "wrong-id"].includes(mode) ? { externalIds: {
          imdb: mode === "id" ? movie.id : "tt8888888888" } } : {}) };
      const rejected = ["wrong-id", "wrong-year", "wrong-kind", "wrong-runtime", "resource-year", "document"].includes(mode);
      const expected = mode === "qualified" ? "SUSPICIOUS"
        : ["presentation", "matching-title"].includes(mode) ? "UNKNOWN"
        : mode === "wrong-runtime" ? "CONTRADICTION" : undefined;
      const observed = await observePipeline(movie, upstream, [provider("title", [{ type: "http", url,
        title: "Serie Aurora Sintetica", ...(mode === "presentation" ? {} : { metadata: { identity,
          identityState: "CORROBORATED", independent: true } }) }, { type: "http", url: sibling }])], {
        target: { providerId: "title", url }, sensitiveValues: ["synthetic-title-private-query"],
        inspect: ({ publicSources, snapshots }) => {
          const target = snapshots.get("probed")?.find(source => source.url === url);
          const entry = publicSources.find(entry => entry.source.url === url);
          expect(publicSources.some(entry => entry.source.url === sibling)).toBe(true);
          expect(Boolean(entry)).toBe(!rejected);
          if (target) expect(getBridgeIdentityState(target)).toBe(expected);
          if (entry) expect(publicIdentityState(entry.stream)).toBe(expected ?? "NOT_OBSERVABLE");
        }
      });
      expect(observed.dimensions).toMatchObject({ publicPrivacy: true, observerPrivacy: true, tracePrivacy: true,
        identityRejections: rejected && mode !== "document" ? 1 : 0 });
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
      expect(upstream.count(`/media/${name}`)).toBe(["wrong-id", "wrong-year", "wrong-kind", "resource-year"].includes(mode) ? 0 : 1);
    });
  });

  it.each(["10", "16", "38"])("%s: neutral claims reach the final source and corresponding public stream", async caseId => {
    await fixture(async upstream => {
      const item = caseId === "10" ? movie : episode;
      const url = media(upstream, "opaque.mp4", caseId === "10" ? 6420 : 1800);
      const identity = caseId === "10" ? { title: movie.title, year: movie.year }
        : { kind: "series", season: 2, episode: 9 };
      const observed = await observePipeline(item, upstream, [provider("neutral", [{ type: "http", url,
        title: caseId === "38" ? "Serie Azul Sintetica" : caseId === "10" ? movie.title : "Server 1",
        metadata: { identity } }])], { sensitiveValues: ["Synthetic Meridian", "Serie Azul Sintetica"],
        inspect: ({ snapshots, publicSources, rejections, ranking }) => {
        expect(publicSources).toHaveLength(1);
        const entry = publicSources[0]!;
        expect(snapshots.get("final")).toEqual([entry.source]);
        expect(getBridgeIdentityState(entry.source)).toBe("UNKNOWN");
        expect(publicIdentityState(entry.stream)).toBe("UNKNOWN");
        expect(entry.source.metadata?.identity).toEqual(identity);
        expect(entry.stream.url).toMatch(/^http:\/\/127\.0\.0\.1:7000\/source\/[A-Za-z0-9_-]{32}\/stream.mp4$/);
        expect(rejections).toEqual([]);
        expect(ranking).toHaveLength(1);
      } });
      expect(observed.probeRequests).toBe(1);
      expect(observed.stages).toEqual({ provider: 1, normalized: 1, deduplicated: 1, probed: 1, admitted: 1, final: 1 });
      expect(observed.dimensions).toMatchObject({ identityState: "UNKNOWN", publicIdentityState: "UNKNOWN",
        identityRejections: 0, probe: "VERIFIED", publicPrivacy: true });
    });
  });

  // Risk: a neutral representative erases a discarded equivalent origin's qualified concern.
  it.each([false, true])("preserves qualified title concern and baseline tie selection (reverse=%s)", async reverse => {
    await fixture(async upstream => {
      const url = media(upstream, "opaque.mp4");
      const neutral = provider("neutral", [{ type: "http", url, metadata: { identity: { title: movie.title, year: 1994 } } }]);
      const concern = provider("concern", [{ type: "http", url, metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }]);
      const observed = await observePipeline(movie, upstream, reverse ? [concern, neutral] : [neutral, concern], {
        inspect: ({ publicSources, snapshots, rejections }) => {
          expect(publicSources).toHaveLength(1);
          expect(publicSources[0]!.source.providerId).toBe(reverse ? "concern" : "neutral");
          expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("SUSPICIOUS");
          expect(publicIdentityState(publicSources[0]!.stream)).toBe("SUSPICIOUS");
          expect(snapshots.get("normalized")).toHaveLength(2);
          expect(rejections).toEqual([]);
        }
      });
      expect(observed.probeRequests).toBe(1);
      expect(upstream.count("/media/opaque.mp4")).toBe(1);
    });
  });

  // Provider flags cannot corroborate IDs or erase a pending title concern.
  it.each([
    { externalIds: { imdb: movie.id } },
    { externalIds: { tmdb: "12345" } },
    { title: "Synthetic Aurora" }
  ])("does not corroborate claims despite provider-controlled confidence/provenance", async identity => {
    await fixture(async upstream => {
      const url = media(upstream, "opaque.mp4");
      await observePipeline(movie, upstream, [provider("spoof", [{ type: "http", url,
        metadata: { identity, identityState: "UNKNOWN", independent: true, provenance: "RESOURCE_IDENTITY" },
        directHttp: { status: "verified", verified: true, rangeSupported: true } }])], {
        inspect: ({ publicSources }) => {
          expect(publicSources).toHaveLength(1);
          expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("externalIds" in identity ? "UNKNOWN" : undefined);
          expect(publicIdentityState(publicSources[0]!.stream)).toBe("externalIds" in identity ? "UNKNOWN" : "NOT_OBSERVABLE");
        }
      });
      expect(upstream.count("/media/opaque.mp4")).toBe(1);
    });
  });

  // Risk: late redirect evidence or measured rejection is hidden by an early neutral claim.
  it.each(["query", "coordinates", "runtime"])("neutral claims cannot hide %s evidence or remove a healthy sibling", async mode => {
    await fixture(async upstream => {
      const effectiveName = mode === "runtime" ? "Synthetic.Meridian.1994.mp4"
        : mode === "coordinates" ? "Synthetic.Blue.Series.S03E04.mp4" : "Synthetic.Blue.Series.S02E09.mp4";
      const effective = media(upstream, effectiveName, mode === "runtime" ? 1200 : 1800);
      const destination = effective + (mode === "query" ? "?token=synthetic-private-query" : "");
      upstream.allowMediaUrl(destination);
      const url = upstream.media("/media/gateway", { redirectTo: destination });
      const sibling = media(upstream, "healthy.mp4", mode === "runtime" ? 6420 : 1800);
      const item = mode === "runtime" ? movie : episode;
      const observed = await observePipeline(item, upstream, [provider("mixed", [
        { type: "http", url, metadata: { identity: mode === "runtime" ? { title: movie.title, year: 1994 }
          : { kind: "series", season: 2, episode: 9 } } },
        { type: "http", url: sibling }
      ])], { target: { providerId: "mixed", url }, sensitiveValues: ["synthetic-private-query"],
        inspect: ({ publicSources, snapshots }) => {
          const target = snapshots.get("probed")!.find(source => source.url === url)!;
          const survives = publicSources.find(entry => entry.source.url === url);
          // Claimed origins still block resource confidence; never falsely neutralize the cap.
          if (mode === "query") {
            expect(getBridgeIdentityState(target)).toBeUndefined();
            expect(publicIdentityState(survives?.stream)).toBe("NOT_OBSERVABLE");
          } else {
            expect(getBridgeIdentityState(target)).toBe("CONTRADICTION");
            expect(survives).toBeUndefined();
          }
          expect(publicSources.map(entry => entry.source.url)).toEqual(mode === "query" ? [url, sibling] : [sibling]);
        }
      });
      expect(observed.probeRequests).toBe(2);
      expect(upstream.count("/media/gateway")).toBe(1);
      expect(upstream.count(`/media/${effectiveName}`)).toBe(1);
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
      expect(observed.dimensions.identityRejections).toBe(mode === "query" ? 0 : 1);
      expect(observed.dimensions.publicPrivacy).toBe(true);
    });
  });

  it("retains exact outcomes, ranking, requests and routing with identity instrumentation OFF/ON", async () => {
    await fixture(async upstream => {
      const urls = [media(upstream, "first.mp4"), media(upstream, "second.mp4")];
      const providers = [provider("neutral", [{ type: "http", url: urls[0]!, quality: "1080p",
        metadata: { identity: { title: "Synthetic Aurora", year: 1994 } } }]),
      provider("healthy", [{ type: "http", url: urls[1]!, quality: "720p" }])];
      const outcomes: unknown[] = [];
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        for (const identityTrace of [false, true]) {
          const observed = await observePipeline(movie, upstream, providers, { identityTrace, inspect: ({ publicSources, ranking }) => {
            expect(publicSources.map(entry => entry.source.url)).toEqual(urls);
            outcomes.push({ ranking, sources: publicSources.map(entry => ({ source: entry.source,
              state: getBridgeIdentityState(entry.source), stream: { ...entry.stream,
                url: entry.stream.url.replace(/\/source\/[A-Za-z0-9_-]{32}\//, "/source/OPAQUE/") } })) });
          } });
          expect(observed.probeRequests).toBe(2);
          expect(observed.dimensions.identityRejections).toBe(0);
        }
      } finally { clock.mockRestore(); }
      expect(outcomes[1]).toEqual(outcomes[0]);
      for (const name of ["first", "second"]) expect(upstream.count(`/media/${name}.mp4`)).toBe(2);
    });
  });

  it("reclassifies a neutral title claim under another requested identity on cached probe replay", async () => {
    await fixture(async upstream => {
      const url = media(upstream, "opaque.mp4");
      const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: [url] });
      const probe = new DirectStreamProbe(new DirectTransport(policy, testConfig().httpPrivacy, silentLogger),
        { enabled: true, timeoutMs: 1000, maxCandidates: 1, maxConcurrent: 1 }, silentLogger);
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register(provider("neutral", [{ type: "http", url, metadata: { identity: { title: movie.title, year: 1994 } } }]));
      const resolver = new StreamResolver(registry, policy, probe);
      const first = await resolver.resolve(movie);
      expect(first.map(source => source.url)).toEqual([url]);
      expect(first.map(getBridgeIdentityState)).toEqual(["UNKNOWN"]);
      const other = await resolver.resolve({ ...movie, id: "tt8888888888", title: "Synthetic Aurora",
        externalIds: { imdb: "tt8888888888" } });
      expect(other.map(source => source.url)).toEqual([url]);
      expect(other.map(getBridgeIdentityState)).toEqual(["SUSPICIOUS"]);
      expect(probe.diagnostics()).toMatchObject({ requests: 1, cacheHits: 1 });
      expect(upstream.count("/media/opaque.mp4")).toBe(1);
      expect(first.map(getBridgeIdentityState)).toEqual(["UNKNOWN"]);
      expect(registry.status()[0]?.identityRejections).toBe(0);
    });
  });

  it("publishes UNKNOWN for Case 20's compatible year without a canonical title anchor", async () => {
    await fixture(async upstream => {
      const url = media(upstream, "opaque.1994.mp4");
      const observed = await observePipeline(movie, upstream, [provider("year", [{ type: "http", url }])], {
        inspect: ({ publicSources }) => {
          expect(publicSources).toHaveLength(1);
          const entry = publicSources[0]!;
          expect(entry.source.directHttp?.movieResource).toMatchObject({ year: 1994, source: "effective_root" });
          expect(getBridgeIdentityState(entry.source)).toBe("UNKNOWN");
          expect(publicIdentityState(entry.stream)).toBe("UNKNOWN");
        }
      });
      expect(observed.probeRequests).toBe(1);
      expect(observed.dimensions.identityRejections).toBe(0);
    });
  });
});
