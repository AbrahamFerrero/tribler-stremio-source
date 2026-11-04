/** Container evidence only, never a claim about tracks, codecs or playability. */
export type DirectMediaSignature = "mp4" | "matroska";
const brands = new Set(["isom", "iso2", "avc1", "mp41", "mp42"]);
const ebmlFields = new Set([0x4286, 0x42f7, 0x42f2, 0x42f3, 0x4282, 0x4287, 0x4285]);
const ascii = (bytes: Uint8Array, start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end));

function mp4(bytes: Uint8Array, total: number): boolean {
  if (bytes.length < 24 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(0);
  // No extended/EOF sizes, scanning, partial ftyp or arbitrary compatible brands.
  if (end < 16 || (end - 16) % 4 !== 0 || end + 8 > bytes.length) return false;
  let explicitMp4 = false;
  for (let at = 8; at < end; at += 4) {
    if (at === 12) continue; // minor_version is numeric, not a brand.
    const brand = ascii(bytes, at, at + 4);
    if (!brands.has(brand)) return false;
    explicitMp4 ||= brand === "mp41" || brand === "mp42";
  }
  const nextSize = view.getUint32(end);
  const nextType = ascii(bytes, end + 4, end + 8);
  return explicitMp4 && nextSize >= 8 && nextSize <= total - end
    && (nextType === "moov" || nextType === "mdat");
}

interface Vint { value: bigint; end: number; width: number; unknown: boolean }
function vint(bytes: Uint8Array, at: number, limit: number, id = false): Vint | undefined {
  const first = bytes[at];
  if (at >= limit || first === undefined || first === 0) return;
  let width = 1, marker = 0x80;
  while (!(first & marker)) { width++; marker >>= 1; }
  if (width > (id ? 4 : 8) || at + width > limit) return;
  let value = BigInt(id ? first : first & (marker - 1));
  for (let i = 1; i < width; i++) value = (value << 8n) | BigInt(bytes[at + i]!);
  return { value, end: at + width, width, unknown: !id && value === (1n << BigInt(7 * width)) - 1n };
}

function matroska(bytes: Uint8Array, total: number): boolean {
  if (bytes.length < 5 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return false;
  const header = vint(bytes, 4, bytes.length);
  if (!header || header.unknown || header.value > BigInt(bytes.length - header.end)) return false;
  const end = header.end + Number(header.value);
  const fields = new Map<number, number>();
  let at = header.end, widestSize = 0;
  // Exactly seven supported fields, once each. No recursion or upstream-sized allocation.
  for (let count = 0; at < end && count < ebmlFields.size; count++) {
    const id = vint(bytes, at, end, true);
    const size = id && vint(bytes, id.end, end);
    if (!id || !size || size.unknown || size.value > BigInt(end - size.end)) return false;
    const key = Number(id.value), length = Number(size.value), next = size.end + length;
    if (!ebmlFields.has(key) || fields.has(key)) return false;
    widestSize = Math.max(widestSize, size.width);
    if (key === 0x4282) {
      if (length !== 8 || ascii(bytes, size.end, next) !== "matroska") return false;
      fields.set(key, 1);
    } else {
      if (length < 1 || length > 8) return false;
      let value = 0n;
      for (let i = size.end; i < next; i++) value = (value << 8n) | BigInt(bytes[i]!);
      if (value > 8n) return false;
      fields.set(key, Number(value));
    }
    at = next;
  }
  const version = fields.get(0x4287) ?? 0, readVersion = fields.get(0x4285) ?? 0;
  const maxSize = fields.get(0x42f3) ?? 0;
  if (at !== end || fields.size !== ebmlFields.size || fields.get(0x4286) !== 1 || fields.get(0x42f7) !== 1
    || fields.get(0x42f2) !== 4 || maxSize < 1 || maxSize > 8 || widestSize > maxSize
    || version < 1 || version > 4 || readVersion < 1 || readVersion > version) return false;
  const segment = vint(bytes, end, bytes.length, true);
  const size = segment && vint(bytes, segment.end, bytes.length);
  return !!segment && segment.value === 0x18538067n && !!size && size.width <= maxSize && size.end < total
    && (size.unknown || size.value > 0n && size.value <= BigInt(total - size.end));
}

/** Only the already inspected initial prefix (at most 64 bytes) may enter here. */
export function directMediaSignature(bytes: Uint8Array, total: number): DirectMediaSignature | undefined {
  if (bytes.length > 64 || !Number.isSafeInteger(total) || total < bytes.length) return;
  if (mp4(bytes, total)) return "mp4";
  if (matroska(bytes, total)) return "matroska";
}
