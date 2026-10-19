export type ConsumerWaitOutcome = "data" | "eof" | "abort" | "error";

export interface TriblerReadAheadOptions {
  startupBytes: number;
  maxBytes: number;
  prebufferTimeoutMs: number;
  onQueued?: (bytes: number) => void;
  onRead?: (bytes: number) => void;
  onProducerWait?: () => void;
  onConsumerWaitStart?: () => void;
  onConsumerWait?: (ms: number, outcome: ConsumerWaitOutcome) => void;
  onUpstreamRead?: (bytes: number) => void;
  onProducerWaitMs?: (ms: number) => void;
  now?: () => number;
}

/** A per-request bounded producer/consumer queue. It owns one upstream reader only. */
export class TriblerReadAheadBuffer {
  private readonly chunks: Uint8Array[] = [];
  private queuedBytes = 0;
  private ended = false;
  private failure: unknown;
  private readonly wakes = new Set<() => void>();
  private readonly controller = new AbortController();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private sourceSignal: AbortSignal | undefined;
  private readonly sourceAbort = (): void => this.abort(this.sourceSignal?.reason);

  constructor(private readonly body: ReadableStream<Uint8Array>, private readonly options: TriblerReadAheadOptions) {}

  start(signal?: AbortSignal): void {
    this.sourceSignal = signal;
    if (signal?.aborted) { this.abort(signal.reason); return; }
    signal?.addEventListener("abort", this.sourceAbort, { once: true });
    void this.produce();
  }

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }
  private notify(): void { for (const wake of this.wakes) wake(); this.wakes.clear(); }
  private async changed(): Promise<void> { await new Promise<void>((resolve) => { this.wakes.add(resolve); }); }

  private async produce(): Promise<void> {
    const reader = this.body.getReader();
    this.reader = reader;
    try {
      while (!this.controller.signal.aborted) {
        while (this.queuedBytes >= this.options.maxBytes && !this.controller.signal.aborted) {
          const wait = this.now(); this.options.onProducerWait?.();
          await this.changed(); this.options.onProducerWaitMs?.(this.now() - wait);
        }
        if (this.controller.signal.aborted) break;
        const next = await reader.read();
        if (next.done) break;
        if (this.controller.signal.aborted) break;
        this.options.onUpstreamRead?.(next.value.length);
        let value = next.value;
        while (value.length > 0 && !this.controller.signal.aborted) {
          while (this.queuedBytes >= this.options.maxBytes && !this.controller.signal.aborted) {
            const wait = this.now(); this.options.onProducerWait?.();
            await this.changed(); this.options.onProducerWaitMs?.(this.now() - wait);
          }
          if (this.controller.signal.aborted) break;
          const space = Math.max(1, this.options.maxBytes - this.queuedBytes);
          const part = value.subarray(0, space);
          this.chunks.push(part); this.queuedBytes += part.length; this.options.onQueued?.(this.queuedBytes);
          value = value.subarray(part.length); this.notify();
        }
      }
    } catch (error) { if (!this.controller.signal.aborted) this.failure = error; }
    finally {
      this.ended = true; this.notify();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      this.reader = undefined;
      this.sourceSignal?.removeEventListener("abort", this.sourceAbort);
    }
  }

  async waitForStartup(): Promise<number> {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.notify(); }, this.options.prebufferTimeoutMs);
    try {
      while (!timedOut && !this.ended && !this.failure && this.queuedBytes < this.options.startupBytes) {
        await this.changed();
      }
      if (this.failure) throw this.failure;
      return this.queuedBytes;
    } finally { clearTimeout(timer); }
  }

  async read(): Promise<Uint8Array | undefined> {
    let waitingSince: number | undefined;
    if (this.chunks.length === 0 && !this.ended && !this.failure) {
      waitingSince = this.now();
      this.options.onConsumerWaitStart?.();
      while (this.chunks.length === 0 && !this.ended && !this.failure) await this.changed();
    }
    const outcome: ConsumerWaitOutcome = this.controller.signal.aborted ? "abort"
      : this.failure ? "error" : this.chunks.length > 0 ? "data" : "eof";
    if (waitingSince !== undefined) this.options.onConsumerWait?.(Math.max(0, this.now() - waitingSince), outcome);
    if (this.failure) throw this.failure;
    const chunk = this.chunks.shift();
    if (chunk) { this.queuedBytes -= chunk.length; this.options.onRead?.(chunk.length); this.notify(); }
    return chunk;
  }

  abort(reason?: unknown): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason);
    this.failure = reason instanceof Error ? reason : new Error("Stream aborted");
    this.ended = true;
    this.chunks.length = 0; this.queuedBytes = 0; this.options.onQueued?.(0);
    this.notify();
    void this.reader?.cancel().catch(() => undefined);
    this.sourceSignal?.removeEventListener("abort", this.sourceAbort);
  }
}
