// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";

const item = { id: "id", kind: "movie" as const, title: "Title", externalIds: {} };
const context = { signal: new AbortController().signal };
const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });

describe("ExternalHttpStreamProvider", () => {
  it("can call an exact explicitly trusted local adapter endpoint", async () => {
    const localPolicy = new ExternalUrlPolicy({
      allowedLoopbackUrls: ["http://127.0.0.1:7100/resolve"]
    });
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ streams: [] }), { headers: { "Content-Type": "application/json" } }
    ));
    const provider = new ExternalHttpStreamProvider({
      url: "http://127.0.0.1:7100/resolve", timeoutMs: 100, policy: localPolicy, fetchImplementation
    });
    await expect(provider.resolve(item, context)).resolves.toEqual([]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("posts only normalized media data and caps streams", async () => {
    const streams = Array.from({ length: 80 }, (_, index) => ({
      type: "https", url: `https://media.example/${index}.mp4`
    }));
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ streams }), { headers: { "Content-Type": "application/json" } }
    ));
    const provider = new ExternalHttpStreamProvider({
      url: "https://provider.example/resolve", timeoutMs: 100, maxStreams: 10, policy, fetchImplementation
    });
    expect(await provider.resolve(item, context)).toHaveLength(10);
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
  });

  it("keeps an IMDb episode identity exact without inventing either title", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ streams: [] }), { headers: { "Content-Type": "application/json" } }
    ));
    const provider = new ExternalHttpStreamProvider({
      url: "https://provider.example/resolve", timeoutMs: 100, policy, fetchImplementation
    });
    await provider.resolve({
      id: "tt9999999999:2:3", kind: "episode", title: "", season: 2, episode: 3,
      externalIds: { imdb: "tt9999999999" }, stremio: { type: "series", videoId: "tt9999999999:2:3" }
    }, context);
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Expected JSON request body");
    const request: unknown = JSON.parse(body);
    expect(request).toEqual({
      id: "tt9999999999:2:3", type: "episode", title: "", season: 2, episode: 3,
      externalIds: { imdb: "tt9999999999" }
    });
  });

  it.each(["episode", "movie"] as const)("carries the authoritative series title only for %s identity", async (kind) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ streams: [] }), { headers: { "Content-Type": "application/json" } }
    ));
    const provider = new ExternalHttpStreamProvider({
      url: "https://provider.example/resolve", timeoutMs: 100, policy, fetchImplementation
    });
    await provider.resolve({
      id: "tt9900101:1:1", kind, title: "First Signal", seriesTitle: "Neral Beacon", season: 1, episode: 1,
      externalIds: { imdb: "tt9900101" }
    }, context);
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Expected JSON request body");
    expect(JSON.parse(body)).toEqual({
      id: "tt9900101:1:1", type: kind, title: "First Signal", season: 1, episode: 1,
      ...(kind === "episode" ? { seriesTitle: "Neral Beacon" } : {}),
      externalIds: { imdb: "tt9900101" }
    });
  });

  it("rejects invalid content types, schemas and oversized JSON", async () => {
    const make = (response: Response) => new ExternalHttpStreamProvider({
      url: "https://provider.example/resolve", timeoutMs: 100, maxResponseBytes: 32,
      policy, fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(response)
    });
    await expect(make(new Response("text", { headers: { "Content-Type": "text/plain" } })).resolve(item, context))
      .rejects.toThrow(/content type/);
    await expect(make(new Response("{}", { headers: { "Content-Type": "application/json" } })).resolve(item, context))
      .rejects.toThrow(/schema/);
    await expect(make(new Response(JSON.stringify({ streams: [], padding: "x".repeat(100) }), {
      headers: { "Content-Type": "application/json" }
    })).resolve(item, context)).rejects.toThrow(/too large/);
  });
});
