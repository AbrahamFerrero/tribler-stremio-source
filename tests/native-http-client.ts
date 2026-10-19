import { request } from "node:http";

/** Buffered loopback fixture client without fetch's automatically inserted browser metadata. */
export async function nativeHttpFetch(input: string | URL, init: RequestInit = {}, redirects = 0): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Fixture client requires IPv4 loopback HTTP");
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.signal ? { signal: init.signal } : {})
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("error", reject); incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const status = incoming.statusCode ?? 500;
        if (status === 307 && init.redirect !== "manual" && incoming.headers.location) {
          if (redirects >= 10) { reject(new Error("Fixture redirect limit")); return; }
          resolve(nativeHttpFetch(new URL(incoming.headers.location, url), init, redirects + 1)); return;
        }
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        resolve(new Response(init.method === "HEAD" || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    outgoing.on("error", reject);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") { outgoing.destroy(); reject(new Error("Fixture client supports string bodies")); return; }
    outgoing.end(init.body);
  });
}
