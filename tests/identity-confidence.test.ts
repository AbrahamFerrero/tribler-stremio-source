import { describe, expect, it } from "vitest";
import { getBridgeIdentityState } from "../src/streams/resolver";
import { normalizeStreamSource } from "../src/streams/normalization";
import type { NormalizedMediaItem, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { observePipeline } from "./identity-qa/harness";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };

describe("bridge-owned identity confidence foundation (component)", () => {
  it("ignores forged states/provenance and keeps transport, admission and identity separate", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const plain = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const claim = upstream.media("/media/claim.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const anchor = upstream.media("/media/Synthetic.Meridian.1994.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const bad = upstream.media("/media/bad.mp4", { body: mp4Fixture(1200), contentType: "video/mp4", range: "honor" });
      const forged = { identityState: "CORROBORATED", confidence: "CORROBORATED", independent: true };
      const provider: StreamProvider = { id: "claims", name: "Synthetic claims", isEnabled: () => true,
        resolve: () => Promise.resolve([
          { providerId: "claims", type: "http", url: plain, ...forged, metadata: { ...forged } },
          { providerId: "claims", type: "http", url: claim, ...forged,
            metadata: { ...forged, identity: { ...forged, externalIds: { imdb: movie.externalIds.imdb } } } },
          { providerId: "claims", type: "http", url: anchor, ...forged },
          { providerId: "claims", type: "http", url: bad, identityState: "UNKNOWN", metadata: { confidence: "UNKNOWN" } }
        ]) };
      const observation = await observePipeline(movie, upstream, [provider], {
        target: { providerId: "claims", url: bad },
        inspect: ({ snapshots, publicSources }) => {
          const sources = snapshots.get("probed")!;
          expect(sources.map(getBridgeIdentityState)).toEqual(["UNKNOWN", "UNKNOWN", "CORROBORATED", "CONTRADICTION"]);
          expect(publicSources).toHaveLength(3);
          expect(publicSources.map(entry => getBridgeIdentityState(entry.source))).toEqual(["UNKNOWN", "UNKNOWN", "CORROBORATED"]);
          for (const source of sources) {
            expect(Object.hasOwn(source, "identityState")).toBe(false);
            expect(getBridgeIdentityState(normalizeStreamSource(source, source.providerId)!)).toBeUndefined();
          }
        }
      });
      expect(observation.dimensions).toMatchObject({ identityState: "CONTRADICTION", probe: "VERIFIED", resourcePublicStreams: 0 });
      expect(observation.candidates[0]!.dimensions.identityState).toBe("UNKNOWN");
      expect(observation.candidates[1]!.dimensions.identityState).toBe("UNKNOWN");
    } finally { await upstream.close(); }
  });

  it.each([false, true])("keeps sparse equivalent ID claims UNKNOWN regardless of arrival order (%s)", async reverse => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const providers: StreamProvider[] = [
        { id: "sparse", name: "Synthetic sparse", isEnabled: () => true,
          resolve: () => Promise.resolve([{ providerId: "sparse", type: "http", url }]) },
        { id: "claim", name: "Synthetic claim", isEnabled: () => true,
          resolve: () => Promise.resolve([{ providerId: "claim", type: "http", url,
            metadata: { identity: { externalIds: { imdb: movie.externalIds.imdb } } } }]) }
      ];
      if (reverse) providers.reverse();
      const observation = await observePipeline(movie, upstream, providers, { inspect: ({ snapshots, publicSources }) => {
        expect(snapshots.get("deduplicated")).toHaveLength(1);
        expect(publicSources).toHaveLength(1);
        expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("UNKNOWN");
      } });
      expect(observation.dimensions.admittedResources).toBe(1);
      expect(observation.candidates.filter(candidate => candidate.dimensions.disposition === "ADMIT")
        .map(candidate => candidate.dimensions.identityState)).toEqual(["UNKNOWN"]);
    } finally { await upstream.close(); }
  });

  it("does not classify a transport failure as an identity contradiction or an admitted UNKNOWN", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/opaque.mp4", { status: 404 });
      const provider: StreamProvider = { id: "transport", name: "Synthetic transport", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "transport", type: "http", url }]) };
      await observePipeline(movie, upstream, [provider], { inspect: ({ snapshots, publicSources }) => {
        expect(snapshots.get("probed")?.map(getBridgeIdentityState)).toEqual([undefined]);
        expect(snapshots.get("admitted")).toHaveLength(0);
        expect(publicSources).toHaveLength(0);
      } });
    } finally { await upstream.close(); }
  });
});
