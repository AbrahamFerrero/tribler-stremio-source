import { describe, expect, it, vi } from "vitest";
import { ExternalUrlPolicy, fetchWithValidatedRedirects } from "../src/network/url-policy";

const publicResolver = (hostname: string) => Promise.resolve([{
  address: hostname === "private.example" ? "10.0.0.5" : "93.184.216.34",
  family: 4
}]);

describe("external URL policy", () => {
  const policy = new ExternalUrlPolicy({ resolver: publicResolver });

  it.each([
    "http://127.0.0.1/x", "http://localhost/x", "http://[::1]/x",
    "http://192.168.1.2/x", "http://10.1.2.3/x", "http://172.16.2.3/x",
    "http://169.254.169.254/latest", "file:///etc/passwd", "gopher://example.com/x",
    "http://[::ffff:127.0.0.1]/x", "data:text/plain,test", "javascript:alert(1)", "ws://example.com"
  ])("rejects %s", async (url) => {
    await expect(policy.validate(url)).rejects.toThrow();
  });

  it("rejects a public hostname when DNS resolves it privately", async () => {
    await expect(policy.validate("https://private.example/video")).rejects.toThrow(/private|reserved/);
  });

  it("allows only the exact explicitly trusted loopback provider URL", async () => {
    const localPolicy = new ExternalUrlPolicy({
      resolver: (hostname) => Promise.resolve([{
        address: hostname === "localhost" ? "127.0.0.1" : "93.184.216.34",
        family: 4
      }]),
      allowedLoopbackUrls: ["http://127.0.0.1:7100/resolve"]
    });
    await expect(localPolicy.validate("http://127.0.0.1:7100/resolve")).resolves.toBeInstanceOf(URL);
    await expect(localPolicy.validate("http://127.0.0.1:7100/other")).rejects.toThrow(/private|reserved/);
    await expect(localPolicy.validate("http://127.0.0.1:7200/resolve")).rejects.toThrow(/private|reserved/);
  });

  it("continues to validate an allowlisted public provider as a normal public URL", async () => {
    const publicPolicy = new ExternalUrlPolicy({
      resolver: publicResolver,
      allowedLoopbackUrls: ["https://provider.example/resolve"]
    });
    await expect(publicPolicy.validate("https://provider.example/resolve")).resolves.toBeInstanceOf(URL);
  });

  it("never lets the trusted provider exception override blocked bridge or Tribler endpoints", async () => {
    const localPolicy = new ExternalUrlPolicy({
      blockedEndpoints: [{ hostname: "127.0.0.1", port: "54528" }],
      allowedLoopbackUrls: ["http://127.0.0.1:54528/api/downloads"]
    });
    await expect(localPolicy.validate("http://127.0.0.1:54528/api/downloads"))
      .rejects.toThrow(/internal service/);
  });

  it("validates every redirect and blocks a public-to-localhost redirect", async () => {
    const mockedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1:54528/api/downloads" }
    }));
    await expect(fetchWithValidatedRedirects(
      "https://public.example/video", policy, {}, mockedFetch
    )).rejects.toThrow(/private|reserved/);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("removes the loopback exception when a trusted provider redirects elsewhere", async () => {
    const localPolicy = new ExternalUrlPolicy({
      allowedLoopbackUrls: ["http://127.0.0.1:7100/resolve"]
    });
    const mockedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1:7000/health" }
    }));
    await expect(fetchWithValidatedRedirects(
      "http://127.0.0.1:7100/resolve", localPolicy, {}, mockedFetch
    )).rejects.toThrow(/private|reserved/);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("limits redirect chains", async () => {
    const mockedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "/again" }
    }));
    await expect(fetchWithValidatedRedirects(
      "https://public.example/start", policy, {}, mockedFetch, 2
    )).rejects.toThrow(/redirect limit/);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });
});
