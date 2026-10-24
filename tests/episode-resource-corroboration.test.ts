import { describe, expect, it, vi } from "vitest";
import { getBridgeIdentityState, StreamResolver, StreamProviderRegistry } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectTransport } from "../src/network/outbound-transport";
import { PlaybackManager } from "../src/playback/manager";
import { DirectHttpPlaybackBackend } from "../src/playback/backends";
import { createAddon } from "../src/addon";
import type { DownloadService } from "../src/download-service";
import express from "express";
import request from "./http-client";
import { getRouter } from "stremio-addon-sdk";
import type { NormalizedMediaItem, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { fixturePrivacySafe, observePipeline } from "./identity-qa/harness";
import { silentLogger, testConfig } from "./helpers";

const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Episode Display",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };

describe("validated episode resource identity through the public pipeline (integration)", () => {
  it.each([
    ["Synthetic.Blue.Series.S02E09.mp4", "", false, "CORROBORATED"],
    ["Synthetic.Blue.Series.S02E09.mp4", "", true, "CORROBORATED"],
    ["Synthetic.Blue.Series.S02E09.mp4", "#Other.Series.S99E99", true, "CORROBORATED"],
    ["Synthetic.Blue.Series.S02E09.mp4", "?", false, "CORROBORATED"],
    ["Synthetic.Blue.Series.S02E09.mp4", "?token=synthetic-private-signature", true, "SUSPICIOUS"],
    ["Synthetic.Blue.Series.1987.S02E09.mp4", "", true, "SUSPICIOUS"],
    ["opaque.1987.S02E09.mp4", "", true, "UNKNOWN"],
    ["Synthetic.Blue.Series.1994.S02E09.mp4", "", false, "CORROBORATED"],
    ["Synthetic.Blue.Series.S02E09.1987.mp4", "", true, "CORROBORATED"],
    ["S02E09.mp4", "", true, "UNKNOWN"],
    ["Serie.Azul.Sintetica.S02E09.mp4", "", true, "UNKNOWN"],
    ["Synthetic.Blue.Series.CODEX.S02E09.mp4", "", true, "UNKNOWN"],
    ["Synthetic.Blue.Series.S02E09.S03E04.mp4", "", true, "UNKNOWN"],
    ["Synthetic.Blue.Series.S03E09.mp4", "?title=Synthetic.Blue.Series.S02E09", true, "CONTRADICTION"],
    ["Synthetic.Blue.Series.S02E04.mp4", "", true, "CONTRADICTION"],
    ["opaque.mp4", "?title=Synthetic.Blue.Series.S02E09", false, "UNKNOWN"]
  ] as const)("resource boundary %#", async (name, suffix, redirect, state) => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const effective = upstream.media(`/media/${name}`, { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      upstream.allowMediaUrl(effective + suffix);
      const url = redirect ? upstream.media("/media/entry.mp4", { redirectTo: effective + suffix }) : effective + suffix;
      const healthy = upstream.media("/media/healthy.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "episode", name: "Synthetic episodes", isEnabled: () => true,
        resolve: request => Promise.resolve([
          { providerId: "episode", type: "http", url,
            title: `${request.seriesTitle} S02E09`,
            metadata: { identityState: "CORROBORATED", independent: true } },
          { providerId: "episode", type: "http", url: healthy }
        ]) };
      const observation = await observePipeline(episode, upstream, [provider], { target: { providerId: "episode", url },
        probeOptions: { maxCandidates: state === "CONTRADICTION" ? 1 : 2, maxConcurrent: 1, timeoutMs: 1000 },
        sensitiveValues: [effective, "synthetic-private-signature"],
        inspect: async ({ snapshots, publicSources, playback, ranking }) => {
          const actual = snapshots.get("probed")!.find(source => source.url === url)!;
          expect(getBridgeIdentityState(actual)).toBe(state);
          const evidence = actual.directHttp?.episodeResource;
          if (evidence) {
            expect(evidence.source).toBe("effective_root");
            expect(evidence.validation).toBe("range_206");
            expect(Object.keys(evidence).every(key => ["source", "validation", "queryPresent", "titleKey", "season", "episode", "year"].includes(key))).toBe(true);
            if (evidence.titleKey) expect(evidence.titleKey).toMatch(/^[a-f0-9]{64}$/);
            expect(fixturePrivacySafe(evidence, [name, effective, "synthetic-private-signature"])).toBe(true);
          }
          expect(publicSources.some(entry => entry.source.url === healthy)).toBe(true);
          const prepared = publicSources.find(entry => entry.source.url === url);
          if (state === "CONTRADICTION") expect(prepared).toBeUndefined();
          else {
            expect(prepared!.source).toBe(actual);
            expect(prepared!.stream.name!.split(" · ")[1]).toBe(state === "CORROBORATED" ? "ID✓" : state === "SUSPICIOUS" ? "ID!" : "ID?");
            expect(prepared!.stream.title).toBeUndefined();
            expect(fixturePrivacySafe(prepared!.stream, [name, effective, "synthetic-private-signature"])).toBe(true);
            const token = /\/source\/([A-Za-z0-9_-]{32})\/stream\.mp4$/.exec(prepared!.stream.url)![1]!;
            expect((await playback.prepare(token)).source).toBe(actual);
          }
          // Equal technical scores retain input order within an identity group;
          // the healthy UNKNOWN precedes SUSPICIOUS under the v1.4 contract.
          expect(publicSources.map(entry => entry.source.url)).toEqual(state === "CONTRADICTION" ? [healthy]
            : state === "SUSPICIOUS" ? [healthy, url] : [url, healthy]);
          if (state !== "CONTRADICTION") expect(ranking[0]!.score).toBe(ranking[1]!.score);
          expect(new Set(publicSources.map(entry => entry.stream.url)).size).toBe(publicSources.length);
        }
      });
      expect(observation.probeRequests).toBe(2);
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
      expect(upstream.count(`/media/${name}`)).toBe(1);
      expect(upstream.count("/media/entry.mp4")).toBe(redirect ? 1 : 0);
      expect(observation.dimensions).toMatchObject({ publicPrivacy: true, tracePrivacy: true,
        providerDiagnosticsPrivacy: true, observerPrivacy: true, reporterPrivacy: true });
    } finally { now.mockRestore(); await upstream.close(); }
  });

  it.each(["blocked", "failed", "document"] as const)("%s route cannot supply episode identity", async mode => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const effective = mode === "blocked" ? upstream.url("/media/unregistered.Synthetic.Blue.Series.S02E09.mp4")
        : upstream.media("/media/Synthetic.Blue.Series.S02E09.mp4", mode === "failed" ? { status: 404 }
          : { contentType: "video/mp4", body: "<html>synthetic document</html>", range: "honor" });
      const url = upstream.media("/media/entry.mp4", { redirectTo: effective });
      const healthy = upstream.media("/media/healthy.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "route", name: "Synthetic routes", isEnabled: () => true,
        resolve: () => Promise.resolve([url, healthy].map(url => ({ providerId: "route", type: "http" as const, url }))) };
      await observePipeline(episode, upstream, [provider], { probeOptions: { maxCandidates: 1, maxConcurrent: 1 },
        inspect: ({ snapshots, publicSources }) => {
          const source = snapshots.get("probed")![0]!;
          expect(getBridgeIdentityState(source)).toBe(mode === "blocked" ? "UNKNOWN" : undefined);
          expect(source.directHttp?.resourceIdentities).toBeUndefined();
          expect(publicSources.map(entry => entry.source.url)).toEqual([healthy]);
          expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("UNKNOWN");
        }
      });
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
    } finally { await upstream.close(); }
  });

  it.each([false, true])("duplicate resources preserve the selected origin and bounded requests (%s)", async reverse => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const url = upstream.media("/media/Synthetic.Blue.Series.S02E09.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const healthy = upstream.media("/media/healthy.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const providers: StreamProvider[] = ["a", "b"].map(id => ({ id, name: "Synthetic copies", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: id, type: "http", url },
          ...(id === "a" ? [{ providerId: id, type: "http" as const, url: healthy }] : [])]) }));
      if (reverse) providers.reverse();
      await observePipeline(episode, upstream, providers, { probeOptions: { maxCandidates: 2, maxConcurrent: 1 },
        inspect: ({ snapshots, publicSources }) => {
          expect(snapshots.get("normalized")).toHaveLength(3);
          expect(snapshots.get("deduplicated")!.map(source => source.url)).toEqual([url, healthy]);
          expect(snapshots.get("deduplicated")![0]!.providerId).toBe(providers[0]!.id);
          expect(publicSources.map(entry => entry.source.url)).toEqual([url, healthy]);
          expect(publicSources.map(entry => getBridgeIdentityState(entry.source))).toEqual(["CORROBORATED", "UNKNOWN"]);
        }
      });
      expect(upstream.count("/media/Synthetic.Blue.Series.S02E09.mp4")).toBe(1);
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
    } finally { now.mockRestore(); await upstream.close(); }
  });

  it("does not infer trusted series identity when metadata is absent", async () => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const url = upstream.media("/media/Synthetic.Blue.Series.S02E09.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
      const transport = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger);
      const probe = new DirectStreamProbe(transport, { enabled: true, maxCandidates: 1, maxConcurrent: 1, timeoutMs: 1000 }, silentLogger);
      const registry = new StreamProviderRegistry(1000, silentLogger);
      let missingSeries = false;
      registry.register({ id: "no-metadata", name: "Synthetic absent metadata", isEnabled: () => true,
        resolve: item => { missingSeries = item.seriesTitle === undefined;
          return Promise.resolve([{ providerId: "no-metadata", type: "http", url, title: "Synthetic Blue Series",
            metadata: { independent: true, identityState: "CORROBORATED" },
            directHttp: { status: "verified", verified: true, rangeSupported: true } }]); } });
      const resolver = new StreamResolver(registry, policy, probe);
      const playback = new PlaybackManager([new DirectHttpPlaybackBackend(transport)]);
      const addon = createAddon({} as DownloadService, silentLogger, [], "http://127.0.0.1:7000", undefined, resolver, playback);
      const response = await request(express().use(getRouter(addon))).get(`/stream/series/${episode.id}.json`).expect(200);
      expect(missingSeries).toBe(true);
      const streams = (response.body as { streams: Array<{ name: string; url: string }> }).streams;
      expect(streams).toHaveLength(1);
      expect(streams[0]!.name.split(" · ").slice(0, 2)).toEqual(["HTTP✓", "ID?"]);
      const token = /\/source\/([A-Za-z0-9_-]{32})\//.exec(streams[0]!.url)![1]!;
      const actual = (await playback.prepare(token)).source!;
      expect(getBridgeIdentityState(actual)).toBe("UNKNOWN");
      expect(upstream.count("/media/Synthetic.Blue.Series.S02E09.mp4")).toBe(1);
    } finally { await upstream.close(); }
  });

  it("keeps HLS outside the file-resource positive scope", async () => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const vod = upstream.vod("episode-scope", 2);
      const url = upstream.media("/media/Synthetic.Blue.Series.S02E09.m3u8", { contentType: "application/vnd.apple.mpegurl",
        body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\n${vod.media}\n` });
      const provider: StreamProvider = { id: "hls", name: "Synthetic HLS", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "hls", type: "http", url }]) };
      await observePipeline(episode, upstream, [provider], { inspect: ({ publicSources }) => {
        expect(publicSources).toHaveLength(1);
        const source = publicSources[0]!.source;
        expect(source.directHttp?.hls).toBe(true);
        expect(source.directHttp?.verified).toBe(true);
        expect(source.directHttp?.episodeResource).toBeUndefined();
        expect(getBridgeIdentityState(source)).toBeUndefined();
        expect(publicSources[0]!.stream.name).not.toMatch(/ID[?!✓]/);
      } });
    } finally { await upstream.close(); }
  });
});
