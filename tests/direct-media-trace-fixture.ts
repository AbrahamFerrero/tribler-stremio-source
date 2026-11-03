import { DiagnosticController } from "../src/diagnostics/controller";
import { diagnosticObserverFactory } from "../src/diagnostics/resolver-observer";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { fixtureOutboundRequest, silentLogger } from "./helpers";

export interface MediaScenario { status?: number; mime?: string; path?: string; filename?: string; range?: string; error?: boolean; retry?: boolean; budget?: boolean; cancel?: boolean; warm?: boolean }
export async function directMediaFixture(scenario: MediaScenario, mode: "off" | "anonymous" | "private", Resolver = StreamResolver, Probe = DirectStreamProbe) {
  const c = new DiagnosticController();
  const parent = new AbortController();
  const requests: Array<{ url: string; method: string; range: string | null }> = [];
  let cancellations = 0;
  const request = fixtureOutboundRequest(({ url, headers, method }, signal) => {
    requests.push({ url, method: method ?? "GET", range: new Headers(headers).get("range") });
    if (scenario.budget || scenario.cancel) return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => { cancellations++; reject(signal.reason instanceof Error ? signal.reason : new Error("synthetic-abort")); }, { once: true });
      if (scenario.cancel) queueMicrotask(() => parent.abort(new Error("exception-private-canary")));
    });
    if (scenario.error) return Promise.reject(new Error("exception-private-canary"));
    if (scenario.retry && requests.length === 1) return Promise.resolve(new Response(null, { status: 416 }));
    const responseHeaders = new Headers();
    if (scenario.mime !== undefined) responseHeaders.set("Content-Type", scenario.mime);
    const status = scenario.status ?? 206;
    if (status === 206) responseHeaders.set("Content-Range", scenario.range ?? "bytes 0-15/100");
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16)); controller.close(); }, cancel() { cancellations++; }
    }), { status, headers: responseHeaders }));
  });
  const probe = new Probe({ id: "fixture", request, diagnostics: () => ({ transport: "fixture", requests: requests.length, failures: 0, averageLatencyMs: 0 }) },
    { enabled: true, timeoutMs: scenario.budget ? 20 : 1000, maxCandidates: 2, maxConcurrent: 1 }, silentLogger, () => 1000);
  const registry = new StreamProviderRegistry(1000, silentLogger);
  registry.register({ id: "fixture", name: "Synthetic provider", isEnabled: () => true, resolve: () => Promise.resolve([
    { providerId: "fixture", type: "https" as const, url: "https://media.example/" + (scenario.path ?? "opaque-private-canary") + "?signature=query-private-canary",
      title: "Synthetic.Display.2001.mkv", ...(scenario.filename !== undefined ? { filename: scenario.filename } : {}) }
  ]) });
  const resolver = new Resolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), probe,
    undefined, undefined, 50, diagnosticObserverFactory(c));
  if (scenario.warm) await resolver.resolve({ id: "query-private-canary", title: "Synthetic request", kind: "movie", externalIds: {} });
  if (mode !== "off") c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }, mode === "private");
  let cancelled = false;
  let result: Awaited<ReturnType<typeof resolver.resolve>> = [];
  try { result = await resolver.resolve({ id: "query-private-canary", title: "Synthetic request", kind: "movie", externalIds: {} }, parent.signal); }
  catch (error) { if (!scenario.cancel) throw error; cancelled = parent.signal.aborted; }
  finally { c.stop(); }
  return { c, result, requests, cancellations, cancelled, diagnostics: probe.diagnostics() };
}

export const scenarios: Array<[string, MediaScenario, boolean, string, string]> = [
  ["206 octet verified with display mkv", { mime: "application/octet-stream" }, false, "MIME_NOT_VIDEO", "application/octet-stream"],
  ["206 missing MIME", {}, false, "MIME_ABSENT", "ABSENT"],
  ["206 MP4", { mime: "video/mp4" }, true, "NONE", "video/mp4"],
  ["206 Matroska", { mime: "VIDEO/X-MATROSKA; charset=binary" }, true, "NONE", "video/x-matroska"],
  ["200 MP4", { status: 200, mime: "video/mp4" }, true, "NONE", "video/mp4"],
  ["200 Matroska", { status: 200, mime: "video/x-matroska" }, true, "NONE", "video/x-matroska"],
  ["200 octet", { status: 200, mime: "application/octet-stream" }, false, "MIME_NOT_VIDEO", "application/octet-stream"],
  ["200 no MIME", { status: 200 }, false, "MIME_ABSENT", "ABSENT"],
  ["206 invalid Range", { mime: "video/mp4", range: "bytes 2-17/100" }, false, "RANGE_NOT_VERIFIED", "video/mp4"],
  ["206 malformed Range", { mime: "video/mp4", range: "range-private-canary" }, false, "RANGE_NOT_VERIFIED", "video/mp4"],
  ["503 video", { status: 503, mime: "video/mp4" }, false, "HTTP_RESPONSE_NOT_ACCEPTED", "video/mp4"],
  ["206 text", { mime: "text/plain" }, false, "MIME_NOT_VIDEO", "text/plain"],
  ["206 unknown MIME", { mime: "application/mime-private-canary" }, false, "MIME_NOT_VIDEO", "OTHER"],
  ["206 malformed MIME", { mime: "mime-private-canary" }, false, "MIME_ABSENT", "MALFORMED"],
  ["206 unknown video MIME", { mime: "video/mime-private-canary" }, true, "NONE", "VIDEO_OTHER"],
  ["recognized URL", { path: "path-private-canary.MKV", mime: "application/octet-stream" }, true, "NONE", "application/octet-stream"],
  ["encoded URL", { path: "path-private-canary%2Emp4", mime: "application/octet-stream" }, true, "NONE", "application/octet-stream"],
  ["structured filename", { filename: "filename-private-canary.mkv", mime: "application/octet-stream" }, true, "NONE", "application/octet-stream"],
  ["unrecognized filename and path", { filename: "filename-private-canary.bin", path: "path-private-canary.bin" }, false, "MIME_ABSENT", "ABSENT"],
  ["fallback GET", { retry: true, status: 200, mime: "video/mp4" }, true, "NONE", "video/mp4"],
  ["network exception", { error: true }, false, "MIME_ABSENT", "UNOBSERVED"],
  ["empty URL basename", { path: "", mime: "video/mp4" }, true, "NONE", "video/mp4"],
  ["cached missing MIME", { warm: true }, false, "MIME_ABSENT", "UNOBSERVED"],
  ["cached malformed MIME", { warm: true, mime: "mime-private-canary" }, false, "MIME_ABSENT", "UNOBSERVED"],
  ["cached canonical MIME", { warm: true, mime: "video/mp4" }, true, "NONE", "video/mp4"],
  ["200 text", { status: 200, mime: "text/plain" }, false, "MIME_NOT_VIDEO", "text/plain"],
  ["malicious URL and filename", { path: "%3Cscript%3Epath-private-canary%3C%2Fscript%3E", filename: "filename-private-canary<script>.bin", mime: "application/mime-private-canary" }, false, "MIME_NOT_VIDEO", "OTHER"]
];
