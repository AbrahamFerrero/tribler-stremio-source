import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvaluationCases, caseSegments } from "../scripts/evaluation-corpus";
import { effectivePolicyContentType } from "../src/streams/content-type-policy";
import fixture from "./fixtures/evaluation-corpus.synthetic-v1.json";

const path = join(process.cwd(), "tests", "fixtures", "evaluation-corpus.synthetic-v1.json");
const combined = [
  "movie/mainstream", "movie/long-tail",
  "series/mainstream", "series/long-tail",
  "anime/mainstream", "anime/long-tail"
];

describe("synthetic evaluation corpus v1 contract", () => {
  it("loads the fixed 24-case balance and anime structural split", () => {
    const corpus = loadEvaluationCases(path, "--corpus");
    expect(corpus.id).toBe("synthetic-evaluation-v1");
    expect(corpus.version).toBe(1);
    expect(corpus.cases).toHaveLength(24);
    expect(new Set(corpus.cases.map((entry) => entry.id)).size).toBe(24);
    expect(new Set(corpus.cases.map((entry) => entry.item.id)).size).toBe(24);
    expect(new Set(corpus.cases.map((entry) => entry.item.externalIds.synthetic)).size).toBe(24);
    expect(corpus.cases.every((entry) => entry.item.id.startsWith("synthetic:"))).toBe(true);
    expect(corpus.cases.filter((entry) => entry.item.kind === "movie")).toHaveLength(12);
    expect(corpus.cases.filter((entry) => entry.item.kind === "episode")).toHaveLength(12);
    for (const segment of combined) {
      expect(corpus.cases.filter((entry) => caseSegments(entry).includes(segment))).toHaveLength(4);
    }
    for (const cohort of ["mainstream", "long-tail"]) {
      const anime = corpus.cases.filter((entry) =>
        entry.mediaClass === "anime" && entry.cohort === cohort);
      expect(anime.filter((entry) => entry.item.kind === "movie" && entry.item.stremio?.type === "movie"))
        .toHaveLength(2);
      expect(anime.filter((entry) => entry.item.kind === "episode" && entry.item.stremio?.type === "series"))
        .toHaveLength(2);
      expect(anime.every((entry) => effectivePolicyContentType(entry.item) === "anime")).toBe(true);
    }
    expect(corpus.fingerprint).toBe("7ea9d84dcd6d5cddaf88d0f90f40d2f569d5a4da688171dbd5134fe0be219314");
    expect(loadEvaluationCases(path, "--corpus").fingerprint).toBe(corpus.fingerprint);
  });

  it("segments every case by class, cohort and anime shape", () => {
    const corpus = loadEvaluationCases(path, "--corpus");
    for (const entry of corpus.cases) {
      expect(caseSegments(entry)).toEqual([
        "all", entry.mediaClass, entry.cohort, `${entry.mediaClass}/${entry.cohort}`,
        ...(entry.mediaClass === "anime"
          ? [`anime/${entry.item.kind}`, `anime/${entry.cohort}/${entry.item.kind}`] : [])
      ]);
      if (entry.item.kind === "episode") {
        expect(entry.item).toMatchObject({ season: 1, episode: 2, stremio: { type: "series" } });
      }
    }
  });

  it("rejects invalid envelopes, cases and item identities through the shared loader", () => {
    const first = fixture.cases[0]!;
    const invalid = [
      null,
      { ...fixture, version: 2 },
      { ...fixture, extra: true },
      { ...fixture, cases: [] },
      { ...fixture, cases: Array.from({ length: 101 }, () => first) },
      { ...fixture, cases: [null] },
      { ...fixture, cases: [first, first] },
      { ...fixture, cases: [{ ...first, extra: true }] },
      { ...fixture, cases: [{ ...first, mediaClass: "unsupported" }] },
      { ...fixture, cases: [{ ...first, cohort: "unsupported" }] },
      { ...fixture, cases: [{ ...first, mediaClass: "anime" }] },
      { ...fixture, cases: [{ ...first, item: { ...first.item, videoId: "invalid id" } }] },
      { ...fixture, cases: [{ ...first, item: { ...first.item, season: -1 } }] }
    ];
    const directory = mkdtempSync(join(tmpdir(), "synthetic-corpus-"));
    const input = join(directory, "invalid.json");
    try {
      for (const value of invalid) {
        writeFileSync(input, JSON.stringify(value));
        expect(() => loadEvaluationCases(input, "--corpus")).toThrow(/CORPUS_INVALID|INPUT_INVALID/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
