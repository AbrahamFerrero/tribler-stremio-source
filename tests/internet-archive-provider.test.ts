import { describe, expect, it, vi } from "vitest";
import { InternetArchiveCatalogProvider } from "../src/catalog/internet-archive-provider";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("InternetArchiveCatalogProvider", () => {
  it("maps a searchable page to Stremio catalog items", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((input: string | URL | Request) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(jsonResponse({
        response: {
          docs: [{
            identifier: "sample_movie",
            title: "Sample Movie",
            description: "<p>A sample description</p>",
            year: 1940,
            subject: ["Drama", "Archive"]
          }]
        }
      }));
    }) as typeof fetch;
    const provider = new InternetArchiveCatalogProvider({
      query: 'mediatype:movies AND format:"Archive BitTorrent"',
      pageSize: 50,
      cacheTtlMs: 60_000,
      requestTimeoutMs: 1_000,
      baseUrl: "https://archive.example",
      fetchImplementation: fetchMock
    });

    const items = await provider.list({ type: "movie", skip: 0, search: "sample!" });

    expect(items).toEqual([expect.objectContaining({
      id: "tribler:ia:sample_movie",
      type: "movie",
      name: "Sample Movie",
      description: "A sample description",
      releaseInfo: "1940",
      poster: "https://archive.example/services/img/sample_movie"
    })]);
    const requested = new URL(requests[0] ?? "");
    expect(requested.pathname).toBe("/advancedsearch.php");
    expect(requested.searchParams.get("q")).toContain("title:(sample)");
    expect(requested.searchParams.get("sort[]")).toBe("downloads desc");
  });

  it("resolves the torrent filename from metadata and caches the response", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({
      metadata: {
        identifier: "sample_movie",
        title: "Sample Movie",
        description: "Description"
      },
      files: [
        { name: "sample_movie.mp4", format: "MPEG4", size: "123456", width: "640", height: "360" },
        { name: "sample_movie_hd.avi", format: "DivX", size: "999999", width: "1920", height: "1080" },
        { name: "files/sample_movie_archive.torrent", format: "Archive BitTorrent" }
      ]
    }))) as typeof fetch;
    const provider = new InternetArchiveCatalogProvider({
      query: "mediatype:movies",
      pageSize: 50,
      cacheTtlMs: 60_000,
      requestTimeoutMs: 1_000,
      baseUrl: "https://archive.example",
      fetchImplementation: fetchMock
    });

    const id = "tribler:ia:sample_movie";
    expect(await provider.getTorrentSource(id)).toBe(
      "https://archive.example/download/sample_movie/files/sample_movie_archive.torrent"
    );
    expect((await provider.get(id))?.name).toBe("Sample Movie");
    expect(await provider.getDirectStream(id)).toEqual({
      url: "https://archive.example/download/sample_movie/sample_movie_hd.avi",
      fileName: "sample_movie_hd.avi",
      size: 999999,
      width: 1920,
      height: 1080,
      format: "DivX"
    });
    expect((await provider.getDirectStreams(id)).map((stream) => stream.fileName)).toEqual([
      "sample_movie_hd.avi",
      "sample_movie.mp4"
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed identifiers and items without torrents", async () => {
    const provider = new InternetArchiveCatalogProvider({
      query: "mediatype:movies",
      pageSize: 50,
      cacheTtlMs: 60_000,
      requestTimeoutMs: 1_000,
      baseUrl: "https://archive.example",
      fetchImplementation: () => Promise.resolve(jsonResponse({
        metadata: { identifier: "no_torrent", title: "No torrent" },
        files: []
      }))
    });

    expect(provider.owns("tribler:ia:../bad")).toBe(false);
    await expect(provider.getTorrentSource("tribler:ia:no_torrent")).rejects.toThrow(/no torrent/i);
  });
});
