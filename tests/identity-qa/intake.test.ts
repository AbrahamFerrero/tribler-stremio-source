import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { normalizeCandidateIdentity, resourceIdentityFromUrl } from "../../src/streams/identity-qualification";
import { normalizeStreamSource } from "../../src/streams/normalization";
import { ExternalHttpStreamProvider } from "../../src/streams/providers/external-http-stream-provider";
import { StremioAddonStreamProvider } from "../../src/streams/providers/stremio-addon-stream-provider";
import type { NormalizedMediaItem } from "../../src/streams/types";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, type PipelineObservation } from "./harness";
import { intakeContract } from "./pilot-corpus";
import { knownViolations } from "./known-violations";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };

function check(caseId: string, observation: PipelineObservation): void {
  const expected = intakeContract[caseId]!;
  const verdict = adjudicate(caseId, expected, observation.dimensions, pilotMode(), knownViolations);
  process.stdout.write(serializeComparison(caseId, expected, observation, verdict));
  expect(verdict.failures, caseId + " contract dimensions; safe report above").toEqual([]);
}

describe("Phase 3 approved external-ID, title and structural intake cases", () => {
  it.each(["01", "02", "04", "05", "05-negative", "06", "07", "09", "10", "11", "15", "16", "16-negative"] as const)(
    "%s: real External HTTP adapter with a static independent upstream result", async caseId => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const isEpisode = caseId === "16" || caseId === "16-negative";
      const item = isEpisode ? episode : movie;
      const seconds = isEpisode ? 1800 : 6420;
      const wrongYear = caseId === "05" || caseId === "05-negative";
      const mediaPath = wrongYear ? "/media/Synthetic.Meridian.1987.mp4" : "/media/opaque.mp4";
      const url = upstream.media(mediaPath, { body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor" });
      // All claims are fixed before the adapter receives a request. No request copying,
      // guessed alias relation, provenance flag, injected probe result or refined state.
      const matchingId = ["01", "04", "05"].includes(caseId);
      const conflictingId = caseId === "02" || caseId === "06";
      const title = caseId === "04" ? "Meridiano Sintetico"
        : caseId === "06" ? "Synthetic Meridian (1994)"
        : ["09", "10"].includes(caseId) ? "Synthetic Meridian" : caseId === "11" ? "Synthetic Aurora" : "Server 1";
      const identity = matchingId || conflictingId ? { externalIds: { imdb: matchingId ? "tt9999999999" : "tt8888888888" } }
        : caseId === "10" ? { title: "Synthetic Meridian", year: 1994 }
        : caseId === "11" ? { title: "Synthetic Aurora", year: 1994 }
        : caseId === "15" ? { kind: "series" }
        : isEpisode ? { kind: "series", season: 2, episode: caseId === "16" ? 9 : 4 } : undefined;
      const payload = { streams: [{ type: "http", url, title, ...(identity ? { metadata: { identity } } : {}) }] };
      const endpointPath = "/media/resolve";
      const endpoint = upstream.media(endpointPath, { contentType: "application/json", body: JSON.stringify(payload) });
      const requestEvents: Array<{ requestType: string; requestId: string }> = [];
      const adapter = new ExternalHttpStreamProvider({ id: "intake", name: "Synthetic HTTP intake", url: endpoint,
        timeoutMs: 1000, policy: new ExternalUrlPolicy({ allowedLoopbackUrls: [endpoint] }),
        diagnostic: event => {
          if (event.type === "request") requestEvents.push({ requestType: event.requestType, requestId: event.requestId });
        } });
      const resolveSpy = vi.spyOn(adapter, "resolve"); // Call-through: does not substitute the adapter or HTTP boundary.
      try {
        const observation = await observePipeline(item, upstream, [adapter]);
        expect(resolveSpy.mock.calls.length).toBe(1);
        expect(resolveSpy.mock.calls[0]![0].externalIds.imdb === item.externalIds.imdb).toBe(true);
        expect(requestEvents.length === 1 && requestEvents[0]!.requestId === item.id
          && requestEvents[0]!.requestType === item.kind).toBe(true);
        expect(upstream.hits.filter(hit => hit.path === endpointPath && hit.method === "POST").length).toBe(1);
        const result = resolveSpy.mock.results[0]!;
        if (result.type !== "return") throw new Error("Synthetic adapter did not return a result");
        const sources = await result.value;
        expect(sources.length).toBe(1);
        expect(sources[0]!.providerId === adapter.id && sources[0]!.title === title).toBe(true);
        const normalized = normalizeStreamSource(sources[0]!, adapter.id);
        expect(normalized !== undefined).toBe(true);
        const acceptedIdentity = normalizeCandidateIdentity(normalized?.metadata?.identity);
        if (matchingId || conflictingId) {
          expect(acceptedIdentity?.externalIds?.imdb === (matchingId ? "tt9999999999" : "tt8888888888")).toBe(true);
        } else if (caseId === "10" || caseId === "11") {
          expect(acceptedIdentity?.title === title && acceptedIdentity.year === 1994 && !acceptedIdentity.externalIds).toBe(true);
        } else if (caseId === "15" || isEpisode) {
          expect(acceptedIdentity?.kind === "series" && !acceptedIdentity.externalIds && !acceptedIdentity.title).toBe(true);
          if (isEpisode) expect(acceptedIdentity?.season === 2 && acceptedIdentity.episode === (caseId === "16" ? 9 : 4)).toBe(true);
        } else {
          expect(acceptedIdentity === undefined).toBe(true);
        }
        if (wrongYear) expect(resourceIdentityFromUrl(url)?.year === 1987).toBe(true);
        // Real probe/negative witnesses are independent of unavailable refined confidence.
        expect(observation.stages.provider).toBe(1);
        expect(upstream.count(mediaPath)).toBe(observation.dimensions.probe === "VERIFIED" ? 1 : 0);
        check(caseId, observation);
      } finally { resolveSpy.mockRestore(); }
    } finally { await upstream.close(); }
  });

  it("17: real Stremio adapter keeps taxonomy/routing and unsupported stray kind fields out of structural identity", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      upstream.streams = [{ url, title: "Synthetic animation", category: "anime", contentType: "TV", kind: "series",
        metadata: { category: "OVA", type: "series" } }];
      const endpoints = [upstream.url("/manifest.json"), upstream.url("/stream/movie/" + movie.id + ".json")];
      const endpointPolicy = new ExternalUrlPolicy({ allowedLoopbackUrls: endpoints });
      const adapter = new StremioAddonStreamProvider({ id: "taxonomy", name: "Synthetic taxonomy", enabled: true,
        manifestUrl: endpoints[0]!, timeoutMs: 1000, manifestTtlMs: 60_000, endpointPolicy: () => endpointPolicy });
      const resolveSpy = vi.spyOn(adapter, "resolve");
      try {
        const observation = await observePipeline(movie, upstream, [adapter]);
        expect(resolveSpy.mock.calls.length).toBe(1);
        expect(upstream.count("/manifest.json")).toBe(1);
        expect(upstream.count("/stream/movie/" + movie.id + ".json")).toBe(1);
        const result = resolveSpy.mock.results[0]!;
        if (result.type !== "return") throw new Error("Synthetic adapter did not return a result");
        const sources = await result.value;
        expect(sources.length === 1 && sources[0]!.type === "http" && sources[0]!.metadata === undefined).toBe(true);
        expect(normalizeStreamSource(sources[0]!, adapter.id)?.metadata === undefined).toBe(true);
        expect(upstream.count("/media/opaque.mp4")).toBe(1);
        check("17", observation);
      } finally { resolveSpy.mockRestore(); }
    } finally { await upstream.close(); }
  });
});
