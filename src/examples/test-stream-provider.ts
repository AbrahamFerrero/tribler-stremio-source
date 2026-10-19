import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BIG_BUCK_BUNNY_HTTPS, BIG_BUCK_BUNNY_SIZE_BYTES } from "./big-buck-bunny";

export { BIG_BUCK_BUNNY_HTTPS, BIG_BUCK_BUNNY_SIZE_BYTES } from "./big-buck-bunny";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7100;
const MAX_REQUEST_BYTES = 32_768;

export const BIG_BUCK_BUNNY_MAGNET = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent";

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("request-too-large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createTestStreamProvider(): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${HOST}`);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, provider: "webtorrent-test" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/resolve") {
        json(response, 404, { error: "not-found" });
        return;
      }
      if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
        json(response, 415, { error: "json-required" });
        return;
      }
      const payload = await requestJson(request);
      const title = typeof payload === "object" && payload !== null
        ? (payload as { title?: unknown }).title
        : undefined;
      if (title !== "Big Buck Bunny - External Provider Test") {
        json(response, 200, { streams: [] });
        return;
      }
      json(response, 200, {
        streams: [
          {
            type: "https",
            url: BIG_BUCK_BUNNY_HTTPS,
            filename: "Big Buck Bunny.mp4",
            title: "WebTorrent HTTPS",
            quality: "720p",
            codec: "H.264",
            sizeBytes: BIG_BUCK_BUNNY_SIZE_BYTES
          },
          {
            type: "magnet",
            magnet: BIG_BUCK_BUNNY_MAGNET,
            filename: "Big Buck Bunny.mp4",
            title: "WebTorrent torrent via Tribler",
            quality: "720p",
            codec: "H.264"
          }
        ]
      });
    })().catch((error: unknown) => {
      const status = error instanceof Error && error.message === "request-too-large" ? 413 : 400;
      json(response, status, { error: status === 413 ? "request-too-large" : "invalid-request" });
    });
  });
}

if (require.main === module) {
  const rawPort = process.env.TEST_STREAM_PROVIDER_PORT;
  const parsedPort = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error("TEST_STREAM_PROVIDER_PORT must be an integer between 1 and 65535");
  }
  const server = createTestStreamProvider();
  server.listen(parsedPort, HOST, () => {
    console.log(JSON.stringify({
      level: "info",
      message: "Test stream provider listening",
      endpoint: `http://${HOST}:${parsedPort}/resolve`
    }));
  });
  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
