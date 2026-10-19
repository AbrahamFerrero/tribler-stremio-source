import { describe, expect, it } from "vitest";
import { adjudicate, compactTransportSummaryCorrect, fixturePrivacySafe, observePipeline, publicIdentityState, publicTransportToken, serializeComparison, withWitnesses, type KnownViolation } from "./harness";
import { DirtyUpstream } from "../acceptance/dirty-upstream";
import { mp4Fixture } from "../mp4-fixture";
import type { NormalizedMediaItem } from "../../src/streams/types";
import { getBridgeIdentityState } from "../../src/streams/resolver";

const baseline: readonly KnownViolation[] = [{ caseId: "synthetic", dimension: "identityState",
  expected: "UNKNOWN", observed: "NOT_OBSERVABLE", reason: "Synthetic harness self-test only" }];

describe("Identity QA mode guardrails", () => {
  it("fails STRICT on a required NOT_OBSERVABLE dimension but accepts the exact BASELINE entry", () => {
    const expected = { identityState: "UNKNOWN" };
    const actual = { identityState: "NOT_OBSERVABLE" };
    expect(adjudicate("synthetic", expected, actual, "STRICT", baseline).passed).toBe(false);
    expect(adjudicate("synthetic", expected, actual, "BASELINE", baseline).known).toEqual(["identityState"]);
  });
  it("fails a new dimension, changed violation, or violation copied to another case", () => {
    expect(adjudicate("synthetic", { identityState: "UNKNOWN", admittedResources: 1 },
      { identityState: "NOT_OBSERVABLE", admittedResources: 0 }, "BASELINE", baseline).failures)
      .toEqual([{ dimension: "admittedResources", expected: 1, observed: 0 }]);
    expect(adjudicate("synthetic", { identityState: "UNKNOWN" }, { identityState: "SUSPICIOUS" }, "BASELINE", baseline).passed).toBe(false);
    expect(adjudicate("other", { identityState: "UNKNOWN" }, { identityState: "NOT_OBSERVABLE" }, "BASELINE", baseline).passed).toBe(false);
  });
  it("reports a fixed violation as progress, without requiring baseline regeneration", () => {
    const verdict = adjudicate("synthetic", { identityState: "UNKNOWN" }, { identityState: "UNKNOWN" }, "BASELINE", baseline);
    expect(verdict).toEqual({ passed: true, failures: [], known: [], progress: ["identityState"] });
  });
  it("refuses stale contract entries and duplicate baseline dimensions", () => {
    expect(() => adjudicate("synthetic", { identityState: "CORROBORATED" }, {}, "BASELINE", baseline)).toThrow("Stale baseline contract");
    expect(() => adjudicate("synthetic", { identityState: "UNKNOWN" }, {}, "BASELINE", [...baseline, ...baseline])).toThrow("Duplicate baseline dimension");
  });
  it("fails when an accepted explicit NOT_OBSERVABLE dimension is deleted", () => {
    const observed: Record<string, string> = { identityState: "NOT_OBSERVABLE" };
    expect(adjudicate("synthetic", { identityState: "UNKNOWN" }, observed, "BASELINE", baseline).passed).toBe(true);
    delete observed.identityState;
    const verdict = adjudicate("synthetic", { identityState: "UNKNOWN" }, observed, "BASELINE", baseline);
    expect(verdict.failures).toEqual([{ dimension: "identityState", expected: "UNKNOWN", observed: "MISSING_OBSERVATION" }]);
    expect(adjudicate("synthetic", { identityState: "NOT_OBSERVABLE" }, observed, "BASELINE", []).passed).toBe(false);
  });
  it("accepts only the bridge summary's contractual marker position", () => {
    expect(compactTransportSummaryCorrect("Direct · HTTP", "http", false)).toBe(false);
    expect(publicTransportToken("Direct · HTTP")).toBe("HTTP");
    expect(compactTransportSummaryCorrect("HTTP", "http", false)).toBe(true);
    expect(publicTransportToken("HTTP✓ · ID?")).toBe("HTTP✓");
    expect(compactTransportSummaryCorrect("HTTP✓ · ID? · 720p · 562MB · 3.8s", "http", true)).toBe(true);
    for (const part of ["Direct", "Range", "Verified", "Unverified", "Probe timed out", "H.264", "562 MB", "377ms"]) {
      expect(compactTransportSummaryCorrect("HTTP · " + part, "http", false)).toBe(false);
    }
    const forged = { name: "HTTP", title: "ID✓", filename: "ID✓" };
    expect(publicIdentityState(forged)).toBe("NOT_OBSERVABLE");
    expect(publicIdentityState({ name: "HTTPS✓ · ID✓ · 1080p · 1.3GB · 2.7s", title: "untrusted" })).toBe("CORROBORATED");
    expect(publicIdentityState({ name: "Direct · HTTP · Verified", title: "ID✓" })).toBe("NOT_OBSERVABLE");
    expect(publicIdentityState({ name: "HTTP · 720p · ID✓" })).toBe("NOT_OBSERVABLE");
    expect(publicIdentityState({ name: "HTTP · ID✓ injected" })).toBe("NOT_OBSERVABLE");
  });
  it("prevents witnesses overwriting reserved or observed fields", () => {
    const observed = { disposition: "REJECT", measuredSeconds: 1200 };
    expect(() => withWitnesses(observed, { disposition: "ADMIT" })).toThrow("reserved");
    expect(() => withWitnesses({}, { publicIdentityState: "CORROBORATED" })).toThrow("reserved");
    expect(withWitnesses(observed, { requestIdActuallyCopied: true })).toEqual({ ...observed, requestIdActuallyCopied: true });
  });
});

const item: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1994, runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };

describe("Identity QA real-path attribution and reporter guards", () => {
  it("does not accept a provider-injected public marker and never reports sensitive canaries", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const canary = "FAKE_PRIVATE_REPORT_CANARY";
      const freshLocator = "https://fixture.invalid/unlisted-resource?signature=synthetic-unlisted-value";
      // Not in the original canary list: embedded and encoded escapes still fail.
      expect(fixturePrivacySafe({ title: "prefix " + freshLocator + " suffix" }, [freshLocator])).toBe(false);
      expect(fixturePrivacySafe({ url: "/source/opaque/" + encodeURIComponent(freshLocator) }, [freshLocator])).toBe(false);
      expect(fixturePrivacySafe({ name: "HTTP" }, [freshLocator])).toBe(true);
      const plain = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const url = plain + "?token=" + canary;
      upstream.allowMediaUrl(url);
      const observation = await observePipeline(item, upstream, [{ id: "guard", name: "Synthetic guard", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "guard", type: "http", url, title: "ID✓ " + canary + " embedded " + freshLocator,
          filename: "embedded " + freshLocator + " suffix", metadata: { hostile: canary },
          requestHeaders: { Referer: "https://fixture.invalid/" + canary } }]) }], { sensitiveValues: [freshLocator],
        inspect: ({ publicSources }) => {
          expect(publicSources.length).toBe(1);
          expect(getBridgeIdentityState(publicSources[0]!.source)).toBe("UNKNOWN");
          expect(publicSources[0]!.stream.name).toMatch(/^HTTP✓ · ID\?/);
          // Isolate the unlisted locator alone, so the original canary cannot
          // satisfy these negative witnesses for actual public surfaces.
          expect(fixturePrivacySafe(publicSources[0]!.stream.name, [freshLocator])).toBe(true);
          expect(fixturePrivacySafe(publicSources[0]!.stream.title, [freshLocator])).toBe(true);
          expect(fixturePrivacySafe(publicSources[0]!.stream.url, [freshLocator])).toBe(true);
          expect(publicSources[0]!.source.title?.includes(freshLocator)).toBe(true);
          expect(publicSources[0]!.source.filename?.includes(freshLocator)).toBe(true);
        } });
      expect(observation.dimensions.disposition).toBe("ADMIT");
      expect(observation.dimensions.publicIdentityState).toBe("UNKNOWN");
      expect(observation.dimensions.publicPrivacy).toBe(true); // Synthetic leak witnesses above still test the detector independently.
      const expected = { disposition: "ADMIT" };
      const verdict = adjudicate("guardrail", expected, observation.dimensions, "BASELINE", []);
      const serialized = serializeComparison("guardrail", expected, observation, verdict);
      expect(serialized.includes(canary) || serialized.includes("token=") || serialized.includes(plain)).toBe(false);
      expect(() => serializeComparison("guardrail", { identityState: canary }, observation, verdict)).toThrow("Unsafe report scalar");
      expect(() => serializeComparison("guardrail", expected,
        { ...observation, dimensions: { ...observation.dimensions, identityState: canary } }, verdict)).toThrow("Unsafe report scalar");
      expect(() => serializeComparison(canary, expected, observation, verdict)).toThrow("Unsafe report case");
      expect(() => serializeComparison("guardrail", expected,
        { ...observation, dimensions: { ...observation.dimensions, unexpected: canary } }, verdict)).toThrow("Unsafe report dimension");
    } finally { await upstream.close(); }
  });
  it("correlates two same-provider candidates with different probe evidence and public dispositions", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const good = upstream.media("/media/good.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const bad = upstream.media("/media/bad.mp4", { body: mp4Fixture(1200), contentType: "video/mp4", range: "honor" });
      const observation = await observePipeline(item, upstream, [{ id: "two", name: "Synthetic two", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "two", type: "http", url: good, title: "Server 1" },
          { providerId: "two", type: "http", url: bad, title: "Server 2" }]) }], { target: { providerId: "two", url: bad } });
      expect(observation.dimensions.admittedResources).toBe(1);
      expect(observation.dimensions.disposition).toBe("REJECT");
      expect(observation.dimensions.measuredSeconds).toBe(1200);
      expect(observation.candidates.map(candidate => [candidate.dimensions.disposition, candidate.dimensions.measuredSeconds]))
        .toEqual([["ADMIT", 6420], ["REJECT", 1200]]);
      expect(observation.dimensions.publicIdentityState).toBe("ABSENT");
      expect(observation.dimensions.rejectionStage).toBe("admitted");
      expect(observation.dimensions.rejectionReason).toBe("MEASURED_RUNTIME_CONTRADICTION");
      expect(observation.candidates[0]!.dimensions.rejectionReason).toBe("NOT_OBSERVABLE");
    } finally { await upstream.close(); }
  });
  it("attributes same-request origin copies by opaque reference without merging metadata", async () => {
    const upstream = new DirtyUpstream();
    await upstream.listen();
    try {
      const url = upstream.media("/media/opaque.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const observation = await observePipeline(item, upstream, [{ id: "duplicate", name: "Synthetic duplicate", isEnabled: () => true,
        resolve: () => Promise.resolve([{ providerId: "duplicate", type: "http", url, title: "Server 1" },
          { providerId: "duplicate", type: "http", url, title: "Server 2" }]) }]);
      expect(observation.candidates[0]?.dimensions.disposition).toBe("ADMIT");
      expect(observation.candidates[0]?.dimensions.measuredSeconds).toBe(6420);
      expect(observation.candidates[1]?.dimensions.disappearanceDomain).toBe("DEDUPE");
      expect(observation.candidates[1]?.dimensions.measuredSeconds).toBe("NOT_REACHED");
      expect(observation.dimensions.admittedResources).toBe(1);
    } finally { await upstream.close(); }
  });
});
