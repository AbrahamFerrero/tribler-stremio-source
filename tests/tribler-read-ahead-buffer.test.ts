import { describe, expect, it, vi } from "vitest";
import { TriblerReadAheadBuffer, type ConsumerWaitOutcome } from "../src/tribler-read-ahead-buffer";

function body(chunks: number[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    const size = chunks[index++];
    if (size === undefined) controller.close();
    else controller.enqueue(new Uint8Array(size));
  } });
}

describe("TriblerReadAheadBuffer", () => {
  it("prebuffers then drains a bounded single upstream cursor", async () => {
    const buffer = new TriblerReadAheadBuffer(body([4, 4, 4]), { startupBytes: 8, maxBytes: 8, prebufferTimeoutMs: 100 });
    buffer.start();
    expect(await buffer.waitForStartup()).toBe(8);
    expect((await buffer.read())?.length).toBe(4);
    expect((await buffer.read())?.length).toBe(4);
    expect((await buffer.read())?.length).toBe(4);
    expect(await buffer.read()).toBeUndefined();
  });

  it("uses partial data after its prebuffer timeout", async () => {
    const buffer = new TriblerReadAheadBuffer(body([3]), { startupBytes: 8, maxBytes: 8, prebufferTimeoutMs: 1 });
    buffer.start();
    expect(await buffer.waitForStartup()).toBe(3);
  });

  function controlled(startupBytes = 1) {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    let now = 0;
    let playing = false;
    let consumerWaitCount = 0;
    let underrunCount = 0;
    let underrunMs = 0;
    const outcomes: ConsumerWaitOutcome[] = [];
    const queued: number[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      cancel() { cancelled = true; }
    });
    const buffer = new TriblerReadAheadBuffer(stream, {
      startupBytes, maxBytes: 4, prebufferTimeoutMs: 1_000,
      now: () => now,
      onQueued: bytes => queued.push(bytes),
      onConsumerWaitStart: () => { consumerWaitCount += 1; },
      onConsumerWait: (ms, outcome) => {
        outcomes.push(outcome);
        if (playing && outcome !== "eof") { underrunCount += 1; underrunMs += ms; }
      }
    });
    return {
      buffer, source, queued, outcomes,
      emit: (size = 1) => source.enqueue(new Uint8Array(size)),
      tick: (ms: number) => { now += ms; },
      play: () => { playing = true; },
      state: () => ({ consumerWaitCount, underrunCount, underrunMs, cancelled })
    };
  }

  async function flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }

  it("counts one continuous playback empty-queue interval despite internal wakeups, including sub-ms time", async () => {
    const test = controlled();
    test.buffer.start();
    test.emit();
    expect(await test.buffer.waitForStartup()).toBe(1);
    expect(await test.buffer.read()).toHaveLength(1);
    test.play();
    const pending = test.buffer.read();
    expect(test.state().consumerWaitCount).toBe(1);
    test.tick(0.1);
    (test.buffer as unknown as { notify: () => void }).notify();
    await flush();
    test.tick(0.1);
    (test.buffer as unknown as { notify: () => void }).notify();
    await flush();
    expect(test.state().underrunCount).toBe(0);
    test.tick(0.1);
    test.emit();
    expect(await pending).toHaveLength(1);
    expect(test.state()).toMatchObject({ consumerWaitCount: 1, underrunCount: 1 });
    expect(test.state().underrunMs).toBeCloseTo(0.3);
    test.source.close();
    expect(await test.buffer.read()).toBeUndefined();
  });

  it("counts two distinct empty-queue intervals separated by delivered data", async () => {
    const test = controlled();
    test.buffer.start();
    test.emit();
    await test.buffer.waitForStartup();
    await test.buffer.read();
    test.play();
    for (let i = 0; i < 2; i += 1) {
      const pending = test.buffer.read();
      test.tick(0.25);
      test.emit();
      expect(await pending).toHaveLength(1);
    }
    expect(test.state()).toMatchObject({ consumerWaitCount: 2, underrunCount: 2, underrunMs: 0.5 });
    test.source.close();
    await test.buffer.read();
  });

  it.each(["startup", "seek"])("%s prebuffer before its first byte is not an underrun", async (_kind) => {
    const test = controlled(4);
    test.buffer.start();
    const prebuffer = test.buffer.waitForStartup();
    test.tick(0.4);
    test.emit(4);
    expect(await prebuffer).toBe(4);
    expect(test.state()).toMatchObject({ consumerWaitCount: 0, underrunCount: 0, underrunMs: 0 });
    expect(await test.buffer.read()).toHaveLength(4);
    test.play();
    test.source.close();
    expect(await test.buffer.read()).toBeUndefined();
    expect(test.state().underrunCount).toBe(0);
  });

  it("does not count EOF while an empty-queue consumer is waiting as an underrun", async () => {
    const test = controlled();
    test.buffer.start();
    test.emit();
    await test.buffer.waitForStartup();
    await test.buffer.read();
    test.play();
    const pending = test.buffer.read();
    test.tick(0.2);
    test.source.close();
    expect(await pending).toBeUndefined();
    expect(test.outcomes).toEqual(["eof"]);
    expect(test.state()).toMatchObject({ consumerWaitCount: 1, underrunCount: 0 });
  });

  it("closes a waiting interval on abort, cancels the reader, releases the queue and clears the startup timer", async () => {
    vi.useFakeTimers();
    try {
      const test = controlled(4);
      const signal = new AbortController();
      test.buffer.start(signal.signal);
      const prebuffer = test.buffer.waitForStartup();
      expect(vi.getTimerCount()).toBe(1);
      signal.abort(new Error("stop"));
      await expect(prebuffer).rejects.toThrow("stop");
      await flush();
      expect(test.state().cancelled).toBe(true);
      expect(test.queued.at(-1)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }

    const test = controlled();
    test.buffer.start();
    test.emit();
    await test.buffer.waitForStartup();
    await test.buffer.read();
    test.play();
    const pending = test.buffer.read();
    test.tick(0.4);
    test.buffer.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    await flush();
    expect(test.outcomes).toEqual(["abort"]);
    expect(test.state()).toMatchObject({ consumerWaitCount: 1, underrunCount: 1, underrunMs: 0.4, cancelled: true });
    expect(test.queued.at(-1)).toBe(0);
  });
});
