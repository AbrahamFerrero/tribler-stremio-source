export type HttpPrivacyMode = "strict";
export type HttpUserAgentMode = "minimal" | "default" | "custom";

export interface HttpPrivacyPolicy {
  mode: HttpPrivacyMode;
  transport: "direct";
  dnsMode: "system";
  /** Default only: an explicit source requirement or local rule can supply Referer. */
  sendReferer: false;
  acceptCookies: false;
  userAgentMode: HttpUserAgentMode;
  customUserAgent?: string;
  maxRedirects: number;
  /** Trusted startup configuration only. Never populated from provider results. */
  sourceHeaderRules?: readonly SourceHeaderRule[];
}

/** Private representation authority supplied only by a live playback token. */
export interface RepresentationBinding {
  effectiveUrl: string;
  requestKey: string;
  upstreamEtag: string;
  opaqueEtag: string;
}

export function strongEtag(value: string | null): string | undefined {
  return value && value.length <= 512 && /^"[\x21\x23-\x7e]*"$/.test(value) ? value : undefined;
}

export interface SourceHeaderRule {
  sourceOrigin: string;
  recipientOrigin: string;
  /** Exact, locally authorized values; omitted names are not authorized. */
  headers: SourceRequestHeaders;
}

/** Bridge-owned context which follows HLS resources without rebasing trust. */
export interface SourceHeaderScope { origin: string; httpsOnly: boolean }

export const MINIMAL_HTTP_USER_AGENT = "Mozilla/5.0";

export type SourceRequestHeaders = Partial<Record<"Referer" | "Origin" | "User-Agent" | "Accept", string>>;
const sourceHeaderNames = new Map<string, keyof SourceRequestHeaders>([
  ["referer", "Referer"], ["origin", "Origin"], ["user-agent", "User-Agent"], ["accept", "Accept"]
]);

/** Treat addon headers as data. Ignore unknown, duplicate, malformed and oversized entries. */
export function sanitizeSourceRequestHeaders(value: unknown): SourceRequestHeaders | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 32) return undefined;
  const result: SourceRequestHeaders = {};
  const seen = new Set<string>();
  let total = 0;
  for (const [rawName, rawValue] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(rawName)) continue;
    const name = sourceHeaderNames.get(rawName.toLowerCase());
    if (!name || seen.has(name)) continue;
    if (typeof rawValue !== "string" || !rawValue || rawValue.length > 1_024
      || [...rawValue].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126)) continue;
    total += rawValue.length;
    if (total > 2_048) break;
    seen.add(name);
    result[name] = rawValue;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Identity only: preserve sanitized values and duplicate precedence, then order names. */
export function sourceRequestHeadersKey(value: unknown): string {
  const headers = sanitizeSourceRequestHeaders(value);
  return headers ? JSON.stringify(Object.fromEntries(Object.entries(headers)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))) : "";
}

export function outboundPlaybackHeaders(input: HeadersInit | undefined, policy: HttpPrivacyPolicy,
  sourceHeaders?: SourceRequestHeaders, scope?: SourceHeaderScope, recipientUrl?: string): Headers {
  const supplied = new Headers(input);
  const output = new Headers();
  output.set("Accept", bounded(supplied.get("Accept"), 256) ?? "*/*");
  output.set("Accept-Encoding", "identity");
  const range = bounded(supplied.get("Range"), 256);
  if (range && /^bytes=(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))*$/.test(range)) {
    output.set("Range", range);
    // Client validators carry no authority. DirectTransport may add a privately bound value.
  }
  if (policy.userAgentMode === "minimal") output.set("User-Agent", MINIMAL_HTTP_USER_AGENT);
  if (policy.userAgentMode === "custom" && policy.customUserAgent) {
    output.set("User-Agent", policy.customUserAgent);
  }
  // URL safety does not authorize a recipient. No scope means no source overrides.
  const recipient = recipientUrl ? new URL(recipientUrl) : undefined;
  const rule = scope && recipient && !(scope.httpsOnly && recipient.protocol === "http:")
    ? policy.sourceHeaderRules?.find(candidate => candidate.sourceOrigin === scope.origin
      && candidate.recipientOrigin === recipient.origin) : undefined;
  const source = sanitizeSourceRequestHeaders(sourceHeaders);
  const allowed: SourceRequestHeaders = rule ? rule.headers : {};
  if (!rule && source && scope && recipient && recipient.origin === scope.origin
    && !(scope.httpsOnly && recipient.protocol === "http:")) {
    if (source.Accept) allowed.Accept = source.Accept;
    const referer = source.Referer ? httpUrl(source.Referer) : undefined;
    if (referer) allowed.Referer = `${referer.origin}/`;
    const origin = source.Origin ? serializedOrigin(source.Origin) : undefined;
    if (origin) allowed.Origin = origin;
    // Source UA is deliberately omitted unless its exact value is authorized locally.
  }
  if (allowed) for (const [name, value] of Object.entries(allowed)) output.set(name, value);
  return output;
}

function httpUrl(raw: string): URL | undefined {
  if (!/^https?:\/\//i.test(raw) || raw.trim() !== raw || raw.includes("\\")
    || [...raw].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return undefined;
  try {
    const url = new URL(raw);
    return !url.username && !url.password && ["http:", "https:"].includes(url.protocol) ? url : undefined;
  } catch { return undefined; }
}

function serializedOrigin(raw: string): string | undefined {
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(raw)) return undefined;
  const url = httpUrl(raw);
  return url && url.pathname === "/" && !url.search && !url.hash ? url.origin : undefined;
}

/** Fail closed at startup; copy and freeze trusted exceptions, without reflecting values. */
export function parseSourceHeaderRules(value: unknown): readonly SourceHeaderRule[] {
  const invalid = (): never => { throw new Error("Invalid HTTP_SOURCE_HEADER_RULES"); };
  if (!Array.isArray(value) || value.length > 32) return invalid();
  const seen = new Set<string>();
  return Object.freeze(value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid();
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some(key => !["sourceOrigin", "recipientOrigin", "headers"].includes(key))) return invalid();
    const sourceOrigin = typeof raw.sourceOrigin === "string" ? serializedOrigin(raw.sourceOrigin) : undefined;
    const recipientOrigin = typeof raw.recipientOrigin === "string" ? serializedOrigin(raw.recipientOrigin) : undefined;
    if (!sourceOrigin || !recipientOrigin || (sourceOrigin.startsWith("https:") && recipientOrigin.startsWith("http:"))) return invalid();
    const key = `${sourceOrigin}\n${recipientOrigin}`;
    if (seen.has(key)) return invalid();
    seen.add(key);
    const headers = sanitizeSourceRequestHeaders(raw.headers);
    if (!headers || Object.keys(headers).length !== Object.keys(raw.headers as object).length) return invalid();
    if (headers.Origin) {
      const origin = serializedOrigin(headers.Origin);
      if (!origin) return invalid();
      headers.Origin = origin;
    }
    if (headers.Referer) {
      const url = httpUrl(headers.Referer);
      if (!url || url.hash) return invalid();
    }
    return Object.freeze({ sourceOrigin, recipientOrigin, headers: Object.freeze(headers) });
  }));
}

export function safeHttpLogTarget(raw: string): Record<string, string> {
  try {
    const url = new URL(raw);
    return { protocol: url.protocol.replace(":", ""), hostname: url.hostname, pathname: sanitizedPathname(url) };
  } catch {
    return { protocol: "invalid", hostname: "invalid", pathname: "[invalid-url]" };
  }
}

export function sanitizedPathname(url: URL): string {
  const extension = /\.[a-zA-Z0-9]{1,10}$/.exec(url.pathname)?.[0]?.toLowerCase() ?? "";
  return url.pathname === "/" || url.pathname === "" ? "/" : `/[redacted-path]${extension}`;
}

function bounded(value: string | null, maximum: number): string | undefined {
  if (!value || value.length > maximum || /[\r\n]/.test(value)) return undefined;
  return value;
}
