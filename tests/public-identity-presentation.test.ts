import { describe, expect, it, vi } from "vitest";
import { getBridgeIdentityState } from "../src/streams/resolver";
import { requestPinned } from "../src/network/url-policy";
import type { NormalizedMediaItem, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { fixturePrivacySafe, observePipeline } from "./identity-qa/harness";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };

describe("public bridge-owned identity through createAddon (integration)", () => {
  it.each(["24", "27", "27-clean", "34-recall", "30", "declared-id", "unclassified", "unverified", "contradiction"] as const)(
    "%s: source state reaches its own public token", async caseId => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const anchored = ["24", "27", "27-clean", "34-recall"].includes(caseId);
      const path = anchored ? "/media/Synthetic.Meridian.1994.mp4" : "/media/opaque.mp4";
      const plain = upstream.media(path, { body: mp4Fixture(caseId === "contradiction" ? 1200 : 6420),
        contentType: "video/mp4", range: caseId === "unverified" ? "ignore" : "honor" });
      let url = caseId === "27" ? plain + "?token=synthetic-private-signature" : plain;
      upstream.allowMediaUrl(url);
      if (caseId === "24") url = upstream.media("/media/gateway", { redirectTo: url });
      const healthy = upstream.media("/media/healthy.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "public", name: "Synthetic public", isEnabled: () => true,
        resolve: () => Promise.resolve([
          { providerId: "public", type: "http", url, resolution: "1080p", codec: "HEVC", sizeBytes: Math.round(1.3 * 1024 ** 3),
            title: caseId === "30" ? "Server 1\n00:20:00" : "ID✓ synthetic-private-label",
            metadata: { confidence: "CORROBORATED", identityState: "CORROBORATED",
              ...(caseId === "declared-id" ? { identity: { externalIds: { ...movie.externalIds } } }
                : caseId === "unclassified" ? { identity: { title: "Synthetic Aurora" } } : {}) } },
          { providerId: "public", type: "http", url: healthy }
        ]) };
      const state = caseId === "contradiction" ? "CONTRADICTION" : caseId === "unclassified" ? undefined
        : caseId === "27" ? "SUSPICIOUS" : anchored ? "CORROBORATED" : "UNKNOWN";
      await observePipeline(movie, upstream, [provider], { target: { providerId: "public", url },
        sensitiveValues: [plain, url, "Synthetic.Meridian.1994.mp4", "synthetic-private-signature", "synthetic-private-label"],
        inspect: async ({ snapshots, publicSources, playback }) => {
          const actual = snapshots.get("probed")!.find(source => source.url === url)!;
          expect(getBridgeIdentityState(actual)).toBe(state);
          expect(publicSources.some(entry => entry.source.url === healthy)).toBe(true);
          expect(new Set(publicSources.map(entry => entry.stream.url)).size).toBe(publicSources.length);
          const prepared = publicSources.find(entry => entry.source.url === url);
          if (state === "CONTRADICTION") { expect(prepared).toBeUndefined(); return; }
          expect(prepared!.source).toBe(actual);
          expect(snapshots.get("final")!.includes(actual)).toBe(true);
          const stream = prepared!.stream;
          const token = /\/source\/([A-Za-z0-9_-]{32})\/stream\.mp4$/.exec(stream.url)![1]!;
          expect((await playback.prepare(token)).source).toBe(actual);
          const marker = state === "CORROBORATED" ? "ID✓" : state === "SUSPICIOUS" ? "ID!" : state === "UNKNOWN" ? "ID?" : undefined;
          const parts = stream.name!.split(" · ");
          expect(parts[0]).toBe(caseId === "unverified" ? "HTTP" : "HTTP✓");
          if (marker) expect(parts[1]).toBe(marker);
          else expect(parts.some(part => part.startsWith("ID"))).toBe(false);
          expect(parts).toContain("1080p"); expect(parts).toContain("1.3GiB");
          if (actual.directHttp?.responseHeaderLatencyMs !== undefined) expect(parts.at(-1)).toMatch(/^\d+\.\ds$/);
          else expect(parts.some(part => /^\d+\.\ds$/.test(part))).toBe(false);
          expect(stream.title).toBeUndefined();
          expect(stream.name).not.toMatch(/Direct|Verified|Unverified|Range|HEVC| ms| GB/);
          expect(fixturePrivacySafe(stream, [plain, url, "synthetic-private-signature", "synthetic-private-label"])).toBe(true);
        }
      });
      expect(upstream.count(path)).toBe(1);
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
      expect(upstream.count("/media/gateway")).toBe(caseId === "24" ? 1 : 0);
    } finally { await upstream.close(); }
  });

  it.each([
    [Math.round(562.4 * 1024 ** 2), 377, "562MiB", "0.4s"],
    [562.5 * 1024 ** 2, 3770, "563MiB", "3.8s"],
    [1024 ** 3 - 1, 0, "1024MiB", "0.0s"],
    [1024 ** 3, 1000, "1.0GiB", "1.0s"],
    [Math.round(1.26 * 1024 ** 3), 140, "1.3GiB", "0.1s"],
    [undefined, 377, undefined, "0.4s"]
  ] as const)("numeric boundary %# in actual Stremio response", async (sizeBytes, latency, size, seconds) => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const provider: StreamProvider = { id: "numeric", name: "Synthetic numeric", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "numeric", type: "http", url, ...(sizeBytes === undefined ? {} : { sizeBytes }) }]) };
      await observePipeline(movie, upstream, [provider], { pinnedRequest: async (target, init) => {
        const response = await requestPinned(target, init); clock += latency; return response;
      }, inspect: ({ publicSources }) => {
        const { stream, source } = publicSources[0]!;
        expect(source.directHttp?.responseHeaderLatencyMs).toBe(latency);
        // Tiny fixture has no displayed MiB size.
        expect(stream.name).toBe(["HTTP✓", "ID?", size, seconds].filter(Boolean).join(" · "));
        expect(stream.title).toBeUndefined();
      } });
      expect(upstream.count("/media/opaque.mp4")).toBe(1);
    } finally { now.mockRestore(); await upstream.close(); }
  });
});
