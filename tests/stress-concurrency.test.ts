import { describe, expect, it, vi } from "vitest";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { silentLogger } from "./helpers";
import { syntheticStress } from "./fixtures/synthetic-stress";

const item = { id: "synthetic", kind: "movie" as const, title: "Synthetic", externalIds: {} };

describe("registry cancellation under contention", () => {
  it("drains peer workload lanes before reporting a harness failure", async () => {
    let calls = 0;
    let finishedPeers = 0;
    const resolve = vi.spyOn(StreamResolver.prototype, "resolve").mockImplementation(async () => {
      if (calls++ === 0) throw new Error("Synthetic harness failure");
      await new Promise<void>(done => setImmediate(done));
      finishedPeers++;
      return [{ type: "magnet", providerId: "synthetic", infoHash: "a".repeat(40) }];
    });
    try {
      await expect(syntheticStress(4)).rejects.toThrow("Synthetic harness failure");
      expect(finishedPeers).toBe(3);
    } finally {
      await new Promise<void>(done => setImmediate(done));
      resolve.mockRestore();
    }
  });

  it("runs a bounded mixed integration workload", async () => {
    const result = await syntheticStress(24);
    expect(result).toMatchObject({ completed: 24, activeAtEnd: 0 });
    expect(result.peakProviders).toBeGreaterThanOrEqual(3);
    expect(result.peakProviders).toBeLessThanOrEqual(6);
  });

  it("serves queued requests in FIFO order without starving later arrivals", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const registry = new StreamProviderRegistry(10_000, silentLogger, 1);
    registry.register({ id: "fifo", name: "FIFO", isEnabled: () => true,
      resolve: media => { order.push(media.id); return new Promise(resolve => { releases.push(() => resolve([])); }); } });
    const requests = Array.from({ length: 12 }, (_, index) => registry.resolveAll({ ...item, id: String(index) }));
    try {
      for (let index = 0; index < 12; index++) {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(order).toEqual(Array.from({ length: index + 1 }, (_, id) => String(id)));
        releases[index]!();
      }
      await Promise.all(requests);
    } finally { for (const release of releases) release(); }
  });

  it("does not invoke providers for an already cancelled request", async () => {
    let calls = 0;
    const registry = new StreamProviderRegistry(100, silentLogger, 1);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => { calls++; return Promise.resolve([]); } });
    await expect(registry.resolveAll(item, AbortSignal.abort())).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("removes cancelled queue waiters before the occupied slot becomes available", async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const registry = new StreamProviderRegistry(10_000, silentLogger, 1);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true,
      resolve: () => { calls++; started(); return new Promise(resolve => { release = () => resolve([]); }); } });
    const occupying = registry.resolveAll(item);
    await ready;
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        const controller = new AbortController();
        const queued = registry.resolveAll(item, controller.signal);
        controller.abort();
        await queued;
      }
      expect(calls).toBe(1);
    } finally { release(); await occupying; }
  }, 1500);

  it("bounds ignored cancellation across retries and admits a healthy sibling", async () => {
    let calls = 0;
    let settle!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<[]>(resolve => { settle = () => resolve([]); });
    const registry = new StreamProviderRegistry(100, silentLogger, 1);
    registry.register({ id: "ignores", name: "Ignores", isEnabled: () => true,
      resolve: () => { calls++; started(); return pending; } });
    registry.register({ id: "healthy", name: "Healthy", isEnabled: () => true,
      resolve: () => Promise.resolve([]) });
    const controller = new AbortController();
    const first = registry.resolveAll(item, controller.signal);
    await ready;
    controller.abort();
    await first;
    try {
      for (let cycle = 0; cycle < 5; cycle++) await registry.resolveAll(item);
      expect(calls).toBe(1);
      expect(registry.status().find(entry => entry.id === "healthy")?.status).toBe("ok");
    } finally { settle(); await pending; }
    await new Promise<void>(resolve => setImmediate(resolve));
    await registry.resolveAll(item);
    expect(calls).toBe(2);
  });

  it("retains retry protection until every abandoned invocation settles, including rejection", async () => {
    const settles: Array<() => void> = [];
    const registry = new StreamProviderRegistry(10, silentLogger, 2);
    let calls = 0;
    registry.register({ id: "ignores", name: "Ignores", isEnabled: () => true,
      resolve: () => {
        calls++;
        return new Promise((resolve, reject) => {
          settles.push(calls === 1 ? () => resolve([]) : () => reject(new Error("Synthetic late rejection")));
        });
      } });
    try {
      await Promise.all([registry.resolveAll(item), registry.resolveAll(item)]);
      expect(calls).toBe(2);
      settles[0]!();
      await new Promise<void>(resolve => setImmediate(resolve));
      await registry.resolveAll(item);
      expect(calls).toBe(2);
      settles[1]!();
      await new Promise<void>(resolve => setImmediate(resolve));
      const recovered = registry.resolveAll(item);
      await new Promise<void>(resolve => setImmediate(resolve));
      settles[2]!();
      await recovered;
      expect(calls).toBe(3);
    } finally { for (const settle of settles) settle(); }
  });

  it("isolates a synchronous provider throw and releases the slot for its sibling", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger, 1);
    registry.register({ id: "throws", name: "Throws", isEnabled: () => true,
      resolve: () => { throw new Error("Synthetic synchronous failure"); } });
    registry.register({ id: "healthy", name: "Healthy", isEnabled: () => true,
      resolve: () => Promise.resolve([]) });
    await registry.resolveAll(item);
    expect(registry.status().map(entry => entry.status)).toEqual(["error", "ok"]);
  });
});
