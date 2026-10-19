const HEX_V1 = /^[a-fA-F0-9]{40}$/;
const HEX_V2 = /^[a-fA-F0-9]{64}$/;
const BASE32_V1 = /^[A-Z2-7]{32}$/i;

function decodeBase32(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 infohash");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes).toString("hex");
}

export function extractInfohash(source: string): string | undefined {
  const trimmed = source.trim();
  const raw = trimmed.startsWith("btih:") ? trimmed.slice(5) : trimmed;
  if (HEX_V1.test(raw) || HEX_V2.test(raw)) return raw.toLowerCase();
  if (BASE32_V1.test(raw)) return decodeBase32(raw);

  if (trimmed.toLowerCase().startsWith("magnet:?")) {
    const params = new URLSearchParams(trimmed.slice(trimmed.indexOf("?") + 1));
    for (const xt of params.getAll("xt")) {
      const match = /^urn:btih:(.+)$/i.exec(xt);
      if (match?.[1]) return extractInfohash(match[1]);
    }
  }
  return undefined;
}

export function normalizeTorrentSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.toLowerCase().startsWith("magnet:?")) {
    if (!extractInfohash(trimmed)) throw new Error("Magnet URI has no valid urn:btih value");
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.username || url.password || url.hash || !url.pathname.toLowerCase().endsWith(".torrent")) {
      throw new Error("Torrent URL must not contain credentials/fragments and must end in .torrent");
    }
    return url.toString();
  }
  const infohash = extractInfohash(trimmed);
  if (!infohash) throw new Error("Expected a magnet URI, torrent URL, btih:<infohash>, or a 40/64 character hex infohash");
  return `magnet:?xt=urn:btih:${infohash}`;
}

export function parseStreamId(id: string, legalTestMagnet?: string): { source: string; fileIndex?: number } {
  let value = id;
  if (id === "tribler:test") {
    if (!legalTestMagnet) throw new Error("LEGAL_TEST_MAGNET is not configured");
    value = legalTestMagnet;
  }
  const manualMatch = /\|file=(\d+)$/.exec(value);
  const source = manualMatch ? value.slice(0, manualMatch.index) : value;
  return {
    source: normalizeTorrentSource(source),
    ...(manualMatch ? { fileIndex: Number(manualMatch[1]) } : {})
  };
}
