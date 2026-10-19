import { safeErrorDetails, type Logger } from "../logger";
import { createHash } from "node:crypto";
import { outboundPlaybackHeaders, parseSourceHeaderRules, safeHttpLogTarget, strongEtag, type RepresentationBinding, type HttpPrivacyPolicy, type SourceHeaderScope, type SourceRequestHeaders } from "./http-privacy";
import { ExternalUrlPolicy, requestPinned } from "./url-policy";

/** A redirect chain cannot complete under the configured transport rules. */
export class OutboundRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRedirectError";
  }
}

export interface OutboundRequest {
  url: string;
  method: "GET" | "HEAD";
  headers?: HeadersInit;
  sourceHeaders?: SourceRequestHeaders;
  sourceHeaderScope?: SourceHeaderScope;
  conditionalRange?: boolean;
  forceFullResponse?: boolean;
  rangeBinding?: Readonly<RepresentationBinding>;
  rangeBindingActive?: () => boolean;
}

export interface OutboundResponse {
  response: Response;
  effectiveUrl: string;
  sourceHeaderScope?: SourceHeaderScope;
  representationRequestKey?: string;
  rangeSent?: string;
  conditionalRangeSent?: boolean;
}
export type PinnedRequest = (
  target: { url: URL; address: string; family: 4 | 6 },
  init: RequestInit
) => Promise<Response>;

export interface OutboundTransport {
  readonly id: string;
  request(request: OutboundRequest, signal?: AbortSignal): Promise<OutboundResponse>;
  diagnostics(): {
    transport: string;
    requests: number;
    failures: number;
    averageLatencyMs: number;
  };
}

export class DirectTransport implements OutboundTransport {
  readonly id = "direct";
  private requests = 0;
  private failures = 0;
  private totalLatencyMs = 0;

  constructor(
    private readonly policy: ExternalUrlPolicy,
    private readonly privacy: HttpPrivacyPolicy,
    private readonly log: Logger,
    private readonly pinnedRequest: PinnedRequest = requestPinned
  ) {
    this.privacy = { ...privacy, ...(privacy.sourceHeaderRules
      ? { sourceHeaderRules: parseSourceHeaderRules(privacy.sourceHeaderRules) } : {}) };
  }

  async request(request: OutboundRequest, signal?: AbortSignal): Promise<OutboundResponse> {
    const started = Date.now();
    this.requests += 1;
    let current = request.url;
    try {
      const sourceHeaderScope = { ...(request.sourceHeaderScope ?? {
        origin: new URL(request.url).origin, httpsOnly: false
      }) };
      const conditionalRange = request.conditionalRange || new Headers(request.headers).has("If-Range");
      for (let redirects = 0; redirects <= this.privacy.maxRedirects; redirects += 1) {
        const validated = await this.policy.resolveValidated(current);
        sourceHeaderScope.httpsOnly ||= validated.url.protocol === "https:";
        const headers = outboundPlaybackHeaders(request.headers, this.privacy, request.sourceHeaders,
          sourceHeaderScope, validated.url.href);
        const range = headers.get("Range");
        headers.delete("Range");
        const requestKey = createHash("sha256").update(JSON.stringify([...headers.entries()].sort())).digest("hex");
        const canBind = !(sourceHeaderScope.httpsOnly && validated.url.protocol === "http:");
        const binding = request.rangeBinding;
        const authorized = canBind && request.rangeBindingActive?.() && binding?.effectiveUrl === validated.url.href && binding.requestKey === requestKey
          && strongEtag(binding.upstreamEtag) === binding.upstreamEtag;
        if (range && !request.forceFullResponse && (!conditionalRange || authorized)) {
          headers.set("Range", range);
          if (conditionalRange && authorized) headers.set("If-Range", binding.upstreamEtag);
        }
        const response = await this.pinnedRequest(validated, {
          method: request.method,
          headers,
          redirect: "manual",
          ...(signal ? { signal } : {})
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          const vary = response.headers.get("vary");
          const comparable = !vary || (vary.length <= 1_024 && vary.split(",").every(name =>
            ["accept", "accept-encoding", "user-agent", "referer", "origin", "host"].includes(name.trim().toLowerCase())));
          this.log.info("Outbound HTTP response", {
            method: request.method,
            ...safeHttpLogTarget(current),
            status: response.status,
            latencyMs: Date.now() - started
          });
          return { response, effectiveUrl: validated.url.toString(), sourceHeaderScope,
            ...(canBind && comparable ? { representationRequestKey: requestKey } : {}),
            ...(headers.has("Range") ? { rangeSent: headers.get("Range")! } : {}),
            conditionalRangeSent: headers.has("If-Range") };
        }
        await response.body?.cancel();
        if (redirects === this.privacy.maxRedirects) throw new OutboundRedirectError("Outbound redirect limit exceeded");
        const location = response.headers.get("location");
        if (!location) throw new OutboundRedirectError("Outbound redirect has no Location header");
        try {
          current = new URL(location, validated.url).toString();
        } catch {
          throw new OutboundRedirectError("Outbound redirect URL is invalid");
        }
        // Recompute recipient authorization after validating each hop.
      }
      throw new OutboundRedirectError("Outbound redirect validation failed");
    } catch (error) {
      this.failures += 1;
      this.log.warn("Outbound HTTP request failed", {
        method: request.method,
        ...safeHttpLogTarget(current),
        error: safeErrorDetails(error),
        latencyMs: Date.now() - started
      });
      throw error;
    } finally {
      this.totalLatencyMs += Date.now() - started;
    }
  }

  diagnostics(): { transport: string; requests: number; failures: number; averageLatencyMs: number } {
    return {
      transport: this.id,
      requests: this.requests,
      failures: this.failures,
      averageLatencyMs: this.requests === 0 ? 0 : Math.round(this.totalLatencyMs / this.requests)
    };
  }
}
