import { sanitizedUrl } from "./network/url-policy";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// These are diagnostic labels, never arbitrary Error.name values from an upstream dependency.
// PlaybackTokenError is internal to PlaybackManager, so its established public labels
// are deliberately listed even though that class is not exported.
const ERROR_TYPES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "URIError", "ReferenceError",
  "AggregateError", "AbortError", "TimeoutError", "PayloadTooLargeError",
  "TriblerError", "MetadataTimeoutError", "NoSeedsError", "NoVideoFileError",
  "UnsafeFileSelectionError", "ActiveStreamError", "ManagedDownloadNotFoundError",
  "RetentionConflictError", "PlaybackTokenExpiredError", "PlaybackTokenInvalidError",
  "ExternalUrlPolicyError", "OutboundRedirectError"
]);

const ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "EISDIR", "EMFILE", "EADDRINUSE", "ECONNREFUSED",
  "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE", "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_HTTP_HEADERS_SENT"
]);

export function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  try {
    const name = error.name;
    return ERROR_TYPES.has(name) ? name : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

/** Safe structured diagnostics, without error.message/stack/cause or arbitrary fields. */
export function safeErrorDetails(error: unknown): Record<string, string | number> {
  const details: Record<string, string | number> = { type: safeErrorType(error) };
  if (typeof error !== "object" || error === null) return details;
  try {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODES.has(code)) details.code = code;
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      details.status = status;
    }
  } catch {
    // Hostile error properties must not make the logger throw.
  }
  return details;
}

/** Best-effort defense in depth for free text. Exception messages never belong here. */
function redactText(value: string): string {
  if (/^https?:\/\//i.test(value)) return sanitizedUrl(value);
  return value
    .replace(/magnet:\?[^\s"'<>]+/gi, "magnet:[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\b(cookie|set-cookie)\s*[:=][^\r\n]*/gi, "$1=[REDACTED]")
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[^\s,'";]+/gi, "Authorization: [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|proxy-authorization|api.?key|token|password|secret|cookie|set-cookie)\s*[:=]\s*[^\s&,;'"<>]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z]:[\\/][^\s'"<>;,]+/g, "[REDACTED_PATH]")
    .replace(/(^|[\s=(])\/(?:home|Users|tmp|var|mnt|private|workspace)\/[^\s'"<>;,]+/g, "$1[REDACTED_PATH]");
}

function redact(key: string, value: unknown): unknown {
  if (/api.?key|authorization|cookie|token|password|secret/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redact(key, entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(childKey, child)]));
  }
  return value;
}

function emit(level: string, message: string, context?: Record<string, unknown>): void {
  const safeContext = context ? redact("context", context) as Record<string, unknown> : undefined;
  const line = JSON.stringify({ ...safeContext, time: new Date().toISOString(), level, message: redactText(message) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger: Logger = {
  debug: (message, context) => emit("debug", message, context),
  info: (message, context) => emit("info", message, context),
  warn: (message, context) => emit("warn", message, context),
  error: (message, context) => emit("error", message, context)
};
