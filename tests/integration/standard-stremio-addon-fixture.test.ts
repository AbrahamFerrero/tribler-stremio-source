import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BIG_BUCK_BUNNY_HTTPS, BIG_BUCK_BUNNY_SIZE_BYTES } from "../../src/examples/big-buck-bunny";
import { createTestStremioAddon } from "../../src/examples/test-stremio-addon";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { StremioAddonStreamProvider } from "../../src/streams/providers/stremio-addon-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../../src/streams/resolver";
import { silentLogger } from "../helpers";

const servers = new Set<ReturnType<typeof createTestStremioAddon>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
});

async function manifestUrl(): Promise<string> {
  const server = createTestStremioAddon();
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/manifest.json`;
}

describe("standard Stremio addon fixture integration", () => {
  it("normalizes its HTTPS stream through StremioAddonStreamProvider", async () => {
    const configuredManifest = await manifestUrl();
    const provider = new StremioAddonStreamProvider({
      id: "bbb-https-test", name: "BBB HTTPS Test", manifestUrl: configuredManifest,
      enabled: true, timeoutMs: 1_000, manifestTtlMs: 60_000,
      endpointPolicy: (url) => new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
    });
    const registry = new StreamProviderRegistry(1_000, silentLogger);
    registry.register(provider);
    const publicStreamPolicy = new ExternalUrlPolicy({
      resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    });
    const streams = await new StreamResolver(registry, publicStreamPolicy).resolve({
      id: "tt1254207", kind: "movie", title: "Big Buck Bunny", externalIds: { imdb: "tt1254207" },
      stremio: { type: "movie", videoId: "tt1254207" }
    });
    expect(streams).toEqual([expect.objectContaining({
      providerId: "stremio-addon-bbb-https-test", type: "https", url: BIG_BUCK_BUNNY_HTTPS,
      filename: "Big Buck Bunny.mp4", sizeBytes: BIG_BUCK_BUNNY_SIZE_BYTES, quality: "720p H.264"
    })]);
  });
});
