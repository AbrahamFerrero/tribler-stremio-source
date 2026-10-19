import { createServer, type Server, type ServerResponse } from "node:http";
import { BIG_BUCK_BUNNY_HTTPS, BIG_BUCK_BUNNY_SIZE_BYTES } from "./big-buck-bunny";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 17_200;

const manifest = {
  id: "org.local.bbb.https-test",
  version: "1.0.0",
  name: "BBB HTTPS Test",
  description: "Controlled standard Stremio addon fixture",
  resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
  types: ["movie"],
  catalogs: []
};

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

export function createTestStremioAddon(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (request.method !== "GET") {
      json(response, 404, { error: "not-found" });
      return;
    }
    if (url.pathname === "/manifest.json") {
      json(response, 200, manifest);
      return;
    }
    if (url.pathname === "/health") {
      json(response, 200, { ok: true, addon: "bbb-https-test" });
      return;
    }
    if (url.pathname === "/stream/movie/tt1254207.json") {
      json(response, 200, {
        streams: [{
          url: BIG_BUCK_BUNNY_HTTPS,
          name: "720p H.264",
          title: "Big Buck Bunny HTTPS",
          behaviorHints: {
            filename: "Big Buck Bunny.mp4",
            videoSize: BIG_BUCK_BUNNY_SIZE_BYTES
          }
        }]
      });
      return;
    }
    if (url.pathname === "/stream/movie/tt7654322.json") {
      json(response, 200, {
        streams: [
          {
            url: "https://1.1.1.1/ac4-duplicate-1080p.mp4",
            name: "1080p H.264",
            title: "AC4 Stremio duplicate 1080p",
            behaviorHints: { filename: "ac4-duplicate-1080p.mp4", videoSize: 5 * 1024 ** 3 }
          },
          {
            url: "https://1.1.1.1/ac4-stremio-720p.mp4",
            name: "720p H.264",
            title: "AC4 Stremio 720p",
            behaviorHints: { filename: "ac4-stremio-720p.mp4", videoSize: 1024 ** 3 }
          }
        ]
      });
      return;
    }
    if (url.pathname === "/stream/movie/tt8765432.json") {
      json(response, 200, {
        streams: [{
          url: "https://1.1.1.1/ac8-healthy-720p.mp4",
          name: "720p H.264",
          title: "AC8 healthy Stremio source",
          behaviorHints: { filename: "ac8-healthy-720p.mp4", videoSize: 1024 ** 3 }
        }]
      });
      return;
    }
    if (url.pathname.startsWith("/stream/")) {
      json(response, 200, { streams: [] });
      return;
    }
    json(response, 404, { error: "not-found" });
  });
}

if (require.main === module) {
  const rawPort = process.env.TEST_STREMIO_ADDON_PORT;
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TEST_STREMIO_ADDON_PORT must be an integer between 1 and 65535");
  }
  const server = createTestStremioAddon();
  server.listen(port, HOST, () => {
    console.log(JSON.stringify({
      level: "info",
      message: "Test Stremio addon listening",
      endpoint: `http://${HOST}:${port}/manifest.json`
    }));
  });
  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
