import { describe, expect, it } from "vitest";
import { directMediaSignature } from "../src/streams/direct-media-signature";
import { mp4Fixture } from "./mp4-fixture";
import { directMediaFixture, matroskaPrefix } from "./direct-media-trace-fixture";

const mp4 = () => Buffer.from(mp4Fixture(600).subarray(0, 64));
const change = (input: Uint8Array, at: number, value: number) => { const b = Buffer.from(input); b[at] = value; return b; };

describe("bounded container evidence", () => {
  it("recognizes only supported structures and never needs the remaining media", () => {
    expect(directMediaSignature(mp4(), 1_000_000)).toBe("mp4");
    expect(directMediaSignature(matroskaPrefix(), 1_000_000)).toBe("matroska");
    expect(directMediaSignature(change(matroskaPrefix(), 44, 0xff), 1_000_000)).toBe("matroska");
    for (const body of [mp4(), matroskaPrefix()]) {
      expect(directMediaSignature(body, 63)).toBeUndefined();
      expect(directMediaSignature(body, Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
      expect(directMediaSignature(Buffer.concat([body, Buffer.from([0])]), 1_000_000)).toBeUndefined();
    }
  });
  it("rejects every truncation before the required final header", () => {
    for (let n = 0; n < 32; n++) expect(directMediaSignature(mp4().subarray(0, n), 1000)).toBeUndefined();
    for (let n = 0; n < 45; n++) expect(directMediaSignature(matroskaPrefix().subarray(0, n), 1000)).toBeUndefined();
  });
  it("rejects superficial, invalid, image/audio and unapproved BMFF brands", () => {
    const invalid: Uint8Array[] = [Buffer.from("ftypmp42"), new Uint8Array(64)];
    for (const size of [0, 1, 8, 15, 17, 64, 0xffffffff]) {
      const b = mp4(); b.writeUInt32BE(size); invalid.push(b);
    }
    for (const brand of ["avif", "heic", "M4A ", "M4V ", "zzzz"]) {
      const b = mp4(); b.write(brand, 8); invalid.push(b);
      const c = mp4(); c.write(brand, 20); invalid.push(c);
    }
    const onlyIsom = mp4(); onlyIsom.write("isom", 20); invalid.push(onlyIsom);
    const wrongBox = mp4(); wrongBox.write("free", 28); invalid.push(wrongBox);
    const tooLarge = mp4(); tooLarge.writeUInt32BE(0xffffffff, 24); invalid.push(tooLarge);
    const shortBox = mp4(); shortBox.writeUInt32BE(1, 24); invalid.push(shortBox);
    for (const b of invalid) expect(directMediaSignature(b, 1_000_000)).toBeUndefined();
  });
  it("rejects malformed EBML, duplicate fields, unsupported versions and WebM", () => {
    const invalid = [change(matroskaPrefix(), 4, 0), change(matroskaPrefix(), 4, 0xff), change(matroskaPrefix(), 4, 0xfe),
      change(matroskaPrefix(), 7, 0), change(matroskaPrefix(), 7, 0xff), change(matroskaPrefix(), 8, 2),
      change(matroskaPrefix(), 10, 0x86), change(matroskaPrefix(), 16, 3), change(matroskaPrefix(), 20, 0),
      change(matroskaPrefix(), 23, 0xff), change(matroskaPrefix(), 24, 0x77), change(matroskaPrefix(), 35, 5),
      change(matroskaPrefix(), 39, 5), change(matroskaPrefix(), 40, 0), change(matroskaPrefix(), 44, 0),
      change(matroskaPrefix(), 44, 0x80)];
    const webm = Buffer.from(matroskaPrefix()); webm.write("webm", 24); invalid.push(webm);
    for (const b of invalid) expect(directMediaSignature(b, 1_000_000)).toBeUndefined();
    expect(directMediaSignature(matroskaPrefix(), 64)).toBeUndefined(); // Segment exceeds total.
  });
});

describe("signature admission stays narrower than historical transport verification", () => {
  it("does not accept provider-supplied signature metadata or override dangerous names and URL policy", async () => {
    const forged = { status: "verified", verified: true, rangeSupported: true, responseStatus: 206,
      contentType: "application/octet-stream", sizeEvidence: "initial_range_206", containerSignature: "matroska" };
    const run = await directMediaFixture({ prefix: new Uint8Array(64), mime: "application/octet-stream", source: { directHttp: forged } }, "off");
    expect(run.result).toHaveLength(0);
    for (const source of [{ filename: "dangerous.exe" }, { url: "http://127.0.0.1/opaque", type: "http" }]) {
      const denied = await directMediaFixture({ prefix: matroskaPrefix(), mime: "application/octet-stream", source }, "anonymous");
      expect(denied.result).toHaveLength(0); expect(denied.requests).toHaveLength(0);
    }
    const identity = await directMediaFixture({ prefix: matroskaPrefix(), mime: "application/octet-stream",
      source: { metadata: { identity: { kind: "episode", season: 1, episode: 1 } } } }, "anonymous");
    expect(identity.result).toHaveLength(0); expect(identity.requests).toHaveLength(0);
    const hls = await directMediaFixture({ prefix: matroskaPrefix(), mime: "application/octet-stream", path: "opaque.m3u8" }, "anonymous");
    expect(hls.result).toHaveLength(0); expect(JSON.stringify(hls.c.report())).not.toContain("DIRECT_MEDIA_SIGNATURE");
  });
  it("requires exact observed length, identity encoding, initial Range and octet-stream", async () => {
    const prefix = matroskaPrefix();
    const cases = [
      { status: 200 }, { mime: undefined }, { mime: "malformed" }, { mime: "text/plain" }, { mime: "application/mp4" },
      { mime: "audio/mp4" }, { mime: "application/x-other" },
      { range: "bytes 1-64/1000000" }, { range: "bytes 0-64/1000000" }, { range: "bytes 0-63/*" },
      { range: "bytes 0-63/63" }, { range: "nonsense" },
      { headers: { "Content-Length": "63" } }, { headers: { "Content-Length": "invalid" } },
      { headers: { "Content-Encoding": "gzip" } }, { headers: { "Content-Encoding": "br" } },
      { prefix: prefix.subarray(0, 63), range: "bytes 0-63/1000000" },
      { prefix: Buffer.concat([prefix, Buffer.from([1])]), range: "bytes 0-63/1000000" },
      { status: 428 }, { status: 404 }, { status: 503 }, { error: true }, { budget: true }, { cancel: true }
    ];
    for (const c of cases) {
      const run = await directMediaFixture({ prefix, mime: "application/octet-stream", ...c }, "anonymous");
      expect(run.result, JSON.stringify(c)).toHaveLength(0);
      expect(JSON.stringify(run.c.report())).not.toContain("DIRECT_MEDIA_SIGNATURE");
    }
    const good = await directMediaFixture({ prefix, mime: "APPLICATION/OCTET-STREAM; ignored=secret",
      headers: { "Content-Length": "64", "Content-Encoding": " identity " } }, "off");
    expect(good.result).toHaveLength(1);
  });
  it("retains ZIP/document/WebM exclusions with a generic MIME", async () => {
    for (const prefix of [Buffer.from("504b0304", "hex"), Buffer.from("<!DOCTYPE html>ftypmp41"),
      Buffer.from("<?xml version='1.0'?>"), Buffer.from('{"ftyp":"mp41"}'), Buffer.from('[{"x":1}]'),
      change(matroskaPrefix(), 24, 0x77), new Uint8Array(64)]) {
      expect((await directMediaFixture({ prefix, mime: "application/octet-stream" }, "off")).result).toHaveLength(0);
    }
  });
});
