/** A deliberately small ISO BMFF reader. Only complete top-level moov/mvhd boxes count. */
export const MP4_INSPECTION_BYTES = 64 * 1024;
const MAX_BOXES = 256;
const MAX_RUNTIME_SECONDS = 7 * 24 * 3_600;

interface Box { type: string; end: number; data: number }

function box(bytes: Uint8Array, offset: number, limit: number): Box | undefined {
  if (offset < 0 || offset + 8 > limit) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(offset);
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  let header = 8;
  let size = size32;
  if (size32 === 1) {
    if (offset + 16 > limit) return undefined;
    const extended = view.getBigUint64(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(extended);
    header = 16;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (size < header || size > Number.MAX_SAFE_INTEGER - offset || offset + size > limit) return undefined;
  return { type, end: offset + size, data: offset + header };
}

function mvhdDuration(bytes: Uint8Array, entry: Box): number | undefined {
  const version = bytes[entry.data];
  if (version !== 0 && version !== 1) return undefined;
  const timescaleAt = entry.data + (version === 0 ? 12 : 20);
  const durationAt = timescaleAt + 4;
  const durationSize = version === 0 ? 4 : 8;
  if (durationAt + durationSize > entry.end) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescale = view.getUint32(timescaleAt);
  const duration = version === 0 ? BigInt(view.getUint32(durationAt)) : view.getBigUint64(durationAt);
  if (!timescale || !duration || duration === (version === 0 ? 0xffffffffn : 0xffffffffffffffffn)
    || duration > BigInt(timescale) * BigInt(MAX_RUNTIME_SECONDS)) return undefined;
  const seconds = Number(duration) / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function moovDuration(bytes: Uint8Array, entry: Box): number | undefined {
  let found: number | undefined;
  let offset = entry.data;
  for (let count = 0; offset < entry.end && count < MAX_BOXES; count += 1) {
    const child = box(bytes, offset, entry.end);
    if (!child) return undefined;
    if (child.type === "mvhd") {
      if (found !== undefined) return undefined;
      found = mvhdDuration(bytes, child);
      if (found === undefined) return undefined;
    }
    offset = child.end;
  }
  return offset === entry.end ? found : undefined;
}

/** Prefix parsing can skip a declared large mdat and identify one bounded tail read. */
export function mp4RuntimeFromPrefix(bytes: Uint8Array, total: number): { seconds?: number; tailOffset?: number } {
  if (bytes.length < 16 || !Number.isSafeInteger(total) || total < bytes.length) return {};
  const first = box(bytes, 0, bytes.length);
  if (!first || first.type !== "ftyp" || first.end > MP4_INSPECTION_BYTES) return {};
  let offset = first.end;
  for (let count = 0; offset < total && count < MAX_BOXES; count += 1) {
    // The header may straddle the prefix boundary; no speculative scan of mdat bytes.
    if (offset + 8 > bytes.length) return {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size32 = view.getUint32(offset);
    const header = size32 === 1 ? 16 : 8;
    if (offset + header > bytes.length) return {};
    const sizeBig = size32 === 1 ? view.getBigUint64(offset + 8)
      : BigInt(size32 === 0 ? total - offset : size32);
    if (sizeBig < BigInt(header) || sizeBig > BigInt(Number.MAX_SAFE_INTEGER - offset)) return {};
    const end = offset + Number(sizeBig);
    if (end > total) return {};
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "moov") {
      if (end <= bytes.length) {
        const seconds = moovDuration(bytes, { type, end, data: offset + header });
        return seconds === undefined ? {} : { seconds };
      }
      // A large fast-start moov need not be downloaded in full when its first
      // child is a complete mvhd inside the bounded prefix.
      const firstChildOffset = offset + header;
      // A zero-size child extends to the end of moov, so it is not complete
      // merely because its header and duration fields fit in this prefix.
      const firstChild = firstChildOffset + 8 <= bytes.length
        && view.getUint32(firstChildOffset) !== 0
        ? box(bytes, firstChildOffset, bytes.length) : undefined;
      if (firstChild?.type === "mvhd" && firstChild.end <= end) {
        const seconds = mvhdDuration(bytes, firstChild);
        if (seconds !== undefined) return { seconds };
      }
      if (end - offset <= MP4_INSPECTION_BYTES && offset >= total - MP4_INSPECTION_BYTES) return { tailOffset: offset };
      return {};
    }
    if (end > bytes.length && type !== "mdat") return {};
    offset = end;
    if (offset >= bytes.length && offset < total) {
      // A declared mdat end is an exact top-level box boundary even when a
      // following moov is much larger than the bounded inspection window.
      return { tailOffset: offset };
    }
  }
  return {};
}

export function mp4RuntimeFromTail(bytes: Uint8Array, start: number, total: number): number | undefined {
  if (start < 0 || start + bytes.length > total || bytes.length > MP4_INSPECTION_BYTES) return undefined;
  const entry = box(bytes, 0, bytes.length);
  if (entry?.type === "moov" && entry.end === bytes.length && start + entry.end <= total) {
    return moovDuration(bytes, entry);
  }
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== "moov") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(0);
  if (size32 === 0) return undefined;
  const header = size32 === 1 ? 16 : 8;
  const sizeBig = size32 === 1 ? view.getBigUint64(8) : BigInt(size32);
  if (sizeBig <= BigInt(bytes.length) || sizeBig > BigInt(total - start) || sizeBig < BigInt(header)) {
    return undefined;
  }
  // A large moov need not be fetched in full when its first child is a
  // complete mvhd within this exact, independently verified Range response.
  const firstChild = header + 8 <= bytes.length && view.getUint32(header) !== 0
    ? box(bytes, header, bytes.length) : undefined;
  return firstChild?.type === "mvhd" && firstChild.end <= Number(sizeBig)
    ? mvhdDuration(bytes, firstChild) : undefined;
}
