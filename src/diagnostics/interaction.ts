import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export type CaptureWake = "TICK" | "ENTER" | "INTERRUPT";
export interface CaptureInteraction {
  now(): number;
  wait(ms: number): Promise<CaptureWake>;
  interrupted(): boolean;
  dispose: () => void;
}

/** Only capture installs listeners. Input is inspected for newline, never accumulated. */
export function captureInteraction(input: Readable & { isTTY?: boolean } = process.stdin, signals: EventEmitter = process): CaptureInteraction {
  let wake: ((reason: CaptureWake) => void) | undefined;
  let pending: CaptureWake | undefined;
  let interrupted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wasFlowing = input.readableFlowing === true;
  const notify = (reason: CaptureWake) => {
    if (reason === "INTERRUPT") interrupted = true;
    pending = interrupted ? "INTERRUPT" : reason;
    if (wake) { const resolve = wake; wake = undefined; clearTimeout(timer); resolve(pending); pending = undefined; }
  };
  const interrupt = () => notify("INTERRUPT");
  const enter = (chunk: Buffer | string) => { if (chunk.includes("\n") || chunk.includes("\r")) notify("ENTER"); };
  signals.on("SIGINT", interrupt); signals.on("SIGTERM", interrupt); signals.on("SIGHUP", interrupt);
  if (input.isTTY) { input.on("data", enter); input.resume(); }
  return {
    now: () => performance.now(), interrupted: () => interrupted,
    wait: ms => new Promise(resolve => {
      if (pending || interrupted) { const reason = interrupted ? "INTERRUPT" : pending!; pending = undefined; resolve(reason); return; }
      wake = resolve; timer = setTimeout(() => { wake = undefined; resolve("TICK"); }, ms);
    }),
    dispose: () => {
      clearTimeout(timer); wake = undefined; pending = undefined;
      signals.removeListener("SIGINT", interrupt); signals.removeListener("SIGTERM", interrupt); signals.removeListener("SIGHUP", interrupt);
      if (input.isTTY) { input.removeListener("data", enter); if (!wasFlowing) input.pause(); }
    }
  };
}
