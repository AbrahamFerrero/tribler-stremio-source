import { describe, expect, it, vi } from "vitest";
import { TriblerClient } from "../src/tribler-client";

describe("TriblerClient", () => {
  it("uses the documented download endpoint and API key header", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      started: true,
      infohash: "a".repeat(40)
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = new TriblerClient("http://127.0.0.1:52194", "secret", 100, fetchMock);

    await client.addDownload("magnet:?xt=urn:btih:test");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:52194/api/downloads");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe("secret");
    expect(init?.body).toBe(JSON.stringify({ uri: "magnet:?xt=urn:btih:test" }));
  });

  it("forwards Range only to the official streaming URL", () => {
    const client = new TriblerClient("http://127.0.0.1:52194", "secret", 100);
    const hash = "b".repeat(40);
    expect(client.streamUrl(hash, 2)).toBe(`http://127.0.0.1:52194/api/downloads/${hash}/stream/2`);
    expect(client.streamHeaders("bytes=10-20").get("Range")).toBe("bytes=10-20");
  });

  it("requests metadata-only mode and can resume or stop through PATCH", async () => {
    const hash = "c".repeat(40);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ started: true, infohash: hash }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modified: true, infohash: hash }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modified: true, infohash: hash }), { status: 200 }));
    const client = new TriblerClient("http://127.0.0.1:52194", "secret", 100, fetchMock);

    await client.addDownload("https://archive.example/movie.torrent", undefined, { onlyMetadata: true });
    await client.resumeDownload(hash);
    await client.stopDownload(hash);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      uri: "https://archive.example/movie.torrent",
      only_metadata: true
    }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://127.0.0.1:52194/api/downloads/${hash}`);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ state: "resume" }));
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ state: "stop" }));
  });

  it("reads only the Tribler defaults that production uses for anonymous downloads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      settings: { libtorrent: { download_defaults: {
        anonymity_enabled: true, number_hops: 2, safeseeding_enabled: true,
        saveas: "private-path", api_key: "private-key"
      } } }
    }), { status: 200 }));
    const client = new TriblerClient("http://127.0.0.1:52194", "secret", 100, fetchMock);
    expect(await client.getAnonymityDefaults()).toEqual({ enabled: true, hops: 2, safeSeeding: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:52194/api/settings");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Api-Key")).toBe("secret");
  });

  it("isolates only the test download destination without overriding hops or seeding", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      started: true, infohash: "a".repeat(40)
    }), { status: 200 }));
    const client = new TriblerClient("http://127.0.0.1:52194", "secret", 100, fetchMock);
    await client.addDownload("magnet:?xt=urn:btih:test", undefined, {
      onlyMetadata: true, destination: "isolated", completedDir: "isolated"
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      uri: "magnet:?xt=urn:btih:test", only_metadata: true,
      destination: "isolated", completed_dir: "isolated"
    }));
  });
});
