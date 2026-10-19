import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BIG_BUCK_BUNNY_HTTPS,
  BIG_BUCK_BUNNY_MAGNET,
  createTestStreamProvider
} from "../src/examples/test-stream-provider";

const servers = new Set<ReturnType<typeof createTestStreamProvider>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
});

async function endpoint(): Promise<string> {
  const server = createTestStreamProvider();
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("local external-provider example", () => {
  it("returns one HTTPS source and one magnet for its test catalog item", async () => {
    const base = await endpoint();
    const response = await fetch(`${base}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test", type: "movie", title: "Big Buck Bunny - External Provider Test" })
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { streams: Array<{ type: string; url?: string; magnet?: string }> };
    expect(payload.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "https", url: BIG_BUCK_BUNNY_HTTPS }),
      expect.objectContaining({ type: "magnet", magnet: BIG_BUCK_BUNNY_MAGNET })
    ]));
  });

  it("does not inject its streams into unrelated catalog items", async () => {
    const base = await endpoint();
    const response = await fetch(`${base}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "other", type: "movie", title: "Something else" })
    });
    await expect(response.json()).resolves.toEqual({ streams: [] });
  });
});
