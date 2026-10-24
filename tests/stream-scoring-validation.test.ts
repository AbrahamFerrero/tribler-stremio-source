import { describe, expect, it } from "vitest";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { normalizeStreamSource } from "../src/streams/normalization";
import { rankedStreamDescription, safeStreamDescription, streamSummary } from "../src/streams/presentation";
import { defaultStreamRankingPolicy, loadStreamRankingPolicy } from "../src/streams/ranking-policy";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { scoreStream, streamScoreComponents } from "../src/streams/scoring";
import type { NormalizedStreamSource } from "../src/streams/types";
import { silentLogger } from "./helpers";

function stream(fields: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource {
  return { providerId: "synthetic", type: "magnet", ...fields };
}
const invalidSeeds = [0.5, 1.5, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];

describe("provider metadata normalization boundary", () => {
  function normalize(fields: Partial<NormalizedStreamSource>) {
    return normalizeStreamSource({ type: "magnet", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      ...fields }, "synthetic")!;
  }

  it.each([
    "en\n", "\ten", "en\r", "en\u0000", "e\u0000n", "en\u200b", "\u00a0en",
    "en" + " ".repeat(78) + "opaque", "en" + " ".repeat(118) + "https://opaque.invalid",
    "en" + " ".repeat(501), "en/eng", "en/es/ja", "en or es", "<b>en</b>"
  ])("does not repair invalid whole provider values %j into points or public labels", value => {
    const fields = { language: value, audio: value };
    for (const source of [stream(fields), normalize(fields)]) {
      expect(streamScoreComponents(source).metadata).toBe(0);
      expect(scoreStream(source)).toBe(-12);
      expect(safeStreamDescription(source)).toBeUndefined();
      expect(rankedStreamDescription(source, 1, defaultStreamRankingPolicy))
        .toBe("#1 · Score -12\nAvail -12 · Res +0 · Size +0 · Codec +0 · Meta +0 · Net +0");
    }
  });

  it.each([
    [{ language: " en ", audio: " JA " }, 3, "Japanese audio"],
    [{ language: "ENG", audio: "English" }, 3, "English audio"],
    [{ language: " ES / ENG ", audio: "ENG+JPN" }, 3, "English/Japanese audio"],
    [{ language: "en", audio: " DuAl   AuDiO " }, 3, "Dual audio"],
    [{ language: "hun", audio: " Multi " }, 3, "Multi audio"],
    [{ language: "en\n", audio: "ja" }, 1, "Japanese audio"],
    [{ language: "en", audio: "ja\n" }, 2, undefined],
    [{ audio: " English subs " }, 0, "English subtitles"],
    [{ language: "opaque", audio: "opaque" }, 0, undefined],
    [{}, 0, undefined],
    [{ language: "en" + " ".repeat(90) + "/es", audio: "en" + " ".repeat(130) + "/ja" },
      3, "English/Japanese audio"]
  ] satisfies Array<[Partial<NormalizedStreamSource>, number, string | undefined]>)(
    "preserves whole valid claims and independent field points %j", (fields, points, label) => {
      const source = normalize(fields);
      expect(streamScoreComponents(source).metadata).toBe(points);
      expect(safeStreamDescription(source)).toBe(label);
      expect(rankedStreamDescription(source, 1, defaultStreamRankingPolicy)).toContain(`Meta +${points}`);
      if ("audio" in fields && fields.audio === "opaque") expect(source.audio).toBe("opaque");
    });

  it("does not create a public subtitle claim by removing an invalid suffix", () => {
    for (const audio of ["English subs\n", "English subs" + " ".repeat(108) + "opaque"]) {
      const source = normalize({ audio });
      expect(streamScoreComponents(source).metadata).toBe(0);
      expect(safeStreamDescription(source)).toBeUndefined();
    }
  });
});

describe("closed structured scoring metadata", () => {
  it.each([
    [{ language: "en" }, 2], [{ audio: "en" }, 1], [{ language: "ja", audio: "Dual audio" }, 3],
    [{ language: " es/en ", audio: "EN + ES" }, 3], [{ language: "English", audio: "audio: ja" }, 3],
    [{ language: "hun", audio: "English audio" }, 3], [{ audio: "Multi" }, 1],
    [{ language: "opaque" }, 0], [{ audio: "opaque" }, 0], [{}, 0]
  ] satisfies Array<[Partial<NormalizedStreamSource>, number]>)("awards only recognized fields %j", (fields, points) => {
    expect(streamScoreComponents(stream(fields)).metadata).toBe(points);
  });

  it.each(["", " ", "arbitrary text", "https://private.invalid/en", "<b>en</b>", "en/es/ja",
    "en or es", "en es", "en/eng", "en/xx", "en|es", "en\n", "audio: en | Dual audio",
    "constructor", "toString", "__proto__", "en".repeat(251)])("rejects opaque or ambiguous whole values %j", value => {
    expect(streamScoreComponents(stream({ language: value, audio: value })).metadata).toBe(0);
  });

  it("does not infer scoring metadata or expose generic language as an audiovisual claim", () => {
    const source = stream({ language: "es/en", title: "Synthetic.en.mp4", filename: "Synthetic.ja.mp4",
      url: "https://private.invalid/en.mp4" });
    expect(streamScoreComponents(source).metadata).toBe(2);
    expect(safeStreamDescription(source)).toBeUndefined();
    const withoutLanguage = { ...source };
    delete withoutLanguage.language;
    expect(streamScoreComponents(withoutLanguage).metadata).toBe(0);
    expect(safeStreamDescription(stream({ language: "ja", audio: "Dual audio" }))).toBe("Dual audio");
    expect(safeStreamDescription(stream({ audio: "en/es" }))).toBe("English/Spanish audio");
    expect(safeStreamDescription(stream({ language: "PRIVATE_SENTINEL", audio: "PRIVATE_SENTINEL" }))).toBeUndefined();
  });
});

describe("seed count validation", () => {
  it.each(invalidSeeds)("treats internal seed count %s as unknown without rounding", seeds => {
    expect(streamScoreComponents(stream({ seeds })).availability).toBe(-12);
    expect(scoreStream(stream({ seeds }))).toBe(-12);
    expect(streamSummary(stream({ seeds }))).toBe("Tribler");
  });

  it.each([...invalidSeeds, "1", null, true, undefined])("normalizes raw provider count %s to unknown", seeds => {
    const source = normalizeStreamSource({ type: "magnet", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      seeds, sizeBytes: 1.5 }, "synthetic")!;
    expect(source).toBeDefined();
    expect(source.seeds).toBeUndefined();
    expect(source.sizeBytes).toBe(1.5);
  });

  it.each([[0, -60], [1, 20], [2, 31.69925001442312], [20, 87.84634845557521],
    [100, 133.1642296550359], [Number.MAX_SAFE_INTEGER, 150]] as const)("preserves count %s and its existing score", (seeds, points) => {
    const source = normalizeStreamSource({ type: "magnet", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, seeds }, "synthetic")!;
    expect(source.seeds).toBe(seeds);
    expect(streamScoreComponents(source).availability).toBeCloseTo(points, 10);
    expect(streamSummary(source)).toContain(`${seeds} ${seeds === 1 ? "seed" : "seeds"}`);
    expect(streamScoreComponents(stream()).availability).toBe(-12);
  });

  it.each([{}, { language: "en", audio: "Dual audio", seeds: 20 },
    { language: "PRIVATE_SENTINEL", audio: "PRIVATE_SENTINEL", seeds: 0.5 }])("shares the effective scorer with F %j", fields => {
    const source = stream(fields);
    const policy = structuredClone(loadStreamRankingPolicy());
    policy.torrent.unknownSeeds = -19;
    const components = streamScoreComponents(source, policy);
    const detail = rankedStreamDescription(source, 1, policy)!;
    expect(detail).toContain(`Score ${Number(scoreStream(source, policy).toFixed(2))}`);
    expect(detail).toContain(`Meta +${components.metadata}`);
    expect(detail).toContain(`Avail ${components.availability < 0 ? "" : "+"}${Number(components.availability.toFixed(2))}`);
    expect(detail).not.toContain("PRIVATE_SENTINEL");
    expect(loadStreamRankingPolicy()).toEqual(defaultStreamRankingPolicy);
  });
});

describe("ranking validation regressions", () => {
  async function resolve(fields: Partial<NormalizedStreamSource>[], bypassSeeds?: number) {
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "synthetic", name: "Synthetic", isEnabled: () => true,
      resolve: () => Promise.resolve(fields.map((extra, index) => stream({
        magnet: `magnet:?xt=urn:btih:${String(index + 1).repeat(40)}`, ...extra
      }))) });
    return new StreamResolver(registry, new ExternalUrlPolicy(), undefined, {
      stage: (stage, sources) => {
        // Simulate an internal producer bypassing provider normalization.
        if (stage === "admitted" && bypassSeeds !== undefined) sources[1]!.seeds = bypassSeeds;
      }
    }).resolve({ id: "synthetic", kind: "movie", title: "Synthetic", externalIds: {} });
  }

  it.each([{ language: "opaque", audio: "opaque" }, { seeds: 0.5 }, { seeds: 1.5 }])(
    "removes the unearned advantage from %j and preserves stable equal-score order", async fields => {
      const final = await resolve([{}, fields]);
      expect(final.map(source => source.infoHash)).toEqual(["1".repeat(40), "2".repeat(40)]);
      expect(scoreStream(final[0]!)).toBe(scoreStream(final[1]!));
    });

  it.each(["en\n", "en" + " ".repeat(118) + "https://opaque.invalid"])(
    "keeps resolver ranking and F consistent for invalid raw metadata %j", async value => {
      const final = await resolve([{}, { language: value, audio: value }]);
      expect(final.map(source => source.infoHash)).toEqual(["1".repeat(40), "2".repeat(40)]);
      for (const [index, source] of final.entries()) {
        expect(scoreStream(source)).toBe(-12);
        expect(safeStreamDescription(source)).toBeUndefined();
        expect(rankedStreamDescription(source, index + 1, defaultStreamRankingPolicy))
          .toBe(`#${index + 1} · Score -12\nAvail -12 · Res +0 · Size +0 · Codec +0 · Meta +0 · Net +0`);
      }
    });

  it.each(invalidSeeds)("does not favor internal invalid seeds %s in score or tie-break", async seeds => {
    const final = await resolve([{}, {}], seeds);
    expect(final.map(source => source.infoHash)).toEqual(["1".repeat(40), "2".repeat(40)]);
  });
});
