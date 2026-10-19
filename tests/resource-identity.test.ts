import { describe, expect, it, vi } from "vitest";
import { DirectTransport, type PinnedRequest } from "../src/network/outbound-transport";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { IdentityPrecisionEvaluation, assessIdentity } from "../src/streams/identity-precision-evaluation";
import { identityMismatch, resourceIdentityFromUrl } from "../src/streams/identity-qualification";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { normalizeStreamSource } from "../src/streams/normalization";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { silentLogger, testConfig } from "./helpers";

const movie: NormalizedMediaItem = { id: "tt9999999999", kind: "movie", title: "Synthetic Meridian",
  year: 1987, externalIds: { imdb: "tt9999999999" } };
const episode: NormalizedMediaItem = { id: "tt9999999998:1:1", kind: "episode", title: "",
  seriesTitle: "Synthetic Sleeping Grove", year: 1998, season: 1, episode: 1, externalIds: { imdb: "tt9999999998" } };
const policy = new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });
const sentinel = "SYNTHETIC_RESOURCE_SECRET_17";
function source(name: string): NormalizedStreamSource {
  return { providerId: "synthetic", type: "https", title: "Synthetic Meridian (1987) 1080p",
    url: `https://media.example/${name}?token=${sentinel}` };
}
function setup(values: NormalizedStreamSource[], item: NormalizedMediaItem, pinned?: PinnedRequest, maxCandidates = 8) {
  const registry = new StreamProviderRegistry(500, silentLogger);
  registry.register({ id: "synthetic", name: "Synthetic fixture", isEnabled: () => true,
    resolve: () => Promise.resolve(values) });
  const audit = new IdentityPrecisionEvaluation(["synthetic"]);
  const probe = pinned ? new DirectStreamProbe(new DirectTransport(policy, testConfig().httpPrivacy, silentLogger, pinned),
    { enabled: true, timeoutMs: 1000, maxCandidates, maxConcurrent: 1 }, silentLogger) : undefined;
  return { resolver: new StreamResolver(registry, policy, probe, audit.itemTrace(item)), audit, probe };
}

describe("bounded independent resource evidence", () => {
  it.each(["Ep1", "Ep.1", "Ep-1", "Ep_1", "Episode1", "Episode.1", "Episode-1", "Episode_1", "eP.1"])(
    "recognizes release marker %s without inventing a season", (marker) => {
      const candidate = source(`Synthetic.Grove.1998.${marker}.mp4`);
      expect(resourceIdentityFromUrl(candidate.url!)).toEqual({ kind: "episode", episode: 1, year: 1998 });
      expect(identityMismatch(movie, candidate)).toBe(true);
      expect(identityMismatch(episode, candidate)).toBe(false);
      expect(identityMismatch({ ...episode, episode: 2 }, candidate)).toBe(true);
      const named = { ...source("master.m3u8"), filename: `Synthetic.Grove.1998.${marker}.mp4` };
      expect(identityMismatch(movie, named)).toBe(true);
      expect(identityMismatch(episode, named)).toBe(false);
      expect(identityMismatch({ ...episode, episode: 2 }, named)).toBe(true);
    });

  it.each([
    ["Synthetic.Meridian.1987.1080p.mkv", false], ["Meridiano.Sintetico.1987.720p.mkv", false],
    ["movies/random-id/master.m3u8", false], ["episode-1.mp4", true],
    ["ep.1.v0.1234567890.720.m3u8", true], ["Synthetic.Harbour.S01E01.mkv", true],
    ["Synthetic.Harbour.S01.E01.mkv", true]
  ] as const)("qualifies movie resource %s independently of a misleading label", (name, rejected) => {
    expect(identityMismatch(movie, source(name))).toBe(rejected);
  });

  it.each([
    ["Synthetic.Grove.S01E01.mkv", false], ["Synthetic.Grove.Ep1.mp4", false], ["Synthetic.Grove.Ep2.mp4", true],
    ["Synthetic.Grove.S02E01.mkv", true], ["Synthetic.Grove.1998.Ep1.mp4", false],
    ["Synthetic.Northern.Grove.2020.Ep1.mp4", false], ["Synthetic.Grove.S01E01.2020.01.01.mkv", false],
    ["Synthetic.Grove.Ep1.2020.01.01.mp4", false], ["movies/random-id/master.m3u8", false],
    ["Synthetic.Grove.1998.2020.Ep1.mp4", false]
  ] as const)("qualifies episode coordinates in %s while deferring release-year rejection", (name, rejected) => {
    expect(identityMismatch(episode, { ...source(name), title: "Synthetic Sleeping Grove (1998) S01E01" })).toBe(rejected);
  });

  it.each(["Ep0", "Ep000", "Ep1000", "Ep999999", "XEp1", "Ep1extra", "Episode..1", "Episode 1",
    "S01E00", "S001E01", "Ep1.Ep2", "S01E01.Ep2", "S01E01.S02E01"])(
    "keeps malformed or conflicting markers ambiguous: %s", (marker) => {
      const candidate = source(`Synthetic.Grove.${marker}.mp4`);
      expect(resourceIdentityFromUrl(candidate.url!)).toBeUndefined();
      expect(identityMismatch(movie, candidate)).toBe(false);
    });

  it("decodes only the final component, ignores token/query/fragment and refuses malformed or non-media names", () => {
    expect(resourceIdentityFromUrl("https://media.example/Episode%2D1.mp4")).toEqual({ kind: "episode", episode: 1 });
    for (const url of ["not a URL", "file:///episode-1.mp4", "https://media.example/Episode%ZZ1.mp4",
      "https://media.example/Episode%2F1.mp4", "https://media.example/Episode%001.mp4",
      "https://media.example/Episode%3F1.mp4", "https://media.example/episode-1.txt",
      `https://media.example/${"x".repeat(1025)}.Ep1.mp4`,
      "https://media.example/2020/Episode-1/master.m3u8?episode=2&filename=Ep2.2004.mp4#Ep3",
      "https://media.example/6f7a09ee2b882340babc89a057af60ec.mp4"]) {
      expect(resourceIdentityFromUrl(url)).toBeUndefined();
      expect(identityMismatch(movie, { ...source("video.mp4"), url })).toBe(false);
    }
    expect(identityMismatch(movie, { ...source("video.mp4"), title: "An episode 1 discussion" })).toBe(false);
  });

  it("defers episode resource-year rejection while keeping coordinate contradictions independent of echoed metadata", () => {
    const candidate = { ...source("Synthetic.Northern.Grove.2020.Ep1.mp4"),
      filename: "Synthetic.Sleeping.Grove.1998.S01E01.mp4",
      metadata: { identity: { kind: "episode", season: 1, episode: 1, year: 1998 } } };
    expect(identityMismatch(episode, candidate)).toBe(false);
    expect(resourceIdentityFromUrl(candidate.url!)).toEqual({ kind: "episode", episode: 1, year: 2020 });
    const wrongEpisode = { ...candidate, url: source("Synthetic.Northern.Grove.2020.Ep2.mp4").url! };
    expect(identityMismatch(episode, wrongEpisode)).toBe(true);
    expect(assessIdentity(episode, wrongEpisode)).toBe("CONTRADICTION");
    expect(identityMismatch(episode, { ...source("Synthetic.Sleeping.Grove.1998.Ep1.mp4"),
      filename: "Synthetic.Sleeping.Grove.2020.S01E01.mp4" })).toBe(false);
    expect(identityMismatch(episode, { ...source("master.m3u8"),
      title: "Synthetic.Northern.Grove.2020.Ep1.mp4" })).toBe(false);
    const withoutYear = { ...episode };
    delete withoutYear.year;
    expect(identityMismatch(withoutYear, candidate)).toBe(false);
  });

  it("shares URL evidence across normalized provider families before any probe", async () => {
    const registry = new StreamProviderRegistry(500, silentLogger);
    const ids = ["stremio-addon-synthetic", "external_http", "synthetic-direct"];
    for (const id of ids) registry.register({ id, name: id, isEnabled: () => true, resolve: () => Promise.resolve([
      { ...source(`${id}/episode-1.mp4`), providerId: id, filename: "Synthetic.Meridian.1987.mp4" },
      { ...source(`${id}/video.mp4`), providerId: id, title: "Server 1" }
    ]) });
    const resolver = new StreamResolver(registry, policy);
    expect((await resolver.resolve(movie)).map((entry) => entry.providerId).sort()).toEqual([...ids].sort());
    expect(resolver.diagnostics().map((entry) => entry.identityRejections)).toEqual([1, 1, 1]);
  });
});

describe("validated effective resource evidence", () => {
  const playlist = "#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
  function pinnedFor(effectiveName: string): ReturnType<typeof vi.fn<PinnedRequest>> {
    return vi.fn<PinnedRequest>().mockImplementation(({ url }) => {
      if (url.pathname === "/wrapper") return Promise.resolve(new Response(null, { status: 302,
        headers: { Location: `/${effectiveName}?token=${sentinel}` } }));
      if (url.pathname.endsWith(".m3u8")) return Promise.resolve(new Response(playlist,
        { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
      return Promise.resolve(new Response(new Uint8Array([1]), { status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/100" } }));
    });
  }

  it.each([
    { label: "episode-shaped movie", item: movie, name: "ep.1.v0.1234567890.720.m3u8", rejected: true },
    { label: "deferred episode release year", item: episode, name: "Synthetic.Northern.Grove.2020.Ep1.mp4", rejected: false },
    { label: "opaque HLS", item: movie, name: "movies/random-id/master.m3u8", rejected: false }
  ])("qualifies $label after safe validated redirects without retaining a locator", async ({ item, name, rejected }) => {
    const candidate = { ...source("wrapper"), title: "Server 1" };
    const { resolver, audit } = setup([candidate], item, pinnedFor(name));
    const survivors = await resolver.resolve(item);
    expect(survivors).toHaveLength(rejected ? 0 : 1);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(rejected ? 1 : 0);
    expect(audit.report().providers[0]?.stages.probed.CONTRADICTION).toBe(rejected ? 1 : 0);
    expect(audit.report().providers[0]?.stages.final.CONTRADICTION).toBe(0);
    if (!rejected) expect(audit.report().providers[0]?.stages.final.UNKNOWN).toBe(1);
  });

  it("backfills structural post-probe rejections within the existing limit, preserving evidence in the probe cache", async () => {
    const pinned = pinnedFor("ep.1.m3u8");
    const { resolver, audit, probe } = setup([
      { ...source("wrapper"), title: "Server 1" }, { ...source("master.m3u8"), title: "Server 1" }
    ], movie, pinned, 1);
    const survivors = await resolver.resolve(movie);
    expect(survivors.map((entry) => entry.url)).toEqual([source("master.m3u8").url]);
    expect(probe?.diagnostics().requests).toBe(2);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
    expect(audit.report().providers[0]?.stages.probed).toMatchObject({ CONTRADICTION: 1, UNKNOWN: 1 });
    const starts = pinned.mock.calls.length;
    expect(await resolver.resolve(movie)).toHaveLength(1);
    expect(pinned.mock.calls).toHaveLength(starts);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(1);
  });

  it("records only safe numeric evidence from selected HLS variant URLs", async () => {
    const pinned = vi.fn<PinnedRequest>().mockImplementation(({ url }) => {
      if (url.pathname === "/wrapper") return Promise.resolve(new Response(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nepisode-1.m3u8?token=${sentinel}\n`,
        { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
      if (url.pathname.endsWith(".m3u8")) return Promise.resolve(new Response(playlist,
        { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
      return Promise.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp2t" } }));
    });
    const { probe } = setup([], movie, pinned);
    const [observed] = await probe!.probe([{ ...source("wrapper"), title: "Server 1" }]);
    expect(observed?.directHttp?.resourceIdentities).toEqual([{ kind: "episode", episode: 1 }]);
    const serialized = JSON.stringify(observed?.directHttp);
    for (const forbidden of [sentinel, "media.example", "episode-1", "token", "https:"]) expect(serialized).not.toContain(forbidden);
    expect(identityMismatch(movie, observed!)).toBe(true);
    expect(normalizeStreamSource(observed, "synthetic")?.directHttp).toBeUndefined();
  });

  it("blocks unsafe redirects without resource evidence or identity rejection counts", async () => {
    const pinned = vi.fn<PinnedRequest>().mockResolvedValue(new Response(null, { status: 302,
      headers: { Location: `http://127.0.0.1/episode-1.mp4?token=${sentinel}` } }));
    const { resolver, probe, audit } = setup([{ ...source("wrapper"), title: "Server 1" }], movie, pinned);
    expect(await resolver.resolve(movie)).toHaveLength(0);
    expect(pinned).toHaveBeenCalledOnce();
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(0);
    expect(audit.report().providers[0]?.stages.probed).toMatchObject({ UNKNOWN: 1, CONTRADICTION: 0 });
    const [observed] = await probe!.probe([source("wrapper")]);
    expect(observed?.directHttp).toMatchObject({ status: "route_rejected" });
    expect(observed?.directHttp?.resourceIdentities).toBeUndefined();
  });

  it("does not promote an episode-shaped failed response into identity evidence", async () => {
    const pinned = vi.fn<PinnedRequest>().mockImplementation(({ url }) => Promise.resolve(
      url.pathname === "/wrapper"
        ? new Response(null, { status: 302, headers: { Location: "/episode-1.mp4" } })
        : new Response(null, { status: 503, headers: { "Content-Type": "video/mp4" } })
    ));
    const { resolver, probe, audit } = setup([{ ...source("wrapper"), title: "Server 1" }], movie, pinned);
    expect(await resolver.resolve(movie)).toHaveLength(0);
    expect(resolver.diagnostics()[0]?.identityRejections).toBe(0);
    expect(audit.report().providers[0]?.stages.probed).toMatchObject({ UNKNOWN: 1, CONTRADICTION: 0 });
    const [observed] = await probe!.probe([source("wrapper")]);
    expect(observed?.directHttp).toMatchObject({ status: "unreachable", responseStatus: 503 });
    expect(observed?.directHttp?.resourceIdentities).toBeUndefined();
  });
});
