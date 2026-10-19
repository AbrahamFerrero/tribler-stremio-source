import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface UpstreamReply {
  responseHeaders?: Readonly<Record<string, string>>;
  /** Faithful conditional-Range fixture behavior; mismatches return the full representation. */
  respectIfRange?: boolean;
  /** Allows streamed partial framing/length adversarial fixtures without a false Content-Length. */
  chunked?: boolean;
  /** Deterministic concurrency barrier; media bytes remain entirely fixture-owned. */
  bodyGate?: Promise<void>;
  /** Test-only observation of the headers actually received by this fixture. */
  observeHeaders?: (headers: IncomingHttpHeaders) => void;
  /** Positive compatibility fixtures refuse bytes unless these exact values arrive. */
  requiredHeaders?: Readonly<Record<string, string>>;
  /** Controlled signed-query requirement; value stays in memory, never in hits. */
  requiredQuery?: string;
  status?: number;
  contentType?: string;
  body?: Buffer | string;
  range?: "honor" | "ignore";
  delayMs?: number;
  redirectTo?: string;
  /** Allows a deliberately incomplete response body. */
  declaredLength?: number;
  interruptAfterBytes?: number;
  splitAtBytes?: number;
  splitDelayMs?: number;
}

export interface UpstreamHit {
  method: string;
  path: string;
  range?: string;
}

/** Deterministic HTTP boundary for addon, metadata, direct media and HLS acceptance cases. */
export class DirtyUpstream {
  private readonly replies = new Map<string, UpstreamReply>();
  private readonly additionalAllowedUrls = new Set<string>();
  private readonly server: Server;
  private baseUrl = "";
  readonly hits: UpstreamHit[] = [];
  streams: unknown[] = [];
  streamStatus = 200;
  streamDelayMs = 0;
  meta: unknown = { meta: null };

  constructor() {
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      this.hits.push({ method: request.method ?? "", path,
        ...(typeof request.headers.range === "string" ? { range: request.headers.range } : {}) });
      if (path === "/manifest.json") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "org.fixture.dirty", name: "Dirty upstream",
          description: "Deterministic stream fixture", version: "1.0.0",
          resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }], types: ["movie"] }));
        return;
      }
      if (/^\/stream\/movie\/tt\d+\.json$/.test(path)) {
        response.setHeader("Content-Type", "application/json");
        const send = (): void => {
          if (response.destroyed) return;
          response.statusCode = this.streamStatus;
          response.end(JSON.stringify({ streams: this.streams }));
        };
        if (this.streamDelayMs) {
          const timer = setTimeout(send, this.streamDelayMs);
          response.once("close", () => clearTimeout(timer));
        } else send();
        return;
      }
      if (/^\/meta\/movie\/tt\d+\.json$/.test(path)) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(this.meta));
        return;
      }
      const reply = this.replies.get(path) ?? { status: 404 };
      reply.observeHeaders?.(request.headers);
      const send = (): void => {
        if (response.destroyed) return;
        if (reply.requiredHeaders && Object.entries(reply.requiredHeaders).some(([name, value]) => request.headers[name.toLowerCase()] !== value)) {
          response.writeHead(403); response.end(); return;
        }
        if (reply.requiredQuery !== undefined && new URL(request.url ?? "/", "http://fixture").search !== reply.requiredQuery) {
          response.writeHead(403); response.end(); return;
        }
        if (reply.redirectTo) {
          response.writeHead(reply.status ?? 302, { Location: reply.redirectTo });
          response.end();
          return;
        }
        for (const [name, value] of Object.entries(reply.responseHeaders ?? {})) response.setHeader(name, value);
        const validator = request.headers["if-range"];
        const expected = typeof validator === "string" && validator.startsWith('"')
          ? reply.responseHeaders?.ETag : reply.responseHeaders?.["Last-Modified"];
        const conditionalMatch = !validator || !reply.respectIfRange || validator === expected;
        const bytes = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? "");
        const match = reply.range === "honor" && conditionalMatch ? /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? "")) : null;
        const range = match && (match[1] || match[2]) ? match : null;
        const start = range ? range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2])) : 0;
        const end = range ? Math.min(range[1] && range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1) : bytes.length - 1;
        if (range && (start >= bytes.length || end < start)) {
          response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` });
          response.end();
          return;
        }
        const chunk = range ? bytes.subarray(start, end + 1) : bytes;
        const status = range ? 206 : reply.status ?? 200;
        response.statusCode = status;
        if (reply.contentType) response.setHeader("Content-Type", reply.contentType);
        if (reply.range === "honor") response.setHeader("Accept-Ranges", "bytes");
        if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
        if (reply.chunked) response.setHeader("Transfer-Encoding", "chunked");
        else response.setHeader("Content-Length", String(reply.declaredLength ?? chunk.length));
        if (request.method === "HEAD") { response.end(); return; }
        if (reply.bodyGate) {
          response.flushHeaders();
          void reply.bodyGate.then(() => { if (!response.destroyed) response.end(chunk); }, () => response.destroy());
          return;
        }
        if (reply.interruptAfterBytes !== undefined) {
          response.write(chunk.subarray(0, reply.interruptAfterBytes));
          setImmediate(() => response.destroy());
          return;
        }
        if (reply.splitAtBytes !== undefined) {
          response.write(chunk.subarray(0, reply.splitAtBytes));
          const timer = setTimeout(() => response.end(chunk.subarray(reply.splitAtBytes)), reply.splitDelayMs ?? 10);
          response.once("close", () => clearTimeout(timer));
          return;
        }
        response.end(chunk);
      };
      if (reply.delayMs) {
        const timer = setTimeout(send, reply.delayMs);
        response.once("close", () => clearTimeout(timer));
      } else send();
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  url(path: string): string { return `${this.baseUrl}${path}`; }

  media(path: string, reply: UpstreamReply): string {
    if (!path.startsWith("/media/")) throw new Error("Media fixture paths must stay under /media/");
    this.replies.set(path, reply);
    return this.url(path);
  }

  allowMediaUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.origin !== this.baseUrl || !parsed.pathname.startsWith("/media/")
      || !this.replies.has(parsed.pathname)) throw new Error("Invalid extra media fixture URL");
    this.additionalAllowedUrls.add(parsed.toString());
  }

  allowedMediaUrls(): string[] {
    return [...this.replies.keys()].map((path) => this.url(path)).concat([...this.additionalAllowedUrls]);
  }

  count(path: string): number { return this.hits.filter((hit) => hit.path === path).length; }

  /** Builds a real master/media VOD with configurable segment count and EXT-X-MAP. */
  vod(name: string, segments: number, withMap = true, options: {
    segmentSeconds?: number; playlistType?: "VOD" | "EVENT"; endList?: boolean;
  } = {}): { master: string; media: string; map?: string;
    first: string; last: string } {
    if (!/^[a-z0-9_-]+$/.test(name) || segments < 2 || segments > 5_000) throw new Error("Invalid VOD fixture");
    const segmentSeconds = options.segmentSeconds ?? 4;
    if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0 || segmentSeconds > 3_600) {
      throw new Error("Invalid segment duration fixture");
    }
    const mediaPath = `/media/${name}/media.m3u8`;
    const master = this.media(`/media/${name}/master.m3u8`, { contentType: "application/vnd.apple.mpegurl",
      body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nmedia.m3u8\n` });
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
      ...(options.playlistType ? [`#EXT-X-PLAYLIST-TYPE:${options.playlistType}`] : [])];
    let map: string | undefined;
    if (withMap) {
      map = this.media(`/media/${name}/init.mp4`, { contentType: "video/mp4", body: Buffer.from("init-media") });
      lines.push('#EXT-X-MAP:URI="init.mp4"');
    }
    for (let index = 0; index < segments; index += 1) {
      this.media(`/media/${name}/segment-${index}.m4s`, { contentType: "video/mp4",
        body: Buffer.from(`segment-${index}`), range: "honor" });
      lines.push(`#EXTINF:${segmentSeconds},`, `segment-${index}.m4s`);
    }
    if (options.endList !== false) lines.push("#EXT-X-ENDLIST");
    this.media(mediaPath, { contentType: "application/vnd.apple.mpegurl", body: `${lines.join("\n")}\n` });
    return { master, media: this.url(mediaPath), ...(map ? { map } : {}),
      first: this.url(`/media/${name}/segment-0.m4s`), last: this.url(`/media/${name}/segment-${segments - 1}.m4s`) };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
