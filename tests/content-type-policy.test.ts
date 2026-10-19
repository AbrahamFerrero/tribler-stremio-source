import { describe, expect, it } from "vitest";
import { allowsContentType, effectivePolicyContentType } from "../src/streams/content-type-policy";
import type { NormalizedMediaItem } from "../src/streams/types";

const movie: NormalizedMediaItem = {
  id: "fixture", kind: "movie", title: "Anime in title", externalIds: { kitsu: "kitsu:1" },
  metadata: { genres: ["anime"], providerName: "anime-addon" }
};
const series: NormalizedMediaItem = { ...movie, kind: "series" };
const episode: NormalizedMediaItem = { ...movie, kind: "episode" };

describe("effective policy content type", () => {
  it("uses structural movie and series classes without heuristics", () => {
    expect(effectivePolicyContentType(movie)).toBe("movie");
    expect(effectivePolicyContentType(series)).toBe("series");
    expect(effectivePolicyContentType(episode)).toBe("series");
    expect(effectivePolicyContentType({ ...movie, classifications: ["Anime"] })).toBe("movie");
  });

  it("uses explicit anime classification or Stremio type before structural kind", () => {
    expect(effectivePolicyContentType({ ...episode, classifications: ["anime"] })).toBe("anime");
    expect(effectivePolicyContentType({ ...movie, classifications: ["anime"] })).toBe("anime");
    expect(effectivePolicyContentType({ ...series, stremio: { type: "anime" } })).toBe("anime");
  });

  it("defaults an absent policy to all enabled", () => {
    for (const item of [movie, series, { ...episode, classifications: ["anime"] }]) {
      expect(allowsContentType(undefined, item)).toBe(true);
    }
  });
});
