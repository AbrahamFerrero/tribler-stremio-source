import express from "express";
import request from "../http-client";
import { describe, expect, it } from "vitest";
import { proxyDirectHttp } from "../../src/automatic-stream";
import type { Logger } from "../../src/logger";
import { requestPinned } from "../../src/network/url-policy";
import type { PinnedRequest } from "../../src/network/outbound-transport";
import { normalizeStreamSource } from "../../src/streams/normalization";
import { scoreStream } from "../../src/streams/scoring";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../../src/streams/types";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, type PipelineObservation } from "./harness";
import { publicTraceContract } from "./pilot-corpus";
import { knownViolations } from "./known-violations";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };
const provider = (id: string, sources: Omit<NormalizedStreamSource, "providerId">[]): StreamProvider => ({
  id, name: "Synthetic QA", isEnabled: () => true,
  resolve: () => Promise.resolve(sources.map(source => ({ ...source, providerId: id })))
});
function check(caseId: string, observation: PipelineObservation): void {
  const expected = publicTraceContract[caseId]!;
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

describe("Phase 3 final block B: real public route, trace and privacy boundaries", () => {
  it.each(["45", "45-recall", "45-independent", "45-negative"] as const)("%s: identity-to-public matrix needs production confidence", async caseId => {
    await fixture(async upstream => {
      const url = media(upstream, caseId === "45-independent" ? "/media/Synthetic.Aurora.1994.mp4" : "/media/opaque.mp4");
      const identity = caseId === "45-recall" ? undefined : { externalIds: {
        imdb: caseId === "45-negative" ? "tt8888888888" : "tt9999999999" } };
      const observation = await observePipeline(movie, upstream, [provider("public", [{ type: "http", url, title: "Server 1",
        ...(identity ? { metadata: { identity } } : {}) }])]);
      expect(upstream.count(new URL(url).pathname)).toBe(caseId === "45-negative" ? 0 : 1);
      check(caseId, observation);
    });
  });
  it.each(["46", "46-recall", "46-independent", "46-clean", "46-negative"] as const)("%s: independent transport and identity public tokens", async caseId => {
    await fixture(async upstream => {
      const https = caseId === "46-independent" || caseId === "46-clean";
      const enabled = caseId !== "46-recall" && caseId !== "46-clean";
      const plain = caseId === "46-negative" ? upstream.media("/media/opaque.mp4", { status: 503 })
        : media(upstream, "/media/opaque.mp4");
      const url = https ? plain.replace("http:", "https:") : plain;
      let socketCalls = 0;
      const pinned: PinnedRequest = (target, init) => {
        socketCalls += 1;
        if (target.url.toString() !== url || target.address !== "127.0.0.1") throw new Error("Unexpected fixture socket target");
        // TLS socket boundary substituted; policy, transport, probe and public route remain real.
        const bytes = new Uint8Array(mp4Fixture(6420));
        const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init.headers).get("Range") ?? "");
        const start = range ? Number(range[1]) : 0;
        const end = Math.min(range?.[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
        return Promise.resolve(new Response(bytes.slice(start, end + 1), { status: range ? 206 : 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start + 1),
            ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}) } }));
      };
      const observation = await observePipeline(movie, upstream, [provider("presentation", [{ type: https ? "https" : "http", url }])], {
        probeOptions: { enabled }, ...(https ? { pinnedRequest: pinned, fixtureUrls: [url] } : {}),
        inspect: ({ publicSources }) => {
          expect(publicSources.length).toBe(1);
          expect(publicSources[0]!.source.type === (https ? "https" : "http")).toBe(true);
          expect(Boolean(publicSources[0]!.source.directHttp?.verified)).toBe(enabled && caseId !== "46-negative");
        } });
      if (https) expect(socketCalls).toBe(enabled ? 1 : 0);
      check(caseId, observation);
    });
  });
  it.each(["47", "47-recall"] as const)("%s: eligible identity evidence does not add score or change tie order", async caseId => {
    await fixture(async upstream => {
      const unknown = { providerId: "ranking", type: "http" as const, url: media(upstream, "/media/unknown.mp4"), quality: "720p" };
      const matching = { ...unknown, url: media(upstream, "/media/matching.mp4"),
        metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } };
      const inputs = caseId === "47" ? [unknown, matching] : [matching, unknown];
      const observation = await observePipeline(movie, upstream, [provider("ranking", inputs)], {
        probeOptions: { enabled: false }, target: { providerId: "ranking", url: inputs[0]!.url },
        inspect: ({ snapshots, ranking, publicSources }) => {
          const normalized = inputs.map(source => normalizeStreamSource(source, "ranking")!);
          expect(scoreStream(normalized[0]!)).toBe(scoreStream(normalized[1]!));
          expect(ranking.length).toBe(2);
          expect(ranking[0]!.score).toBe(ranking[1]!.score);
          expect(snapshots.get("final")?.every((source, index) => source.url === inputs[index]!.url)).toBe(true);
          expect(publicSources.every((entry, index) => entry.source.url === inputs[index]!.url)).toBe(true);
        } });
      check(caseId, observation); // Evidence-neutral scores are observable; refined confidence-to-score is not.
    });
  });
  it("48: attributable real pre-probe coordinate reject with later stages explicitly not reached", async () => {
    await fixture(async upstream => {
      const url = media(upstream, "/media/Synthetic.Blue.Series.S03E04.mp4", 1800);
      const observation = await observePipeline(episode, upstream, [provider("trace", [{ type: "http", url }])]);
      expect(observation.stages.normalized).toBe(0);
      expect(observation.probeRequests).toBe(0);
      expect(upstream.count("/media/Synthetic.Blue.Series.S03E04.mp4")).toBe(0);
      expect(observation.dimensions.preProbeDecision).toBe("REJECT");
      expect(observation.dimensions.rejectionReason).toBe("EPISODE_COORDINATE_CONFLICT");
      expect(observation.dimensions.identityState).toBe("CONTRADICTION");
      check("48", observation);
    });
  });
  it.each(["50", "50-negative", "50-clean", "50-recall"] as const)("%s: selected resource domain is observed separately", async caseId => {
    await fixture(async upstream => {
      const shared = media(upstream, "/media/shared.mp4");
      const sibling = media(upstream, "/media/sibling.mp4");
      let providers: StreamProvider[];
      let target = { providerId: "domains", url: shared };
      let enabled = true;
      if (caseId === "50") {
        providers = [provider("first", [{ type: "http", url: shared }]), provider("domains", [
          { type: "http", url: shared }, { type: "http", url: sibling },
          { type: "http", url: shared, requestHeaders: { Accept: "video/mp4" } }
        ])];
      } else if (caseId === "50-clean") {
        const urls = Array.from({ length: 51 }, (_, index) => media(upstream, `/media/quota-${index}.mp4`));
        providers = [provider("domains", urls.map(url => ({ type: "http", url })))];
        target = { providerId: "domains", url: urls[50]! }; enabled = false;
      } else {
        providers = [provider("domains", [{ type: "http", url: shared },
          ...(caseId === "50-negative" ? [{ type: "http" as const, url: sibling }] : [])])];
        if (caseId === "50-negative") target = { providerId: "domains", url: sibling };
      }
      const observation = await observePipeline(movie, upstream, providers, { target,
        probeOptions: { enabled, maxCandidates: caseId === "50-negative" ? 1 : 8 },
        inspect: ({ snapshots }) => {
          if (caseId === "50") {
            expect(snapshots.get("deduplicated")?.length).toBe(3); // Shared copy collapses, distinct URL/header route does not.
            expect(snapshots.get("final")?.length).toBe(3);
          }
        } });
      expect(observation.candidates.every(candidate => candidate.dimensions.rejectionReason === "NOT_OBSERVABLE")).toBe(true);
      check(caseId, observation);
    });
  });
  it("51: required signed query survives real probe and token-backed playback; forbidden headers and telemetry are clean", async () => {
    await fixture(async upstream => {
      const canaries = ["FAKE_PRIVATE_SIGNED_QUERY_CANARY", "FAKE_PRIVATE_AUTH_CANARY", "FAKE_PRIVATE_COOKIE_CANARY",
        "FAKE_PRIVATE_API_CANARY", "FAKE_PRIVATE_PROXY_CANARY", "FAKE_PRIVATE_FORBIDDEN_CANARY"];
      const query = "?signature=" + canaries[0]!;
      const plain = upstream.media("/media/signed.mp4", { body: mp4Fixture(6420), contentType: "video/mp4",
        range: "honor", requiredQuery: query });
      const url = plain + query; upstream.allowMediaUrl(url);
      const entries: string[] = [];
      const record: Logger["info"] = (message, context) => { entries.push(JSON.stringify({ message, context })); };
      const log: Logger = { debug: record, info: record, warn: record, error: record };
      const requestHeaders = { Authorization: canaries[1]!, Cookie: canaries[2]!, "X-API-Key": canaries[3]!,
        "Proxy-Authorization": canaries[4]!, "X-Forwarded-For": canaries[5]!, Accept: "video/mp4" };
      let safeWireRequests = 0;
      const pinned: PinnedRequest = (target, init) => {
        const headers = new Headers(init.headers);
        if (Object.keys(requestHeaders).filter(name => name !== "Accept").some(name => headers.has(name))) {
          throw new Error("Forbidden synthetic header crossed wire boundary");
        }
        if (target.url.search === query) safeWireRequests += 1;
        return requestPinned(target, init); // Actual protected socket to controlled local fixture.
      };
      const observation = await observePipeline(movie, upstream, [provider("privacy", [{ type: "http", url, title: "Server 1", requestHeaders }])], {
        log, logOutput: entries, canaries, sensitiveValues: [plain, url,
          ...Object.entries(requestHeaders).filter(([name]) => name !== "Accept").map(([, value]) => value)], pinnedRequest: pinned,
        inspect: async ({ publicSources, transport }) => {
          expect(publicSources.length).toBe(1);
          const source = publicSources[0]!.source; // Obtained through real opaque PlaybackManager token preparation.
          expect(source.url === url && Object.keys(source.requestHeaders ?? {}).join() === "Accept").toBe(true);
          const app = express().get("/fixture-playback", (req, res) => {
            void proxyDirectHttp({ url: source.url!, fileName: "signed.mp4", size: 1,
              ...(source.requestHeaders ? { requestHeaders: source.requestHeaders } : {}) }, req, res, 1000,
              new AbortController().signal, "GET", transport);
          });
          const played = await request(app).get("/fixture-playback").set("Range", "bytes=0-63");
          expect(played.status).toBe(206);
          const unsigned = await transport.request({ url: plain, method: "GET" });
          expect(unsigned.response.status).toBe(403); await unsigned.response.body?.cancel();
          expect(safeWireRequests >= 2).toBe(true);
        } });
      const verdict = adjudicate("51", publicTraceContract["51"]!, observation.dimensions, pilotMode(), knownViolations);
      expect(canaries.some(canary => serializeComparison("51", publicTraceContract["51"]!, observation, verdict).includes(canary))).toBe(false);
      check("51", observation);
    });
  });
  it("53: selected reject plays through isolated QA while only the survivor receives public playback", async () => {
    await fixture(async upstream => {
      const bad = media(upstream, "/media/rejected.mp4", 1200);
      const good = media(upstream, "/media/survivor.mp4");
      let reviewHandle = "";
      const observation = await observePipeline(movie, upstream, [provider("review", [{ type: "http", url: bad }, { type: "http", url: good }])], {
        target: { providerId: "review", url: bad }, inspect: async ({ publicSources, playback, review }) => {
          expect(publicSources.length === 1 && publicSources[0]!.source.url === good).toBe(true);
          // The normal manager still refuses unissued tokens; QA uses its own manager.
          let refused = false;
          try { await playback.prepare("A".repeat(32)); } catch { refused = true; }
          expect(refused).toBe(true);
          const candidates = review.summaries();
          expect(candidates).toHaveLength(1);
          expect(candidates[0]).toMatchObject({ identityState: "CONTRADICTION", reason: "MEASURED_RUNTIME_CONTRADICTION",
            stage: "admitted", probe: "VERIFIED", runtimeDifferenceSeconds: 5220 });
          expect(JSON.stringify(candidates).includes(bad)).toBe(false);
          expect(review.adjudication()).toBeUndefined(); // Fixtures never assign content truth.
          const handle = await review.select(candidates[0]!.candidate);
          reviewHandle = handle;
          const get = await fetch(handle);
          expect(get.status).toBe(200);
          expect(Buffer.from(await get.arrayBuffer()).equals(mp4Fixture(1200))).toBe(true);
          const head = await fetch(handle, { method: "HEAD" });
          expect(head.status).toBe(200);
          expect(Number(head.headers.get("content-length"))).toBe(mp4Fixture(1200).length);
          expect((await head.arrayBuffer()).byteLength).toBe(0);
          const range = await fetch(handle, { headers: { Range: "bytes=0-15" } });
          expect(range.status).toBe(206);
          expect(range.headers.get("content-range")).toBe(`bytes 0-15/${mp4Fixture(1200).length}`);
          expect(Buffer.from(await range.arrayBuffer()).equals(mp4Fixture(1200).subarray(0, 16))).toBe(true);
          const token = new URL(handle).pathname.split("/").at(-1)!;
          await expect(playback.prepare(token)).rejects.toThrow(); // QA token cannot prepare normal playback.
          expect((await fetch(handle.replace(token, "A".repeat(32)))).status).toBe(404);
          expect(publicSources).toHaveLength(1);
        } });
      await expect(fetch(reviewHandle)).rejects.toThrow(); // Harness finally closed the isolated listener.
      check("53", observation);
    });
  });
});
