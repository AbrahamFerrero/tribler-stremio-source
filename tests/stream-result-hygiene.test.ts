import { fixtureOutboundRequest, type FixtureOutboundRequest } from "./helpers";
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import type { OutboundTransport } from "../src/network/outbound-transport";
import { silentLogger } from "./helpers";

const item = { id: "movie", kind: "movie" as const, title: "Movie", externalIds: {} };
const policy = new ExternalUrlPolicy({
  resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
});

describe("stream result hygiene", () => {
  it("admits up to 100 external adapter candidates with the existing response bound", async () => {
    const streams = Array.from({ length: 101 }, (_, index) => ({
      type: "https", url: `https://media.example/${index}.mp4`
    }));
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ streams }), { headers: { "Content-Type": "application/json" } }
    ));
    const provider = new ExternalHttpStreamProvider({
      url: "https://provider.example/resolve", timeoutMs: 100, policy, fetchImplementation
    });
    const result = await provider.resolve(item, { signal: new AbortController().signal });
    expect(result).toHaveLength(100);
    expect(result[99]?.url).toBe("https://media.example/99.mp4");
  });

  it("ranks all 100 raw candidates before retaining a provider's best 50", async () => {
    const registry = new StreamProviderRegistry(100, silentLogger);
    const torrents = Array.from({ length: 99 }, (_, index) => ({
      providerId: "mixed", type: "magnet" as const,
      magnet: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, "0")}`,
      quality: "480p", seeds: 1
    }));
    const lateUrl = "https://media.example/late.mp4";
    registry.register({
      id: "mixed", name: "Mixed", isEnabled: () => true,
      resolve: () => Promise.resolve([...torrents, { providerId: "mixed", type: "https", url: lateUrl,
        quality: "1080p" }])
    });
    const request = vi.fn<FixtureOutboundRequest>().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206, headers: { "Content-Range": "bytes 0-0/1", "Content-Type": "video/mp4" }
    }));
    const transport: OutboundTransport = {
      id: "fake", request: fixtureOutboundRequest(request),
      diagnostics: () => ({ transport: "fake", requests: 0, failures: 0, averageLatencyMs: 0 })
    };
    const probe = new DirectStreamProbe(transport, {
      enabled: true, timeoutMs: 100, maxCandidates: 8, maxConcurrent: 2
    }, silentLogger);
    const sources = await new StreamResolver(registry, policy, probe).resolve(item);
    expect(sources).toHaveLength(50);
    expect(sources[0]?.url).toBe(lateUrl);
    expect(sources[0]?.directHttp).toMatchObject({ verified: true, rangeSupported: true });
    expect(request).toHaveBeenCalledOnce();
    expect(sources.some((source) => source.infoHash === torrents[98]?.magnet.slice(-40))).toBe(false);
  });
});
