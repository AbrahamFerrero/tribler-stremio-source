import { describe, expect, it, vi } from "vitest";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { getBridgeIdentityState, type StreamCandidateRef, type StreamResolverTrace } from "../src/streams/resolver";
import { IdentityDiagnostics } from "../src/qa/identity-diagnostics";
import { composeResolverTraces } from "../src/streams/source-diversity-evaluation";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { fixturePrivacySafe, observePipeline } from "./identity-qa/harness";

const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };
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
const media = (upstream: DirtyUpstream, name: string, seconds = 1800) => upstream.media(`/media/${name}`, {
  body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor"
});

describe("pre-probe identity observations through protected transport and addon (integration)", () => {
  it.each([movie, episode])("observes existing $kind ID rejection without changing probe eligibility", async item => {
    await fixture(async upstream => {
      const wrong = media(upstream, "rejected.mp4", item.kind === "movie" ? 6420 : 1800);
      const healthy = media(upstream, "healthy.mp4", item.kind === "movie" ? 6420 : 1800);
      const sources = [{ type: "http" as const, url: wrong,
        metadata: { identity: { externalIds: { imdb: "tt8888888888" } }, independent: true } },
      { type: "http" as const, url: healthy, metadata: { identity: {
        externalIds: { ...item.externalIds }, ...(item.kind === "episode" ? { kind: "series", season: 2, episode: 9 } : {})
      } } }];
      for (const identityTrace of [false, true]) {
        const observed = await observePipeline(item, upstream, [provider("claims", sources)], { identityTrace,
          target: { providerId: "claims", url: wrong },
          inspect: ({ rejections, preProbeDecisions, publicSources }) => {
            expect(publicSources.map(entry => entry.source.url)).toEqual([healthy]);
            expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("UNKNOWN");
            expect(rejections).toEqual(identityTrace ? [{ candidate: {}, stage: "normalized",
              reason: "EXTERNAL_ID_CONFLICT", identityState: "CONTRADICTION" }] : []);
            if (identityTrace) expect(preProbeDecisions[0]).toMatchObject({ decision: "REJECT", identityState: "CONTRADICTION" });
          }
        });
        expect(observed.dimensions).toMatchObject({ publicIdentityState: "ABSENT", disposition: identityTrace ? "REJECT" : "NOT_OBSERVABLE",
          probe: "NOT_REACHED", identityRejections: 1, admittedResources: 1 });
        expect(observed.dimensions.identityState).toBe(identityTrace ? "CONTRADICTION" : "NOT_OBSERVABLE");
        expect(observed.probeRequests).toBe(1);
      }
      expect(upstream.count("/media/rejected.mp4")).toBe(0);
      expect(upstream.count("/media/healthy.mp4")).toBe(2);
    });
  });

  it("attributes equivalent rejects separately, preserves healthy siblings, and exposes no source values", async () => {
    await fixture(async upstream => {
      const name = "Synthetic.Blue.Series.S03E04.mp4";
      const wrong = media(upstream, name) + "?token=private-synthetic-query";
      upstream.allowMediaUrl(wrong);
      const healthy = media(upstream, "healthy.mp4");
      const other = media(upstream, "other.mp4");
      const source = { type: "http" as const, url: wrong, filename: name, title: "private-synthetic-title",
        requestHeaders: { Referer: "https://synthetic.example/private-synthetic-secret" } };
      let references: readonly StreamCandidateRef[] = [];
      const repeated = { ...source, providerId: "same" };
      const sameProvider: StreamProvider = { id: "same", name: "Synthetic repeated objects", isEnabled: () => true,
        resolve: () => Promise.resolve([repeated, repeated, { providerId: "same", type: "http", url: healthy }]) };
      const observed = await observePipeline(episode, upstream, [sameProvider, provider("other", [{ type: "http", url: other }])], {
        sensitiveValues: [name, source.title, "private-synthetic-query", "private-synthetic-secret"],
        inspect: ({ rejections, preProbeDecisions, publicSources, review }) => {
          expect(rejections).toHaveLength(2);
          references = rejections.map(event => event.candidate);
          expect(references[0]).not.toBe(references[1]);
          for (const event of rejections) {
            expect(event).toEqual({ candidate: {}, stage: "normalized", reason: "EPISODE_COORDINATE_CONFLICT",
              identityState: "CONTRADICTION" });
            expect(Object.isFrozen(event.candidate)).toBe(true);
            expect(Reflect.ownKeys(event.candidate)).toEqual([]);
            expect(preProbeDecisions.find(decision => decision.candidate === event.candidate)?.decision).toBe("REJECT");
            expect(review.idFor(event.candidate)).toBeUndefined();
          }
          expect(review.summaries()).toEqual([]);
          const diagnostics = new IdentityDiagnostics(episode, review);
          for (const event of rejections) diagnostics.trace.rejection?.(event);
          expect(diagnostics.report(undefined).measuredRejections).toBe(0);
          expect(new Set(publicSources.map(entry => entry.source.url))).toEqual(new Set([healthy, other]));
          expect(fixturePrivacySafe({ rejections, preProbeDecisions }, [wrong, name, source.title,
            "private-synthetic-query", "Referer", "private-synthetic-secret", "same"])).toBe(true);
        }
      });
      expect(upstream.count(`/media/${name}`)).toBe(0);
      expect(observed.probeRequests).toBe(2);
      for (const candidate of observed.candidates.slice(0, 2)) {
        expect(candidate.dimensions).toMatchObject({ identityState: "CONTRADICTION", preProbeDecision: "REJECT",
          rejectionReason: "EPISODE_COORDINATE_CONFLICT", rejectionStage: "normalized", probe: "NOT_REACHED",
          laterStagesNotReached: true, disappearanceDomain: "IDENTITY" });
      }
      expect(observed.origins[0]?.candidateStages).toEqual({ provider: "CONTINUE", normalized: "REJECT",
        deduplicated: "NOT_REACHED", probed: "NOT_REACHED", admitted: "NOT_REACHED", final: "NOT_REACHED" });
      expect(observed.dimensions.tracePrivacy).toBe(true);
      // A fresh call must not reuse the previous candidate reference.
      await observePipeline(episode, upstream, [provider("same", [source])], {
        inspect: ({ rejections }) => { expect(rejections[0]?.candidate).not.toBe(references[0]); }
      });
    });
  });

  it.each(["Synthetic.Blue.Series.S02E09.mp4", "Synthetic.Blue.Series.S03E04.mp4"])(
    "keeps opaque UNKNOWN separate from later validated %s", async name => {
      await fixture(async upstream => {
        const target = media(upstream, name);
        const url = upstream.media("/media/gateway", { redirectTo: target });
        const observed = await observePipeline(episode, upstream, [provider("redirect", [{ type: "http", url }])], {
          inspect: ({ preProbeDecisions, snapshots }) => {
            expect(preProbeDecisions).toEqual([{ candidate: {}, stage: "normalized", decision: "CONTINUE", identityState: "UNKNOWN" }]);
            // Pre-probe state is an event, never assigned to the final source WeakMap.
            expect(getBridgeIdentityState(snapshots.get("normalized")![0]!)).toBeUndefined();
          }
        });
        expect(observed.dimensions.preProbeIdentityState).toBe("UNKNOWN");
        expect(observed.dimensions.identityState).toBe(name.includes("S02E09") ? "CORROBORATED" : "CONTRADICTION");
        expect(observed.dimensions.rejectionReason).toBe("NOT_OBSERVABLE");
        expect(observed.probeRequests).toBe(1);
        expect(upstream.count("/media/gateway")).toBe(1);
        expect(upstream.count(`/media/${name}`)).toBe(1);
      });
    });

  it.each([true, false])("does not authenticate %s request-derived/static external-ID claims", async echo => {
    await fixture(async upstream => {
      const url = media(upstream, "opaque.mp4");
      const producer: StreamProvider = { id: "claims", name: "Synthetic claims", isEnabled: () => true,
        resolve: request => Promise.resolve([{ providerId: "claims", type: "http", url,
          metadata: { identity: { externalIds: echo ? { ...request.externalIds } : { imdb: "tt9999999998" } },
            independent: true, provenance: "private-synthetic-provider-claim" } }]) };
      const observed = await observePipeline(episode, upstream, [producer], {
        inspect: ({ preProbeDecisions, rejections }) => {
          expect(preProbeDecisions).toEqual([{ candidate: {}, stage: "normalized", decision: "CONTINUE", identityState: "UNKNOWN" }]);
          expect(rejections).toEqual([]);
        }
      });
      expect(observed.dimensions.preProbeIdentityState).toBe("UNKNOWN");
      expect(observed.dimensions.identityState).toBe("UNKNOWN");
      expect(observed.dimensions.publicIdentityState).toBe("UNKNOWN");
      expect(observed.dimensions.disposition).toBe("ADMIT");
    });
  });

  it.each(["url-policy", "redirect", "transport", "unclassified"])("does not invent final identity from %s failure", async mode => {
    await fixture(async upstream => {
      const blocked = "http://127.0.0.1:9999/media/opaque.mp4";
      const url = mode === "url-policy" ? blocked : upstream.media("/media/gateway", { redirectTo: blocked });
      if (mode === "transport") upstream.media("/media/gateway", { redirectTo: url });
      const observed = await observePipeline(episode, upstream, [provider("blocked", [{ type: "http", url,
        ...(mode === "unclassified" ? { metadata: { identity: { externalIds: { imdb: "tt9999999998" } } } } : {}) }])], {
        inspect: ({ rejections }) => { expect(rejections).toEqual([]); }
      });
      expect(observed.dimensions.identityState).toBe(["redirect", "transport"].includes(mode) ? "UNKNOWN" : "NOT_OBSERVABLE");
      expect(observed.dimensions.preProbeIdentityState).toBe("UNKNOWN");
      expect(observed.dimensions.publicIdentityState).toBe("ABSENT");
      expect(observed.dimensions.preProbeDecision).toBe("CONTINUE");
      expect(observed.dimensions.identityRejections).toBe(0);
      expect(observed.dimensions.rejectionReason).toBe("NOT_OBSERVABLE");
    });
  });

  it("leaves unresolved ID/year composition unclassified and retains the existing rejection", async () => {
    await fixture(async upstream => {
      const url = media(upstream, "Synthetic.Meridian.1987.mp4", 6420);
      const observed = await observePipeline(movie, upstream, [provider("claims", [{ type: "http", url,
        metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } }])]);
      expect(observed.dimensions).toMatchObject({ identityState: "NOT_OBSERVABLE", preProbeIdentityState: "NOT_OBSERVABLE",
        preProbeDecision: "REJECT", rejectionReason: "NOT_OBSERVABLE", admittedResources: 0 });
      expect(observed.probeRequests).toBe(0);
    });
  });

  it("preserves exact survivors, order, attempts, scores and public tokens with instrumentation disabled/enabled", async () => {
    await fixture(async upstream => {
      const wrong = media(upstream, "Synthetic.Blue.Series.S03E04.mp4");
      const urls = [media(upstream, "same.mp4"), media(upstream, "other.mp4")];
      const providers = [provider("same", [{ type: "http", url: wrong }, { type: "http", url: urls[0]!, quality: "1080p" }]),
        provider("other", [{ type: "http", url: urls[1]!, quality: "720p" }])];
      const outputs: unknown[] = [];
      const time = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        for (const identityTrace of [false, true]) {
          const observation = await observePipeline(episode, upstream, providers, { identityTrace,
            inspect: ({ publicSources, ranking }) => {
              outputs.push({ sources: publicSources.map(entry => ({ source: entry.source,
                stream: { ...entry.stream, url: entry.stream.url.replace(/\/source\/[A-Za-z0-9_-]{32}\//, "/source/OPAQUE/") } })), ranking });
              for (const entry of publicSources) expect(entry.stream.url).toMatch(/^http:\/\/127\.0\.0\.1:7000\/source\/[A-Za-z0-9_-]{32}\//);
              expect(publicSources.map(entry => entry.source.url)).toEqual(urls);
            }
          });
          expect(observation.probeRequests).toBe(2);
          expect(observation.dimensions.identityRejections).toBe(1);
        }
      } finally { time.mockRestore(); }
      expect(outputs[1]).toEqual(outputs[0]);
      expect(upstream.count("/media/Synthetic.Blue.Series.S03E04.mp4")).toBe(0);
      expect(upstream.count("/media/same.mp4")).toBe(2);
      expect(upstream.count("/media/other.mp4")).toBe(2);
    });
  });

  it("composes optional events and aligned references without copying candidate contents", () => {
    const stage = vi.fn<StreamResolverTrace["stage"]>();
    const rejection = vi.fn<NonNullable<StreamResolverTrace["rejection"]>>();
    const preProbeIdentity = vi.fn<NonNullable<StreamResolverTrace["preProbeIdentity"]>>();
    const trace = composeResolverTraces({ stage, rejection, preProbeIdentity }, { stage: () => undefined });
    const candidate = Object.freeze({});
    trace.stage("provider", [], [candidate]);
    trace.preProbeIdentity?.({ candidate, stage: "normalized", decision: "REJECT", identityState: "CONTRADICTION" });
    trace.rejection?.({ candidate, stage: "normalized", reason: "KIND_CONFLICT", identityState: "CONTRADICTION" });
    expect(stage.mock.calls[0]?.[2]?.[0]).toBe(candidate);
    expect(rejection.mock.calls[0]?.[0].candidate).toBe(candidate);
    expect(preProbeIdentity.mock.calls[0]?.[0].candidate).toBe(candidate);
  });
});
