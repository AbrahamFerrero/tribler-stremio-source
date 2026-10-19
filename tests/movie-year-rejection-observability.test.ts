import { describe, expect, it, vi } from "vitest";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver, type StreamRejection } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { DirectTransport } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { IdentityDiagnostics } from "../src/qa/identity-diagnostics";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { fixturePrivacySafe, observePipeline } from "./identity-qa/harness";
import { silentLogger, testConfig } from "./helpers";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const provider = (id: string, sources: Omit<NormalizedStreamSource, "providerId">[]): StreamProvider => ({
  id, name: "Synthetic fixture", isEnabled: () => true,
  resolve: () => Promise.resolve(sources.map(source => ({ ...source, providerId: id })))
});
async function fixture(run: (upstream: DirtyUpstream) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  try { await run(upstream); } finally { await upstream.close(); }
}
const media = (upstream: DirtyUpstream, name: string) => upstream.media(`/media/${name}`, {
  body: mp4Fixture(6420), contentType: "video/mp4", range: "honor"
});

describe("bounded original movie-year rejection observations (integration)", () => {
  it.each(["18", "05-negative", "filename"])("%s: observes the actual pre-probe reject with a healthy public sibling", async caseId => {
    await fixture(async upstream => {
      const name = caseId === "18" ? "opaque.1987.mp4" : "Synthetic.Meridian.1987.mp4";
      const wrong = media(upstream, caseId === "filename" ? "opaque.mp4" : name);
      const healthy = media(upstream, "healthy.mp4");
      const observed = await observePipeline(movie, upstream, [provider("year", [
        { type: "http", url: wrong, ...(caseId === "filename" ? { filename: name } : {}) },
        { type: "http", url: healthy }
      ])], { target: { providerId: "year", url: wrong }, sensitiveValues: [name],
        probeOptions: { maxCandidates: 1, maxConcurrent: 1 },
        inspect: ({ preProbeDecisions, rejections, publicSources, snapshots, review }) => {
          expect(rejections).toHaveLength(1);
          const event = rejections[0]!;
          expect(event).toEqual({ candidate: {}, stage: "normalized", reason: "MOVIE_YEAR_CONFLICT", identityState: "CONTRADICTION" });
          expect(Object.isFrozen(event.candidate)).toBe(true);
          expect(Reflect.ownKeys(event.candidate)).toEqual([]);
          expect(preProbeDecisions.find(entry => entry.candidate === event.candidate)).toEqual({
            candidate: event.candidate, stage: "normalized", decision: "REJECT", identityState: "CONTRADICTION"
          });
          expect(publicSources.map(entry => entry.source.url)).toEqual([healthy]);
          expect(snapshots.get("final")![0]).toBe(publicSources[0]!.source);
          expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("UNKNOWN");
          expect(publicSources[0]!.stream.url).toMatch(/^http:\/\/127\.0\.0\.1:7000\/source\/[A-Za-z0-9_-]{32}\/stream.mp4$/);
          expect(review.idFor(event.candidate)).toBeUndefined();
          const diagnostics = new IdentityDiagnostics(movie, review);
          diagnostics.trace.rejection?.(event);
          expect(diagnostics.report(undefined).measuredRejections).toBe(0);
          expect(fixturePrivacySafe({ rejections, preProbeDecisions }, [wrong, name, "year"])).toBe(true);
        }
      });
      expect(observed.dimensions).toMatchObject({ identityState: "CONTRADICTION", preProbeIdentityState: "CONTRADICTION",
        publicIdentityState: "ABSENT", rejectionReason: "MOVIE_YEAR_CONFLICT", rejectionStage: "normalized",
        identityRejections: 1, probe: "NOT_REACHED", laterStagesNotReached: true, tracePrivacy: true });
      expect(observed.probeRequests).toBe(1);
      expect(upstream.count(new URL(wrong).pathname)).toBe(0);
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
    });
  });

  it.each(["opaque.1987.1994.mp4", "opaque.1987-1994.mp4", "opaque.1987.1990.mp4"])(
    "multiple/ambiguous years do not acquire rejection authority: %s", async name => {
      await fixture(async upstream => {
        const url = media(upstream, name);
        const observed = await observePipeline(movie, upstream, [provider("ambiguous", [{ type: "http", url }])], {
          inspect: ({ rejections, publicSources }) => {
            expect(rejections).toEqual([]);
            expect(publicSources.map(entry => entry.source.url)).toEqual([url]);
          }
        });
        expect(observed.dimensions.identityRejections).toBe(0);
        expect(observed.probeRequests).toBe(1);
      });
    });

  // Risk: an event claims decisive resource evidence for an unresolved producer/ID branch.
  it.each(["matching-id", "conflicting-id", "standalone-id", "incomparable-id", "structured-year", "presentation-year"])(
    "%s retains its original rejection and observes only an existing ID decision", async mode => {
      await fixture(async upstream => {
        const url = media(upstream, mode.endsWith("year") || mode === "standalone-id" ? "opaque.mp4" : "Synthetic.Meridian.1987.mp4");
        const identity = mode === "structured-year" ? { year: 1987 }
          : mode === "matching-id" ? { externalIds: { imdb: movie.id } }
          : mode === "conflicting-id" || mode === "standalone-id" ? { externalIds: { imdb: "tt8888888888" } }
          : mode === "incomparable-id" ? { externalIds: { tmdb: "12345" } } : undefined;
        const idRejected = mode === "conflicting-id" || mode === "standalone-id";
        const observed = await observePipeline(movie, upstream, [provider("pending", [{ type: "http", url,
          ...(identity ? { metadata: { identity } } : { title: "Synthetic Meridian (1987)" }) }])], {
          inspect: ({ rejections, preProbeDecisions, publicSources }) => {
            expect(rejections).toEqual(idRejected ? [{ candidate: {}, stage: "normalized",
              reason: "EXTERNAL_ID_CONFLICT", identityState: "CONTRADICTION" }] : []);
            expect(preProbeDecisions).toEqual([{ candidate: {}, stage: "normalized", decision: "REJECT",
              ...(idRejected ? { identityState: "CONTRADICTION" } : {}) }]);
            expect(publicSources).toEqual([]);
          }
        });
        expect(observed.dimensions.identityState).toBe(idRejected ? "CONTRADICTION" : "NOT_OBSERVABLE");
        expect(observed.dimensions.publicIdentityState).toBe("ABSENT");
        expect(observed.dimensions.identityRejections).toBe(1);
        expect(observed.probeRequests).toBe(0);
      });
    });

  // Risk: an equivalent external-ID copy arriving later changes whether a dispute is observed as hard.
  it.each([false, true])("equivalent ID claims suppress year observations in both arrival orders (%s)", async reverse => {
    await fixture(async upstream => {
      const wrong = media(upstream, "Synthetic.Meridian.1987.mp4");
      const healthy = media(upstream, "healthy.mp4");
      const copies = [provider("plain", [{ type: "http", url: wrong }]),
        provider("claimed", [{ type: "http", url: wrong, metadata: { identity: { externalIds: { imdb: movie.id } } } }])];
      if (reverse) copies.reverse();
      const observed = await observePipeline(movie, upstream, [...copies, provider("sibling", [{ type: "http", url: healthy }])], {
        probeOptions: { maxCandidates: 1, maxConcurrent: 1 },
        inspect: ({ rejections, publicSources, preProbeDecisions }) => {
          expect(rejections).toEqual([]);
          expect(preProbeDecisions.slice(0, 2).map(entry => entry.identityState)).toEqual([undefined, undefined]);
          expect(publicSources.map(entry => entry.source.url)).toEqual([healthy]);
        }
      });
      expect(observed.dimensions.identityRejections).toBe(2);
      expect(observed.probeRequests).toBe(1);
      expect(upstream.count("/media/Synthetic.Meridian.1987.mp4")).toBe(0);
    });
  });

  it("does not observe competing original filename/URL years as one unambiguous year", async () => {
    await fixture(async upstream => {
      const url = media(upstream, "opaque.1987.mp4");
      const observed = await observePipeline(movie, upstream, [provider("ambiguous", [{ type: "http", url,
        filename: "opaque.1994.mp4" }])], { inspect: ({ rejections, publicSources }) => {
        expect(rejections).toEqual([]);
        expect(publicSources).toEqual([]);
      } });
      // Existing qualification still rejects the independently parsed URL; no new policy is applied.
      expect(observed.dimensions.identityRejections).toBe(1);
      expect(observed.dimensions.identityState).toBe("NOT_OBSERVABLE");
      expect(observed.probeRequests).toBe(0);
    });
  });

  // Risk: original observation steals the later validated-resource decision or cache replay state.
  it("keeps cached redirected evidence post-probe and cannot manufacture a pre-probe reject", async () => {
    await fixture(async upstream => {
      const effective = media(upstream, "Synthetic.Meridian.1987.mp4");
      const url = upstream.media("/media/gateway", { redirectTo: effective });
      const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
      const probe = new DirectStreamProbe(new DirectTransport(policy, testConfig().httpPrivacy, silentLogger),
        { enabled: true, timeoutMs: 1000, maxCandidates: 1, maxConcurrent: 1 }, silentLogger);
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register(provider("redirect", [{ type: "http", url }]));
      const events: StreamRejection[] = [];
      const decisions: unknown[] = [];
      let probed: readonly NormalizedStreamSource[] = [];
      const resolver = new StreamResolver(registry, policy, probe, { stage: (stage, entries) => {
        if (stage === "probed") probed = entries;
      }, rejection: event => { events.push(event); }, preProbeIdentity: event => { decisions.push(event); } });
      for (let index = 0; index < 2; index++) {
        expect(await resolver.resolve(movie)).toEqual([]);
        expect(getBridgeIdentityState(probed[0]!)).toBe("CONTRADICTION");
        expect(events).toEqual([]);
      }
      expect(decisions).toEqual(Array.from({ length: 2 }, () => ({ candidate: {}, stage: "normalized", decision: "CONTINUE", identityState: "UNKNOWN" })));
      expect(probe.diagnostics()).toMatchObject({ requests: 1, cacheHits: 1 });
      expect(upstream.count("/media/gateway")).toBe(1);
      expect(upstream.count("/media/Synthetic.Meridian.1987.mp4")).toBe(1);
    });
  });

  it("preserves exact public survivors/order, ranking, tokens and attempts with instrumentation OFF/ON", async () => {
    await fixture(async upstream => {
      const wrong = media(upstream, "opaque.1987.mp4");
      const shared = media(upstream, "shared.mp4");
      const second = media(upstream, "second.mp4");
      const providers = [provider("a", [{ type: "http", url: wrong }, { type: "http", url: shared, quality: "1080p" }]),
        provider("b", [{ type: "http", url: shared, quality: "1080p" }, { type: "http", url: second, quality: "720p" }])];
      const outcomes: unknown[] = [];
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        for (const identityTrace of [false, true]) {
          const observed = await observePipeline(movie, upstream, providers, { identityTrace,
            probeOptions: { maxCandidates: 2, maxConcurrent: 1 },
            inspect: ({ publicSources, ranking }) => {
              expect(publicSources.map(entry => entry.source.url)).toEqual([shared, second]);
              expect(publicSources.map(entry => entry.source.providerId)).toEqual(["a", "b"]);
              outcomes.push({ ranking, sources: publicSources.map(entry => ({ source: entry.source,
                stream: { ...entry.stream, url: entry.stream.url.replace(/\/source\/[A-Za-z0-9_-]{32}\//, "/source/OPAQUE/") } })) });
            }
          });
          expect(observed.dimensions.identityRejections).toBe(1);
          expect(observed.probeRequests).toBe(2);
        }
      } finally { clock.mockRestore(); }
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(upstream.count("/media/opaque.1987.mp4")).toBe(0);
      expect(upstream.count("/media/shared.mp4")).toBe(2);
      expect(upstream.count("/media/second.mp4")).toBe(2);
    });
  });
});
