import { describe, expect, it, vi } from "vitest";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../../src/streams/types";
import type { PinnedRequest } from "../../src/network/outbound-transport";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, type PipelineObservation } from "./harness";
import { boundsContract } from "./pilot-corpus";
import { knownViolations } from "./known-violations";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const provider = (sources: Omit<NormalizedStreamSource, "providerId">[]): StreamProvider => ({
  id: "bounds", name: "Synthetic bounds", isEnabled: () => true,
  resolve: () => Promise.resolve(sources.map(source => ({ ...source, providerId: "bounds" })))
});
function check(caseId: string, observation: PipelineObservation): void {
  const expected = boundsContract[caseId]!;
  const verdict = adjudicate(caseId, expected, observation.dimensions, pilotMode(), knownViolations);
  process.stdout.write(serializeComparison(caseId, expected, observation, verdict));
  expect(verdict.failures, caseId + " safe contract report above").toEqual([]);
}
async function fixture(run: (upstream: DirtyUpstream) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream(); await upstream.listen();
  try { await run(upstream); } finally { await upstream.close(); }
}
const media = (upstream: DirtyUpstream, path: string, seconds = 6420): string =>
  upstream.media(path, { body: mp4Fixture(seconds), contentType: "video/mp4", range: "honor" });

describe("Phase 3 final block A: transport and real bounded composition", () => {
  it.each(["39", "39-negative", "39-recall"] as const)("%s: transport domain is not identity rejection", async caseId => {
    await fixture(async upstream => {
      const path = "/media/entry.mp4";
      const url = upstream.media(path, caseId === "39-recall" ? { status: 503 }
        : { redirectTo: upstream.url(caseId === "39" ? "/media/not-allowed/S03E04.mp4" : path) });
      const observation = await observePipeline(movie, upstream, [provider([{ type: "http", url, title: "Server 1",
        metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } }])]);
      expect(upstream.count("/media/not-allowed/S03E04.mp4")).toBe(0);
      expect(upstream.count(path)).toBe(caseId === "39-negative" ? 4 : 1);
      check(caseId, observation);
    });
  });
  it("40: verified transport cannot remove the approved ID/resource-title suspicion", async () => {
    await fixture(async upstream => {
      const url = media(upstream, "/media/Synthetic.Aurora.1994.mp4");
      const observation = await observePipeline(movie, upstream, [provider([{ type: "http", url, title: "Server 1",
        metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } }])]);
      expect(upstream.count("/media/Synthetic.Aurora.1994.mp4")).toBe(1);
      check("40", observation);
    });
  });
  it("41: pre-probe contradiction and healthy same-provider sibling are independent", async () => {
    await fixture(async upstream => {
      const bad = media(upstream, "/media/opaque.1987.mp4");
      const good = media(upstream, "/media/healthy.mp4");
      const observation = await observePipeline(movie, upstream, [provider([
        { type: "http", url: bad }, { type: "http", url: good }
      ])], { target: { providerId: "bounds", url: bad } });
      expect(upstream.count("/media/opaque.1987.mp4")).toBe(0);
      expect(upstream.count("/media/healthy.mp4")).toBe(1);
      expect(observation.candidates[1]!.dimensions.disposition).toBe("ADMIT");
      check("41", observation);
    });
  });
  it.each(["42", "42-negative"] as const)("%s: post-probe rejection uses bounded replacement, never unlimited search", async caseId => {
    await fixture(async upstream => {
      const first = media(upstream, "/media/first.mp4", 1200);
      const second = media(upstream, "/media/second.mp4", caseId === "42" ? 6420 : 1200);
      const late = media(upstream, "/media/late.mp4");
      const observation = await observePipeline(movie, upstream, [provider([
        { type: "http", url: first }, { type: "http", url: second }, { type: "http", url: late }
      ])], { probeOptions: { maxCandidates: 1, maxConcurrent: 1 },
        target: { providerId: "bounds", url: caseId === "42" ? second : late } });
      expect(observation.probeRequests).toBe(2);
      expect(upstream.count("/media/first.mp4")).toBe(1);
      expect(upstream.count("/media/second.mp4")).toBe(1);
      expect(upstream.count("/media/late.mp4")).toBe(0);
      check(caseId, observation);
    });
  });
  it("43: one reject does not consume a useful slot; final quota and raw/probe bounds stay separate", async () => {
    await fixture(async upstream => {
      const bad = media(upstream, "/media/opaque.1987.mp4");
      const good = Array.from({ length: 51 }, (_, index) => media(upstream, `/media/good-${index}.mp4`));
      const observation = await observePipeline(movie, upstream, [provider([
        { type: "http", url: bad }, ...good.map(url => ({ type: "http" as const, url }))
      ])], { probeOptions: { enabled: false }, target: { providerId: "bounds", url: good[49]! },
        inspect: ({ snapshots }) => {
          expect(snapshots.get("provider")?.length).toBe(52); // Below the existing 100 raw ceiling.
          expect(snapshots.get("admitted")?.length).toBe(51);
          expect(snapshots.get("final")?.length).toBe(50);
          expect(snapshots.get("final")?.some(source => source.url === good[49])).toBe(true);
        } });
      expect(observation.probeRequests).toBe(0); // Probe quota is independently disabled here.
      expect(observation.candidates[51]!.dimensions.disappearanceDomain).toBe("PROVIDER_QUOTA");
      check("43", observation);
    });
  });
  it.each(["44", "44-negative"] as const)("%s: transient timeout versus slice exhaustion, neither opens replacement", async caseId => {
    await fixture(async upstream => {
      const first = media(upstream, "/media/first.mp4");
      const second = media(upstream, "/media/second.mp4");
      let markStarted = (): void => undefined;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      let requests = 0;
      const pinned: PinnedRequest = (_target, init) => {
        requests += 1; markStarted();
        return caseId === "44" ? new Promise((_resolve, reject) => setTimeout(() =>
          reject(new DOMException("Synthetic request timed out", "TimeoutError")), 10))
          : new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason instanceof Error ? init.signal!.reason : new Error("Synthetic probe aborted")), { once: true }));
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const pending = observePipeline(movie, upstream, [provider([{ type: "http", url: first }, { type: "http", url: second }])], {
          pinnedRequest: pinned, probeOptions: { timeoutMs: 90, maxCandidates: 1, maxConcurrent: 1 },
          target: { providerId: "bounds", url: first }, inspect: ({ snapshots }) => {
            expect(snapshots.get("probed")?.[0]?.directHttp?.status).toBe(caseId === "44" ? "timeout" : "budget_exhausted");
            expect(snapshots.get("probed")?.[1]?.directHttp).toBeUndefined();
          } });
        await started;
        await vi.advanceTimersByTimeAsync(caseId === "44" ? 10 : 60); // Existing clock fixture / two-thirds slice; no real sleeps.
        const observation = await pending;
        expect(requests).toBe(1);
        expect(observation.probeRequests).toBe(1);
        check(caseId, observation);
      } finally { vi.useRealTimers(); }
    });
  });
});
