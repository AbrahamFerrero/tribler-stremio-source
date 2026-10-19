import { describe, expect, it } from "vitest";
import { extractInfohash, normalizeTorrentSource, parseStreamId } from "../src/source";

const hash = "08ada5a7a6183aae1e09d831df6748d566095a10";

describe("torrent source parsing", () => {
  it("extracts and normalizes a magnet infohash", () => {
    const magnet = `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=Sintel`;
    expect(extractInfohash(magnet)).toBe(hash);
  });

  it("turns a raw infohash into a magnet", () => {
    expect(normalizeTorrentSource(hash)).toBe(`magnet:?xt=urn:btih:${hash}`);
  });

  it("accepts a manual file suffix", () => {
    expect(parseStreamId(`${hash}|file=7`)).toEqual({
      source: `magnet:?xt=urn:btih:${hash}`,
      fileIndex: 7
    });
  });

  it("accepts torrent URLs and rejects credentials or non-torrent paths", () => {
    expect(normalizeTorrentSource("https://archive.example/item/video.torrent"))
      .toBe("https://archive.example/item/video.torrent");
    expect(() => normalizeTorrentSource("https://user:secret@archive.example/video.torrent")).toThrow();
    expect(() => normalizeTorrentSource("https://archive.example/video.mp4")).toThrow();
  });
});
