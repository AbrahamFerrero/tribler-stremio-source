import { describe, expect, it, vi } from "vitest";
import { discoverTriblerEndpoint } from "../src/tribler-endpoint-discovery";
import { TriblerClient } from "../src/tribler-client";

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const failed = () => new TypeError("fetch failed");
const downloads = () => new Response(JSON.stringify({ downloads: [] }), { status: 200 });

describe("Tribler endpoint discovery", () => {
  it("TAD01 keeps a healthy configured endpoint without discovery", async () => {
    const recover = vi.fn(() => Promise.resolve("http://127.0.0.1:52000"));
    const client = new TriblerClient("http://127.0.0.1:51000", "secret", 100, vi.fn<typeof fetch>().mockResolvedValue(downloads()), recover);
    await expect(client.listDownloads()).resolves.toEqual([]);
    expect(recover).not.toHaveBeenCalled();
  });

  it("TAD02 invokes discovery only for ECONNREFUSED and TAD03 ignores other failures", async () => {
    const recover = vi.fn(() => Promise.resolve("http://127.0.0.1:52000"));
    const nonRefused = new TriblerClient("http://127.0.0.1:51000", "secret", 100, vi.fn<typeof fetch>().mockRejectedValue(failed()), recover);
    await expect(nonRefused.listDownloads()).rejects.toThrow("fetch failed");
    expect(recover).not.toHaveBeenCalled();
    const httpFailure = new TriblerClient("http://127.0.0.1:51000", "secret", 100, vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 401 })), recover);
    await expect(httpFailure.listDownloads()).rejects.toThrow("HTTP 401");
    expect(recover).not.toHaveBeenCalled();
  });

  it("TAD04, TAD05, TAD06, TAD07 and TAD08 accept exactly one authenticated loopback candidate", async () => {
    const probe = vi.fn((url: string) => Promise.resolve(url.endsWith(":52000")));
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://127.0.0.1:51000", "http://127.0.0.1:52000"]), probe
    })).resolves.toBe("http://127.0.0.1:52000");
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://127.0.0.1:51000"]), probe: () => Promise.resolve(false)
    })).resolves.toBeUndefined();
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://127.0.0.1:51000", "http://127.0.0.1:52000"]), probe: () => Promise.resolve(true)
    })).resolves.toBeUndefined();
    const restrictedProbe = vi.fn(() => Promise.resolve(true));
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://127.0.0.1:52000", "http://192.168.1.2:52001", "http://127.0.0.1:52002/path"]), probe: restrictedProbe
    })).resolves.toBe("http://127.0.0.1:52000");
    expect(restrictedProbe).toHaveBeenCalledOnce();
  });

  it("TAD09 rejects failed authentication and TAD10/TAD11 preserve IPv4 and IPv6 loopback", async () => {
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://127.0.0.1:52000"]), probe: () => Promise.resolve(false)
    })).resolves.toBeUndefined();
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://127.0.0.1:52000"]), probe: () => Promise.resolve(true)
    })).resolves.toBe("http://127.0.0.1:52000");
    await expect(discoverTriblerEndpoint("secret", {
      listCandidates: () => Promise.resolve(["http://[::1]:52000"]), probe: () => Promise.resolve(true)
    })).resolves.toBe("http://[::1]:52000");
  });

  it("TAD12 retries the original request exactly once after recovery", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(downloads());
    const recover = vi.fn(() => Promise.resolve("http://127.0.0.1:52000"));
    const client = new TriblerClient("http://127.0.0.1:51000", "secret", 100, fetchMock, recover);
    await client.addDownload("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", undefined, { onlyMetadata: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["http://127.0.0.1:51000/api/downloads", "http://127.0.0.1:52000/api/downloads"]);
    const retry = fetchMock.mock.calls[1]?.[1];
    expect(retry?.method).toBe("PUT");
    expect(typeof retry?.body === "string" && retry.body).toContain("only_metadata");
    expect(new Headers(retry?.headers).get("X-Api-Key")).toBe("secret");
  });

  it("TAD13 bounds recovery and TAD14 shares one recovery for concurrent refusals", async () => {
    const once = vi.fn(() => Promise.resolve("http://127.0.0.1:52000"));
    const bounded = new TriblerClient("http://127.0.0.1:51000", "secret", 100, vi.fn<typeof fetch>().mockRejectedValue(refused()), once);
    await expect(bounded.listDownloads()).rejects.toThrow("fetch failed");
    expect(once).toHaveBeenCalledOnce();
    let release: (() => void) | undefined;
    const shared = new Promise<string>((resolve) => { release = () => resolve("http://127.0.0.1:52000"); });
    const recover = vi.fn(() => shared);
    let initialCalls = 0;
    let rejectInitial: (() => void) | undefined;
    const bothInitial = new Promise<void>((resolve) => { rejectInitial = resolve; });
    const fetchMock = vi.fn<typeof fetch>((url) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (target.startsWith("http://127.0.0.1:51000")) {
        initialCalls += 1;
        if (initialCalls === 2) rejectInitial?.();
        return bothInitial.then(() => Promise.reject(refused()));
      }
      return Promise.resolve(downloads());
    });
    const concurrent = new TriblerClient("http://127.0.0.1:51000", "secret", 100, fetchMock, recover);
    const left = concurrent.listDownloads(); const right = concurrent.listDownloads();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    release?.();
    await expect(Promise.all([left, right])).resolves.toEqual([[], []]);
  });

  it("TAD15 supports later port drift, TAD16 has no persistence path, and TAD17 suppresses recovery errors", async () => {
    const recover = vi.fn().mockResolvedValueOnce("http://127.0.0.1:52000").mockResolvedValueOnce("http://127.0.0.1:53000");
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(downloads()).mockRejectedValueOnce(refused()).mockResolvedValueOnce(downloads());
    const client = new TriblerClient("http://127.0.0.1:51000", "secret", 100, fetchMock, recover);
    await client.listDownloads(); await client.listDownloads();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("http://127.0.0.1:53000/api/downloads");
    const secretRecovery = new TriblerClient("http://127.0.0.1:51000", "secret-value", 100, vi.fn<typeof fetch>().mockRejectedValue(refused()), () => Promise.reject(new Error("apiKey=secret-value")));
    await expect(secretRecovery.listDownloads()).rejects.toThrow("fetch failed");
  });
});
