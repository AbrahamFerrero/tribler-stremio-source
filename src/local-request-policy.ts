import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

const desktopOrigin = "https://web.stremio.com";
const contextHeaders = ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];
const tokenPattern = /^[a-fA-F0-9]{64}$/;

export function validateAdminToken(token: string | undefined): void {
  if (token !== undefined && !tokenPattern.test(token)) throw new Error("BRIDGE_ADMIN_TOKEN must contain 64 hexadecimal characters");
}

export function authorityStatus(value: string, port: number, ipv6 = false): number {
  const match = /^(\[[^\]]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match || (match[2] !== undefined && (!/^[1-9][0-9]{0,4}$/.test(match[2]) || Number(match[2]) > 65535))) return 400;
  const host = match[1]!.toLowerCase();
  if (!["127.0.0.1", "localhost", ...(ipv6 ? ["[::1]"] : [])].includes(host)) return 403;
  return (match[2] === undefined ? port === 80 : Number(match[2]) === port) ? 200 : 403;
}

function values(req: Request, name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) result.push(req.rawHeaders[i + 1]!);
  }
  return result;
}

function deny(res: Response, status = 403): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: "Request denied" });
}

function native(req: Request): boolean {
  return contextHeaders.every((header) => values(req, header).length === 0);
}

function unambiguousContext(req: Request): boolean {
  if ([...contextHeaders, "authorization", "access-control-request-method", "access-control-request-headers"].some((header) => values(req, header).length > 1)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    try { if (new URL(origin).origin !== origin) return false; }
    catch { return false; }
  }
  for (const header of contextHeaders.filter((name) => name.startsWith("sec-fetch-"))) {
    const value = req.headers[header];
    if (value !== undefined && (typeof value !== "string" || !/^(?:[a-z-]+|\?1)$/.test(value))) return false;
  }
  if (req.headers.referer !== undefined) {
    try { if (!/^https?:$/.test(new URL(String(req.headers.referer)).protocol)) return false; }
    catch { return false; }
  }
  return true;
}

function allowedContext(req: Request, playback: boolean): boolean {
  if (playback && native(req)) return true;
  if (req.headers.origin !== desktopOrigin) return false;
  const site = req.headers["sec-fetch-site"];
  const mode = req.headers["sec-fetch-mode"];
  const dest = req.headers["sec-fetch-dest"];
  const user = req.headers["sec-fetch-user"];
  const metadata = [site, mode, dest, user];
  if (metadata.some((value) => value !== undefined)) {
    if (!["cross-site", "same-site", "same-origin", "none"].includes(String(site)) ||
        !["cors", "no-cors", "same-origin"].includes(String(mode)) ||
        !["empty", "audio", "video"].includes(String(dest)) || user !== undefined) return false;
  }
  if (req.headers.referer !== undefined) {
    try { if (new URL(String(req.headers.referer)).origin !== desktopOrigin) return false; }
    catch { return false; }
  }
  return true;
}

/** First inbound middleware. Capabilities remain enforced by PlaybackManager. */
export function localRequestPolicy(adminToken?: string): RequestHandler {
  validateAdminToken(adminToken);
  return (req, res, next) => {
    const hosts = values(req, "host");
    const status = hosts.length === 1
      ? authorityStatus(hosts[0]!, req.socket.localPort ?? 0, req.socket.localAddress === "::1") : 400;
    if (status !== 200) { deny(res, status); return; }
    if (req.method === "OPTIONS" && req.url === "*") { res.status(204).end(); return; }
    if (!req.url.startsWith("/") || req.url.startsWith("//") || req.method === "CONNECT") { deny(res, 400); return; }
    // Express matches paths case-insensitively. Reject ambiguous encoding before routing.
    const path = req.path;
    if (/%(?:2f|5c|00)|\\/i.test(path)) { deny(res, 400); return; }
    if (!unambiguousContext(req)) { deny(res); return; }
    const admin = /^\/(health|providers|resolve|downloads)(?:\/|$)/i.test(path);
    const manifest = /^\/manifest\.json\/?$/i.test(path);
    const discovery = /^\/(catalog|meta|stream)\//.test(path);
    const playback = /^\/(auto|play)(?:\/|$)/i.test(path);
    const capability = /^\/(source|hls)(?:\/|$)/i.test(path);
    if (admin) {
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "OPTIONS" || !native(req) || !adminToken) { deny(res); return; }
      const supplied = /^Bearer ([a-fA-F0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      if (!supplied || !timingSafeEqual(Buffer.from(supplied), Buffer.from(adminToken))) {
        res.setHeader("WWW-Authenticate", "Bearer");
        deny(res, 401); return;
      }
      next(); return;
    }
    if (!manifest && !discovery && !playback && !capability) { deny(res, 404); return; }
    res.vary("Origin");
    res.vary("Sec-Fetch-Site"); res.vary("Sec-Fetch-Mode"); res.vary("Sec-Fetch-Dest");
    res.vary("Sec-Fetch-User"); res.vary("Referer");
    if ((discovery || playback) && !allowedContext(req, playback)) { deny(res); return; }
    const origin = manifest || capability ? "*" : req.headers.origin;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (playback || capability) {
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified");
    }
    // SDK cors() and cache headers cannot broaden the decision made above.
    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: string | number | readonly string[]) => {
      if (name.toLowerCase().startsWith("access-control-")) return res;
      if (/^\/stream\//.test(path) && name.toLowerCase() === "cache-control") return setHeader(name, "no-store");
      return setHeader(name, value);
    }) as Response["setHeader"];
    if (/^\/stream\//.test(path)) setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      const method = req.headers["access-control-request-method"];
      const headers = String(req.headers["access-control-request-headers"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if ((method !== undefined && method !== "GET" && method !== "HEAD") || headers.some((h) => !["range", "if-range", "content-type"].includes(h))) {
        res.removeHeader("Access-Control-Allow-Origin"); deny(res); return;
      }
      setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      setHeader("Access-Control-Allow-Headers", "Range, If-Range, Content-Type");
      res.status(204).end(); return;
    }
    next();
  };
}
