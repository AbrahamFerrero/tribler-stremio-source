function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function extendedBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 4, "ascii");
  header.writeBigUInt64BE(BigInt(payload.length + 16), 8);
  return Buffer.concat([header, payload]);
}

export function mp4Fixture(seconds: number, placement: "prefix" | "tail" = "prefix", version: 0 | 1 = 0): Buffer {
  const ftyp = box("ftyp", Buffer.from("69736f6d0000000069736f6d6d703431", "hex"));
  const mvhd = Buffer.alloc(version === 0 ? 20 : 32);
  mvhd[0] = version;
  const timescaleAt = version === 0 ? 12 : 20;
  mvhd.writeUInt32BE(1_000, timescaleAt);
  if (version === 0) mvhd.writeUInt32BE(seconds * 1_000, timescaleAt + 4);
  else mvhd.writeBigUInt64BE(BigInt(seconds) * 1_000n, timescaleAt + 4);
  const moov = box("moov", box("mvhd", mvhd));
  const mdat = box("mdat", Buffer.alloc(placement === "tail" ? 80 * 1024 : 32));
  return placement === "prefix" ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov]);
}

/** A fast-start MP4 whose moov exceeds the prefix while mvhd is complete near its start. */
export function mp4FixtureWithLargeMoov(seconds: number): Buffer {
  const ordinary = mp4Fixture(seconds);
  const ftyp = ordinary.subarray(0, 24);
  const mvhd = ordinary.subarray(32, 60);
  const moov = box("moov", Buffer.concat([mvhd, box("free", Buffer.alloc(96 * 1024))]));
  return Buffer.concat([ftyp, moov, ordinary.subarray(60)]);
}

/** A large final moov with a complete mvhd at its declared box boundary. */
export function mp4FixtureWithLargeTailMoov(seconds: number, durationKnown = true): Buffer {
  const ordinary = mp4Fixture(seconds);
  const ftyp = ordinary.subarray(0, 24);
  const mvhd = Buffer.from(ordinary.subarray(32, 60));
  if (!durationKnown) mvhd.writeUInt32BE(0, 20);
  const mdat = extendedBox("mdat", Buffer.alloc(80 * 1024));
  const moov = box("moov", Buffer.concat([mvhd, box("free", Buffer.alloc(96 * 1024))]));
  return Buffer.concat([ftyp, mdat, moov]);
}
