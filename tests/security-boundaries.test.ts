import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger";
import { LocalJsonStreamProvider } from "../src/streams/providers/local-json-stream-provider";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("security boundaries", () => {
  it("prevents LocalJsonStreamProvider path traversal", () => {
    const parent = mkdtempSync(join(tmpdir(), "tribler-local-json-"));
    directories.push(parent);
    const allowed = join(parent, "allowed");
    const outside = join(parent, "outside.json");
    mkdirSync(allowed);
    writeFileSync(outside, "{}");
    expect(() => new LocalJsonStreamProvider(outside, allowed)).toThrow(/outside/);
  });

  it("redacts secrets, URL queries and complete magnets from logs", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logger.info("test", {
      Authorization: "Bearer secret-value",
      url: "https://example.com/video?token=secret-value",
      magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}&private=secret-value`
    });
    const line = output.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("secret-value");
    expect(line).not.toContain("?token=");
    expect(line).toContain("[REDACTED]");
  });
});
