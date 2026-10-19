import { describe, expect, it } from "vitest";
import { identityMismatch, measuredRuntimeMismatch, runtimeContradicts } from "../src/streams/identity-qualification";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";

// These fixture identities, localized labels and provider/release names are invented.
// Alternate labels do not assert a trusted alias relation; no remote corpus is used.
const requested: NormalizedMediaItem = {
  id: "tt9900000001", kind: "movie", title: "The Copper Sky", year: 2013,
  runtimeSeconds: 126 * 60, externalIds: { imdb: "tt9900000001" }
};

function candidate(title: string, identity?: Record<string, unknown>): NormalizedStreamSource {
  return { providerId: "fixture", type: "https", url: "https://media.example/video.mp4", title,
    ...(identity ? { metadata: { identity } } : {}) };
}

describe("explicit movie runtime contradictions", () => {
  it.each(["mp4_mvhd", "hls_vod"] as const)("uses verified %s measurement without suppressing other decisive conflicts", evidence => {
    const measured: NormalizedStreamSource = { ...candidate("Server 1\n00:20:00"), directHttp: {
      verified: true, status: "verified", rangeSupported: true, runtimeEvidence: evidence, actualRuntimeSeconds: 7560
    } };
    expect(identityMismatch(requested, measured)).toBe(false);
    expect(measuredRuntimeMismatch(requested, measured)).toBe(false);
    expect(identityMismatch(requested, { ...measured, metadata: { identity: { externalIds: { imdb: "tt8888888888" } } } })).toBe(true);
    expect(identityMismatch(requested, { ...measured, filename: "Other.Series.S03E04.mp4" })).toBe(true);
    const episode = { ...requested, kind: "episode" as const, season: 2, episode: 9 };
    expect(identityMismatch(episode, { ...measured, filename: "Other.Series.S03E04.mp4" })).toBe(true);
    expect(measuredRuntimeMismatch(requested, { ...measured, directHttp: { ...measured.directHttp!, actualRuntimeSeconds: 1200 } })).toBe(true);
  });

  it("keeps weak-text rejection without a supported verified measurement", () => {
    const weak = candidate("Server 1\n00:20:00");
    expect(identityMismatch(requested, weak)).toBe(true);
    expect(identityMismatch(requested, weak, { deferTextualRuntime: true })).toBe(false);
    for (const actualRuntimeSeconds of [undefined, 0, NaN, Infinity]) {
      expect(identityMismatch(requested, { ...weak, directHttp: { verified: true, status: "verified", rangeSupported: true,
        runtimeEvidence: "mp4_mvhd", ...(actualRuntimeSeconds !== undefined ? { actualRuntimeSeconds } : {}) } })).toBe(true);
    }
    expect(identityMismatch(requested, { ...weak, directHttp: { verified: false, status: "reachable", rangeSupported: true,
      runtimeEvidence: "mp4_mvhd", actualRuntimeSeconds: 7560 } })).toBe(true);
    expect(identityMismatch(requested, { ...weak, directHttp: { verified: true, status: "verified", rangeSupported: true,
      actualRuntimeSeconds: 7560 } })).toBe(true);
    expect(identityMismatch(requested, { ...weak, metadata: { runtimeSeconds: 7560 } })).toBe(true);
  });

  it("retains strict measured equality and no inferred exact-episode expected duration", () => {
    expect(runtimeContradicts("movie", 6000, 7800)).toBe(false);
    expect(runtimeContradicts("movie", 6000, 7860)).toBe(true);
    const episode: NormalizedMediaItem = { id: "tt9999999998:2:9", kind: "episode", title: "", season: 2, episode: 9, externalIds: {} };
    expect(measuredRuntimeMismatch(episode, { ...candidate("00:20:00"), metadata: { runtimeSeconds: 1200 }, directHttp: {
      verified: true, status: "verified", rangeSupported: true, runtimeEvidence: "mp4_mvhd", actualRuntimeSeconds: 6420
    } })).toBe(false);
  });

  it.each([
    ["2:57:17", true],
    ["2:10:00", false],
    ["2:25:00", false],
    ["2:36:00", false],
    ["2h 57m", false],
    ["2:99:17", false],
    ["", false]
  ])("qualifies a standalone %s duration conservatively", (duration, rejected) => {
    expect(identityMismatch(requested, candidate(`Akagane Sora\n${duration}\n1080p`))).toBe(rejected);
  });

  it("allows moderate differences and missing requested runtime", () => {
    expect(identityMismatch({ ...requested, runtimeSeconds: 180 * 60 },
      candidate("Akagane Sora\n3:25:00"))).toBe(false);
    const withoutRuntime = { ...requested };
    delete withoutRuntime.runtimeSeconds;
    expect(identityMismatch(withoutRuntime,
      candidate("Other Name\n2:57:17"))).toBe(false);
    expect(identityMismatch(requested, candidate("銅のそら (2013) 1080p"))).toBe(false);
    expect(identityMismatch(requested, candidate("Akagane Sora (2013) 1080p"))).toBe(false);
    expect(identityMismatch(requested, candidate("Other Name (2013) 1080p"))).toBe(false);
    expect(identityMismatch(requested, candidate("Server 1"))).toBe(false);
  });

  it("does not let matching runtime override explicit year or external-ID contradictions", () => {
    expect(identityMismatch(requested, candidate("Other Movie (2020)\n2:06:00"))).toBe(true);
    expect(identityMismatch(requested, candidate("Other Movie\n2:06:00",
      { externalIds: { imdb: "tt9999999" } }))).toBe(true);
    expect(identityMismatch(requested, candidate("Other Movie\n2:10:00\n2:57:17"))).toBe(false);
  });
});

describe("explicit movie years in video filenames", () => {
  const movie: NormalizedMediaItem = {
    id: "neral", kind: "movie", title: "Neral: A Lone Navigator", year: 2013, externalIds: {}
  };

  it.each([
    "[FixtureCloud] [1.57 GB] Neral.1985.DC.1080p.10bit.BluRay.HIN-ENG.x265.ESub-FixtureReels.invalid.mkv\nfixturecloud | FixtureDock\nFX",
    "[FixtureCloud] [1.66 GB] Coastal.Neral.1991.1080p.x264.WEBRip.Hindi.English.ESubs.-.FixtureReels.example.mkv\nHindi\nfixturecloud | FixtureDock\nFX",
    "[FixtureCloud] [815.28 MB] Coastal.Neral.1991.720p.x264.WEBRip.Hindi.English.ESubs.-.FixtureReels.example.mkv\nHindi\nfixturecloud | FixtureDock\nFX"
  ])("rejects a contradictory release filename in a multiline label", (title) => {
    expect(identityMismatch(movie, candidate(title))).toBe(true);
  });

  it.each([
    "Some.Localized.Title.2013.1080p.WEB-DL.mkv",
    "Some.Localized.Title.1080p.WEB-DL.mkv",
    "Movie.Title.2160p.WEB-DL.mkv",
    "Some.Localized.Title (2013) 1080p",
    "Neralo 1080p",
    "Server 1",
    "A 1985 review of Some.Localized.Title.1080p.mkv",
    "Some.Localized.Title.1985.2013.mkv",
    "Some.Localized.Title.1985.txt"
  ])("keeps a source without one contradictory filename year: %s", (title) => {
    expect(identityMismatch(movie, candidate(title))).toBe(false);
  });

  it("uses an explicit normalized filename, but ignores a URL path and an absent requested year", () => {
    expect(identityMismatch(movie, { ...candidate("Direct"), filename: "Some Localized Title 1985 1080p.mkv" })).toBe(true);
    expect(identityMismatch(movie, { ...candidate("Direct"), url: "https://media.example/1985/video.mkv" })).toBe(false);
    const withoutYear = { ...movie };
    delete withoutYear.year;
    expect(identityMismatch(withoutYear, candidate("Other.Movie.1985.1080p.mkv"))).toBe(false);
  });

  it("retains the existing explicit structured release-year rejection", () => {
    expect(identityMismatch(movie, candidate("Other Movie (1985) 1080p"))).toBe(true);
  });
});

describe("explicit episodes in video release names", () => {
  const movie: NormalizedMediaItem = {
    id: "tt9900000002", kind: "movie", title: "Glass Signals", year: 1994, externalIds: { imdb: "tt9900000002" }
  };

  it.each([
    "N.E.R.A.S04E18.480p.WEB-DL.HIN-ENG.x264.ESub-FixtureForge.mkv",
    "N.E.R.A.s04e18.480p.WEB-DL.mkv"
  ])("rejects an explicit episode release for a movie: %s", (title) => {
    expect(identityMismatch(movie, candidate(title))).toBe(true);
  });

  it.each([
    "Glass.Signals.1994.1080p.10bit.BluRay.mkv",
    "Some.Movie.Part.3.1994.1080p.mkv",
    "A note about this episode",
    "A S04E18 review of Movie.1994.1080p.mkv",
    "Movie.1994.1080p.mkv",
    "Movie.2160p.mkv",
    "Show.S04E18 without a video filename",
    "Show.S100E18.1080p.mkv",
    "Show.S04E00.1080p.mkv",
    "Show.S04E18.S04E17.1080p.mkv"
  ])("keeps movie candidates without one explicit episode identity: %s", (title) => {
    expect(identityMismatch(movie, candidate(title))).toBe(false);
  });

  it("uses the normalized filename and compares explicit episode coordinates", () => {
    expect(identityMismatch(movie, { ...candidate("Direct"), filename: "Show.S04E18.1080p.mkv" })).toBe(true);
    const episode: NormalizedMediaItem = { id: "show:4:18", kind: "episode", title: "",
      season: 4, episode: 18, externalIds: {} };
    expect(identityMismatch(episode, candidate("Show.S04E18.1080p.mkv"))).toBe(false);
    expect(identityMismatch(episode, candidate("Show.S04E17.1080p.mkv"))).toBe(true);
    expect(identityMismatch(episode, candidate("Show.S04E18.1080p.mkv",
      { kind: "episode", season: 4, episode: 17 }))).toBe(true);
  });

  it.each(["S01E06", "S01.E06", "S01-E06", "S01 E06", "S01_E06"])(
    "compares bounded episode coordinates with common separators: %s", (coordinates) => {
      const source = { ...candidate("Direct"), filename: `Maps.and.Recollections.${coordinates}.1080p.mkv` };
      const episode: NormalizedMediaItem = { id: "show:1:6", kind: "episode", title: "",
        season: 1, episode: 6, externalIds: {} };
      expect(identityMismatch(movie, source)).toBe(true);
      expect(identityMismatch(episode, source)).toBe(false);
      expect(identityMismatch({ ...episode, season: 2 }, source)).toBe(true);
      expect(identityMismatch({ ...episode, episode: 5 }, source)).toBe(true);
    });

  it.each(["XS01.E06", "S001.E06", "S01.E006", "S01.E06extra", "S01..E06", "S01.E00"])(
    "preserves filename boundary protections: %s", (coordinates) => {
      expect(identityMismatch(movie, { ...candidate("Direct"), filename: `Show.${coordinates}.mkv` })).toBe(false);
    });
});

describe("identity precision synthetic recall controls", () => {
  const recollection: NormalizedMediaItem = { id: "tt9900000003", kind: "movie", title: "Recollection",
    year: 1968, runtimeSeconds: 4260, externalIds: { imdb: "tt9900000003" } };
  const starfarer: NormalizedMediaItem = { id: "tt9900000004", kind: "movie", title: "The Starfarer",
    year: 1984, runtimeSeconds: 107 * 60, externalIds: { imdb: "tt9900000004" } };

  it.each(["The.Recollection.1999.mkv", "The.Recollection.2025.mp4", "Recollection.2022.mp4",
    "The.Cost.of.Recollection.S01E01.mkv", "Maps.and.Recollections.S01.E06.mkv"])(
    "rejects strong Recollection contradictions: %s", (title) => {
      expect(identityMismatch(recollection, candidate(title))).toBe(true);
    });

  it.each(["The Starfarer (1984) 1080p", "Starfarer", "O Navegante das Estrelas",
    "480p (Audio Original)", "360p (Audio Original)", "Portuguese / Latino", "Server 1",
    "The_Starfarer_1984_RM4K_1080p_BluRay_x265_10bit_FixtureWeaver_part002.mkv",
    "The.Starfarer.1984.part003.mkv"])("preserves diverse Starfarer presentation: %s", (title) => {
      expect(identityMismatch(starfarer, candidate(title))).toBe(false);
    });

  it("keeps generic and unrelated title-only candidates fail-open", () => {
    expect(identityMismatch(recollection, candidate("Opaque source"))).toBe(false);
    expect(identityMismatch(recollection, candidate("Unrelated Movie"))).toBe(false);
    expect(identityMismatch(starfarer, { ...candidate("Starfarer"), directHttp: {
      status: "unreachable", verified: false, rangeSupported: false, responseStatus: 503
    } })).toBe(false);
  });
});
