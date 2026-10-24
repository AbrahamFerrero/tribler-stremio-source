import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHostname, loadConfig } from "../src/config";

describe("loopback validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", "false", "true"])("loads independent ranking detail flag %s", raw => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("STREAM_RANKING_DETAILS", raw);
    expect(loadConfig().streamRankingDetails).toBe(raw === "true");
  });

  it("rejects a malformed ranking detail flag", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("STREAM_RANKING_DETAILS", "yes");
    expect(loadConfig).toThrow("STREAM_RANKING_DETAILS must be true or false");
  });

  it.each([undefined, "1", "50", "60", "100"])("loads final provider quota %s", raw => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("STREAM_MAX_RESULTS_PER_PROVIDER", raw);
    expect(loadConfig().streamMaxResultsPerProvider).toBe(raw === undefined ? 50 : Number(raw));
  });

  it.each(["0", "-1", "101", "1.5", "invalid", "", " ", "NaN", "Infinity"])("rejects invalid final provider quota %s", raw => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("STREAM_MAX_RESULTS_PER_PROVIDER", raw);
    expect(loadConfig).toThrow("STREAM_MAX_RESULTS_PER_PROVIDER must be an integer between 1 and 100");
  });

  it("defaults HTTP playback to strict privacy with a one-hour opaque-token TTL", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("HTTP_PRIVACY_MODE", "strict");
    vi.stubEnv("HTTP_PRIVACY_USER_AGENT", "minimal");
    vi.stubEnv("HTTP_PRIVACY_SEND_REFERER", "false");
    vi.stubEnv("HTTP_PRIVACY_ACCEPT_COOKIES", "false");
    vi.stubEnv("DNS_MODE", "system");
    vi.stubEnv("HTTP_STREAM_TOKEN_TTL_SECONDS", "3600");
    vi.stubEnv("DIRECT_HTTP_PROBE_TIMEOUT_MS", "");
    const config = loadConfig();
    expect(config.httpPrivacy).toEqual({
      mode: "strict", transport: "direct", dnsMode: "system", sendReferer: false,
      acceptCookies: false, userAgentMode: "minimal", maxRedirects: 3
    });
    expect(config.httpStreamTokenTtlMs).toBe(3_600_000);
    expect(config.directHttpProbe).toEqual({ enabled: false, timeoutMs: 4_000, maxCandidates: 8, maxConcurrent: 3 });
    expect(config.triblerStreamBuffer).toMatchObject({ enabled: true, startupBytes: 8 * 1024 * 1024,
      seekBytes: 4 * 1024 * 1024, maxBytes: 64 * 1024 * 1024, prebufferTimeoutMs: 15_000 });
  });

  it("preserves an explicit direct HTTP probe timeout override", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("DIRECT_HTTP_PROBE_TIMEOUT_MS", "2500");
    expect(loadConfig().directHttpProbe.timeoutMs).toBe(2_500);
  });

  it("uses only an explicitly configured Stremio movie metadata endpoint", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("STREMIO_MOVIE_METADATA_BASE_URL", "");
    expect(loadConfig().stremioMovieMetadataBaseUrl).toBeUndefined();
    vi.stubEnv("STREMIO_MOVIE_METADATA_BASE_URL", "https://metadata.example/");
    expect(loadConfig().stremioMovieMetadataBaseUrl).toBe("https://metadata.example/");
  });

  it("rejects an invalid Tribler buffer hierarchy", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("TRIBLER_STREAM_STARTUP_BUFFER_MIB", "65");
    vi.stubEnv("TRIBLER_STREAM_MAX_BUFFER_MIB", "64");
    expect(loadConfig).toThrow(/STARTUP_BUFFER/);
  });

  it("does not permit cookies or Referer to be enabled in strict mode", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("HTTP_PRIVACY_SEND_REFERER", "true");
    expect(loadConfig).toThrow(/REFERER/);
    vi.stubEnv("HTTP_PRIVACY_SEND_REFERER", "false");
    vi.stubEnv("HTTP_PRIVACY_ACCEPT_COOKIES", "true");
    expect(loadConfig).toThrow(/COOKIES/);
  });

  it("does not silently claim that a configured DoH endpoint is active", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    vi.stubEnv("DNS_MODE", "system");
    vi.stubEnv("DNS_DOH_ENDPOINT", "https://dns.example/query");
    expect(loadConfig).toThrow(/DNS_DOH_ENDPOINT/);
  });

  it("keeps the external provider default above the adapter request timeout", () => {
    const previousUrl = process.env.TRIBLER_URL;
    const previousTimeout = process.env.STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS;
    process.env.TRIBLER_URL = "http://127.0.0.1:52194";
    delete process.env.STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS;
    expect(loadConfig().externalStreamProviderTimeoutMs).toBe(10_000);
    if (previousUrl === undefined) delete process.env.TRIBLER_URL;
    else process.env.TRIBLER_URL = previousUrl;
    if (previousTimeout === undefined) delete process.env.STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS;
    else process.env.STREAM_PROVIDER_EXTERNAL_TIMEOUT_MS = previousTimeout;
  });

  it("accepts loopback names and rejects externally reachable addresses", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.42")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("192.168.1.10")).toBe(false);
  });

  it("refuses an API key embedded in TRIBLER_URL", () => {
    const previous = process.env.TRIBLER_URL;
    process.env.TRIBLER_URL = "http://127.0.0.1:52194/?key=should-not-be-here";
    expect(loadConfig).toThrow(/TRIBLER_API_KEY/);
    if (previous === undefined) delete process.env.TRIBLER_URL;
    else process.env.TRIBLER_URL = previous;
  });

  it("rejects unknown catalog providers", () => {
    const previousUrl = process.env.TRIBLER_URL;
    const previousProvider = process.env.CATALOG_PROVIDER;
    process.env.TRIBLER_URL = "http://127.0.0.1:52194";
    process.env.CATALOG_PROVIDER = "unknown";
    expect(loadConfig).toThrow(/CATALOG_PROVIDER/);
    if (previousUrl === undefined) delete process.env.TRIBLER_URL;
    else process.env.TRIBLER_URL = previousUrl;
    if (previousProvider === undefined) delete process.env.CATALOG_PROVIDER;
    else process.env.CATALOG_PROVIDER = previousProvider;
  });

  it("rejects unknown torrent safety modes", () => {
    const previousUrl = process.env.TRIBLER_URL;
    const previousMode = process.env.TORRENT_SAFETY_MODE;
    process.env.TRIBLER_URL = "http://127.0.0.1:52194";
    process.env.TORRENT_SAFETY_MODE = "strict-ish";
    expect(loadConfig).toThrow(/TORRENT_SAFETY_MODE/);
    if (previousUrl === undefined) delete process.env.TRIBLER_URL;
    else process.env.TRIBLER_URL = previousUrl;
    if (previousMode === undefined) delete process.env.TORRENT_SAFETY_MODE;
    else process.env.TORRENT_SAFETY_MODE = previousMode;
  });

  it("defaults lifecycle retention to smart and rejects unknown modes", () => {
    vi.stubEnv("TRIBLER_URL", "http://127.0.0.1:52194");
    expect(loadConfig().downloadRetentionMode).toBe("smart");
    vi.stubEnv("DOWNLOAD_RETENTION_MODE", "forever");
    expect(loadConfig).toThrow(/DOWNLOAD_RETENTION_MODE/);
  });
});
