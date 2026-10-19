import { describe, expect, it } from "vitest";
import { AddonRequestIdentityResolver } from "../src/streams/addon-request-identity";
import { MediaIdMapperRegistry, StoredExternalIdMapper, type MediaIdMapper } from "../src/streams/media-id-mapper";
import { parseStreamResourceCapabilities } from "../src/streams/stremio-addon-manifest";
import type { NormalizedMediaItem } from "../src/streams/types";

function item(overrides: Partial<NormalizedMediaItem> = {}): NormalizedMediaItem {
  return {
    id: "internal:item",
    kind: "movie",
    title: "Item",
    externalIds: {},
    ...overrides
  };
}

const resolver = new AddonRequestIdentityResolver();

describe("AddonRequestIdentityResolver", () => {
  it("uses an existing IMDb ID for a compatible movie addon", async () => {
    await expect(resolver.resolve(
      item({ externalIds: { imdb: "tt1234567" } }),
      { types: ["movie"], idPrefixes: ["tt"] }
    )).resolves.toEqual({ type: "movie", id: "tt1234567" });
  });

  it("constructs the documented IMDb episode video ID without mutating the base ID", async () => {
    const episode = item({
      kind: "episode", season: 1, episode: 5, externalIds: { imdb: "tt1234567" }
    });
    await expect(resolver.resolve(episode, {
      types: ["series"], idPrefixes: ["tt"]
    })).resolves.toEqual({ type: "series", id: "tt1234567:1:5" });
    expect(episode.externalIds.imdb).toBe("tt1234567");
  });

  it("can represent anime with IMDb while selecting the addon-specific anime type", async () => {
    await expect(resolver.resolve(item({
      kind: "episode",
      classifications: ["anime"],
      season: 2,
      episode: 3,
      externalIds: { imdb: "tt7654321" }
    }), { types: ["anime"], idPrefixes: ["tt"] })).resolves.toEqual({
      type: "anime", id: "tt7654321:2:3"
    });
  });

  it.each([
    ["kitsu", "kitsu:42"],
    ["anilist", "anilist:123"],
    ["mal", "mal:456"]
  ])("uses an exact available %s identity for anime", async (namespace, id) => {
    await expect(resolver.resolve(item({
      kind: "series",
      classifications: ["anime"],
      externalIds: { [namespace]: id }
    }), { types: ["anime"], idPrefixes: [namespace] })).resolves.toEqual({ type: "anime", id });
  });

  it("selects only the namespace compatible with the addon when several IDs exist", async () => {
    await expect(resolver.resolve(item({
      kind: "series",
      classifications: ["anime"],
      externalIds: { imdb: "tt1234567", kitsu: "kitsu:99", anilist: "anilist:100" }
    }), { types: ["anime"], idPrefixes: ["kitsu"] })).resolves.toEqual({
      type: "anime", id: "kitsu:99"
    });
  });

  it("preserves an exact catalog video ID ahead of base or mapped IDs", async () => {
    await expect(resolver.resolve(item({
      kind: "episode",
      season: 4,
      episode: 7,
      externalIds: { imdb: "tt1234567" },
      stremio: { type: "anime", videoId: "kitsu:exact-episode-7" },
      classifications: ["anime"]
    }), { types: ["anime"], idPrefixes: ["kitsu"] })).resolves.toEqual({
      type: "anime", id: "kitsu:exact-episode-7"
    });
  });

  it("uses an exact Stremio episode video ID even when separate season fields are unavailable", async () => {
    await expect(resolver.resolve(item({
      kind: "episode",
      externalIds: { imdb: "tt1234567" },
      stremio: { type: "series", videoId: "tt1234567:3:9" }
    }), { types: ["series"], idPrefixes: ["tt"] })).resolves.toEqual({
      type: "series", id: "tt1234567:3:9"
    });
  });

  it("does not fabricate an IMDb ID for an episode missing season or episode", async () => {
    await expect(resolver.resolve(item({
      kind: "episode", season: 1, externalIds: { imdb: "tt1234567" }
    }), { types: ["series"], idPrefixes: ["tt"] })).resolves.toBeUndefined();
  });

  it.each(["../secret", "tt123/1/2", "bad?id", " space", ""])(
    "rejects malformed media ID %s safely",
    async (id) => {
      await expect(resolver.resolve(item({ id, externalIds: {} }), {
        types: ["movie"]
      })).resolves.toBeUndefined();
    }
  );

  it("does not use a malformed external identity", async () => {
    await expect(resolver.resolve(item({ externalIds: { kitsu: "kitsu:../../secret" } }), {
      types: ["anime"], idPrefixes: ["kitsu"]
    })).resolves.toBeUndefined();
  });

  it("returns no identity when no type or ID is compatible", async () => {
    await expect(resolver.resolve(item({ externalIds: { imdb: "tt1234567" } }), {
      types: ["anime"], idPrefixes: ["kitsu"]
    })).resolves.toBeUndefined();
  });

  it("allows a future mapper to be registered without changing the provider", async () => {
    const mapper: MediaIdMapper = {
      id: "future_tmdb_to_custom",
      canMap: (media, namespace) => namespace === "tmdb" && Boolean(media.externalIds.tmdb),
      map: (media) => Promise.resolve(`future:${media.externalIds.tmdb}`)
    };
    const registry = new MediaIdMapperRegistry([mapper, new StoredExternalIdMapper()]);
    const extensible = new AddonRequestIdentityResolver(registry);
    await expect(extensible.resolve(item({ externalIds: { tmdb: "321" } }), {
      types: ["movie"], idPrefixes: ["future:"]
    })).resolves.toEqual({ type: "movie", id: "future:321" });
  });
});

describe("stream manifest capabilities", () => {
  it("uses stream resource capabilities instead of conflicting global capabilities", () => {
    expect(parseStreamResourceCapabilities({
      id: "org.fixture", name: "Fixture", description: "Fixture", version: "1.0.0",
      types: ["movie"], idPrefixes: ["tt"],
      resources: [{ name: "stream", types: ["anime"], idPrefixes: ["kitsu"] }]
    })).toEqual({ types: ["anime"], idPrefixes: ["kitsu"] });
  });
});
