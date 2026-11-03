import { describe, expect, it } from "vitest";
import { identityMismatchReason, measuredRuntimeMismatch, movieResourceObservationFromUrl, effectiveMovieIdentityState } from "../src/streams/identity-qualification";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { StremioMovieMetadataLookup } from "../src/metadata/movie-metadata";
import { DirectStreamProbe } from "../src/streams/direct-stream-probe";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import type { NormalizedMediaItem, NormalizedStreamSource } from "../src/streams/types";
import { fixtureOutboundRequest, silentLogger } from "./helpers";
import { mp4Fixture } from "./mp4-fixture";

// Invented titles only. Nearby release dates are uncertainty, never an ID attestation.
const item: NormalizedMediaItem = { id: "tt9900105", title: "Invented: Harbour", kind: "movie", year: 2022, externalIds: { imdb: "tt9900105" } };
const candidate = (extra: Partial<NormalizedStreamSource> = {}): NormalizedStreamSource => ({
  providerId: "fixture", type: "magnet", infoHash: "a".repeat(40),
  magnet: `magnet:?xt=urn:btih:${extra.infoHash ?? "a".repeat(40)}`, ...extra
});
const policy = () => new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) });

describe("bounded movie release-year ambiguity", () => {
  it.each([2021, 2022, 2023])("keeps title-compatible year %i eligible without creating corroboration", year => {
    for (const source of [candidate({ title: `Invented: Harbour (${year}) 1080p` }),
      candidate({ filename: `Invented.Harbour.${year}.mkv` }),
      candidate({ title: `Invented_Harbour_${year}.mkv` }),
      candidate({ metadata: { identity: { title: "INVENTED — HARBOUR", year } } }),
      candidate({ type: "https", url: `https://media.example/Invented.Harbour.${year}.mp4` })]) {
      expect(identityMismatchReason(item, source)).toBeUndefined();
      expect(effectiveMovieIdentityState(item, source)).not.toBe("CORROBORATED");
    }
  });

  it.each([
    candidate({ filename: "Other.Film.2021.mkv" }),
    candidate({ filename: "Invented.Harbour.2020.mkv" }),
    candidate({ filename: "Invented.Harbour.2024.mkv" }),
    candidate({ filename: "1995.mkv", metadata: { identity: { year: 2021 } } }),
    candidate({ metadata: { identity: { year: 2021 } } }),
    candidate({ title: "Another Work (2021) 1080p" }),
    candidate({ title: "Invented Harbour 2 (2021) 1080p" }),
    candidate({ title: "Invented: Harbour (2021)", filename: "Other.Film.2021.mkv" }),
    candidate({ title: "Invented: Harbour (2021)", metadata: { identity: { year: 2021 } } }),
    candidate({ filename: "Invented.Harbour.2021.mkv", type: "https", url: "https://media.example/Other.Film.2021.mp4" }),
    candidate({ filename: "Other.Film.2021.mkv", type: "https", url: "https://media.example/Invented.Harbour.2021.mp4" }),
    candidate({ filename: "Invented.Harbour.2021.mkv", directHttp: { status: "verified", verified: true, rangeSupported: true, resourceIdentities: [{ year: 2021 }] } }),
    candidate({ filename: "Other.Film.2021.mkv", metadata: { identity: { title: item.title, year: 2022 } } })
  ])("retains a year rejection without a bound compatible title or outside the adjacent-year exception: %#", source => {
    expect(identityMismatchReason(item, source)).toBe("MOVIE_YEAR_CONFLICT");
  });

  it("preserves conflicting IDs, structural kind and measured runtime authority", () => {
    const source = candidate({ filename: "Invented.Harbour.2021.mkv" });
    expect(identityMismatchReason(item, { ...source, metadata: { identity: { externalIds: { imdb: "tt9900106" } } } })).toBe("EXTERNAL_ID_CONFLICT");
    expect(identityMismatchReason(item, { ...source, metadata: { identity: { kind: "episode" } } })).toBe("KIND_CONFLICT");
    expect(measuredRuntimeMismatch({ ...item, runtimeSeconds: 7200 }, { ...source, directHttp: {
      status: "verified", verified: true, rangeSupported: true, actualRuntimeSeconds: 1200, runtimeEvidence: "mp4_mvhd"
    } })).toBe(true);
  });

  it("retains existing fail-open for absent request year, ambiguous years and episode release years", () => {
    const { year: _year, ...withoutYear } = item; void _year;
    expect(identityMismatchReason(withoutYear, candidate({ filename: "Other.Film.1957.mkv" }))).toBeUndefined();
    expect(identityMismatchReason(item, candidate({ filename: "Invented.Harbour.2021.2022.mkv" }))).toBeUndefined();
    expect(identityMismatchReason({ ...item, kind: "episode", season: 1, episode: 2 }, candidate({ filename: "Invented.Harbour.1957.S01E02.mkv" }))).toBeUndefined();
  });

  it("allows only bound validated effective-root ambiguity and never promotes it to CORROBORATED", () => {
    const requested = { ...item, title: "Invented Harbour" };
    const root = movieResourceObservationFromUrl("https://media.example/Invented.Harbour.2021.mp4", "range_206")!;
    const source = candidate({ type: "https", url: "https://media.example/opaque.mp4", directHttp: {
      status: "verified", verified: true, rangeSupported: true, responseStatus: 206, movieResource: root, resourceIdentities: [{ year: 2021 }]
    } });
    expect(identityMismatchReason(requested, source)).toBeUndefined();
    expect(identityMismatchReason(item, source)).toBeUndefined();
    expect(effectiveMovieIdentityState(requested, source)).not.toBe("CORROBORATED");
    for (const extra of [{ responseStatus: 404 }, { verified: false }, { hls: true },
      { resourceIdentities: [{ year: 2021 }, { year: 2021 }] }, { movieResource: { ...root, year: 2020 } },
      { movieResource: movieResourceObservationFromUrl("https://media.example/Other.Film.2021.mp4", "range_206")! }]) {
      expect(identityMismatchReason(requested, { ...source, directHttp: { ...source.directHttp!, ...extra } })).toBe("MOVIE_YEAR_CONFLICT");
    }
  });

  it.each([[2022, 2021], [1996, 1995], [1994, 1995]])("uses parsed requested metadata %i with candidate year %i through the real resolver", async (requestedYear, candidateYear) => {
    const lookup = new StremioMovieMetadataLookup({ baseUrl: "https://metadata.example/", endpointPolicy: policy,
      fetchImplementation: () => Promise.resolve(new Response(JSON.stringify({ meta: { id: item.id, type: "movie", name: item.title, releaseInfo: String(requestedYear) } }), { headers: { "Content-Type": "application/json" } })) });
    const metadata = await lookup.lookup(item.id); expect(metadata?.year).toBe(requestedYear);
    const registry = new StreamProviderRegistry(1000, silentLogger);
    registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true, resolve: () => Promise.resolve([
      candidate({ filename: `Invented.Harbour.${candidateYear}.mkv` }),
      candidate({ infoHash: "b".repeat(40), filename: `Other.Film.${candidateYear}.mkv` }),
      candidate({ infoHash: "c".repeat(40), filename: `Invented.Harbour.${candidateYear}.mkv`, metadata: { identity: { externalIds: { imdb: "tt9900106" } } } })
    ]) });
    const rejections: string[] = [];
    const resolver = new StreamResolver(registry, policy(), undefined, { stage: () => undefined, rejection: e => rejections.push(e.reason) });
    const result = await resolver.resolve({ ...item, ...metadata });
    expect(result).toHaveLength(1); expect(result[0]!.infoHash).toBe("a".repeat(40));
    expect(getBridgeIdentityState(result[0]!)).not.toBe("CORROBORATED");
    expect(rejections).toEqual(["MOVIE_YEAR_CONFLICT", "EXTERNAL_ID_CONFLICT"]);
  });

  it("preserves the exception through actual file probing while measured runtime can still reject it", async () => {
    for (const seconds of [7200, 1200]) {
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register({ id: "fixture", name: "Fixture", isEnabled: () => true, resolve: () => Promise.resolve([
        candidate({ type: "https", url: "https://media.example/Invented.Harbour.2021.mp4" })
      ]) });
      const body = Uint8Array.from(mp4Fixture(seconds));
      const probe = new DirectStreamProbe({ id: "fixture", request: fixtureOutboundRequest(({ headers }) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range") ?? "")!;
        const start = Number(range[1]), end = Math.min(Number(range[2]), body.length - 1);
        return Promise.resolve(new Response(body.subarray(start, end + 1), {
          status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${body.length}` }
        }));
      }), diagnostics: () => ({ transport: "fixture", requests: 0, failures: 0, averageLatencyMs: 0 }) },
      { enabled: true, timeoutMs: 1000, maxCandidates: 1, maxConcurrent: 1 }, silentLogger);
      const resolver = new StreamResolver(registry, policy(), probe);
      const result = await resolver.resolve({ ...item, title: "Invented Harbour", runtimeSeconds: 7200 });
      expect(result).toHaveLength(seconds === 7200 ? 1 : 0);
      if (result[0]) expect(getBridgeIdentityState(result[0])).not.toBe("CORROBORATED");
    }
  });
});
