import { describe, expect, it, vi } from "vitest";
import { StremioMovieMetadataLookup } from "../../src/metadata/movie-metadata";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { normalizeCandidateIdentity, resourceIdentityFromUrl } from "../../src/streams/identity-qualification";
import { ExternalHttpStreamProvider } from "../../src/streams/providers/external-http-stream-provider";
import type { NormalizedMediaItem, StreamProvider } from "../../src/streams/types";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, withWitnesses, type PipelineObservation,
  type Dimensions } from "./harness";
import { resourceRuntimeContract } from "./pilot-corpus";
import { knownViolations } from "./known-violations";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };

function check(caseId: string, observation: PipelineObservation, witnesses: Dimensions = {}): void {
  const expected = resourceRuntimeContract[caseId]!;
  const observed = { ...observation, dimensions: withWitnesses(observation.dimensions, witnesses) };
  const verdict = adjudicate(caseId, expected, observed.dimensions, pilotMode(), knownViolations);
  process.stdout.write(serializeComparison(caseId, expected, observed, verdict));
  expect(verdict.failures, caseId + " contract dimensions; safe report above").toEqual([]);
}

describe("Phase 3 fifteen approved resource, ambiguity and runtime cases", () => {
  it.each(["18", "19", "20", "21", "21-negative", "23", "23-recall", "28", "31", "31-negative",
    "32", "33", "34", "34-recall", "35", "35-recall", "36", "37", "38"] as const)(
    "%s: real adapter intake and protected media measurement", async caseId => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const isEpisode = ["21", "21-negative", "23", "23-recall", "32", "38"].includes(caseId);
      let item = isEpisode ? episode : movie;
      if (caseId === "31" || caseId === "31-negative") item = { ...movie, runtimeSeconds: 6000 };
      if (caseId === "37") {
        // Remove trusted duration, rather than replacing it with provider metadata.
        const { runtimeSeconds: omitted, ...withoutRuntime } = movie;
        expect(omitted).toBe(6420);
        item = withoutRuntime;
      }
      if (caseId === "32") {
        // Real lookup, real pinned HTTP. The series-level 20 min claim is not
        // an exact S02E09 duration, even when video coordinates are present.
        const metadataPath = "/media/metadata/meta/series/tt9999999998.json";
        const endpoint = upstream.media(metadataPath, { contentType: "application/json", body: JSON.stringify({ meta: {
          id: "tt9999999998", type: "series", name: "Synthetic Blue Series", releaseInfo: "1994", runtime: "20 min",
          videos: [{ id: episode.id, season: 2, episode: 9 }] } }) });
        const metadata = new StremioMovieMetadataLookup({ baseUrl: upstream.url("/media/metadata/"), timeoutMs: 1000,
          endpointPolicy: () => new ExternalUrlPolicy({ allowedLoopbackUrls: [endpoint] }) });
        const result = await metadata.lookupSeries("tt9999999998");
        expect(result !== undefined && result.title === episode.seriesTitle && result.year === 1994).toBe(true);
        expect(result !== undefined && !Object.hasOwn(result, "runtimeSeconds")).toBe(true);
        expect(upstream.count(metadataPath)).toBe(1);
        item = { ...episode, title: result!.title, seriesTitle: result!.title,
          ...(result!.year !== undefined ? { year: result!.year } : {}) };
      }
      const seconds = caseId === "31" ? 7800 : caseId === "31-negative" ? 7860
        : ["33", "37"].includes(caseId) ? 1200 : isEpisode && caseId !== "32" ? 1800 : 6420;
      const mediaPath = caseId === "18" ? "/media/opaque.1987.mp4"
        : caseId === "19" ? "/media/opaque.1987.1994.mp4"
        : caseId === "20" ? "/media/opaque.1994.mp4"
        : caseId.startsWith("21") ? "/media/opaque.S02E09.S03E04.mp4"
        : caseId === "23" ? "/media/Synthetic.Blue.Series.1987.S02E09.mp4"
        : caseId === "23-recall" ? "/media/opaque.1987.S02E09.mp4"
        : caseId === "28" ? "/media/Other.Series.S03E04/opaque.mp4"
        : caseId.startsWith("34") ? "/media/Synthetic.Meridian.1994.mp4"
        : caseId === "35" ? "/media/Synthetic.Aurora.1994.mp4"
        : caseId === "35-recall" ? "/media/xq.97z.group.1080p.mp4" : "/media/opaque.mp4";
      const effective = upstream.media(mediaPath, { body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor" });
      const url = caseId === "28" ? upstream.media("/media/gateway", { redirectTo: effective }) : effective;
      const identity = ["33", "35", "35-recall"].includes(caseId) ? { externalIds: { imdb: "tt9999999999" } }
        : caseId === "34" ? { externalIds: { imdb: "tt8888888888" } }
        : caseId === "21-negative" ? { kind: "series", season: 2, episode: 4 }
        : caseId === "38" ? { kind: "series", season: 2, episode: 9 } : undefined;
      // Fixed upstream result before any resolve request: the adapter observes
      // producer-local claims, not an invented provenance or alias field.
      const payload = { streams: [{ type: "http", url, title: caseId === "38" ? "Serie Azul Sintetica" : "Server 1",
        ...((identity || caseId === "37") ? { metadata: { ...(identity ? { identity } : {}),
          ...(caseId === "37" ? { runtimeSeconds: 6420 } : {}) } } : {}) }] };
      const endpointPath = "/media/resolve";
      const endpoint = upstream.media(endpointPath, { contentType: "application/json", body: JSON.stringify(payload) });
      const adapter = new ExternalHttpStreamProvider({ id: "resource-runtime", name: "Synthetic intake", url: endpoint,
        timeoutMs: 1000, policy: new ExternalUrlPolicy({ allowedLoopbackUrls: [endpoint] }) });
      const spy = vi.spyOn(adapter, "resolve"); // Call-through, including protected HTTP.
      try {
        const observation = await observePipeline(item, upstream, [adapter]);
        expect(spy.mock.calls.length).toBe(1);
        const actualRequest = spy.mock.calls[0]![0];
        expect(actualRequest.id === item.id).toBe(true);
        const result = spy.mock.results[0]!;
        if (result.type !== "return") throw new Error("Synthetic adapter did not return a result");
        const sources = await result.value;
        expect(sources.length).toBe(1);
        const accepted = normalizeCandidateIdentity(sources[0]!.metadata?.identity);
        expect(accepted?.externalIds?.imdb === identity?.externalIds?.imdb).toBe(true);
        if (caseId === "21-negative" || caseId === "38") {
          expect(accepted?.season === 2 && accepted.episode === (caseId === "38" ? 9 : 4)
            && !accepted.title && !accepted.externalIds).toBe(true);
        }
        if (caseId === "19") expect(resourceIdentityFromUrl(effective)?.year === undefined).toBe(true);
        if (caseId.startsWith("21")) expect(resourceIdentityFromUrl(effective) === undefined).toBe(true);
        if (caseId === "28") {
          expect(resourceIdentityFromUrl(effective) === undefined).toBe(true);
          expect(upstream.count("/media/gateway")).toBe(1);
        }
        if (caseId === "32" || caseId === "37") expect(actualRequest.runtimeSeconds === undefined).toBe(true);
        if (caseId === "37") {
          expect(sources[0]!.metadata?.runtimeSeconds === 6420 && !accepted).toBe(true);
        }
        expect(upstream.hits.filter(hit => hit.path === endpointPath && hit.method === "POST").length).toBe(1);
        expect(upstream.count(mediaPath)).toBe(observation.dimensions.probe === "VERIFIED" ? 1 : 0);
        const witnesses = caseId === "31" ? { trustedRuntimeActuallyReceived: actualRequest.runtimeSeconds === 6000 }
          : caseId === "32" || caseId === "37" ? { trustedRuntimeActuallyReceived: actualRequest.runtimeSeconds !== undefined } : {};
        check(caseId, observation, witnesses);
      } finally { spy.mockRestore(); }
    } finally { await upstream.close(); }
  });

  it("22: actual request presentation echo cannot hide contradictory resource coordinates", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/Synthetic.Blue.Series.S03E04.mp4", {
        body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      let copied = false;
      const provider: StreamProvider = { id: "echo", name: "Synthetic echo", isEnabled: () => true, resolve: request => {
        const title = `${request.seriesTitle} S${String(request.season).padStart(2, "0")}E${String(request.episode).padStart(2, "0")}`;
        copied = request.season === 2 && request.episode === 9 && title === "Synthetic Blue Series S02E09";
        return Promise.resolve([{ providerId: "echo", type: "http", url, title }]);
      } };
      const observation = await observePipeline(episode, upstream, [provider]);
      expect(copied).toBe(true);
      expect(upstream.count("/media/Synthetic.Blue.Series.S03E04.mp4")).toBe(0);
      check("22", observation, { requestPresentationActuallyCopied: copied });
    } finally { await upstream.close(); }
  });
});
