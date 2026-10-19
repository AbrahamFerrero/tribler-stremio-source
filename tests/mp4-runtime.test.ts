import { describe, expect, it } from "vitest";
import { MP4_INSPECTION_BYTES, mp4RuntimeFromPrefix, mp4RuntimeFromTail } from "../src/streams/mp4-runtime";
import { mp4Fixture, mp4FixtureWithLargeMoov, mp4FixtureWithLargeTailMoov } from "./mp4-fixture";

describe("bounded MP4 mvhd reader", () => {
  it.each([0, 1] as const)("reads fast-start mvhd version %i", (version) => {
    const video = mp4Fixture(7_560, "prefix", version);
    expect(mp4RuntimeFromPrefix(video, video.length).seconds).toBe(7_560);
  });

  it("locates a complete moov after a large mdat without scanning mdat bytes", () => {
    const video = mp4Fixture(240, "tail");
    const prefix = video.subarray(0, MP4_INSPECTION_BYTES);
    const offset = mp4RuntimeFromPrefix(prefix, video.length).tailOffset;
    expect(offset).toBe(video.length - 36);
    expect(mp4RuntimeFromTail(video.subarray(offset), offset!, video.length)).toBe(240);
  });

  it("reads an early mvhd from a large moov at a declared post-mdat boundary", () => {
    const video = mp4FixtureWithLargeTailMoov(15_600);
    const offset = mp4RuntimeFromPrefix(video.subarray(0, MP4_INSPECTION_BYTES), video.length).tailOffset;
    expect(offset).toBe(24 + 16 + 80 * 1024);
    if (offset === undefined) throw new Error("Expected declared post-mdat box boundary");
    expect(mp4RuntimeFromTail(video.subarray(offset, offset + MP4_INSPECTION_BYTES), offset, video.length))
      .toBe(15_600);
    const unboundedChild = Buffer.from(video.subarray(offset, offset + MP4_INSPECTION_BYTES));
    unboundedChild.writeUInt32BE(0, 8);
    expect(mp4RuntimeFromTail(unboundedChild, offset, video.length)).toBeUndefined();
    const overlongMoov = Buffer.from(video.subarray(offset, offset + MP4_INSPECTION_BYTES));
    overlongMoov.writeUInt32BE(video.length, 0);
    expect(mp4RuntimeFromTail(overlongMoov, offset, video.length)).toBeUndefined();
    const overlongMdat = Buffer.from(video);
    overlongMdat.writeBigUInt64BE(BigInt(video.length + 1), 32);
    expect(mp4RuntimeFromPrefix(overlongMdat.subarray(0, MP4_INSPECTION_BYTES), video.length))
      .toEqual({});
  });

  it("reads the complete first mvhd inside a moov larger than the bounded prefix", () => {
    const video = mp4FixtureWithLargeMoov(197);
    expect(mp4RuntimeFromPrefix(video.subarray(0, MP4_INSPECTION_BYTES), video.length))
      .toEqual({ seconds: 197 });
    const unboundedChild = Buffer.from(video);
    unboundedChild.writeUInt32BE(0, 32);
    expect(mp4RuntimeFromPrefix(unboundedChild.subarray(0, MP4_INSPECTION_BYTES), unboundedChild.length))
      .toEqual({});
  });

  it("reads a valid extended-size moov box", () => {
    const video = mp4Fixture(240);
    const extended = Buffer.alloc(16);
    extended.writeUInt32BE(1, 0);
    extended.write("moov", 4, 4, "ascii");
    extended.writeBigUInt64BE(44n, 8);
    const withExtendedMoov = Buffer.concat([video.subarray(0, 24), extended, video.subarray(32, 60),
      video.subarray(60)]);
    expect(mp4RuntimeFromPrefix(withExtendedMoov, withExtendedMoov.length).seconds).toBe(240);
  });

  it("treats truncated mvhd, zero timescale and unsupported version as unknown", () => {
    const original = mp4Fixture(240);
    const timescale = Buffer.from(original);
    timescale.writeUInt32BE(0, 52);
    expect(mp4RuntimeFromPrefix(timescale, timescale.length).seconds).toBeUndefined();
    const version = Buffer.from(original);
    version[40] = 2;
    expect(mp4RuntimeFromPrefix(version, version.length).seconds).toBeUndefined();
    const truncated = original.subarray(0, 50);
    expect(mp4RuntimeFromPrefix(truncated, original.length).seconds).toBeUndefined();
  });

  it("does not scan past a non-moov box at the declared mdat boundary", () => {
    const video = mp4Fixture(240, "tail");
    const gap = Buffer.alloc(MP4_INSPECTION_BYTES + 8);
    gap.writeUInt32BE(gap.length, 0);
    gap.write("free", 4, 4, "ascii");
    const boundary = video.length - 36;
    const moved = Buffer.concat([video.subarray(0, boundary), gap, video.subarray(boundary)]);
    expect(mp4RuntimeFromPrefix(moved.subarray(0, MP4_INSPECTION_BYTES), moved.length))
      .toEqual({ tailOffset: boundary });
    expect(mp4RuntimeFromTail(moved.subarray(boundary, boundary + MP4_INSPECTION_BYTES), boundary,
      moved.length)).toBeUndefined();
  });
});
