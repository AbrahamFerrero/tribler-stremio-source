import { describe, expect, it } from "vitest";
import { RejectedSourceReview } from "../src/qa/rejected-source-review";
import { DirectTransport } from "../src/network/outbound-transport";
import { ExternalUrlPolicy, requestPinned } from "../src/network/url-policy";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { mp4Fixture } from "./mp4-fixture";
import { silentLogger, testConfig } from "./helpers";

const item = { id: "tt9999999999", kind: "movie" as const, title: "Synthetic Meridian", year: 1994,
  runtimeSeconds: 6420, externalIds: { imdb: "tt9999999999" } };

async function fixture(run: (input: { upstream: DirtyUpstream; first: RejectedSourceReview; second: RejectedSourceReview;
  signed: string; advance: () => void }) => Promise<void>): Promise<void> {
  const upstream = new DirtyUpstream();
  await upstream.listen();
  const unsigned = upstream.media("/media/rejected.mp4", { requiredQuery: "?token=FAKE_PRIVATE_REVIEW_QUERY",
    body: mp4Fixture(1200), contentType: "video/mp4", range: "honor" });
  const signed = unsigned + "?token=FAKE_PRIVATE_REVIEW_QUERY";
  upstream.allowMediaUrl(signed);
  const other = upstream.media("/media/other.mp4", { body: mp4Fixture(1800), contentType: "video/mp4", range: "honor" });
  const good = upstream.media("/media/survivor.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
  const policy = new ExternalUrlPolicy({ allowedLoopbackUrls: upstream.allowedMediaUrls() });
  const transport = new DirectTransport(policy, testConfig().httpPrivacy, silentLogger, async (target, init) => {
    const outgoing = new Headers(init.headers);
    expect(outgoing.has("Authorization") || outgoing.has("Cookie")).toBe(false);
    const response = await requestPinned(target, init); // Real controlled sockets; no network substitute.
    const headers = new Headers(response.headers);
    headers.set("ETag", "FAKE_PRIVATE_ETAG");
    headers.set("Content-Disposition", 'attachment; filename="FAKE_PRIVATE_FILENAME"');
    return new Response(response.body, { status: response.status, headers });
  });
  let now = Date.now();
  const first = new RejectedSourceReview(transport, item, () => now, 30_000);
  const second = new RejectedSourceReview(transport, item, () => now, 30_000);
  try {
    for (const review of [first, second]) {
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register({ id: "FAKE_PRIVATE_PROVIDER", name: "Synthetic", isEnabled: () => true,
        resolve: () => Promise.resolve([signed, other, good].map(url => ({ providerId: "FAKE_PRIVATE_PROVIDER", type: "http" as const,
          url, title: "FAKE_PRIVATE_TITLE", requestHeaders: { Accept: "video/mp4", Authorization: "FAKE_PRIVATE_HEADER" } }))) });
      const probe = new DirectStreamProbe(transport, { enabled: true, timeoutMs: 1000, maxCandidates: 8, maxConcurrent: 1 }, silentLogger);
      const result = await new StreamResolver(registry, policy, probe, { ...review.trace, stage: (stage, sources, refs) => {
        review.trace.stage(stage, sources, refs);
        if (stage === "probed") expect(sources.map(source => [source.directHttp?.status, source.directHttp?.actualRuntimeSeconds]))
          .toEqual([["verified", 1200], ["verified", 1800], ["verified", 6420]]);
      } }).resolve(item);
      expect(result.map(source => source.url)).toEqual([good]);
      expect(review.summaries()).toHaveLength(2);
    }
    await run({ upstream, first, second, signed, advance: () => { now += 30_001; } });
  } finally { await first.close(); await second.close(); await upstream.close(); }
}

describe("selected rejected-source QA inspection (integration)", () => {
  it("isolates candidates, sessions, tokens and explicit independent human verdicts", async () => {
    await fixture(async ({ first, second, signed, advance }) => {
      const entries = first.summaries();
      const id = entries[0]!.candidate;
      expect(() => first.trace.stage("provider", [])).toThrow("fresh resolution session");
      expect(JSON.stringify(entries)).not.toContain("FAKE_PRIVATE");
      expect(JSON.stringify(entries)).not.toContain(signed);
      expect(first.adjudication()).toBeUndefined();
      await expect(first.select(signed)).rejects.toThrow();
      await expect(second.select(id)).rejects.toThrow();
      const handle = await first.select(id);
      await expect(first.select(entries[1]!.candidate)).rejects.toThrow();
      const otherHandle = await second.select(second.summaries()[1]!.candidate);
      const body = await fetch(handle, { headers: { Authorization: "FAKE_PRIVATE_CLIENT", Cookie: "FAKE_PRIVATE_CLIENT" } });
      expect(body.headers.get("etag")).toBeNull();
      expect(body.headers.get("content-disposition")).toBeNull();
      expect(Buffer.from(await body.arrayBuffer()).equals(mp4Fixture(1200))).toBe(true);
      const otherBody = await fetch(otherHandle);
      expect(Buffer.from(await otherBody.arrayBuffer()).equals(mp4Fixture(1800))).toBe(true);
      const token = new URL(handle).pathname.split("/").at(-1)!;
      const otherToken = new URL(otherHandle).pathname.split("/").at(-1)!;
      expect((await fetch(otherHandle.replace(otherToken, token))).status).toBe(404);
      expect((await fetch(handle, { headers: { Origin: "https://example.invalid" } })).status).toBe(403);
      first.adjudicate(id, "CORRECT_CONTENT", "RULE_FALSIFIED"); // Explicit inputs, not truth inferred from MP4 bytes.
      expect(first.adjudication()).toEqual({ candidate: id, contentTruth: "CORRECT_CONTENT", ruleVerdict: "RULE_FALSIFIED" });
      expect(second.adjudication()).toBeUndefined();
      advance();
      expect((await fetch(handle)).status).toBe(410);
      expect(first.summaries()).toEqual([]);
      await expect(first.select(id)).rejects.toThrow();
    });
  });

  it("revalidates a changed redirect through the real URL policy rather than replaying a probe permit", async () => {
    await fixture(async ({ upstream, first }) => {
      const handle = await first.select(first.summaries()[0]!.candidate);
      upstream.media("/media/rejected.mp4", { redirectTo: upstream.url("/private-admin?token=FAKE_PRIVATE_REDIRECT") });
      const result = await fetch(handle);
      expect(result.status).toBe(404);
      expect(await result.text()).toBe('{"error":"Review unavailable"}');
      expect(upstream.count("/private-admin")).toBe(0);
    });
  });

  it("refuses changed HTML/HLS media without leaking its body or metadata", async () => {
    await fixture(async ({ upstream, first }) => {
      const handle = await first.select(first.summaries()[0]!.candidate);
      for (const contentType of ["text/html", "application/vnd.apple.mpegurl"]) {
        upstream.media("/media/rejected.mp4", { contentType, body: "FAKE_PRIVATE_MEDIA_BODY" });
        const result = await fetch(handle);
        expect(result.status).toBe(404);
        expect(await result.text()).toBe('{"error":"Review unavailable"}');
      }
    });
  });
});
