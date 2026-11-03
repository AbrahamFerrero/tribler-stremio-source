import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticController, type DiagnosticStart } from "../src/diagnostics/controller";
import { DIAGNOSTIC_LIMITS as L, DiagnosticRecorder, type DiagnosticEvent } from "../src/diagnostics/recorder";

const options: DiagnosticStart = { ttlMs: 1000, resolutions: 10, retainReport: true };
const event: DiagnosticEvent = { kind: "STAGE", stage: "FINAL", count: 1 };
afterEach(() => vi.useRealTimers());

describe("bounded diagnostic lifecycle", () => {
  it("starts OFF without allocating recorders; never restores state in a new controller", () => {
    const factory = vi.fn((id: string) => new DiagnosticRecorder(id));
    const c = new DiagnosticController(undefined, factory);
    expect(c.status()).toEqual({ state: "OFF", reportAvailable: false });
    expect(c.beginResolution()).toBeUndefined(); expect(factory).not.toHaveBeenCalled();
    c.start(options); c.stop();
    expect(c.report()).toBeDefined();
    expect(new DiagnosticController().report()).toBeUndefined();
    expect(new DiagnosticController().status().state).toBe("OFF");
  });

  it("allows only one session and copies options", () => {
    const c = new DiagnosticController(); const input = { ...options };
    expect(c.start(input)).toBe("STARTED"); input.resolutions = 1;
    expect(c.start(options)).toBe("ACTIVE"); expect(c.status().quota).toBe(10); c.stop();
  });

  it("rejects hidden start fields and accessors without retaining private objects", () => {
    const c = new DiagnosticController(); const getter = vi.fn(() => "private-start");
    expect(c.start({ ...options, [Symbol("private")]: { source: "private-start" } })).toBe("INVALID");
    const input = Object.defineProperty({ ...options }, "ttlMs", { get: getter });
    expect(c.start(input)).toBe("INVALID"); expect(getter).not.toHaveBeenCalled();
    expect(c.status().state).toBe("OFF");
  });

  it("expires automatically, revokes handles and removes reports on the exact deadline", () => {
    vi.useFakeTimers(); const c = new DiagnosticController(Date.now);
    c.start(options); const h = c.beginResolution()!; h.record(event);
    vi.advanceTimersByTime(1000);
    expect(c.status().state).toBe("OFF");
    const report = c.report();
    expect(report).toMatchObject({ reason: "EXPIRED", state: "TRUNCATED", events: 1 });
    h.record(event); h.finish(); expect(c.report()).toEqual(report);
    vi.advanceTimersByTime(L.ttlMs - 1); expect(c.report()).toBeDefined();
    vi.advanceTimersByTime(1); expect(c.report()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend retention when timer delivery is late", () => {
    let now = 0; const c = new DiagnosticController(() => now);
    c.start(options); now = 1000 + L.ttlMs;
    expect(c.report()).toBeUndefined(); expect(c.status().state).toBe("OFF");
  });

  it("stop is idempotent; restart discards report and stale handles cannot affect a new session", () => {
    const c = new DiagnosticController(); c.start(options); const old = c.beginResolution()!;
    old.record(event); c.stop(); const previous = c.report(); c.stop(); expect(c.report()).toEqual(previous);
    c.start(options); expect(c.report()).toBeUndefined(); const next = c.beginResolution()!;
    old.record(event); old.finish(); expect(c.status().active).toBe(1); expect(c.status().events).toBe(0);
    next.finish(); next.record(event); c.stop();
    expect(c.report()).toMatchObject({ events: 0, state: "CLOSED" });
    expect(c.report()!.id).not.toBe(previous!.id);
  });

  it("reserves quota at entry and never replenishes it after finish or concurrency skips", () => {
    const c = new DiagnosticController(); c.start(options);
    const handles = Array.from({ length: 4 }, () => c.beginResolution()!);
    expect(c.beginResolution()).toBeUndefined(); expect(c.status()).toMatchObject({ reserved: 5, active: 4, skippedConcurrent: 1, truncated: true });
    handles.forEach(h => h.finish());
    for (let i = 0; i < 5; i++) c.beginResolution()!.finish();
    expect(c.beginResolution()).toBeUndefined(); expect(c.status().reserved).toBe(10); c.stop();
    expect(c.report()!.resolutions).toHaveLength(9);
  });

  it("retains no report when disabled and clears all timers on stop", () => {
    vi.useFakeTimers(); const c = new DiagnosticController(Date.now);
    c.start({ ...options, retainReport: false }); c.beginResolution()!.record(event); c.stop();
    expect(c.report()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 300001, NaN, Infinity, 1.5])("rejects invalid TTL %s", ttlMs => {
    const c = new DiagnosticController(); expect(c.start({ ...options, ttlMs })).toBe("INVALID");
    expect(c.status().state).toBe("OFF");
  });

  it("enforces maximum TTL and resolution quota", () => {
    const c = new DiagnosticController();
    for (const resolutions of [0, 11, 1.5, NaN]) expect(c.start({ ...options, resolutions })).toBe("INVALID");
    expect(c.start({ ...options, ttlMs: L.ttlMs })).toBe("STARTED"); c.stop();
  });
});

describe("recorder privacy and budgets", () => {
  it("assigns ephemeral candidate IDs, copies input and returns detached DTOs", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    const input: DiagnosticEvent = { kind: "CANDIDATE", candidate: 0, decision: "RETAIN" };
    h.record(input); input.decision = "REJECT"; h.record(input); h.finish(); c.stop();
    const report = c.report()!; const events = report.resolutions[0]!.events;
    expect(events[0]).toMatchObject({ decision: "RETAIN" });
    expect(events[0]).toHaveProperty("candidateId", (events[1] as { candidateId: string }).candidateId);
    report.resolutions.length = 0; expect(c.report()!.resolutions).toHaveLength(1);
    c.start(options); c.beginResolution()!.record(input); c.stop();
    expect(c.report()!.resolutions[0]!.events[0]).not.toEqual(events[1]);
  });

  it("bounds per-resolution events, session events and total DTO size without dropping production work", () => {
    const c = new DiagnosticController(); c.start(options);
    let productionResults = 0;
    for (let resolution = 0; resolution < 12; resolution++) {
      const h = c.beginResolution();
      for (let i = 0; i <= L.resolutionEvents; i++) h?.record({ kind: "CANDIDATE", candidate: i % 256, decision: "CONTINUE" });
      h?.finish(); productionResults++;
    }
    expect(productionResults).toBe(12); expect(c.status()).toMatchObject({ reserved: 10, events: 8192, truncated: true }); c.stop();
    const report = c.report()!;
    expect(report.state).toBe("TRUNCATED");
    expect(report.resolutions.every(r => r.events.length <= 2048)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(L.dtoBytes);
  });

  it("admits exactly 256 candidate slots and truncates overflow", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    for (let i = 0; i <= 256; i++) h.record({ kind: "CANDIDATE", candidate: i, decision: "CONTINUE" });
    h.finish(); c.stop(); expect(c.report()).toMatchObject({ state: "TRUNCATED", events: 256 });
  });

  it("truncates invalid primitives and stage overflow without coercion", () => {
    const coercion = vi.fn(() => { throw new Error("private coercion"); });
    for (const invalid of [
      { kind: "STAGE", stage: "FINAL", count: 257 },
      { kind: "STAGE", stage: { toString: coercion }, count: 1 },
      { kind: "STAGE", stage: "FINAL", count: NaN },
      { kind: "CANDIDATE", candidate: -1, decision: "RETAIN" },
      { kind: "CANDIDATE", candidate: 0, decision: "arbitrary-private" }
    ]) {
      const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
      expect(() => h.record(invalid as DiagnosticEvent)).not.toThrow();
      h.record(event); h.finish(); c.stop();
      expect(c.report()).toMatchObject({ events: 0, state: "TRUNCATED" });
    }
    expect(coercion).not.toHaveBeenCalled();
  });

  it("contains hostile proxy access and can start a fresh capture after recorder failure", () => {
    const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
    const proxy = new Proxy(event, { ownKeys: () => { throw new Error("private proxy"); } });
    expect(() => h.record(proxy)).not.toThrow();
    expect(c.status().state).toBe("OFF"); expect(c.report()).toMatchObject({ state: "TRUNCATED", reason: "RECORDER_FAILURE" });
    c.start(options); h.record(event); expect(c.status().events).toBe(0);
    const fresh = c.beginResolution()!; fresh.record(event); fresh.finish(); c.stop();
    expect(c.report()).toMatchObject({ state: "CLOSED", events: 1 });
  });

  it("rejects private canaries and arbitrary fields before storing, serializing or reading getters", () => {
    const canaries = ["https://private.example/item?token=synthetic", "Private title", "query-private", "Bearer synthetic",
      "magnet:" + "?xt=urn:btih:" + "f".repeat(40), "f".repeat(40), "C:" + "\\" + "Users" + "\\" + "synthetic-private"];
    for (const canary of canaries) {
      const c = new DiagnosticController(); c.start(options); const h = c.beginResolution()!;
      h.record({ ...event, source: { url: canary }, title: canary } as DiagnosticEvent);
      h.record({ kind: "STAGE", stage: canary, count: 1 } as DiagnosticEvent);
      c.stop(); expect(JSON.stringify(c.report())).not.toContain(canary); expect(c.report()!.events).toBe(0);
    }
    const getter = vi.fn(() => { throw new Error("private error"); });
    const c = new DiagnosticController(); c.start(options);
    c.beginResolution()!.record(Object.defineProperty({ kind: "STAGE", count: 1 }, "stage", { get: getter }) as DiagnosticEvent);
    c.stop(); expect(getter).not.toHaveBeenCalled(); expect(c.report()!.events).toBe(0);
  });

  it.each(["factory", "record", "close", "snapshot"])("contains %s failures and revokes capture", point => {
    class Failing extends DiagnosticRecorder {
      override record(): void { if (point === "record") throw new Error("private failure"); }
      override close(): void { if (point === "close") throw new Error("private failure"); }
      override snapshot() { if (point === "snapshot") throw new Error("private failure"); return super.snapshot(); }
    }
    const c = new DiagnosticController(undefined, id => { if (point === "factory") throw new Error("private failure"); return new Failing(id); });
    c.start(options);
    expect(() => { const h = c.beginResolution(); h?.record(event); h?.finish(); c.stop(); h?.record(event); }).not.toThrow();
    expect(c.status().state).toBe("OFF"); expect(JSON.stringify(c.report()) ?? "").not.toContain("private failure");
  });
});
