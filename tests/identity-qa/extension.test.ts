import { describe, expect, it, vi } from "vitest";
import { logger } from "../../src/logger";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../../src/streams/types";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, type PipelineObservation } from "./harness";
import { extensionContract } from "./pilot-corpus";
import { knownViolations } from "./known-violations";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "Synthetic Blue Series",
  seriesTitle: "Synthetic Blue Series", year: 1994, season: 2, episode: 9, externalIds: { imdb: "tt9999999998" } };
const provider = (id: string, sources: Omit<NormalizedStreamSource, "providerId">[]): StreamProvider => ({
  id, name: "Synthetic provider", isEnabled: () => true,
  resolve: () => Promise.resolve(sources.map(source => ({ ...source, providerId: id })))
});
function check(caseId: string, observation: PipelineObservation): void {
  const expected = extensionContract[caseId]!;
  const verdict = adjudicate(caseId, expected, observation.dimensions, pilotMode(), knownViolations);
  process.stdout.write(serializeComparison(caseId, expected, observation, verdict));
  expect(verdict.failures, caseId + " contract dimensions; safe report above").toEqual([]);
}
async function fixture(run: (upstream: DirtyUpstream) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  try { await run(upstream); } finally { await upstream.close(); }
}

describe("Phase 3 eight approved additions after harness gate", () => {
  it("12: independently corroborating origin plus unknown equivalent copy without metadata fusion", async () => {
    await fixture(async upstream => {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const observation = await observePipeline(movie, upstream, [
        provider("unknown", [{ type: "http", url, title: "Server 1", metadata: { fromUnknown: true } }]),
        provider("independent", [{ type: "http", url, title: "Server 2", metadata: {
          fromIndependent: true, identity: { externalIds: { imdb: "tt9999999999" } } } }])
      ], { target: { providerId: "unknown", url } });
      expect(observation.stages.provider).toBe(2);
      expect(observation.stages.deduplicated).toBe(1);
      expect(observation.candidates[0]!.resource === observation.candidates[1]!.resource).toBe(true);
      check("12", observation);
    });
  });
  it("14: validated contradiction removes every shared-resource copy while a distinct healthy sibling survives", async () => {
    await fixture(async upstream => {
      const bad = upstream.media("/media/Synthetic.Blue.Series.S03E04.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const url = upstream.media("/media/shared", { redirectTo: bad });
      const good = upstream.media("/media/Synthetic.Blue.Series.S02E09.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      const observation = await observePipeline(episode, upstream, [
        provider("shared-a", [{ type: "http", url, title: "Server 1", metadata: { identity: { externalIds: { imdb: "tt9999999998" } } } }]),
        provider("shared-b", [{ type: "http", url, title: "Server 2" }]),
        provider("healthy", [{ type: "http", url: good, title: "Server 3" }])
      ], { target: { providerId: "shared-a", url } });
      expect(observation.candidates[0]!.resource === observation.candidates[1]!.resource).toBe(true);
      expect(observation.candidates.slice(0, 2).every(candidate => candidate.dimensions.resourcePublicStreams === 0)).toBe(true);
      expect(observation.candidates[2]!.dimensions.disposition).toBe("ADMIT");
      expect(upstream.count("/media/shared")).toBe(1);
      expect(upstream.count("/media/Synthetic.Blue.Series.S03E04.mp4")).toBe(1);
      check("14", observation);
    });
  });
  it.each(["25", "26", "26-recall", "29"] as const)("%s: protected redirect and actual effective-resource evidence", async caseId => {
    await fixture(async upstream => {
      const compatible = caseId === "26-recall";
      const suffix = compatible ? "S02E09" : "S03E04";
      const effectivePath = "/media/Synthetic.Blue.Series." + suffix + ".mp4";
      const effective = upstream.media(effectivePath, { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
      // Unregistered local path remains disallowed by exact loopback policy, so no external DNS/socket is needed.
      const blockedPath = "/media/blocked.S03E04.mp4";
      const entryPath = caseId === "29" ? "/media/Synthetic.Blue.Series.S02E09.mp4" : "/media/gateway";
      const url = upstream.media(entryPath, { redirectTo: caseId === "26" ? upstream.url(blockedPath) : effective });
      const observation = await observePipeline(episode, upstream, [provider("redirect", [{ type: "http", url, title: "Server 1" }])]);
      expect(upstream.count(entryPath)).toBe(1);
      expect(upstream.count(blockedPath)).toBe(0);
      expect(upstream.count(effectivePath)).toBe(caseId === "26" ? 0 : 1);
      if (caseId === "25") expect(observation.dimensions.preProbeIdentityState).toBe("UNKNOWN");
      if (caseId === "26") {
        expect(observation.dimensions.preProbeIdentityState).toBe("UNKNOWN");
        expect(observation.dimensions.identityRejections).toBe(0);
        expect(observation.dimensions.resourcePublicStreams).toBe(0);
        expect(observation.dimensions.rejectionReason).toBe("NOT_OBSERVABLE");
      }
      check(caseId, observation);
    });
  });
  it.each(["27", "27-clean", "27-independent"] as const)("%s: basename-only query cap and independent strong-anchor control", async caseId => {
    await fixture(async upstream => {
      const plain = upstream.media("/media/Synthetic.Meridian.1994.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const url = caseId === "27-clean" ? plain : plain + "?selector=S03E04&token=FAKE_QUERY_CANARY";
      if (url !== plain) upstream.allowMediaUrl(url);
      const observation = await observePipeline(movie, upstream, [provider("query", [{ type: "http", url, title: "Server 1",
        ...(caseId === "27-independent" ? { metadata: { identity: { externalIds: { imdb: "tt9999999999" } } } } : {}) }])]);
      expect(upstream.count("/media/Synthetic.Meridian.1994.mp4")).toBe(1);
      check(caseId, observation);
    });
  });
  it("49: same-provider healthy sibling cannot satisfy the post-probe reject's outcome or measurement", async () => {
    await fixture(async upstream => {
      const good = upstream.media("/media/good.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const bad = upstream.media("/media/bad.mp4", { body: mp4Fixture(1200), contentType: "video/mp4", range: "honor" });
      const observation = await observePipeline(movie, upstream, [provider("siblings", [
        { type: "http", url: good, title: "Server 1" }, { type: "http", url: bad, title: "Server 2" }
      ])], { target: { providerId: "siblings", url: bad } });
      expect(observation.candidates[0]!.dimensions.disposition).toBe("ADMIT");
      expect(observation.candidates[0]!.dimensions.measuredSeconds).toBe(6420);
      expect(observation.candidates[0]!.dimensions.identityState).toBe("UNKNOWN");
      expect(observation.candidates[0]!.dimensions.rejectionReason).toBe("NOT_OBSERVABLE");
      expect(observation.candidates[1]!.dimensions).toMatchObject({
        identityState: "CONTRADICTION", rejectionReason: "MEASURED_RUNTIME_CONTRADICTION", rejectionStage: "admitted", resourcePublicStreams: 0
      });
      check("49", observation);
    });
  });
  it("52: hostile synthetic title, filename, metadata, locator, headers and provider errors exercise real privacy surfaces", async () => {
    await fixture(async upstream => {
      const canaries = ["FAKE_PRIVATE_TITLE_CANARY", "FAKE_PRIVATE_FILENAME_CANARY", "FAKE_PRIVATE_METADATA_CANARY",
        "FAKE_PRIVATE_QUERY_CANARY", "FAKE_PRIVATE_HEADER_CANARY", "FAKE_PRIVATE_ERROR_CANARY"];
      const logs: string[] = [];
      const spies = (["log", "warn", "error"] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
      }));
      try {
        const plain = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
        const url = plain + "?token=" + canaries[3]!;
        upstream.allowMediaUrl(url);
        const error = new Error(canaries[5]);
        error.name = canaries[5]!;
        const failed: StreamProvider = { id: "hostile-error", name: "Synthetic error", isEnabled: () => true,
          resolve: () => Promise.reject(error) };
        const hostileHeaders = { Referer: "https://fixture.invalid/?token=" + canaries[4]!, Authorization: canaries[4]! };
        const observation = await observePipeline(movie, upstream, [provider("hostile", [{ type: "http", url,
          title: "ID✓ https://fixture.invalid/?token=" + canaries[0]!, filename: "token=" + canaries[1]! + ".mp4",
          metadata: { text: "password=" + canaries[2]! },
          requestHeaders: hostileHeaders
        }]), failed], { log: logger, logOutput: logs, canaries, sensitiveValues: [plain, url, error.name, ...Object.values(hostileHeaders)] });
        expect(logs.length > 0).toBe(true); // Real logger ran; not an empty sink privacy pass.
        expect(observation.dimensions).toMatchObject({
          logPrivacy: true, providerDiagnosticsPrivacy: true, providersPrivacy: true,
          publicPrivacy: true
        });
        const serialized = serializeComparison("52", extensionContract["52"]!, observation,
          adjudicate("52", extensionContract["52"]!, observation.dimensions, pilotMode(), knownViolations));
        expect(canaries.some(canary => serialized.includes(canary))).toBe(false);
        check("52", observation);
      } finally { spies.forEach(spy => spy.mockRestore()); }
    });
  });
});
