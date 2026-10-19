import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, safeErrorDetails, safeErrorType } from "../src/logger";
import type { DownloadService } from "../src/download-service";
import { createStreamHandler } from "../src/stream-proxy";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const synthetic = {
  token: "P2A_SYNTH_opaque_987654",
  bearer: "P2A_SYNTH_BEARER_1234",
  cookie: "P2A_SYNTH_cookie_4321",
  path: "P2A_SYNTH_private_config.json"
};

describe("Node diagnostic boundaries", () => {
  it("redacts embedded URLs, bearer tokens, cookies and local paths in message and nested context", () => {
    const captured = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logger.warn(`Transport failed at https://media.example.invalid/p.mp4?sig=${synthetic.token} ` +
      `Authorization: Bearer ${synthetic.bearer} C:\\Users\\fixture\\${synthetic.path}`, {
      details: [
        { warning: `Cookie: session=${synthetic.cookie}; url=https://media.example.invalid/s?token=${synthetic.token}` },
        { path: `/home/fixture/${synthetic.path}`, apiKey: synthetic.token }
      ]
    });
    const output = captured.mock.calls[0]?.[0] as string;
    expect(output).toBeTruthy();
    for (const value of Object.values(synthetic)) expect(output).not.toContain(value);
    expect(output).not.toContain("?sig=");
    expect(output).toContain("Transport failed");
    expect(output).toContain("[REDACTED]");
    expect(JSON.parse(output)).toMatchObject({ level: "warn" });
  });

  it.each(["Cookie", "Set-Cookie"])("redacts complete %s values including later pairs and attributes", (header) => {
    const captured = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const message = `${header}: first=${synthetic.cookie}; second=${synthetic.token}; Path=/private/${synthetic.path}`;
    logger.warn(message, { nested: [{ warning: message }] });
    const output = captured.mock.calls[0]?.[0] as string;
    for (const value of Object.values(synthetic)) expect(output).not.toContain(value);
    expect(JSON.parse(output)).toMatchObject({ message: `${header}=[REDACTED]`,
      nested: [{ warning: `${header}=[REDACTED]` }] });
  });

  it("preserves ordinary Basic diagnostics while redacting Basic authorization", () => {
    const captured = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logger.info("Basic metadata available");
    expect(JSON.parse(captured.mock.calls[0]?.[0] as string)).toMatchObject({ message: "Basic metadata available" });
    logger.info(`Authorization: Basic ${synthetic.bearer}`);
    expect(captured.mock.calls[1]?.[0]).not.toContain(synthetic.bearer);
  });

  it("preserves safe fixed diagnostic labels but does not allow context to override the message", () => {
    const captured = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logger.info("Resolved stage", { message: "spoofed", level: "error", time: "fake-time", type: "TimeoutError", status: 504 });
    expect(JSON.parse(captured.mock.calls[0]?.[0] as string)).toMatchObject({
      message: "Resolved stage", level: "info", type: "TimeoutError", status: 504
    });
  });

  it("allowlists error names/codes/status without logging messages, stacks or arbitrary fields", () => {
    const unsafe = Object.assign(new Error(`Bearer ${synthetic.bearer}`), {
      name: `External_${synthetic.token}`, code: synthetic.token, status: 503,
      cause: new Error(synthetic.token), stack: synthetic.path
    });
    expect(safeErrorType(unsafe)).toBe("UnknownError");
    expect(safeErrorDetails(unsafe)).toEqual({ type: "UnknownError", status: 503 });
    expect(JSON.stringify(safeErrorDetails(unsafe))).not.toContain(synthetic.token);
    const io = Object.assign(new Error("private path"), { code: "EACCES" });
    expect(safeErrorDetails(io)).toEqual({ type: "Error", code: "EACCES" });
    expect(safeErrorType(Object.assign(new Error("expired"), { name: "PlaybackTokenExpiredError" })))
      .toBe("PlaybackTokenExpiredError");
    expect(safeErrorType(null)).toBe("UnknownError");
    for (const name of [undefined, null, 17, {}, [], Symbol("synthetic")]) {
      const unexpected = new Error("synthetic");
      Object.defineProperty(unexpected, "name", { value: name });
      expect(safeErrorType(unexpected)).toBe("UnknownError");
    }
    const hostile = new Error("synthetic");
    Object.defineProperty(hostile, "name", { get() { throw new Error("unexpected accessor"); } });
    expect(safeErrorDetails(hostile)).toEqual({ type: "UnknownError" });
    let nameReads = 0;
    const changingName = new Error("synthetic");
    Object.defineProperty(changingName, "name", { get() { return nameReads++ === 0 ? "TypeError" : synthetic.token; } });
    expect(safeErrorType(changingName)).toBe("TypeError");
    expect(nameReads).toBe(1);
  });

  it("keeps real stream-handler upstream failures out of stderr and public HTTP", async () => {
    const marker = "P2A_SYNTH_STREAM_EXCEPTION_123";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new TypeError(`Authorization: Bearer ${marker} https://media.example.invalid/file?sig=${marker}`)
    ));
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infohash = "a".repeat(40);
    const req = Object.assign(new EventEmitter(), {
      params: { infohash, fileIndex: "0" }, headers: {}
    }) as unknown as Request;
    const status = vi.fn().mockReturnThis();
    const endStream = vi.fn();
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false, headersSent: false,
      status, json: vi.fn(), destroy: vi.fn()
    }) as unknown as Response;
    const service = {
      client: {
        streamUrl: () => "http://127.0.0.1:9999/stream",
        streamHeaders: () => new Headers()
      },
      beginStream: vi.fn(), endStream
    } as unknown as DownloadService;
    await createStreamHandler(service, 1_000, logger)(req, res);
    const logged = output.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logged).toContain("Stream proxy failed");
    expect(logged).not.toContain(marker);
    expect(status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "Tribler stream failed" });
    expect(JSON.stringify((res.json as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(marker);
    expect(endStream).toHaveBeenCalledWith(infohash, 0);
  });

  it("never logs an upstream exception when only safe structured error details are passed", () => {
    const captured = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error(`https://media.example.invalid/p?token=${synthetic.token}`), {
      code: "ECONNRESET", name: "TypeError", privatePath: synthetic.path
    });
    logger.error("Stream failed", { stage: "stream_proxy", error: safeErrorDetails(error) });
    const output = captured.mock.calls[0]?.[0] as string;
    expect(output).not.toContain(synthetic.token);
    expect(output).not.toContain(synthetic.path);
    expect(JSON.parse(output)).toMatchObject({ error: { type: "TypeError", code: "ECONNRESET" } });
  });
});
