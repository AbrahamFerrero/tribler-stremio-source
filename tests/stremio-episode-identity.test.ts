// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { describe, expect, it } from "vitest";
import { createStreamMediaItem } from "../src/addon";
import { parseStremioEpisodeIdentity } from "../src/streams/stremio-episode-identity";

describe("Stremio episode identity", () => {
  it("recognizes a bounded movie IMDb ID without changing the exact Stremio request ID", () => {
    expect(createStreamMediaItem("movie", "tt9900105")).toMatchObject({
      id: "tt9900105", kind: "movie", externalIds: { imdb: "tt9900105" },
      stremio: { type: "movie", videoId: "tt9900105" }
    });
    expect(createStreamMediaItem("movie", "tt9900105", {
      id: "catalog", type: "movie", name: "Zunra", externalIds: { imdb: "tt9999999" }
    }).externalIds.imdb).toBe("tt9900105");
    expect(createStreamMediaItem("movie", "tt1234").externalIds.imdb).toBeUndefined();
  });
  it("enriches a standard IMDb episode while preserving its exact Stremio id", () => {
    expect(createStreamMediaItem("series", "tt1234567:1:5")).toMatchObject({
      id: "tt1234567:1:5", kind: "episode", title: "", externalIds: { imdb: "tt1234567" },
      season: 1, episode: 5, stremio: { type: "series", videoId: "tt1234567:1:5" }
    });
  });

  it("keeps catalog metadata but does not let it replace the requested video id", () => {
    expect(createStreamMediaItem("series", "tt1234567:1:5", {
      id: "catalog", type: "series", name: "Series", kind: "episode", season: 2, episode: 3,
      externalIds: { tmdb: "44" }, classifications: ["anime"], stremio: { type: "anime", videoId: "old" }
    })).toMatchObject({
      kind: "episode", season: 2, episode: 3, externalIds: { imdb: "tt1234567", tmdb: "44" },
      classifications: ["anime"], stremio: { type: "series", videoId: "tt1234567:1:5" }
    });
  });

  it.each(["../secret", "tt1234567/1/5", "tt1234567:?x", "kitsu:episode:5", "tt1234567:1:-1"])(
    "does not reinterpret malformed or other namespace identities: %s", (id) => {
      expect(parseStremioEpisodeIdentity("series", id)).toBeUndefined();
      expect(createStreamMediaItem("series", id).stremio?.videoId).toBe(id);
    }
  );

  it("accepts specials season zero", () => {
    expect(parseStremioEpisodeIdentity("series", "tt1234567:0:0")).toEqual({ imdb: "tt1234567", season: 0, episode: 0 });
  });
});
