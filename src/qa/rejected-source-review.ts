import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { proxyDirectHttp } from "../automatic-stream";
import type { OutboundTransport } from "../network/outbound-transport";
import { DirectHttpPlaybackBackend } from "../playback/backends";
import { PlaybackManager } from "../playback/manager";
import { getBridgeIdentityState, type StreamCandidateRef, type StreamRejection, type StreamResolverTrace } from "../streams/resolver";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../streams/types";

export const CONTENT_TRUTHS = ["CORRECT_CONTENT", "WRONG_CONTENT", "INCONCLUSIVE"] as const;
export const RULE_VERDICTS = ["RULE_SUPPORTED", "RULE_FALSIFIED", "IMPLEMENTATION_BUG", "HARNESS_GAP", "UPSTREAM_UNKNOWN"] as const;
export interface ReviewSummary {
  candidate: string;
  providerFamily: "external_http" | "catalog" | "stremio_addon" | "local_json" | "other";
  stage: "admitted";
  reason: "MEASURED_RUNTIME_CONTRADICTION";
  identityState: "CONTRADICTION";
  transport: "http" | "https";
  probe: "VERIFIED";
  runtimeDifferenceSeconds?: number;
}

/** Explicit QA process only. One resolution, at most 16 rejects and one selected playback session. */
export class RejectedSourceReview {
  private references = new WeakMap<StreamCandidateRef, NormalizedStreamSource>();
  private readonly candidates = new Map<string, { source: NormalizedStreamSource; event: StreamRejection; summary: ReviewSummary }>();
  private complete = false;
  private started = false;
  private closed = false;
  private selected: string | undefined;
  private server: Server | undefined;
  private playback: PlaybackManager | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();
  private readonly expiresAt: number;
  private readonly expectedRuntime: number | undefined;
  private record: { candidate: string; contentTruth: typeof CONTENT_TRUTHS[number]; ruleVerdict: typeof RULE_VERDICTS[number] } | undefined;

  constructor(private readonly transport: OutboundTransport, item: NormalizedMediaItem,
    private readonly now: () => number = Date.now, private readonly ttlMs = 5 * 60_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60_000) throw new Error("Invalid review lifetime");
    this.expiresAt = now() + ttlMs;
    this.expectedRuntime = item.runtimeSeconds;
    this.timer = setTimeout(() => { void this.close(); }, ttlMs);
    this.timer.unref();
  }

  readonly trace: StreamResolverTrace = {
    stage: (stage, sources, refs) => {
      if (this.closed) return;
      if (this.complete) throw new Error("Review requires a fresh resolution session");
      if (stage === "provider") {
        if (this.started) throw new Error("Review requires a fresh resolution session");
        this.started = true;
      } else if (!this.started) throw new Error("Review resolution has not started");
      if (stage === "probed" && refs) sources.forEach((source, index) => this.references.set(refs[index]!, source));
      if (stage === "final") this.complete = true;
    },
    rejection: event => {
      if (this.closed || this.complete || this.candidates.size >= 16) return;
      const source = this.references.get(event.candidate);
      const probe = source?.directHttp;
      if (!source || !source.url || (source.type !== "http" && source.type !== "https")
        || event.stage !== "admitted" || event.reason !== "MEASURED_RUNTIME_CONTRADICTION" || event.identityState !== "CONTRADICTION"
        || getBridgeIdentityState(source) !== "CONTRADICTION" || !probe?.verified || probe.runtimeEvidence !== "mp4_mvhd"
        || probe.contentType !== "video/mp4" || probe.hls || probe.archiveFormat || probe.documentFormat
        || ![200, 206].includes(probe.responseStatus ?? 0)) return;
      if ([...this.candidates.values()].some(candidate => candidate.event.candidate === event.candidate)) return;
      const candidate = randomBytes(12).toString("hex");
      const providerFamily = source.providerId === "external_http" ? "external_http"
        : source.providerId.startsWith("catalog_") ? "catalog"
        : source.providerId.startsWith("stremio-addon-") ? "stremio_addon"
        : source.providerId === "local_json" ? "local_json" : "other";
      const expected = this.expectedRuntime;
      const measured = probe.actualRuntimeSeconds;
      const summary: ReviewSummary = { candidate, providerFamily, stage: event.stage, reason: event.reason,
        identityState: event.identityState, transport: source.type, probe: "VERIFIED",
        ...(expected !== undefined && measured !== undefined
          ? { runtimeDifferenceSeconds: Math.round(Math.abs(expected - measured)) } : {}) };
      this.candidates.set(candidate, { source, event, summary });
    }
  };

  summaries(): ReviewSummary[] {
    return this.complete && !this.closed && this.now() < this.expiresAt
      ? [...this.candidates.values()].map(candidate => ({ ...candidate.summary })) : [];
  }

  get signal(): AbortSignal { return this.abort.signal; }

  idFor(reference: StreamCandidateRef): string | undefined {
    return this.summaries().find(summary => this.candidates.get(summary.candidate)?.event.candidate === reference)?.candidate;
  }

  async select(candidate: string): Promise<string> {
    const entry = this.candidates.get(candidate);
    if (!entry || !this.complete || this.closed || this.selected || this.now() >= this.expiresAt) {
      throw new Error("Review selection unavailable");
    }
    this.selected = candidate; // Reserve before awaiting; simultaneous selection cannot allocate another session.
    // Delegate every socket/URL/DNS/redirect/header operation to the protected transport.
    // MP4 only in this tranche; never send an unrewritten playlist or upstream response metadata.
    const mediaTransport: OutboundTransport = {
      id: this.transport.id, diagnostics: () => this.transport.diagnostics(),
      request: async (input, signal) => {
        const result = await this.transport.request(input, signal);
        if (result.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "video/mp4") {
          await result.response.body?.cancel();
          throw new Error("Review media unavailable");
        }
        const headers = new Headers({ "Content-Type": "video/mp4" });
        for (const name of ["content-length", "content-range", "accept-ranges"]) {
          const value = result.response.headers.get(name);
          if (value && /^(?:\d+|bytes|bytes \d+-\d+\/\d+|bytes \*\/\d+)$/.test(value)) headers.set(name, value);
        }
        return { effectiveUrl: result.effectiveUrl, response: new Response(result.response.body, { status: result.response.status, headers }) };
      }
    };
    const playback = new PlaybackManager([new DirectHttpPlaybackBackend(mediaTransport)], this.ttlMs, 1, this.now);
    this.playback = playback;
    const token = playback.register(entry.source);
    const app = express();
    app.disable("x-powered-by");
    let active = 0;
    app.use((req, res, next) => {
      if (this.closed || this.now() >= this.expiresAt) { res.status(410).end(); return; }
      const port = this.server?.address();
      if (!port || typeof port === "string" || req.headers.host !== `127.0.0.1:${port.port}` || req.headers.origin) {
        res.status(403).end(); return;
      }
      if (active >= 2) { res.status(429).end(); return; }
      active += 1;
      res.once("close", () => { active -= 1; });
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    const serve = (method: "GET" | "HEAD") => async (req: express.Request, res: express.Response): Promise<void> => {
      const client = new AbortController();
      req.once("aborted", () => client.abort());
      res.once("close", () => client.abort());
      const signal = AbortSignal.any([client.signal, this.abort.signal]);
      try {
        const prepared = await playback.prepare(String(req.params.token), signal);
        if (!prepared.source?.url || !prepared.transport) throw new Error("Review unavailable");
        await proxyDirectHttp({ url: prepared.source.url, fileName: "review.mp4", size: prepared.source.sizeBytes ?? 0,
          ...(prepared.source.requestHeaders ? { requestHeaders: prepared.source.requestHeaders } : {}) },
        req, res, 15_000, signal, method, prepared.transport);
      } catch {
        if (!res.headersSent) res.status(404).json({ error: "Review unavailable" });
        else res.destroy();
      }
    };
    app.head("/review/:token", serve("HEAD"));
    app.get("/review/:token", serve("GET"));
    app.use((_req, res) => { res.status(404).end(); });
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) res.destroy();
      else res.status(400).json({ error: "Review unavailable" });
    });
    try {
      const server = app.listen(0, "127.0.0.1");
      this.server = server;
      server.maxConnections = 4;
      server.headersTimeout = 15_000;
      server.requestTimeout = 15_000;
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string" || this.closed || this.now() >= this.expiresAt) throw new Error("Review unavailable");
      return `http://127.0.0.1:${address.port}/review/${token}`;
    } catch { await this.close(); throw new Error("Review unavailable"); }
  }

  adjudicate(candidate: string, contentTruth: typeof CONTENT_TRUTHS[number], ruleVerdict: typeof RULE_VERDICTS[number]): void {
    if (this.closed || candidate !== this.selected || !CONTENT_TRUTHS.includes(contentTruth) || !RULE_VERDICTS.includes(ruleVerdict)) {
      throw new Error("Review adjudication unavailable");
    }
    this.record = { candidate, contentTruth, ruleVerdict }; // Explicit human input only; no inferred PASS.
  }

  adjudication(): typeof this.record { return this.record ? { ...this.record } : undefined; }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.references = new WeakMap();
    this.candidates.clear();
    this.record = undefined;
    this.playback = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
