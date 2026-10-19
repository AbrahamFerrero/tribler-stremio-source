import { extractInfohash } from "../source";
import { sourceRequestHeadersKey } from "../network/http-privacy";
import type { NormalizedStreamSource } from "./types";

/** The exact identity used by StreamResolver for per-provider and cross-provider deduplication. */
export function streamDeduplicationKey(source: NormalizedStreamSource): string | undefined {
  const hash = source.infoHash ?? (source.magnet ? extractInfohash(source.magnet) : undefined);
  return hash
    ? `bt:${hash}:${source.fileIndex ?? ""}:${source.filename?.toLowerCase() ?? ""}`
    : source.url
      ? `${source.type === "torrent" ? "bturl" : "url"}:${new URL(source.url).toString()}:${
        source.type === "torrent" ? `${source.fileIndex ?? ""}:${source.filename?.toLowerCase() ?? ""}` : sourceRequestHeadersKey(source.requestHeaders)
      }`
      : undefined;
}
