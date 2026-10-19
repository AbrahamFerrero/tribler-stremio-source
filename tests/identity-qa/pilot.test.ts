import { describe, expect, it } from "vitest";
import type { NormalizedMediaItem, StreamProvider } from "../../src/streams/types";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, withWitnesses, type Dimensions, type PipelineObservation } from "./harness";
import { pilotContract } from "./pilot-corpus";
import { knownViolations } from "./known-violations";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };

function check(caseId: string, observation: PipelineObservation, extra: Dimensions = {}): void {
  const actual = withWitnesses(observation.dimensions, extra);
  const verdict = adjudicate(caseId, pilotContract[caseId]!, actual, pilotMode(), knownViolations);
  process.stdout.write(serializeComparison(caseId, pilotContract[caseId]!, { ...observation, dimensions: actual }, verdict));
  expect(verdict.failures, `${caseId} contract dimensions; safe scalar report above`).toEqual([]);
}

async function withUpstream(run: (upstream: DirtyUpstream) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  try { await run(upstream); } finally { await upstream.close(); }
}

describe("Phase 3 Identity QA five-case pilot", () => {
  it("03: a provider really copies the request ID; echo cannot corroborate", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      let copied = false;
      const observation = await observePipeline(movie, upstream, [{ id: "echo", name: "Synthetic echo",
        isEnabled: () => true, resolve: request => {
          copied = request.externalIds.imdb === movie.externalIds.imdb;
          return Promise.resolve([{ providerId: "echo", type: "http", url, title: "Server 1",
            metadata: { identity: { externalIds: { ...request.externalIds } } } }]);
        } }]);
      expect(observation.dimensions.identityState).toBe("UNKNOWN"); // No independent corroboration is established.
      check("03", observation, { requestIdActuallyCopied: copied });
    } finally { await upstream.close(); }
  });

  it.each(["08a", "08b", "08-negative"] as const)("%s: request echo versus real resource episode identity", async caseId => {
    await withUpstream(async upstream => {
      const name = caseId === "08a" ? "opaque.mp4" : caseId === "08b"
        ? "Synthetic.Blue.Series.S02E09.mp4" : "Synthetic.Blue.Series.S03E04.mp4";
      const url = upstream.media(`/media/${name}`, { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      let copied = false;
      const provider: StreamProvider = { id: "episode", name: "Synthetic episode", isEnabled: () => true,
        resolve: request => {
          const title = `${request.seriesTitle} S${String(request.season).padStart(2, "0")}E${String(request.episode).padStart(2, "0")}`;
          copied = title === "Synthetic Blue Series S02E09";
          return Promise.resolve([{ providerId: "episode", type: "http", url, title: caseId === "08a" ? title : "Server 1" }]);
        } };
      const observation = await observePipeline(episode, upstream, [provider]);
      check(caseId, observation, caseId === "08a" ? { requestPresentationActuallyCopied: copied } : {});
    });
  });

  it.each(["13", "13-negative"] as const)("%s: equivalent-resource origin dispute versus standalone conflicting ID", async caseId => {
    await withUpstream(async upstream => {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      // Independent static producer claims, never copied from the resolve request.
      const conflicting: StreamProvider = { id: "origin-b", name: "Synthetic origin B", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "origin-b", type: "http", url, title: "Server 1",
          metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } }]) };
      const matching: StreamProvider = { id: "origin-a", name: "Synthetic origin A", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "origin-a", type: "http", url, title: "Server 1",
          metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } }]) };
      check(caseId, await observePipeline(movie, upstream, caseId === "13" ? [matching, conflicting] : [conflicting]));
    });
  });

  it.each(["24", "24-negative"] as const)("%s: opaque entry redirects through protected transport to a real resource", async caseId => {
    await withUpstream(async upstream => {
      const year = caseId === "24" ? 1994 : 1987;
      const effective = upstream.media(`/media/Synthetic.Meridian.${year}.mp4`, {
        body: mp4Fixture(6420), contentType: "video/mp4", range: "honor"
      });
      const url = upstream.media("/media/gateway", { redirectTo: effective });
      const observation = await observePipeline(movie, upstream, [{ id: "redirect", name: "Synthetic redirect",
        isEnabled: () => true, resolve: () => Promise.resolve([{ providerId: "redirect", type: "http", url, title: "Server 1" }]) }]);
      // Real socket evidence: root was requested and the real redirect target was fetched.
      expect(upstream.count("/media/gateway")).toBe(1);
      expect(upstream.count(`/media/Synthetic.Meridian.${year}.mp4`)).toBe(1);
      expect(observation.dimensions.preProbeIdentityState).toBe("UNKNOWN");
      check(caseId, observation);
    });
  });

  it.each(["30", "30-recall", "30-negative"] as const)("%s: weak runtime text versus independently measured MP4", async caseId => {
    await withUpstream(async upstream => {
      const seconds = caseId === "30-negative" ? 1200 : 6420;
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor" });
      let trusted = false;
      const observation = await observePipeline(movie, upstream, [{ id: "runtime", name: "Synthetic runtime",
        isEnabled: () => true, resolve: request => {
          trusted = request.runtimeSeconds === 6420;
          return Promise.resolve([{ providerId: "runtime", type: "http", url,
            title: caseId === "30" ? "Server 1\n00:20:00" : "Server 1" }]);
        } }]);
      check(caseId, observation, caseId === "30" ? { trustedRuntimeActuallyReceived: trusted } : {});
    });
  });
});
