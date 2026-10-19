import { describe, expect, it } from "vitest";
import { getBridgeIdentityState } from "../src/streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { observePipeline } from "./identity-qa/harness";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };

describe("validated effective movie resource corroboration (integration)", () => {
  it.each([
    ["Synthetic.Meridian.1994.mp4", "", "CORROBORATED"],
    ["Synthetic.Meridian.1994.mp4", "#Other.Title.1987", "CORROBORATED"],
    ["Synthetic.Meridian.1994.mp4", "?", "CORROBORATED"],
    ["Synthetic.Meridian.1994.mp4", "?token=synthetic-private-query", "SUSPICIOUS"],
    ["Synthetic.Meridian.1994.mp4", "?next=Other.Title.1987", "SUSPICIOUS"],
    ["Synthetic.Meridian.1987.mp4", "?title=Synthetic.Meridian.1994", "CONTRADICTION"],
    ["opaque.mp4", "?title=Synthetic.Meridian.1994#Synthetic.Meridian.1994", "UNKNOWN"],
    ["opaque.mp4", "", "UNKNOWN"],
    ["opaque.1994.mp4", "", "UNKNOWN"],
    ["opaque.1994.mp4", "?title=Synthetic.Meridian.1994", "UNKNOWN"]
  ] as const)("redirect resource boundary %#", async (name, suffix, state) => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const effective = upstream.media(`/media/${name}`, { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      upstream.allowMediaUrl(effective + suffix);
      const url = upstream.media("/media/gateway", { redirectTo: effective + suffix });
      const sibling = upstream.media("/media/healthy.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "resource", name: "Synthetic resource", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "resource", type: "http", url },
          { providerId: "resource", type: "http", url: sibling }]) };
      const observation = await observePipeline(movie, upstream, [provider], {
        target: { providerId: "resource", url }, sensitiveValues: [name, "synthetic-private-query"],
        inspect: ({ snapshots, publicSources }) => {
          const target = snapshots.get("probed")!.find(source => source.url === url)!;
          expect(getBridgeIdentityState(target)).toBe(state);
          const observation = target.directHttp?.movieResource;
          if (observation) {
            expect(observation.source).toBe("effective_root");
            expect(observation.validation).toBe("range_206");
            expect(observation.queryPresent).toBe(suffix.startsWith("?") && suffix.length > 1);
            expect(Object.keys(observation).sort()).toEqual(["queryPresent", "source", "titleKey", "validation", "year"]);
            expect(observation.titleKey).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.stringify(observation).includes(name)).toBe(false);
          }
          expect(publicSources.some(entry => entry.source.url === sibling)).toBe(true);
          const prepared = publicSources.find(entry => entry.source.url === url);
          if (state === "CONTRADICTION") expect(prepared).toBeUndefined();
          else {
            expect(prepared?.source).toBe(target);
            expect(getBridgeIdentityState(prepared!.source)).toBe(state);
          }
        }
      });
      expect(upstream.count("/media/gateway")).toBe(1);
      expect(upstream.count(`/media/${name}`)).toBe(1);
      expect(observation.dimensions).toMatchObject({ identityState: state, publicPrivacy: true,
        observerPrivacy: true, tracePrivacy: true, providerDiagnosticsPrivacy: true, reporterPrivacy: true });
    } finally { await upstream.close(); }
  });

  it.each(["opaque.mp4", "1994.mp4", "Synthetic.Meridian.Contract.1994.mp4",
    "Synthetic.Meridian.HLFV.CODEX.1994.mp4", "Other.Synthetic.Meridian.1994.mp4",
    "Synthetic.Meridian.1994.1987.mp4"])("does not infer positive title evidence from %s", async name => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media(`/media/${name}`, { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "echo", name: "Synthetic echo", isEnabled: () => true,
        resolve: request => Promise.resolve([{ providerId: "echo", type: "http", url,
          title: `${request.title} (${request.year})`, filename: "Synthetic.Meridian.1994.mp4",
          directHttp: { status: "verified", verified: true, rangeSupported: true },
          metadata: { confidence: "CORROBORATED", independent: true } }]) };
      await observePipeline(movie, upstream, [provider], { inspect: ({ publicSources }) => {
        expect(publicSources).toHaveLength(1);
        expect(getBridgeIdentityState(publicSources[0]!.source)).not.toBe("CORROBORATED");
      } });
    } finally { await upstream.close(); }
  });

  it("blocked redirects supply no effective identity, and cannot remove a healthy sibling", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/gateway", { redirectTo: "http://127.0.0.1:9/Synthetic.Meridian.1994.mp4" });
      const sibling = upstream.media("/media/healthy.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "blocked", name: "Synthetic blocked", isEnabled: () => true,
        resolve: () => Promise.resolve([url, sibling].map(url => ({ providerId: "blocked", type: "http" as const, url }))) };
      await observePipeline(movie, upstream, [provider], { inspect: ({ snapshots, publicSources }) => {
        const source = snapshots.get("probed")![0]!;
        expect(source.directHttp?.status).toBe("route_rejected");
        expect(getBridgeIdentityState(source)).toBe("UNKNOWN");
        expect(source.directHttp?.resourceIdentities).toBeUndefined();
        expect(publicSources.map(entry => entry.source.url)).toEqual([sibling]);
      } });
    } finally { await upstream.close(); }
  });

  it.each([false, true])("does not authenticate equivalent candidate ID claims (%s)", async reverse => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/Synthetic.Meridian.1994.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const sources: NormalizedStreamSource[] = [
        { providerId: "copies", type: "http", url },
        { providerId: "copies", type: "http", url, metadata: { identity: { externalIds: { ...movie.externalIds } } } }
      ];
      if (reverse) sources.reverse();
      const provider: StreamProvider = { id: "copies", name: "Synthetic copies", isEnabled: () => true,
        resolve: () => Promise.resolve(sources) };
      await observePipeline(movie, upstream, [provider], { inspect: ({ snapshots, publicSources }) => {
        expect(snapshots.get("deduplicated")).toHaveLength(1);
        expect(publicSources).toHaveLength(1);
        expect(getBridgeIdentityState(publicSources[0]!.source)).toBeUndefined();
      } });
    } finally { await upstream.close(); }
  });

  it.each(["full-video", "failed", "document", "wrong-runtime", "disabled"] as const)(
    "qualifies actual media before positive identity: %s", async mode => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const effective = upstream.media("/media/Synthetic.Meridian.1994.mp4", {
        body: mode === "document" ? "<html>synthetic document</html>" : mp4Fixture(mode === "wrong-runtime" ? 1200 : 6420),
        contentType: "video/mp4", range: mode === "full-video" ? "ignore" : "honor",
        ...(mode === "failed" ? { status: 404, range: "ignore" as const } : {})
      });
      const url = upstream.media("/media/gateway", { redirectTo: effective });
      const provider: StreamProvider = { id: "validation", name: "Synthetic validation", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "validation", type: "http", url,
          directHttp: { status: "verified", verified: true, rangeSupported: true,
            movieResource: { source: "effective_root", validation: "range_206", titleKey: "forged", year: 1994, queryPresent: false } } }]) };
      await observePipeline(movie, upstream, [provider], { probeOptions: { enabled: mode !== "disabled" },
        inspect: ({ snapshots, publicSources }) => {
          const source = snapshots.get("probed")![0]!;
          expect(getBridgeIdentityState(source)).toBe(mode === "full-video" ? "CORROBORATED"
            : mode === "wrong-runtime" ? "CONTRADICTION" : undefined);
          expect(publicSources).toHaveLength(mode === "full-video" ? 1 : 0);
          if (["document", "failed", "disabled"].includes(mode)) expect(source.directHttp?.movieResource).toBeUndefined();
        }
      });
    } finally { await upstream.close(); }
  });

  it("keeps a query-bearing entry capped after a clean redirect and deduplicates equivalent copies", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const effective = upstream.media("/media/Synthetic.Meridian.1994.mp4", {
        body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const entry = upstream.media("/media/gateway", { redirectTo: effective }) + "?token=synthetic-private-query";
      upstream.allowMediaUrl(entry);
      const providers: StreamProvider[] = ["a", "b"].map(id => ({ id, name: "Synthetic copy", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: id, type: "http", url: entry }]) }));
      await observePipeline(movie, upstream, providers, { inspect: ({ snapshots, publicSources }) => {
        expect(snapshots.get("normalized")).toHaveLength(2);
        expect(snapshots.get("deduplicated")).toHaveLength(1);
        expect(snapshots.get("probed")).toHaveLength(1);
        expect(publicSources).toHaveLength(1);
        expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("SUSPICIOUS");
        expect(publicSources[0]!.source.directHttp?.movieResource?.queryPresent).toBe(false);
      } });
      expect(upstream.count("/media/gateway")).toBe(1);
      expect(upstream.count("/media/Synthetic.Meridian.1994.mp4")).toBe(1);
    } finally { await upstream.close(); }
  });
});
