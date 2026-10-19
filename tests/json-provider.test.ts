import { describe, expect, it, vi } from "vitest";
import { JsonCatalogProvider } from "../src/catalog/json-provider";

const torrent = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

describe("JsonCatalogProvider", () => {
  it("turns a static list into Stremio metadata and quality variants", async () => {
    const provider = new JsonCatalogProvider({
      id: "static-test",
      name: "Static test",
      type: "movie",
      items: [{
        id: "movie/one",
        name: "Movie one",
        kind: "episode",
        season: 1,
        episode: 5,
        externalIds: { imdb: "tt1234567", kitsu: "kitsu:42" },
        classifications: ["anime"],
        stremio: { type: "anime", videoId: "kitsu:episode-5" },
        torrent,
        streams: [
          { url: "https://media.example/720.mp4", fileName: "movie-720p.mp4", size: 20, height: 720 },
          { url: "https://media.example/1080.mp4", fileName: "movie-1080p.mp4", size: 40, height: 1080 }
        ]
      }],
      pageSize: 50,
      cacheTtlMs: 1_000,
      requestTimeoutMs: 1_000
    });

    const items = await provider.list({ type: "movie", skip: 0 });
    expect(items).toHaveLength(1);
    expect(provider.owns(items[0]?.id ?? "")).toBe(true);
    expect(items[0]).toEqual(expect.objectContaining({
      kind: "episode",
      season: 1,
      episode: 5,
      externalIds: { imdb: "tt1234567", kitsu: "kitsu:42" },
      classifications: ["anime"],
      stremio: { type: "anime", videoId: "kitsu:episode-5" }
    }));
    expect(await provider.getTorrentSource(items[0]?.id ?? "")).toBe(torrent);
    expect(await provider.getDirectStreams(items[0]?.id ?? "")).toHaveLength(2);
    expect(await provider.supportsTriblerFallback(items[0]?.id ?? "")).toBe(true);
  });

  it("maps a remote API shape without exposing header values in errors", async () => {
    const previous = process.env.TEST_REMOTE_AUTH;
    process.env.TEST_REMOTE_AUTH = "Bearer private-test-value";
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      payload: {
        results: [{
          uuid: "remote-1",
          title: "Remote movie",
          playback: {
            http: [{ href: "https://cdn.example/movie.webm", filename: "movie.webm", bytes: 123 }]
          }
        }]
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
      const provider = new JsonCatalogProvider({
        id: "remote-test",
        name: "Remote test",
        type: "movie",
        catalogUrl: "https://api.example/catalog?query={search}",
        itemUrl: "https://api.example/items/{id}",
        itemsPath: "payload.results",
        mapping: {
          id: "uuid",
          name: "title",
          streams: "playback.http",
          streamUrl: "href",
          streamFileName: "filename",
          streamSize: "bytes"
        },
        headersFromEnv: { Authorization: "TEST_REMOTE_AUTH" },
        pageSize: 25,
        cacheTtlMs: 1_000,
        requestTimeoutMs: 1_000,
        fetchImplementation
      });
      const items = await provider.list({ type: "movie", skip: 0, search: "remote" });
      expect(items[0]?.name).toBe("Remote movie");
      expect(await provider.getDirectStreams(items[0]?.id ?? "")).toEqual([
        expect.objectContaining({ fileName: "movie.webm", size: 123 })
      ]);
      expect(await provider.supportsTriblerFallback(items[0]?.id ?? "")).toBe(false);
      const request = fetchImplementation.mock.calls[0];
      expect(request?.[0]).toContain("query=remote");
      expect((request?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer private-test-value");
    } finally {
      if (previous === undefined) delete process.env.TEST_REMOTE_AUTH;
      else process.env.TEST_REMOTE_AUTH = previous;
    }
  });

  it("rejects malformed provider ids and missing secret environment variables", () => {
    expect(() => new JsonCatalogProvider({
      id: "Bad id",
      name: "Bad",
      type: "movie",
      items: [],
      pageSize: 10,
      cacheTtlMs: 1_000,
      requestTimeoutMs: 1_000
    })).toThrow(/Catalog id/);
    expect(() => new JsonCatalogProvider({
      id: "secret-test",
      name: "Secret",
      type: "movie",
      catalogUrl: "https://api.example/items",
      headersFromEnv: { Authorization: "DEFINITELY_MISSING_TEST_SECRET" },
      pageSize: 10,
      cacheTtlMs: 1_000,
      requestTimeoutMs: 1_000
    })).toThrow(/DEFINITELY_MISSING_TEST_SECRET/);
  });
});
