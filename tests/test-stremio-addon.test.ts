import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BIG_BUCK_BUNNY_HTTPS, BIG_BUCK_BUNNY_SIZE_BYTES } from "../src/examples/big-buck-bunny";
import { createTestStremioAddon } from "../src/examples/test-stremio-addon";

const servers = new Set<ReturnType<typeof createTestStremioAddon>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
});

async function endpoint(): Promise<string> {
  const server = createTestStremioAddon();
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("standard Stremio BBB HTTPS fixture", () => {
  it("serves a minimal stream manifest", async () => {
    const response = await fetch(`${await endpoint()}/manifest.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      id: "org.local.bbb.https-test",
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
      types: ["movie"], catalogs: []
    });
  });

  it("returns exactly one direct HTTPS stream only for the BBB IMDb id", async () => {
    const base = await endpoint();
    const accepted = await fetch(`${base}/stream/movie/tt1254207.json`);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      streams: [{
        url: BIG_BUCK_BUNNY_HTTPS,
        name: "720p H.264",
        title: "Big Buck Bunny HTTPS",
        behaviorHints: { filename: "Big Buck Bunny.mp4", videoSize: BIG_BUCK_BUNNY_SIZE_BYTES }
      }]
    });
    const rejected = await fetch(`${base}/stream/movie/tt0000000.json`);
    await expect(rejected.json()).resolves.toEqual({ streams: [] });
  });
});
