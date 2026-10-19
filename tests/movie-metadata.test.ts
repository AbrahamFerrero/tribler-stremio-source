// These replacement titles and localized labels are invented fixture identities.
// IMDb-shaped numbers are local test data, not a reserved external namespace.
import { describe, expect, it, vi } from "vitest";
import { StremioMovieMetadataLookup } from "../src/metadata/movie-metadata";
import { ExternalUrlPolicy, type DnsLookup } from "../src/network/url-policy";

const publicPolicy = () => new ExternalUrlPolicy({
  resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
});
const baseUrl = "https://metadata.example/";
const movie = (id = "tt9900105", extras: Record<string, unknown> = {}) => ({
  meta: { id, type: "movie", name: "Zunra", releaseInfo: "2011", ...extras }
});
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { "Content-Type": "application/json" }
});

describe("trusted Stremio movie metadata lookup", () => {
  it("follows safe relative and cross-host redirects with validation at every hop", async () => {
    const resolver = vi.fn<DnsLookup>().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "/redirected.json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307,
        headers: { Location: "https://metadata-cdn.example/neravelle.json" } }))
      .mockResolvedValueOnce(json(movie("tt9900104", { name: "Neravelle", releaseInfo: "1968", runtime: "71 min" })));
    const lookup = new StremioMovieMetadataLookup({ baseUrl,
      endpointPolicy: () => new ExternalUrlPolicy({ resolver }), fetchImplementation: fetcher });
    await expect(lookup.lookup("tt9900104")).resolves.toEqual({ title: "Neravelle", year: 1968, runtimeSeconds: 4260 });
    expect(resolver.mock.calls.map(([host]) => host)).toEqual([
      "metadata.example", "metadata.example", "metadata-cdn.example"
    ]);
    expect(fetcher.mock.calls.map(([, init]) => init?.redirect)).toEqual(["manual", "manual", "manual"]);
  });

  it("blocks a redirect whose hostname resolves privately before fetching it", async () => {
    const resolver = vi.fn<DnsLookup>().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: "https://private.example/meta.json" }
    }));
    const lookup = new StremioMovieMetadataLookup({ baseUrl,
      endpointPolicy: () => new ExternalUrlPolicy({ resolver }), fetchImplementation: fetcher });
    await expect(lookup.lookup("tt9900104")).resolves.toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["loop", "chain"])("bounds a redirect %s and cancels every intermediate body", async (shape) => {
    const responses: Response[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      const response = new Response("redirect", { status: 302,
        headers: { Location: shape === "loop" ? "/meta/movie/tt9900104.json" : `/hop-${responses.length}.json` } });
      responses.push(response);
      return Promise.resolve(response);
    });
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy, fetchImplementation: fetcher });
    await expect(lookup.lookup("tt9900104")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const response of responses) expect(response.bodyUsed).toBe(true);
  });

  it("accepts a matching movie title and optional year", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(movie()))
      .mockResolvedValueOnce(json(movie("tt1000001", { releaseInfo: undefined })));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher });
    await expect(lookup.lookup("tt9900105")).resolves.toEqual({ title: "Zunra", year: 2011 });
    await expect(lookup.lookup("tt1000001")).resolves.toEqual({ title: "Zunra" });
    expect(fetcher.mock.calls.map(([url]) => new URL(url instanceof URL ? url.href
      : typeof url === "string" ? url : url.url).pathname)).toEqual([
      "/meta/movie/tt9900105.json", "/meta/movie/tt1000001.json"
    ]);
  });

  it("preserves a bounded runtime without requiring it for valid movie identity", async () => {
    const runtimes = ["126 min", "bad", "-5 min", "0 min", "999 min", undefined];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const id = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        .pathname.match(/(tt\d+)\.json$/)?.[1];
      const index = Number(id?.slice(2)) - 1000000;
      return Promise.resolve(json(movie(id, { runtime: runtimes[index] })));
    });
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher });
    for (const [index, runtime] of runtimes.entries()) {
      await expect(lookup.lookup(`tt${1000000 + index}`)).resolves.toEqual({ title: "Zunra", year: 2011,
        ...(runtime === "126 min" ? { runtimeSeconds: 7_560 } : {}) });
    }
  });

  it.each([
    ["mismatched ID", movie("tt9999999")],
    ["mismatched type", movie("tt9900105", { type: "series" })],
    ["missing name", movie("tt9900105", { name: "" })],
    ["oversized name", movie("tt9900105", { name: "x".repeat(301) })],
    ["control character in name", movie("tt9900105", { name: "Zun\nra" })],
    ["malformed response", { meta: [] }]
  ])("ignores %s", async (_description, payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(payload));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher });
    await expect(lookup.lookup("tt9900105")).resolves.toBeUndefined();
  });

  it("bounds responses and ignores invalid or ambiguous years without losing a valid title", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(movie()))
      .mockResolvedValueOnce(json(movie("tt1000001", { releaseInfo: "2011-2012" })))
      .mockResolvedValueOnce(json(movie("tt1000002", { year: 2020 })));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher, maxResponseBytes: 96 });
    await expect(lookup.lookup("tt9900105")).resolves.toEqual({ title: "Zunra", year: 2011 });
    await expect(lookup.lookup("tt1000001")).resolves.toEqual({ title: "Zunra" });
    await expect(lookup.lookup("tt1000002")).resolves.toEqual({ title: "Zunra" });
    const oversized = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      maxResponseBytes: 32, fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(json(movie())) });
    await expect(oversized.lookup("tt9900105")).resolves.toBeUndefined();
  });

  it("caches success and failure with bounded entries and coalesces in-flight requests", async () => {
    let now = 0;
    let release!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(first)
      .mockResolvedValueOnce(json(movie("tt1000001")))
      .mockResolvedValueOnce(json(movie("tt1000002"), 503))
      .mockResolvedValueOnce(json(movie("tt9900105")))
      .mockResolvedValueOnce(json(movie("tt1000002"), 503))
      .mockResolvedValueOnce(json(movie("tt9900105")));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher, maxEntries: 2, successTtlMs: 100, failureTtlMs: 20,
      now: () => now });
    const pendingA = lookup.lookup("tt9900105");
    const pendingB = lookup.lookup("tt9900105");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release(json(movie()));
    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual([
      { title: "Zunra", year: 2011 }, { title: "Zunra", year: 2011 }
    ]);
    await expect(lookup.lookup("tt9900105")).resolves.toMatchObject({ year: 2011 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await lookup.lookup("tt1000001");
    await expect(lookup.lookup("tt1000002")).resolves.toBeUndefined();
    await lookup.lookup("tt9900105"); // oldest success was evicted
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(lookup.lookup("tt1000002")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(4);
    now = 21;
    await expect(lookup.lookup("tt1000002")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(5);
    now = 101;
    await expect(lookup.lookup("tt9900105")).resolves.toMatchObject({ year: 2011 });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each(["lookup", "lookupSeries"] as const)("%s returns no metadata after a timeout, unsafe redirect, or blocked private target", async (method) => {
    const waiting: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason instanceof Error
        ? init.signal.reason : new Error("Metadata request timed out")), { once: true });
    });
    const timedOut = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: waiting, timeoutMs: 10 });
    await expect(timedOut[method]("tt9900105")).resolves.toBeUndefined();

    const redirectedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "http://127.0.0.1:7000/private" }
    }));
    const redirected = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: redirectedFetch });
    await expect(redirected[method]("tt9900105")).resolves.toBeUndefined();
    expect(redirectedFetch).toHaveBeenCalledOnce();

    const privateFetch = vi.fn<typeof fetch>().mockResolvedValue(json(movie()));
    const privateTarget = new StremioMovieMetadataLookup({ baseUrl: "http://127.0.0.1:7777/",
      endpointPolicy: () => new ExternalUrlPolicy(), fetchImplementation: privateFetch });
    await expect(privateTarget[method]("tt9900105")).resolves.toBeUndefined();
    expect(privateFetch).not.toHaveBeenCalled();

    const internalTarget = new StremioMovieMetadataLookup({ baseUrl: "http://127.0.0.1:7000/",
      endpointPolicy: (url) => new ExternalUrlPolicy({
        blockedEndpoints: [{ hostname: "127.0.0.1", port: "7000" }], allowedLoopbackUrls: [url]
      }), fetchImplementation: privateFetch });
    await expect(internalTarget[method]("tt9900105")).resolves.toBeUndefined();
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe base URLs and ignores non-IMDb movie IDs", async () => {
    const options = { endpointPolicy: publicPolicy };
    expect(() => new StremioMovieMetadataLookup({ ...options,
      baseUrl: "https://metadata.example/?token=secret" })).toThrow(/base URL/);
    const fetcher = vi.fn<typeof fetch>();
    const lookup = new StremioMovieMetadataLookup({ ...options, baseUrl,
      fetchImplementation: fetcher });
    await expect(lookup.lookup("../tt9900105")).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe("trusted Stremio series metadata on shared bounded infrastructure", () => {
  const series = (extras: Record<string, unknown> = {}) => ({
    meta: { id: "tt9999999998", type: "series", name: "Synthetic Harbour", ...extras }
  });

  it.each([
    [{ releaseInfo: "1998" }, 1998], [{ year: 1998 }, 1998], [{ releaseInfo: " 1998 ", year: 1998 }, 1998],
    [{ releaseInfo: "1998", year: 2004 }, undefined], [{ releaseInfo: "1998-2004" }, undefined],
    [{ releaseInfo: "born 1998" }, undefined], [{ releaseInfo: "0000", year: -1 }, undefined]
  ] as const)("preserves a validated title with conservative series year evidence %j", async (extra, year) => {
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(json(series(extra))) });
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toEqual({ title: "Synthetic Harbour",
      ...(year !== undefined ? { year } : {}) });
  });

  it("follows a safe redirect and retains trusted series title and year metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 308, headers: { Location: "https://metadata-cdn.example/series.json" }
    })).mockResolvedValueOnce(json(series({ year: 1998, runtime: "60 min" })));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy, fetchImplementation: fetcher });
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toEqual({ title: "Synthetic Harbour", year: 1998 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the series endpoint and keeps validated name and year", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(series({
      releaseInfo: "1998", year: 1998, runtime: "60 min",
      videos: [{ id: "tt9999999998:1:1", title: "Pilot" }]
    })));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher });
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toEqual({ title: "Synthetic Harbour", year: 1998 });
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL(`${baseUrl}meta/series/tt9999999998.json`));
    await expect(lookup.lookupSeries("tt9999999998:1:1")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not manufacture exact episode runtime from series runtime or episode air dates", async () => {
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(json(series({
        year: 1998, runtime: "45 min", videos: [
          { id: "tt9999999998:1:1", season: 1, episode: 1, name: "Synthetic Pilot",
            released: "1998-01-01T00:00:00.000Z", firstAired: "1998-01-01T00:00:00.000Z" },
          { id: "tt9999999998:1:2", season: 1, episode: 2, name: "Synthetic Second Chapter",
            released: "1998-01-08T00:00:00.000Z" }
        ]
      }))) });
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toEqual({ title: "Synthetic Harbour", year: 1998 });
  });

  it.each([
    ["wrong id", series({ id: "tt9999999" })],
    ["wrong type", series({ type: "movie" })],
    ["blank name", series({ name: "   " })],
    ["nonstring name", series({ name: 123 })],
    ["oversized name", series({ name: "x".repeat(301) })],
    ["control character", series({ name: "Synthetic\u0000Harbour" })],
    ["missing meta", {}], ["array meta", { meta: [] }], ["null response", null]
  ])("rejects %s", async (_reason, payload) => {
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(json(payload)) });
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toBeUndefined();
  });

  it("enforces the response bound and treats network failure as absent metadata", async () => {
    const oversized = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      maxResponseBytes: 32, fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(json(series())) });
    await expect(oversized.lookupSeries("tt9999999998")).resolves.toBeUndefined();
    const failed = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")) });
    await expect(failed.lookupSeries("tt9999999998")).resolves.toBeUndefined();
  });

  it("shares concurrency/cache bounds and TTLs while separating movie and series identity", async () => {
    let now = 0;
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(json(movie("tt9999999998", { name: "Synthetic Meridian" })))
      .mockResolvedValueOnce(json(series(), 503))
      .mockResolvedValueOnce(json(series({ year: 1998 })));
    const lookup = new StremioMovieMetadataLookup({ baseUrl, endpointPolicy: publicPolicy,
      fetchImplementation: fetcher, maxEntries: 1, maxInFlight: 1,
      successTtlMs: 100, failureTtlMs: 20, now: () => now });
    const first = lookup.lookupSeries("tt9999999998");
    const duplicate = lookup.lookupSeries("tt9999999998");
    await expect(lookup.lookup("tt9999999998")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    release(json(series({ year: 1998 })));
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { title: "Synthetic Harbour", year: 1998 }, { title: "Synthetic Harbour", year: 1998 }
    ]);
    await lookup.lookupSeries("tt9999999998");
    expect(fetcher).toHaveBeenCalledOnce();
    now = 101;
    await expect(lookup.lookup("tt9999999998")).resolves.toEqual({ title: "Synthetic Meridian", year: 2011 });
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toBeUndefined();
    await lookup.lookupSeries("tt9999999998");
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = 122;
    await expect(lookup.lookupSeries("tt9999999998")).resolves.toEqual({ title: "Synthetic Harbour", year: 1998 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
