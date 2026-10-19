import { fetchWithValidatedRedirects, type ExternalUrlPolicy } from "../../network/url-policy";
import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider, StreamProviderContext } from "../types";

export interface ExternalHttpProviderOptions {
  id?: string;
  name?: string;
  url: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  maxStreams?: number;
  policy: ExternalUrlPolicy;
  fetchImplementation?: typeof fetch;
  /** Ephemeral local diagnostics; production does not configure this callback. */
  diagnostic?: (event: ExternalHttpDiagnosticEvent) => void;
}

export type ExternalHttpDiagnosticEvent =
  | { type: "request"; requestType: string; requestId: string }
  | { type: "response"; httpStatus: number }
  | { type: "raw-streams"; streams: unknown[] };

function jsonDepth(value: unknown, current = 0): number {
  if (current > 8) return current;
  if (typeof value !== "object" || value === null) return current;
  return Math.max(current, ...Object.values(value).map((entry) => jsonDepth(entry, current + 1)));
}

async function limitedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("External provider returned an unexpected content type");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new Error("External provider response is too large");
  if (!response.body) throw new Error("External provider returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("External provider response is too large");
    }
    chunks.push(chunk.value);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (jsonDepth(payload) > 8) throw new Error("External provider JSON is too deeply nested");
  return payload;
}

export class ExternalHttpStreamProvider implements StreamProvider {
  readonly id: string;
  readonly name: string;
  readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch | undefined;

  constructor(private readonly options: ExternalHttpProviderOptions) {
    this.id = options.id ?? "external_http";
    this.name = options.name ?? "External HTTP provider";
    this.timeoutMs = options.timeoutMs;
    this.fetchImplementation = options.fetchImplementation;
  }

  isEnabled(): boolean { return Boolean(this.options.url); }

  async resolve(item: NormalizedMediaItem, context: StreamProviderContext): Promise<NormalizedStreamSource[]> {
    const request = {
      id: item.id.slice(0, 1_024),
      type: item.kind,
      title: item.title.slice(0, 300),
      ...(item.kind === "episode" && item.seriesTitle !== undefined
        ? { seriesTitle: item.seriesTitle.slice(0, 300) } : {}),
      ...(item.year ? { year: item.year } : {}),
      ...(item.season !== undefined ? { season: item.season } : {}),
      ...(item.episode !== undefined ? { episode: item.episode } : {}),
      ...(item.externalIds ? { externalIds: Object.fromEntries(Object.entries(item.externalIds).slice(0, 20)) } : {})
    };
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 32_768) throw new Error("External provider request is too large");
    this.options.diagnostic?.({ type: "request", requestType: item.kind, requestId: item.id });
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const response = await fetchWithValidatedRedirects(this.options.url, this.options.policy, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity" },
      body,
      signal: AbortSignal.any([context.signal, timeout])
    }, this.fetchImplementation, 3, "same-origin");
    this.options.diagnostic?.({ type: "response", httpStatus: response.status });
    if (!response.ok) throw new Error(`External provider returned HTTP ${response.status}`);
    const payload = await limitedJson(response, this.options.maxResponseBytes ?? 262_144);
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { streams?: unknown }).streams)) {
      throw new Error("External provider response schema is invalid");
    }
    const streams = (payload as { streams: NormalizedStreamSource[] }).streams;
    this.options.diagnostic?.({ type: "raw-streams", streams });
    return streams.slice(0, this.options.maxStreams ?? 100)
      .map((source) => ({ ...source, providerId: this.id }));
  }
}
