import { DiagnosticController } from "../src/diagnostics/controller";
import { diagnosticObserverFactory } from "../src/diagnostics/resolver-observer";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { ExternalUrlPolicy, ExternalUrlPolicyError } from "../src/network/url-policy";
import { fixtureOutboundRequest, silentLogger } from "./helpers";
import type { DirectHttpProbeMetadata } from "../src/streams/types";

export type HlsScenario = "success" | "root-503" | "root-404" | "root-invalid" | "root-empty" | "root-large" | "root-length" | "refs-invalid"
  | "variant-404" | "variant-503" | "variant-timeout" | "variant-route" | "variant-network" | "variant-type"
  | "media-404" | "media-503" | "media-invalid" | "media-read-error" | "map-404" | "key-404"
  | "audio-503" | "audio-segment-404" | "depth-limit" | "no-media" | "no-distinct-media" | "budget" | "cancel";

export async function hlsTraceFixture(scenario: HlsScenario, mode: "off" | "anonymous" | "private", Probe = DirectStreamProbe) {
  const c = new DiagnosticController();
  if (mode !== "off") c.start({ ttlMs: 300000, resolutions: 1, retainReport: true }, mode === "private");
  const parent = new AbortController();
  const requests: Array<{ path: string; range: string | null }> = [];
  const manifest = (text: string, headers: Record<string, string> = {}) => new Response(text, { headers: { "Content-Type": "application/vnd.apple.mpegurl", ...headers } });
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8\n';
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\none.ts\n#EXTINF:4,\ntwo.ts\n#EXT-X-ENDLIST\n';
  const request = fixtureOutboundRequest(({ url, headers }, signal) => {
    const path = new URL(url).pathname; requests.push({ path, range: new Headers(headers).get("range") });
    if (path.endsWith("healthy.mp4")) return Promise.resolve(new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "Content-Type": "video/mp4" } }));
    if (path.endsWith("root.m3u8")) {
      if (scenario === "budget" || scenario === "cancel") return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("synthetic-abort"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        if (scenario === "cancel") queueMicrotask(() => parent.abort(new DOMException("private-error-canary", "AbortError")));
      });
      if (scenario === "root-503" || scenario === "root-404") return Promise.resolve(new Response(null, { status: scenario === "root-503" ? 503 : 404 }));
      if (scenario === "root-invalid") return Promise.resolve(manifest("<html>private-body-canary</html>"));
      if (scenario === "root-empty") return Promise.resolve(new Response(null, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
      if (scenario === "root-large") return Promise.resolve(manifest("#EXTM3U\n" + "#".repeat(600000)));
      if (scenario === "root-length") return Promise.resolve(manifest(master, { "Content-Length": "9999" }));
      if (scenario === "refs-invalid") return Promise.resolve(manifest('#EXTM3U\n#EXTINF:4,\nfile:///private-resource-canary\n'));
      if (scenario === "no-media") return Promise.resolve(manifest('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-ENDLIST\n'));
      if (scenario === "no-distinct-media") return Promise.resolve(manifest(media.replace("two.ts", "one.ts")));
      const audio = scenario.startsWith("audio-") ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="a",DEFAULT=YES,URI="audio.m3u8"\n' : "";
      const selected = audio ? master.replace("BANDWIDTH=100000", 'BANDWIDTH=100000,AUDIO="a"')
        : scenario === "variant-type" ? master.replace("variant.m3u8", "variant-opaque") : master;
      return Promise.resolve(manifest(audio ? selected.replace("#EXTM3U\n", "#EXTM3U\n" + audio) : selected));
    }
    if (path.endsWith("audio.m3u8")) return Promise.resolve(scenario === "audio-503" ? new Response(null, { status: 503 }) : manifest(media.replaceAll(".ts", ".audio.ts")));
    if (path.endsWith("variant.m3u8") || path.endsWith("variant-opaque")) {
      if (scenario === "variant-404" || scenario === "variant-503") return Promise.resolve(new Response(null, { status: scenario === "variant-404" ? 404 : 503 }));
      if (scenario === "variant-timeout") return Promise.reject(new DOMException("private-error-canary", "TimeoutError"));
      if (scenario === "variant-route") return Promise.reject(new ExternalUrlPolicyError("private-error-canary"));
      if (scenario === "variant-network") return Promise.reject(new Error("private-error-canary"));
      if (scenario === "variant-type") return Promise.resolve(new Response("private-body-canary", { headers: { "Content-Type": "text/plain" } }));
      if (scenario === "depth-limit") return Promise.resolve(manifest(master));
      const dependency = scenario === "map-404" ? '#EXT-X-MAP:URI="init.mp4"\n' : scenario === "key-404" ? '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' : "";
      return Promise.resolve(manifest(media.replace("#EXTM3U\n", "#EXTM3U\n" + dependency)));
    }
    if (path.endsWith("init.mp4") || path.endsWith("key.bin")) return Promise.resolve(new Response(null, { status: 404 }));
    if (path.endsWith(".ts")) {
      if (scenario === "media-404" || scenario === "media-503" || scenario === "audio-segment-404" && path.endsWith(".audio.ts")) return Promise.resolve(new Response(null, { status: scenario === "media-503" ? 503 : 404 }));
      if (scenario === "media-read-error") return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-read-canary")); } }), { headers: { "Content-Type": "video/mp2t" } }));
      return Promise.resolve(new Response(scenario === "media-invalid" ? "<html>private-body-canary</html>" : new Uint8Array([1, 2, 3, 4]), { headers: { "Content-Type": "video/mp2t" } }));
    }
    return Promise.reject(new Error("unexpected-synthetic-request"));
  });
  const probe = new Probe({ id: "fixture", request, diagnostics: () => ({ transport: "fixture", requests: requests.length, failures: 0, averageLatencyMs: 0 }) },
    { enabled: true, timeoutMs: scenario === "budget" ? 30 : 1000, maxCandidates: 2, maxConcurrent: 2 }, silentLogger, () => 1000);
  const registry = new StreamProviderRegistry(1000, silentLogger);
  registry.register({ id: "fixture", name: "Synthetic provider", isEnabled: () => true, resolve: () => Promise.resolve([
    { providerId: "fixture", type: "https" as const, url: "https://media.example/root.m3u8?private-locator-canary" },
    { providerId: "fixture", type: "https" as const, url: "https://media.example/healthy.mp4" }
  ]) });
  let observations: Array<DirectHttpProbeMetadata | undefined> = [];
  const resolver = new StreamResolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }), probe,
    { stage: (stage, sources) => { if (stage === "probed") observations = sources.map(s => s.directHttp); } }, undefined, 50, diagnosticObserverFactory(c));
  let cancelled = false;
  let result: Awaited<ReturnType<typeof resolver.resolve>> = [];
  try { result = await resolver.resolve({ id: "private-query-canary", title: "Synthetic request", kind: "movie", externalIds: {} }, parent.signal); }
  catch (error) { if (scenario !== "cancel") throw error; cancelled = parent.signal.aborted; }
  finally { c.stop(); }
  return { c, result, requests, cancelled, probe, observations };
}
