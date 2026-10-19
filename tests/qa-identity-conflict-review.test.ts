import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConflictFrequency, conflictCaseSignal, conflictConfig, conflictPattern, conflictReport, parseConflictArgs, privateConflictDirectory } from "../scripts/qa-identity-conflict-review";
import { assessStudyKodi, isolatedStudyCell, selectStudyCases, StudyObservation, studyConfig, studySchedule, studySummary } from "../scripts/qa-identity-conflict-review";
import type { EvaluationCorpus } from "../scripts/evaluation-corpus";
import { DirectTransport } from "../src/network/outbound-transport";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StremioAddonStreamProvider } from "../src/streams/providers/stremio-addon-stream-provider";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";
import { withinSmokeDeadline } from "../scripts/identity-live-smoke-runner";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { RejectedSourceReview } from "../src/qa/rejected-source-review";
import { IdentityDiagnostics } from "../src/qa/identity-diagnostics";
import { StreamProviderRegistry, StreamResolver, type StreamResolverTrace } from "../src/streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { silentLogger, testConfig } from "./helpers";

const item: NormalizedMediaItem = { id: "synthetic", kind: "movie", title: "Synthetic Meridian", year: 1994,
  externalIds: { imdb: "tt9999999999" } };
const source = (name: string, id = "tt9999999999"): NormalizedStreamSource => ({ providerId: "external_http", type: "https",
  url: `https://media.example/${name}?signature=FAKE_PRIVATE_QUERY`,
  metadata: { identity: { externalIds: { imdb: id } }, secret: "FAKE_PRIVATE_METADATA" },
  requestHeaders: { Accept: "video/mp4", Origin: "https://FAKE_PRIVATE_ORIGIN.example" } });

describe("opt-in conflict frequency", () => {
  it("requires explicit bounded arguments and refuses extra execution/review switches", () => {
    expect(parseConflictArgs(["--corpus", "private.json", "--out-dir", "private-dir"]))
      .toEqual({ corpus: "private.json", outDir: "private-dir", maxCases: 20, deadlineMs: 180_000,
        caseDeadlineMs: 15_000, providerConcurrency: 2 });
    for (const args of [[], ["--corpus", "private.json"], ["--max-cases", "101"], ["--deadline-ms", "240001"],
      ["--review", "6"], ["--quick", "true"], ["--full", "true"], ["--corpus", "a", "--corpus", "b"]]) {
      expect(() => parseConflictArgs(args)).toThrow();
    }
  });

  it("accepts the four-case profile and bounds scheduling without extending provider or probing timeouts", () => {
    const base = ["--corpus", "private.json", "--out-dir", "private-dir"];
    const args = parseConflictArgs([...base, "--max-cases", "4", "--deadline-ms", "240000",
      "--case-deadline-ms", "60000", "--provider-concurrency", "6"]);
    expect(args).toMatchObject({ maxCases: 4, deadlineMs: 240_000, caseDeadlineMs: 60_000, providerConcurrency: 6 });
    const configured = testConfig();
    const before = conflictConfig(configured, parseConflictArgs(base));
    const after = conflictConfig(configured, args);
    expect(after).toEqual({ ...before, streamProviderMaxConcurrent: 6 });
    expect(configured.streamProviderMaxConcurrent).toBe(testConfig().streamProviderMaxConcurrent);
    for (const [flag, value] of [["--case-deadline-ms", "60001"], ["--case-deadline-ms", "0"],
      ["--provider-concurrency", "7"], ["--provider-concurrency", "0"], ["--provider-concurrency", "1.5"],
      ["--case-deadline-ms", "NaN"], ["--deadline-ms", "0"]]) {
      expect(() => parseConflictArgs([...base, flag!, value!])).toThrow();
    }
  });

  it("completes four viable cases with 28 providers while preserving failed and timed-out outcomes", async () => {
    const args = parseConflictArgs(["--corpus", "private.json", "--out-dir", "private-dir", "--max-cases", "4",
      "--deadline-ms", "240000", "--case-deadline-ms", "60000", "--provider-concurrency", "6"]);
    // Millisecond-scale provider fixtures exercise the real queue and native abort deadlines.
    const config = conflictConfig({ ...testConfig(), streamProviderTimeoutMs: 80 }, args);
    const controller = new AbortController();
    const rows: Parameters<typeof conflictReport>[0] = [];
    let active = 0, peak = 0;
    try {
      for (let caseIndex = 0; caseIndex < args.maxCases; caseIndex += 1) {
        const frequency = new ConflictFrequency(item, false);
        const registry = new StreamProviderRegistry(config.streamProviderTimeoutMs, silentLogger, config.streamProviderMaxConcurrent);
        for (let index = 0; index < 28; index += 1) {
          const id = `stremio-addon-synthetic-${index}`;
          registry.register({ id, name: "Synthetic fixture", isEnabled: () => true,
            resolve: (_item, context) => new Promise((resolve, reject) => {
              if (context.signal.aborted) { reject(new Error("Cancelled")); return; }
              active += 1; peak = Math.max(peak, active);
              const finish = (): void => { active -= 1; clearTimeout(timer); context.signal.removeEventListener("abort", abort); };
              const abort = (): void => { finish(); reject(new Error("FAKE_PRIVATE_TIMEOUT")); };
              // Four providers wait for their individual timeout; others finish independently.
              const timer = index % 7 === 0 ? undefined : setTimeout(() => {
                finish();
                if (index % 7 === 1) reject(new Error("FAKE_PRIVATE_ERROR")); // Four errors.
                else resolve([{ ...source(`Synthetic.Meridian.1987.${index}.mp4`), providerId: id }]);
              }, index % 7 === 1 ? 5 : 25);
              context.signal.addEventListener("abort", abort, { once: true });
            }) });
        }
        const signal = conflictCaseSignal(controller.signal, args.caseDeadlineMs);
        const resolver = new StreamResolver(registry, new ExternalUrlPolicy(), undefined, frequency.trace);
        await withinSmokeDeadline(() => resolver.resolve(item, signal), signal);
        const observed = frequency.report();
        expect(observed).toMatchObject({ intakeObserved: true, received: 20, normalizable: 20, early: 20, pattern05: 20 });
        expect(registry.status().filter(row => row.status === "error")).toHaveLength(8);
        expect(registry.status().filter(row => row.lastError === "Provider timed out or was cancelled")).toHaveLength(4);
        rows.push({ case: caseIndex + 1, status: "completed", frequency: observed, diagnostics: null });
      }
      expect(peak).toBe(6); expect(active).toBe(0);
      const report = conflictReport(rows, 24);
      expect(report.caseOutcomes.completed).toBe(4);
      expect(report.totals).toMatchObject({ received: 80, normalizable: 80, early: 80 });
      expect(report.rates.earlyOfNormalizable).toEqual({ numerator: 80, denominator: 80, percent: 100 });
      expect(report.observationCoverage).toEqual({ casesWithIntake: 4, casesWithoutIntake: 0 });
      expect(JSON.stringify(report)).not.toContain("FAKE_PRIVATE");
    } finally { controller.abort(); }
  });

  it("lets global cancellation override the case deadline and reports missing intake as unknown", async () => {
    const controller = new AbortController();
    const signal = conflictCaseSignal(controller.signal, 60_000);
    controller.abort();
    expect(signal.aborted).toBe(true);
    const frequency = new ConflictFrequency(item, false);
    await expect(withinSmokeDeadline(() => Promise.resolve([]), signal)).rejects.toThrow();
    expect(frequency.report().intakeObserved).toBe(false);
    const report = conflictReport([{ case: 1, status: "timed_out", frequency: null, diagnostics: null }], 24);
    expect(report.observationCoverage).toEqual({ casesWithIntake: 0, casesWithoutIntake: 1 });
    expect(report.rates.earlyOfNormalizable.percent).toBeNull();
    expect(report.caseOutcomes.completed).toBe(0);
  });

  it("distinguishes missing intake at the deadline from observed partial intake after cancellation drains", async () => {
    const registry = new StreamProviderRegistry(1000, silentLogger, 2);
    let partialResults = 0;
    let startedProviders = 0;
    for (let index = 0; index < 28; index += 1) {
      registry.register({ id: `stremio-addon-partial-${index}`, name: "Synthetic partial", isEnabled: () => true,
        resolve: (_item, context) => {
          startedProviders += 1;
          if (index === 0) { partialResults += 1; return Promise.resolve([source("Synthetic.Meridian.1987.mp4")]); }
          return new Promise((_resolve, reject) => {
            if (context.signal.aborted) reject(new Error("Cancelled"));
            else context.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          });
        } });
    }
    const frequency = new ConflictFrequency(item, false);
    const signal = conflictCaseSignal(new AbortController().signal, 30);
    let deadlineSnapshot: ReturnType<ConflictFrequency["report"]> | undefined;
    signal.addEventListener("abort", () => { deadlineSnapshot = frequency.report(); }, { once: true });
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy(), undefined, frequency.trace);
    const pending = resolver.resolve(item, signal);
    await expect(withinSmokeDeadline(() => pending, signal)).rejects.toThrow();
    expect(partialResults).toBe(1);
    // Awaiting the deadline rejection also lets the registry drain microtasks.
    // Capture the deadline itself rather than depending on how many queue turns
    // cancellation takes. No intake at that instant remains missing evidence.
    expect(deadlineSnapshot).toMatchObject({ intakeObserved: false, received: 0 });
    const observed = deadlineSnapshot!;
    const report = conflictReport([{ case: 1, status: "timed_out",
      frequency: observed.intakeObserved ? observed : null, diagnostics: null }], 24);
    expect(report.observationCoverage).toEqual({ casesWithIntake: 0, casesWithoutIntake: 1 });
    expect(report.cases[0]?.frequency).toBeNull();
    expect(report.rates.earlyOfNormalizable.percent).toBeNull();
    await pending; // Drain the cancelled queue; no background fixture work survives the test.
    // Prompt queue cancellation can expose the already completed provider's
    // real partial intake. That evidence does not make the timed-out case complete.
    expect(startedProviders).toBe(3);
    const drained = frequency.report();
    expect(drained).toMatchObject({ intakeObserved: true, received: 1, normalizable: 1, early: 1 });
    const partialReport = conflictReport([{ case: 1, status: "timed_out", frequency: drained, diagnostics: null }], 24);
    expect(partialReport.observationCoverage).toEqual({ casesWithIntake: 1, casesWithoutIntake: 0 });
    expect(partialReport.caseOutcomes).toMatchObject({ completed: 0, timed_out: 1 });
    expect(partialReport.totals).toMatchObject({ received: 1, normalizable: 1, early: 1 });
  });

  it("rejects ignored worktree output and nested Git directories", () => {
    expect(() => privateConflictDirectory(process.cwd())).toThrow();
    const root = mkdtempSync(join(tmpdir(), "conflict-output-"));
    try {
      expect(privateConflictDirectory(root)).toBeTruthy();
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "private"));
      expect(() => privateConflictDirectory(join(root, "private"))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("counts real early decisions, duplicates and weak patterns without admitting rejected sources or probing them", async () => {
    const first = source("Synthetic.Meridian.1987.mp4");
    const candidates = [first, { ...first, requestHeaders: { Origin: first.requestHeaders!.Origin!, Accept: "video/mp4" } },
      source("Synthetic.Meridian.1994.mp4", "tt8888888888"),
      { ...source("opaque.mp4"), title: "Synthetic Meridian (1987)" },
      { ...source("Other.1987.mp4"), metadata: {} },
      { ...source("kind.mp4"), metadata: { identity: { kind: "episode" } } },
      source("unproven.mp4", "tt8888888888"),
      { ...source("good.mp4"), metadata: {} }, { ...source("invalid.mp4"), filename: "danger.exe" }];
    const registry = new StreamProviderRegistry(100, silentLogger);
    registry.register({ id: "external_http", name: "FAKE_PRIVATE_PROVIDER", isEnabled: () => true,
      resolve: () => Promise.resolve(candidates) });
    const request = vi.fn().mockRejectedValue(new Error("Unexpected media request"));
    const review = new RejectedSourceReview({ id: "fixture", request,
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) }, item);
    try {
      const diagnostic = new IdentityDiagnostics(item, review);
      const frequency = new ConflictFrequency(item, false);
      const trace: StreamResolverTrace = {
        stage: (...args) => { diagnostic.trace.stage(...args); frequency.trace.stage(...args); },
        rejection: event => { diagnostic.trace.rejection?.(event); frequency.trace.rejection?.(event); },
        preProbeIdentity: event => frequency.trace.preProbeIdentity?.(event)
      };
      const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
      const result = await new StreamResolver(registry, policy, undefined, trace).resolve(item);
      expect(result.map(candidate => candidate.url)).toEqual([candidates[7]!.url]);
      const observed = frequency.report();
      expect(observed).toMatchObject({ received: 9, normalizable: 8, invalidNormalization: 1, afterIdentityAndUrlPolicy: 1,
        early: 7, pattern05: 2, pattern34PotentialUrlYear: 1, distinctCaseResources: 7,
        duplicateResourceOccurrences: 1, distinctEarlyCaseResources: 6, duplicateEarlyResourceOccurrences: 1,
        distinctPattern05CaseResources: 1, distinctPattern34PotentialCaseResources: 1,
        unclassifiedFor05or34: 4, explicitRejectionEvents: 4, earlyHttp: 7, earlyNonHttp: 0,
        reasons: { MOVIE_YEAR_CONFLICT: 4, EXTERNAL_ID_CONFLICT: 2, KIND_CONFLICT: 1 } });
      const report = conflictReport([{ case: 1, status: "completed", frequency: observed,
        diagnostics: diagnostic.report(undefined, 0, registry.status()) },
      { case: 2, status: "timed_out", frequency: null, diagnostics: null }], 10);
      expect(report.rates.earlyOfNormalizable).toEqual({ numerator: 7, denominator: 8, percent: 87.5 });
      expect(report.casesNotSelected).toBe(8);
      expect(report.review).toMatchObject({ supported: false, performed: 0, ruleVerdict: null, earlyHttpWithoutVerifiedMp4: 7,
        excludedByFormatAlone: null, contentTruth: "INSUFFICIENT_EVIDENCE" });
      expect(request).not.toHaveBeenCalled();
      expect(review.summaries()).toEqual([]);
      const serialized = JSON.stringify(report);
      for (const privateValue of ["FAKE_PRIVATE", "media.example", "Synthetic", "tt9999999999", "signature=", "https://", "requestHeaders"])
        expect(serialized).not.toContain(privateValue);
    } finally { await review.close(); }
  });

  it("retains provider failures and timeouts without adding them to source denominators", async () => {
    const registry = new StreamProviderRegistry(10, silentLogger);
    registry.register({ id: "local_json", name: "Synthetic error", isEnabled: () => true,
      resolve: () => Promise.reject(new Error("FAKE_PRIVATE_ERROR")) });
    registry.register({ id: "stremio-addon-synthetic", name: "Synthetic timeout", isEnabled: () => true,
      resolve: (_item, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("FAKE_PRIVATE_TIMEOUT")), { once: true });
      }) });
    const request = vi.fn().mockRejectedValue(new Error("Unexpected request"));
    const review = new RejectedSourceReview({ id: "fixture", request,
      diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) }, item);
    try {
      const diagnostic = new IdentityDiagnostics(item, review);
      const frequency = new ConflictFrequency(item, true);
      const trace: StreamResolverTrace = { stage: (...args) => { diagnostic.trace.stage(...args); frequency.trace.stage(...args); },
        preProbeIdentity: event => frequency.trace.preProbeIdentity?.(event),
        rejection: event => frequency.trace.rejection?.(event) };
      await new StreamResolver(registry, new ExternalUrlPolicy(), undefined, trace).resolve(item);
      const diagnostics = diagnostic.report(undefined, 0, registry.status());
      expect(diagnostics.providers).toMatchObject({ errors: 1, timeouts: 1 });
      const report = conflictReport([{ case: 1, status: "completed", diagnostics, frequency: frequency.report() }], 1);
      expect(report.totals).toMatchObject({ received: 0, normalizable: 0, early: 0 });
      expect(report.rates.earlyOfNormalizable.percent).toBeNull();
      expect(JSON.stringify(report)).not.toContain("FAKE_PRIVATE");
      expect(request).not.toHaveBeenCalled();
    } finally { await review.close(); }
  });

  it("does not count presentation-only year disputes, conflicting IDs or opaque resources as stronger patterns", () => {
    expect(conflictPattern(item, { ...source("opaque.mp4"), title: "Synthetic Meridian (1987)" }, "MOVIE_YEAR_CONFLICT").pattern05).toBe(false);
    expect(conflictPattern(item, source("Synthetic.Meridian.1987.mp4", "tt8888888888"), "EXTERNAL_ID_CONFLICT"))
      .toEqual({ pattern05: false, pattern34PotentialUrlYear: false });
    expect(conflictPattern(item, source("opaque.mp4", "tt8888888888"), "EXTERNAL_ID_CONFLICT").pattern34PotentialUrlYear).toBe(false);
    expect(conflictPattern(item, { ...source("Synthetic.Meridian.1994.mp4", "tt8888888888"), filename: "Other.1987.mp4" },
      "EXTERNAL_ID_CONFLICT").pattern34PotentialUrlYear).toBe(false);
    expect(conflictReport([], 1).rates.earlyOfNormalizable.percent).toBeNull();
  });
});

describe("isolated HTTPS resolution exploration", () => {
  it("preserves effective production B and applies only the specified A/C/D settings in memory", () => {
    const base = testConfig({ streamProviders: ["catalog", "stremio_addons", "external_http"],
      streamProviderTimeoutMs: 25_000, stremioAddonRequestTimeoutMs: 25_000, externalStreamProviderTimeoutMs: 90_000,
      directHttpProbe: { enabled: false, maxCandidates: 48, timeoutMs: 4000, maxConcurrent: 32 } });
    const production = studyConfig(base, "B", "combined");
    expect(production).toEqual({ ...base, streamProviders: ["stremio_addons", "external_http"] });
    expect(studyConfig(base, "C", "combined")).toEqual({ ...production,
      stremioAddonRequestTimeoutMs: 8000, externalStreamProviderTimeoutMs: 20_000 });
    expect(studyConfig(base, "D", "combined")).toEqual({ ...production,
      directHttpProbe: { enabled: false, maxCandidates: 16, timeoutMs: 6000, maxConcurrent: 4 } });
    expect(studyConfig(base, "A", "stremio")).toMatchObject({ streamProviders: ["stremio_addons"], streamProviderTimeoutMs: 3000,
      directHttpProbe: { enabled: false, maxCandidates: 4, timeoutMs: 1500, maxConcurrent: 2 } });
    expect(base.externalStreamProviderTimeoutMs).toBe(90_000);
    expect(base.directHttpProbe.maxCandidates).toBe(48);
  });

  it("selects four stable diverse cases and reuses them for every family/profile with combined D last", () => {
    const corpus: EvaluationCorpus = { id: "synthetic", version: 1, fingerprint: "synthetic", cases:
      ["movie", "series", "anime", "movie", "anime"].map((mediaClass, index) => ({ id: `synthetic-${index}`,
        mediaClass: mediaClass as "movie" | "series" | "anime", cohort: "mainstream" as const,
        item: { ...item, kind: mediaClass === "series" || index === 4 ? "episode" : "movie" } })) };
    const selected = selectStudyCases(corpus);
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map(entry => `${entry.mediaClass}/${entry.item.kind}`)).size).toBe(4);
    expect(selectStudyCases(corpus)).toEqual(selected);
    const schedule = studySchedule(selected.length);
    expect(schedule).toHaveLength(40);
    expect(schedule.slice(-4).every(job => job.family === "combined" && job.profile === "D")).toBe(true);
    for (const family of ["stremio", "external_http"] as const) for (const profile of ["A", "B", "C", "D"] as const)
      expect(schedule.filter(job => job.family === family && job.profile === profile).map(job => job.case)).toEqual([1, 2, 3, 4]);
  });

  it("requires the actual advertised configured Kodi IDs and reports safe live deadlines without guessing worker limits", () => {
    const health = { ok: true, service: "tribler-stremio-python-adapter", resolverTimeoutSeconds: 70,
      requestTimeoutSeconds: 80, maxConcurrentResolvers: 4, secret: "FAKE_PRIVATE_HEALTH" };
    const resolvers = { resolvers: [{ id: "FAKE_PRIVATE_ID", name: "FAKE_PRIVATE_NAME", enabled: true, status: "never-run" }] };
    const advertised = assessStudyKodi(health, resolvers, ["FAKE_PRIVATE_ID"]);
    expect(advertised).toMatchObject({ status: "KODI_ADVERTISED", resolverTimeoutSeconds: 70, requestTimeoutSeconds: 80,
      outcomes: { neverRun: 1, ok: 0 } });
    expect(JSON.stringify(advertised)).not.toContain("FAKE_PRIVATE");
    expect(assessStudyKodi({}, resolvers, ["FAKE_PRIVATE_ID"]).status).toBe("KODI_UNAVAILABLE");
    expect(assessStudyKodi(health, { resolvers: [{ id: "example", enabled: true, status: "ok" }] }, ["FAKE_PRIVATE_ID"]).status)
      .toBe("KODI_UNAVAILABLE");
    expect(assessStudyKodi(health, resolvers, []).status).toBe("KODI_UNAVAILABLE");
  });

  it("observes real providers, resolver and probe at controlled boundaries without exposing source identities", async () => {
    const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
    const body = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    const urls = ["a", "b", "c", "d", "e"].map(name => `https://media.example/${name}.mp4?signature=FAKE_PRIVATE_QUERY`);
    const addon = new StremioAddonStreamProvider({ id: "synthetic", name: "FAKE_PRIVATE_NAME", enabled: true,
      manifestUrl: "https://addon.example/manifest.json", timeoutMs: 500, manifestTtlMs: 1000, endpointPolicy: () => policy,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValueOnce(body({ id: "synthetic", version: "1.0.0",
        name: "Synthetic", description: "Synthetic", resources: ["stream"], types: ["movie"] }))
        .mockResolvedValueOnce(body({ streams: urls.slice(0, 4).map(url => ({ url })) })) });
    const external = new ExternalHttpStreamProvider({ url: "https://adapter.example/resolve", timeoutMs: 500, policy,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(body({ streams: [
        ...[urls[0], urls[4]].map(url => ({ type: "https", url })), { type: "https", url: "invalid-url" }
      ] })) });
    const registry = new StreamProviderRegistry(500, silentLogger, 2);
    registry.register(addon); registry.register(external);
    const pinned = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
      status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/100" }
    })));
    const transport = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger, pinned);
    const probe = new DirectStreamProbe(transport, { enabled: true, maxCandidates: 2, timeoutMs: 500, maxConcurrent: 1 }, silentLogger);
    const observation = new StudyObservation(item, true);
    await new StreamResolver(registry, policy, probe, observation.trace).resolve(item);
    const metrics = observation.report(registry.status());
    expect(metrics.stages.provider).toMatchObject({ candidates: 7, httpsDistinct: 5, httpsVerified: 0 });
    expect(metrics.normalizable).toBe(6);
    expect(metrics.stages.normalized?.httpsDistinct).toBe(5);
    expect(metrics.stages.probed?.httpsVerified).toBe(2);
    expect(metrics.stages.admitted?.httpsDistinct).toBe(2);
    expect(metrics.stages.final?.httpsDistinct).toBe(2);
    expect(metrics.probe).toMatchObject({ starts: 2, verified: 2, unexamined: 3, exhausted: 0, failed: 0 });
    expect(pinned).toHaveBeenCalledTimes(2);
    expect(metrics.providers).toMatchObject({ selected: 2, ok: 2, errors: 0, timeoutsOrCancelled: 0 });
    expect(metrics.timing.providerQueueMs).toBeNull();
    expect(metrics.timing.probingMs).toBeGreaterThanOrEqual(0);
    expect(metrics.timing.listingMs).toBeGreaterThanOrEqual(metrics.timing.probingMs!);
    expect(JSON.stringify(metrics)).not.toContain("FAKE_PRIVATE");
    expect(JSON.stringify(metrics)).not.toContain("https://");
    const base = { case: 1, profile: "B" as const, family: "stremio" as const,
      status: "completed" as const, elapsedMs: 1, metrics, kodi: null };
    const summary = studySummary([base, { ...base, profile: "A" },
      { ...base, case: 2, profile: "A", status: "timed_out", metrics: null }]);
    expect(summary.table.find(row => row.profile === "A" && row.family === "stremio"))
      .toMatchObject({ planned: 2, completed: 1, incomplete: 1, finalHttps: 2,
        pairedAgainstB: [{ case: 1, finalHttpsDelta: 0, verifiedHttpsDelta: 0, listingMsDelta: 0 }] });
    expect(summary.observations.productionCasesWithUnexaminedOrExhausted).toBe(1);
    expect(studySummary([{ ...base, status: "KODI_UNAVAILABLE", metrics: null }]).table.find(row => row.profile === "B" && row.family === "stremio")?.finalHttps).toBeNull();
  });

  it("runs a cold isolated real external-provider cell only through its configured adapter and skips an example-only host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "https-study-"));
    const profiles = join(directory, "profiles.json");
    writeFileSync(profiles, JSON.stringify({ version: 1, profiles: [{ id: "synthetic_kodi", enabled: true, workerTimeoutSeconds: 5 }] }));
    let advertised = true, calls = 0;
    let hold: (() => void) | undefined;
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/health") response.end(JSON.stringify({ ok: true, service: "tribler-stremio-python-adapter",
        resolverTimeoutSeconds: 6, requestTimeoutSeconds: 8, maxConcurrentResolvers: 4 }));
      else if (request.url === "/resolvers") response.end(JSON.stringify({ resolvers: [
        { id: advertised ? "synthetic_kodi" : "example", enabled: true, status: calls ? "ok" : "never-run" }] }));
      else if (request.url === "/resolve" && request.method === "POST") {
        calls += 1;
        if (hold) { hold(); return; }
        response.end(JSON.stringify({ streams: [source("Synthetic.Meridian.1987.mp4")] }));
      } else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      vi.stubEnv("STREAM_PROVIDERS", "external_http");
      vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:9999");
      vi.stubEnv("STREAM_PROVIDER_EXTERNAL_ENABLED", "true");
      vi.stubEnv("STREAM_PROVIDER_EXTERNAL_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/resolve`);
      vi.stubEnv("PYTHON_ADAPTER_KODI_RESOLVERS_FILE", profiles);
      vi.stubEnv("DIRECT_HTTP_PROBE_ENABLED", "false");
      const row = await isolatedStudyCell({ case: 1, family: "external_http", profile: "B" }, item, controller.signal);
      expect(row.status).toBe("completed");
      expect(row.kodi).toMatchObject({ status: "KODI_ADVERTISED", localWorkerTimeoutSeconds: [5], resolverTimeoutSeconds: 6 });
      expect(row.metrics?.normalizable).toBe(1);
      expect(row.metrics?.identity.early).toBe(1);
      expect(calls).toBe(1);
      expect(JSON.stringify(row)).not.toContain("FAKE_PRIVATE");
      expect(JSON.stringify(row)).not.toContain(profiles);
      advertised = false;
      const missing = await isolatedStudyCell({ case: 1, family: "external_http", profile: "A" }, item, controller.signal);
      expect(missing).toMatchObject({ status: "KODI_UNAVAILABLE", metrics: null });
      expect(calls).toBe(1);
      advertised = true;
      const deadline = new AbortController();
      hold = () => { setTimeout(() => deadline.abort(), 25); };
      const unfinished = await isolatedStudyCell({ case: 2, family: "external_http", profile: "B" }, item,
        AbortSignal.any([controller.signal, deadline.signal]));
      expect(unfinished).toMatchObject({ status: "timed_out", metrics: null });
      expect(calls).toBe(2);
    } finally {
      clearTimeout(timer); controller.abort(); vi.unstubAllEnvs();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("keeps exhausted, unexamined and network timeout observations separate from confirmed probe failures", () => {
    const observation = new StudyObservation(item, true);
    const raw = source("opaque.mp4");
    const metadata = { verified: false, rangeSupported: false };
    observation.trace.stage("probed", [
      raw, { ...raw, directHttp: { ...metadata, status: "budget_exhausted" } },
      { ...raw, directHttp: { ...metadata, status: "timeout" } },
      { ...raw, directHttp: { ...metadata, status: "route_rejected" } }
    ]);
    expect(observation.report([]).probe).toEqual({ starts: 0, verified: 0, failed: 1, timeout: 1, uncertain: 0,
      exhausted: 1, unexamined: 1 });
    expect(observation.report([]).timing.listingMs).toBeNull();
  });
});
