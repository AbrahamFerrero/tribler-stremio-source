import { describe, expect, it } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { adjudicate, observePipeline, pilotMode, serializeComparison, withWitnesses,
  type Dimensions, type PipelineObservation } from "./identity-qa/harness";
import { knownViolations } from "./identity-qa/known-violations";
import { intakeContract, pilotContract, resourceRuntimeContract } from "./identity-qa/pilot-corpus";

// Complementary Phase 4 transformations, NOT new Phase 3 cases or a new baseline.
// All sets fit the existing eight probe slots, concurrency one, and provider quotas.
const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };
type Source = Omit<NormalizedStreamSource, "providerId">;
const idClaim = (matching: boolean) => ({ identity: { externalIds: {
  imdb: matching ? "tt9999999999" : "tt8888888888"
} } });
async function fixture(run: (upstream: DirtyUpstream) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream(); await upstream.listen();
  try { await run(upstream); } finally { await upstream.close(); }
}
function media(upstream: DirtyUpstream, name: string): string {
  return upstream.media(`/media/${name}`, { contentType: "video/mp4", body: mp4Fixture(6420), range: "honor" });
}
function producer(upstream: DirtyUpstream, id: string, streams: readonly Source[]): StreamProvider {
  // Fixed response before any resolve request: real HTTP intake, no provenance flag.
  const url = upstream.media(`/media/intake-${id}`, { contentType: "application/json",
    body: JSON.stringify({ streams }) });
  return new ExternalHttpStreamProvider({ id, name: "Synthetic Phase 4", url, timeoutMs: 1000,
    policy: new ExternalUrlPolicy({ allowedLoopbackUrls: [url] }) });
}
const contracts: Readonly<Record<string, Dimensions>> = { ...pilotContract, ...intakeContract, ...resourceRuntimeContract };
function check(caseId: string, transform: string, observation: PipelineObservation, expected = contracts[caseId]!): void {
  // Only literal fixture labels may accompany the existing closed safe reporter.
  if (!/^[a-z0-9-]+$/.test(transform)) throw new Error("Unsafe transformation label");
  const strict = adjudicate(caseId, expected, observation.dimensions, "STRICT", []);
  const verdict = adjudicate(caseId, expected, observation.dimensions, pilotMode(),
    caseId === "guardrail" ? [] : knownViolations);
  // Separate prefix preserves the official 84-report inventory. Include STRICT
  // even in BASELINE; an accepted historical discrepancy is never called compliant.
  process.stdout.write(`IDENTITY_PHASE4 ${transform} ` + serializeComparison(caseId, expected, observation, strict).slice(12));
  expect(verdict.failures, `${caseId}/${transform}: contract discrepancies in safe report`).toEqual([]);
}

describe("Phase 4 approved 05/13/34 composition transformations", () => {
  it.each(["single", "duplicate", "equivalent", "equivalent-reverse"] as const)(
    "05: independent ID/year dispute, %s", async transform => fixture(async upstream => {
      const url = media(upstream, "Synthetic.Meridian.1987.mp4");
      const source: Source = { type: "http", url, metadata: idClaim(true) };
      const a = producer(upstream, "a", transform === "duplicate" ? [source, { ...source }] : [source]);
      const b = producer(upstream, "b", [source]);
      const providers = transform === "equivalent" ? [a, b] : transform === "equivalent-reverse" ? [b, a] : [a];
      const observation = await observePipeline(movie, upstream, providers, { inspect: ({ snapshots }) => {
        expect(snapshots.get("provider")?.[0]?.providerId).toBe(transform === "equivalent-reverse" ? "b" : "a");
      } });
      // Causal witness, independent of missing identity state: no socket opportunity
      // exists if the real normalized snapshot is empty. Do not infer a reason.
      expect(upstream.count("/media/Synthetic.Meridian.1987.mp4")).toBe(observation.probeRequests);
      check("05", transform, observation);
    }));

  it("05-negative: repetition without an independent ID remains a decisive year conflict", async () => fixture(async upstream => {
    const url = media(upstream, "Synthetic.Meridian.1987.mp4");
    const a = producer(upstream, "a", [{ type: "http", url }, { type: "http", url }]);
    const observation = await observePipeline(movie, upstream, [a]);
    expect(observation.probeRequests).toBe(0);
    // Multiplicity changes counts, not the approved per-candidate negative decision.
    expect(observation.candidates.every(candidate => candidate.dimensions.disposition === "REJECT")).toBe(true);
    check("05-negative", "duplicate-negative", observation,
      { ...contracts["05-negative"]!, originsRejectedBeforeDedupe: 2 });
  }));

  it("03: a real request ID echo remains non-corroborating even when repeated", async () => fixture(async upstream => {
    const url = media(upstream, "opaque.mp4");
    let copied = false;
    const echo: StreamProvider = { id: "echo", name: "Synthetic echo", isEnabled: () => true,
      resolve: request => {
        copied = request.externalIds.imdb === movie.externalIds.imdb;
        return Promise.resolve([0, 1].map(() => ({ providerId: "echo", type: "http" as const, url,
          metadata: { identity: { externalIds: { ...request.externalIds } } } })));
      } };
    const observation = await observePipeline(movie, upstream, [echo]);
    expect(observation.stages.deduplicated).toBe(1);
    expect(observation.probeRequests).toBe(1);
    expect(observation.dimensions.identityState === "CORROBORATED").toBe(false);
    expect(observation.dimensions.publicIdentityState === "CORROBORATED").toBe(false);
    check("03", "duplicate-echo", { ...observation,
      dimensions: withWitnesses(observation.dimensions, { requestIdActuallyCopied: copied }) });
  }));

  it("05: an echoed ID cannot counter-anchor a wrong resource year", async () => fixture(async upstream => {
    const url = media(upstream, "Synthetic.Meridian.1987.mp4");
    const echo: StreamProvider = { id: "echo", name: "Synthetic echo", isEnabled: () => true,
      resolve: request => Promise.resolve([{ providerId: "echo", type: "http", url,
        metadata: { identity: { externalIds: { ...request.externalIds } } } }]) };
    const observation = await observePipeline(movie, upstream, [echo]);
    expect(observation.probeRequests).toBe(0);
    check("05-negative", "echo-wrong-year", observation);
  }));

  it.each(["forward", "reverse", "repeat-matching", "repeat-conflicting"] as const)(
    "13: same-resource origin dispute, %s", async transform => fixture(async upstream => {
      const url = media(upstream, "opaque.mp4");
      const good: Source = { type: "http", url, metadata: idClaim(true) };
      const bad: Source = { type: "http", url, metadata: idClaim(false) };
      const a = producer(upstream, "a", transform === "repeat-matching" ? [good, { ...good }] : [good]);
      const b = producer(upstream, "b", transform === "repeat-conflicting" ? [bad, { ...bad }] : [bad]);
      const observation = await observePipeline(movie, upstream, transform === "reverse" ? [b, a] : [a, b], {
        ...(transform === "reverse" ? { target: { providerId: "a", url } } : {}),
        inspect: ({ snapshots }) => {
          expect(snapshots.get("provider")?.[0]?.providerId).toBe(transform === "reverse" ? "b" : "a");
        }
      });
      expect(observation.stages.deduplicated).toBe(1);
      expect(observation.probeRequests).toBe(1);
      check("13", transform, observation);
    }));

  it("13-negative: isolated conflicting ID still rejects without probe", async () => fixture(async upstream => {
    const url = media(upstream, "opaque.mp4");
    const observation = await observePipeline(movie, upstream,
      [producer(upstream, "b", [{ type: "http", url, metadata: idClaim(false) }])]);
    expect(observation.probeRequests).toBe(0);
    check("13-negative", "isolated-negative", observation);
  }));

  it.each(["direct", "redirect", "duplicate", "neutral-first", "neutral-last"] as const)(
    "34: conflicting ID versus validated resource, %s", async transform => fixture(async upstream => {
      const effective = media(upstream, "Synthetic.Meridian.1994.mp4");
      const url = transform === "redirect" ? upstream.media("/media/gateway", { redirectTo: effective }) : effective;
      const source: Source = { type: "http", url, metadata: idClaim(false) };
      const a = producer(upstream, "a", transform === "duplicate" ? [source, { ...source }] : [source]);
      const neutral = producer(upstream, "neutral", [{ type: "http", url }]);
      const providers = transform === "neutral-first" ? [neutral, a] : transform === "neutral-last" ? [a, neutral] : [a];
      const observation = await observePipeline(movie, upstream, providers, {
        ...(transform === "neutral-first" ? { target: { providerId: "a", url } } : {}),
        inspect: ({ snapshots }) => {
          expect(snapshots.get("provider")?.[0]?.providerId).toBe(transform === "neutral-first" ? "neutral" : "a");
        }
      });
      // Real bytes/effective facts may only come from candidates that reach probe.
      expect(upstream.count("/media/Synthetic.Meridian.1994.mp4")).toBe(observation.probeRequests);
      check("34", transform, observation);
    }));

  it.each(["direct", "redirect", "forged-resource"] as const)(
    "34-recall: resource validation control, %s", async transform => fixture(async upstream => {
      const effective = media(upstream, "Synthetic.Meridian.1994.mp4");
      const url = transform === "redirect" ? upstream.media("/media/gateway", { redirectTo: effective })
        : transform === "forged-resource" ? media(upstream, "opaque.mp4") : effective;
      const source: Source = { type: "http", url, ...(transform === "forged-resource" ? {
        directHttp: { status: "verified" as const, verified: true, rangeSupported: true,
          movieResource: { source: "effective_root" as const, validation: "range_206" as const,
            titleKey: "syntheticmeridian", year: 1994, queryPresent: false },
          resourceIdentities: [{ year: 1994 }], actualRuntimeSeconds: 1200 }
      } : {}) };
      const observation = await observePipeline(movie, upstream, [producer(upstream, "a", [source])]);
      expect(observation.probeRequests).toBe(1);
      if (transform === "forged-resource") {
        check("guardrail", transform, observation, { disposition: "ADMIT", identityState: "UNKNOWN",
          publicIdentityState: "UNKNOWN", effectiveIdentityFacts: 0, probe: "VERIFIED", measuredSeconds: 6420 });
      } else {
        expect(upstream.count("/media/Synthetic.Meridian.1994.mp4")).toBe(1);
        check("34-recall", transform, observation);
      }
    }));
});

describe("Phase 4 HTTP route equivalence (real socket requirements)", () => {
  it.each(["same", "header-order", "different-headers", "different-query"] as const)(
    "%s: dedupe only equivalent wire requirements", async transform => fixture(async upstream => {
      let validRequests = 0;
      const headers = { Accept: "video/mp4", Origin: upstream.url("") };
      const path = "/media/opaque.mp4";
      const url = upstream.media(path, { contentType: "video/mp4", body: mp4Fixture(6420), range: "honor",
        ...(transform === "different-query" ? { requiredQuery: "?signature=synthetic" } : { requiredHeaders: headers }),
        observeHeaders: actual => {
          if (actual.accept === headers.Accept && actual.origin === headers.Origin) validRequests++;
        } });
      const bUrl = transform === "different-query" ? url + "?signature=synthetic" : url;
      if (bUrl !== url) upstream.allowMediaUrl(bUrl);
      const aHeaders = transform === "different-query" ? undefined : headers;
      const bHeaders = transform === "different-headers" ? { ...headers, Accept: "video/webm" }
        : transform === "header-order" ? { Origin: headers.Origin, Accept: headers.Accept } : aHeaders;
      const sources: Source[] = [{ type: "http", url, ...(aHeaders ? { requestHeaders: aHeaders } : {}) },
        { type: "http", url: bUrl, ...(bHeaders ? { requestHeaders: bHeaders } : {}) }];
      const observation = await observePipeline(movie, upstream, [producer(upstream, "a", sources)]);
      const distinct = transform.startsWith("different-");
      // Failed HTTP requirements remain transport/media refusal, never identity rejection.
      expect(observation.dimensions.identityRejections).toBe(0);
      if (transform !== "different-query") expect(validRequests).toBe(transform === "different-headers" ? 1 : observation.probeRequests);
      check("guardrail", transform, observation, { admittedResources: 1, identityRejections: 0 });
      expect(observation.stages.deduplicated, "wire-equivalent headers must not create a second resource").toBe(distinct ? 2 : 1);
      expect(new Set(observation.candidates.map(candidate => candidate.resource)).size).toBe(distinct ? 2 : 1);
      expect(observation.probeRequests).toBe(distinct ? 2 : 1);
    }));
});
