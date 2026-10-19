import type { DownloadService } from "../download-service";
import type { OutboundTransport } from "../network/outbound-transport";
import type { NormalizedStreamSource } from "../streams/types";
import type { PlaybackBackend, PlayableStream } from "./types";

export class DirectHttpPlaybackBackend implements PlaybackBackend {
  readonly id = "direct_http";
  constructor(private readonly transport: OutboundTransport) {}
  canHandle(source: NormalizedStreamSource): boolean { return source.type === "http" || source.type === "https"; }
  prepare(source: NormalizedStreamSource): Promise<PlayableStream> {
    if (!source.url) throw new Error("Direct stream URL is missing");
    return Promise.resolve({ kind: "direct", source, transport: this.transport });
  }
}

export class TriblerPlaybackBackend implements PlaybackBackend {
  readonly id = "tribler";
  constructor(private readonly service: DownloadService) {}
  canHandle(source: NormalizedStreamSource): boolean { return source.type === "magnet" || source.type === "torrent"; }
  async prepare(source: NormalizedStreamSource, signal?: AbortSignal): Promise<PlayableStream> {
    const input = source.type === "magnet" ? source.magnet : source.url;
    if (!input) throw new Error("Torrent source is missing");
    const resolved = await this.service.resolve(
      input,
      source.fileIndex,
      signal,
      source.filename ? { name: source.filename, size: source.sizeBytes ?? 0 } : undefined
    );
    return { kind: "redirect", url: resolved.url };
  }
}
