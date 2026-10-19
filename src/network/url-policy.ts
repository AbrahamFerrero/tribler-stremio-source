import { BlockList, isIP, type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { SystemDnsResolver, type DnsResolver } from "./dns";
import { sanitizedPathname } from "./http-privacy";

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type { DnsResolver, ResolvedAddress } from "./dns";
const MAX_OUTBOUND_CONNECTIONS = 64;
let activeOutboundConnections = 0;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["fec0::", 10], ["2001:db8::", 32]
] as const) blocked.addSubnet(network, prefix, "ipv6");

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1];
  if (mapped) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return blocked.check(mapped, "ipv4");
    const parts = mapped.split(":");
    if (parts.length === 2) {
      const high = Number.parseInt(parts[0] ?? "", 16);
      const low = Number.parseInt(parts[1] ?? "", 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        const ipv4 = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
        return blocked.check(ipv4, "ipv4");
      }
    }
    return true;
  }
  return blocked.check(address, "ipv6");
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const mapped = /^::ffff:(.+)$/i.exec(normalized)?.[1];
  if (mapped) return mapped.startsWith("127.");
  return normalized.startsWith("127.") && isIP(normalized) === 4;
}

export interface ExternalUrlPolicyOptions {
  resolver?: DnsResolver | DnsLookup;
  blockedEndpoints?: Array<{ hostname: string; port: string }>;
  allowedLoopbackUrls?: string[];
}

/** A URL is disallowed by the bridge policy, independent of transport availability. */
export class ExternalUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalUrlPolicyError";
  }
}

export class ExternalUrlPolicy {
  private readonly resolver: DnsResolver;
  private readonly blockedEndpoints: Set<string>;
  private readonly allowedLoopbackUrls: Set<string>;

  constructor(options: ExternalUrlPolicyOptions = {}) {
    const configuredResolver = options.resolver ?? new SystemDnsResolver();
    this.resolver = typeof configuredResolver === "function"
      ? { resolve: async (hostname) => (await configuredResolver(hostname)).flatMap(({ address, family }) =>
        family === 4 || family === 6 ? [{ address, family }] : []
      ) }
      : configuredResolver;
    this.blockedEndpoints = new Set((options.blockedEndpoints ?? []).map(({ hostname, port }) =>
      `${hostname.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`
    ));
    this.allowedLoopbackUrls = new Set((options.allowedLoopbackUrls ?? []).map((raw) => new URL(raw).href));
  }

  async resolveValidated(raw: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ExternalUrlPolicyError("External URL is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ExternalUrlPolicyError("External URL scheme is not allowed");
    if (url.username || url.password) throw new ExternalUrlPolicyError("External URL credentials are not allowed");
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (this.blockedEndpoints.has(`${hostname}:${port}`)) {
      throw new ExternalUrlPolicyError("External URL targets an internal service");
    }
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await this.resolver.resolve(hostname);
    const explicitlyAllowedLoopback = this.allowedLoopbackUrls.has(url.href) &&
      addresses.length > 0 && addresses.every(({ address }) => isLoopbackAddress(address));
    if (!explicitlyAllowedLoopback && (
      hostname === "localhost" || hostname.endsWith(".localhost") ||
      addresses.some(({ address }) => isBlockedAddress(address))
    )) {
      throw new ExternalUrlPolicyError("External URL resolves to a private or reserved address");
    }
    // An empty DNS answer may be temporary; it does not establish a policy violation.
    if (addresses.length === 0) throw new Error("External URL resolves to a private or reserved address");
    const selected = addresses[0];
    if (!selected || (selected.family !== 4 && selected.family !== 6)) throw new Error("External URL has no usable address");
    return { url, address: selected.address, family: selected.family };
  }

  async validate(raw: string): Promise<URL> { return (await this.resolveValidated(raw)).url; }
}

export function sanitizedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${sanitizedPathname(url)}`;
  } catch {
    return "[invalid-url]";
  }
}

export async function fetchWithValidatedRedirects(
  raw: string,
  policy: ExternalUrlPolicy | undefined,
  init: RequestInit,
  fetchImplementation?: typeof fetch,
  maxRedirects = 3,
  redirectAuthority: "any-origin" | "same-origin" = "any-origin"
): Promise<Response> {
  // Authority is anchored to the configured recipient, independently of DNS safety.
  // No-policy library callers retain native transport, but use the same redirect gate.
  const authorizedOrigin = new URL(raw).origin;
  let current = raw;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const validated = policy ? await policy.resolveValidated(current) : undefined;
    const response = validated && !fetchImplementation
      ? await requestPinned(validated, init)
      : await (fetchImplementation ?? fetch)(validated?.url ?? current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects === maxRedirects) throw new Error("External URL exceeded redirect limit");
    const location = response.headers.get("location");
    if (!location) throw new Error("External redirect has no Location header");
    let next: URL;
    try { next = new URL(location, validated?.url ?? current); }
    catch { throw new Error("External redirect URL is invalid"); }
    if (next.username || next.password) throw new Error("External redirect URL credentials are not allowed");
    if (redirectAuthority === "same-origin" && next.origin !== authorizedOrigin) {
      throw new Error("External redirect recipient is not authorized");
    }
    current = next.toString();
  }
  throw new Error("External URL redirect validation failed");
}

export async function requestPinned(
  target: { url: URL; address: string; family: 4 | 6 },
  init: RequestInit
): Promise<Response> {
  if (activeOutboundConnections >= MAX_OUTBOUND_CONNECTIONS) {
    throw new Error("Too many simultaneous outbound HTTP connections");
  }
  activeOutboundConnections += 1;
  return await new Promise<Response>((resolve, reject) => {
    let request: http.ClientRequest | undefined;
    let upstream: http.IncomingMessage | undefined;
    let released = false;
    const abort = (): void => {
      request?.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error("Request aborted"));
    };
    const release = (): void => {
      if (released) return;
      released = true;
      init.signal?.removeEventListener("abort", abort);
      activeOutboundConnections -= 1;
    };
    const fail = (error: unknown): void => {
      upstream?.destroy();
      request?.destroy();
      release();
      reject(error instanceof Error ? error : new Error("Outbound HTTP request failed"));
    };
    try {
      init.signal?.throwIfAborted();
      const transport = target.url.protocol === "https:" ? https : http;
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      };
      request = transport.request(target.url, {
        method: init.method ?? "GET",
        headers,
        lookup: pinnedLookup
      }, (incoming) => {
        upstream = incoming;
        upstream.once("close", release);
        upstream.once("error", fail);
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < upstream.rawHeaders.length; index += 2) {
            const name = upstream.rawHeaders[index];
            const value = upstream.rawHeaders[index + 1];
            if (name && value) responseHeaders.append(name, value);
          }
          const method = (init.method ?? "GET").toUpperCase();
          const status = upstream.statusCode ?? 502;
          const bodyless = method === "HEAD" || status === 204 || status === 205 || status === 304;
          const body = bodyless ? null : Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
          const response = new Response(body, {
            status,
            ...(upstream.statusMessage ? { statusText: upstream.statusMessage } : {}),
            headers: responseHeaders
          });
          // No consumer will read a null body, so close its upstream explicitly.
          if (bodyless) upstream.destroy();
          resolve(response);
        } catch (error) { fail(error); }
      });
      init.signal?.addEventListener("abort", abort, { once: true });
      request.once("error", fail);
      if (init.signal?.aborted) { abort(); return; }
      if (typeof init.body === "string" || init.body instanceof Uint8Array) request.write(init.body);
      else if (init.body !== undefined && init.body !== null) {
        request.destroy(new Error("Unsupported outbound request body"));
        return;
      }
      request.end();
    } catch (error) { fail(error); }
  });
}
