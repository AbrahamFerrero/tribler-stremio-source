import { describe, expect, it } from "vitest";
import type { TriblerFile } from "../src/types";
import { inferVideoHeight, isDangerousFile, listVideoFiles, selectMainVideo } from "../src/video-selection";

function file(index: number, name: string, size: number): TriblerFile {
  return { index, name, size, included: true, progress: 0 };
}

describe("selectMainVideo", () => {
  it("selects the largest preferred video and ignores extras", () => {
    const selected = selectMainVideo([
      file(0, "poster.jpg", 20_000),
      file(1, "sample.mkv", 80_000_000),
      file(2, "movie.webm", 700_000_000),
      file(3, "movie.mp4", 900_000_000)
    ]);
    expect(selected?.index).toBe(3);
  });

  it("falls back to other common video formats", () => {
    expect(selectMainVideo([file(4, "feature.avi", 10_000)])?.index).toBe(4);
  });

  it("returns undefined when no video exists", () => {
    expect(selectMainVideo([file(0, "readme.txt", 100)])).toBeUndefined();
  });

  it("recognizes executable and script extensions, including trailing Windows dots", () => {
    expect(isDangerousFile(file(1, "setup.exe", 10))).toBe(true);
    expect(isDangerousFile(file(2, "watch.mp4.exe. ", 10))).toBe(true);
    expect(isDangerousFile(file(3, "movie.mkv", 10))).toBe(false);
  });

  it("lists all video formats ordered by inferred quality", () => {
    const variants = listVideoFiles([
      file(0, "movie.360p.mp4", 100),
      file(1, "movie.1080p.avi", 900),
      file(2, "movie.720p.webm", 500),
      file(3, "notes.txt", 5)
    ]);
    expect(variants.map((variant) => variant.index)).toEqual([1, 2, 0]);
    expect(inferVideoHeight("Film.4K.mkv")).toBe(2160);
  });
});
