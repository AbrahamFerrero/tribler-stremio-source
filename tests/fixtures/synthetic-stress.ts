import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { StreamProviderRegistry, StreamResolver } from "../../src/streams/resolver";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import type { NormalizedStreamSource } from "../../src/streams/types";
import { silentLogger } from "../helpers";

/** In-process integration workload: no sockets, DNS, playback or external providers. */
export async function syntheticStress(cycles: number, concurrency = 4): Promise<{
  cycles: number; peakProviders: number; activeAtEnd: number; completed: number;
  memory: Array<{ heapUsed: number; rss: number }>;
  resourcesBefore: string[]; resourcesAfter: string[];
}> {
  let active = 0;
  let peak = 0;
  let next = 0;
  let completed = 0;
  const memory: Array<{ heapUsed: number; rss: number }> = [];
  const resourcesBefore = process.getActiveResourcesInfo().sort();
  const registry = new StreamProviderRegistry(200, silentLogger, 3);
  for (const mode of ["fast", "slow", "throws", "timeout", "large", "disabled"]) {
    registry.register({ id: mode, name: mode, isEnabled: () => mode !== "disabled",
      ...(mode === "timeout" ? { timeoutMs: 10 } : {}),
      resolve: async (_item, { signal }) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (mode === "throws") throw new Error("Synthetic failure");
          await delay(mode === "timeout" ? 1000 : mode === "slow" ? 2 : 0, undefined, { signal });
          return Array.from({ length: mode === "large" ? 150 : 1 }, (_, index): NormalizedStreamSource => ({
            providerId: mode, type: "magnet", magnet: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, "0")}`,
            filename: "synthetic.mkv", seeds: 1
          }));
        } finally { active--; }
      } });
  }
  // Magnet normalization does not perform network operations.
  const resolver = new StreamResolver(registry, new ExternalUrlPolicy());
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
      while (next < cycles) {
        const index = next++;
        const controller = new AbortController();
        const resolving = resolver.resolve({ id: `synthetic:${index}`, kind: "movie", title: "Synthetic", externalIds: {} }, controller.signal);
        if (index % 5 === 0) controller.abort();
        const streams = await resolving;
        assert.ok(streams.length <= 52);
        if (index % 5 !== 0) assert.ok(streams.length > 0);
        completed++;
        if (completed % Math.max(1, Math.floor(cycles / 5)) === 0) {
          const { heapUsed, rss } = process.memoryUsage();
          memory.push({ heapUsed, rss });
        }
      }
    }));
    // A failed assertion must not leave peer lanes running after the caller
    // receives the error or after the rejection observer is detached.
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(active, 0);
    // Three logical slots plus at most three timed-out invocations still
    // unwinding cancellation. This is not a hard execution limit on plugin code.
    assert.ok(peak <= 6);
    assert.equal(completed, cycles);
    assert.deepEqual(unhandled, []);
    const resourcesAfter = process.getActiveResourcesInfo().sort();
    for (const resource of new Set(resourcesAfter)) {
      assert.ok(resourcesAfter.filter(value => value === resource).length
        <= resourcesBefore.filter(value => value === resource).length, `additional active resource: ${resource}`);
    }
    return { cycles, peakProviders: peak, activeAtEnd: active, completed, memory, resourcesBefore, resourcesAfter };
  } finally { process.removeListener("unhandledRejection", onUnhandled); }
}
