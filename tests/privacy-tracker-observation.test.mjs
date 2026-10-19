import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  classifyTrackerObservationAddress, classifyTrackerObservationTracker, readHiddenLine, runTrackerObservationTest,
  validateTrackerObservationMagnet
} from "../scripts/privacy-tracker-observation.mjs";

const hash = "a".repeat(40);
const magnet = "magnet:" + "?xt=urn:btih:" + hash + "&tr=" +
  encodeURIComponent("https://tracker.example/announce?token=example-token");
const trackerUrl = "https://tracker.example/announce?token=example-token";
const reference = "198.51.100.20";
const other = "203.0.113.9";
const config = { torrentSafetyMode: "balanced" };

function fixture({ defaults = { enabled: true, hops: 2, safeSeeding: true },
  existing = false, wrongOwner = false, wrongReturnedHash = false,
  trackerState = "Not contacted yet" } = {}) {
  const downloads = new Map();
  if (existing) downloads.set(hash, { infohash: hash, destination: "existing" });
  downloads.set("b".repeat(40), { infohash: "b".repeat(40), destination: "other" });
  const client = {
    listDownloads: vi.fn(() => Promise.resolve([...downloads.values()])),
    getAnonymityDefaults: vi.fn(() => Promise.resolve(defaults)),
    getDownload: vi.fn((id) => Promise.resolve(downloads.get(id))),
    addDownload: vi.fn(async (_input, _signal, options) => {
      const returnedHash = wrongReturnedHash ? "c".repeat(40) : hash;
      downloads.set(returnedHash, {
        infohash: returnedHash, status: "DOWNLOADING", hops: 2, anon_download: true,
        safe_seeding: true, destination: wrongOwner ? "other" : options.destination,
        completed_dir: wrongOwner ? "other" : options.completedDir,
        trackers: [{ url: trackerUrl, status: trackerState }]
      });
      return { started: true, infohash: returnedHash };
    }),
    deleteDownload: vi.fn(async (id) => { downloads.delete(id); })
  };
  return { client, downloads };
}

async function execute(options = {}) {
  const { client, downloads } = fixture(options);
  const output = [];
  const wait = vi.fn(() => Promise.resolve());
  const asks = vi.fn((prompt) => Promise.resolve(prompt.startsWith("Magnet") ? magnet : (options.observed ?? other)));
  const report = await runTrackerObservationTest({
    client, config, ask: asks,
    reference: options.noReference ? () => Promise.reject(new Error("offline")) : () => Promise.resolve(reference),
    wait, write: (line) => output.push(line)
  });
  return { report, client, downloads, asks, wait, output: output.join("\n") };
}

describe("privacy:tracker-observation", () => {
  it("validates btih and trackers without returning tracker query strings", () => {
    expect(validateTrackerObservationMagnet(magnet)).toEqual({
      infoHash: hash, trackerHostnames: ["tracker.example"]
    });
    expect(validateTrackerObservationMagnet("magnet:" + "?xt=urn:btih:" + hash)).toBeUndefined();
    expect(validateTrackerObservationMagnet("http://tracker.example")).toBeUndefined();
  });

  it("classifies only the magnet tracker and never returns its raw status", () => {
    const hostnames = new Set(["tracker.example"]);
    expect(classifyTrackerObservationTracker([{ url: trackerUrl, status: "Not contacted yet" }], hostnames))
      .toBe("PENDING");
    expect(classifyTrackerObservationTracker([{ url: trackerUrl, status: "Working" }], hostnames))
      .toBe("REPLIED");
    expect(classifyTrackerObservationTracker([{ url: trackerUrl,
      status: "Error: example-token refused" }], hostnames)).toBe("ERROR");
    expect(classifyTrackerObservationTracker([{ url: "https://unrelated.example/announce", status: "Working" }], hostnames))
      .toBe("UNKNOWN");
  });

  it("keeps a pending tracker active for the bounded observation window", async () => {
    const run = await execute({ observed: "" });
    expect(run.report).toMatchObject({ trackerStatus: "PENDING", result: "INCONCLUSIVE",
      downloadRemoved: true, cleanup: "OK" });
    expect(run.wait).toHaveBeenCalledTimes(18);
    expect(run.wait.mock.calls.every(([ms]) => ms === 5_000)).toBe(true);
    expect(run.output).toContain("trackerStatus: PENDING");
  });

  it("prompts once Tribler reports a tracker reply", async () => {
    const run = await execute({ trackerState: "Working", observed: "" });
    expect(run.report).toMatchObject({ trackerStatus: "REPLIED", result: "INCONCLUSIVE" });
    expect(run.wait).not.toHaveBeenCalled();
  });

  it("reports a tracker error without exposing its URL, token or REST message", async () => {
    const run = await execute({ trackerState: "Error: example-token refused", observed: "" });
    expect(run.report).toMatchObject({ trackerStatus: "ERROR", result: "INCONCLUSIVE",
      cleanup: "OK" });
    const all = run.output + JSON.stringify(run.report);
    expect(all).not.toContain(trackerUrl);
    expect(all).not.toContain("example-token");
    expect(all).not.toContain(hash);
  });

  it("reads the magnet from a raw terminal without echoing it", async () => {
    const input = new EventEmitter();
    input.isTTY = true;
    input.setRawMode = vi.fn();
    input.pause = vi.fn();
    input.resume = vi.fn();
    const output = { write: vi.fn() };
    const line = readHiddenLine("Magnet (hidden): ", 8192, input, output);
    input.emit("data", Buffer.from(magnet + "\r"));
    expect(await line).toBe(magnet);
    expect(input.setRawMode.mock.calls.map(([mode]) => mode)).toEqual([true, false]);
    expect(output.write.mock.calls.map(([value]) => value).join("")).not.toContain(magnet);
  });

  it("times out a forgotten hidden prompt and restores terminal mode", async () => {
    const input = new EventEmitter();
    input.isTTY = true;
    input.setRawMode = vi.fn();
    input.pause = vi.fn();
    input.resume = vi.fn();
    await expect(readHiddenLine("IP (hidden): ", 64, input, { write: vi.fn() }, 5))
      .rejects.toThrow("INPUT_TIMEOUT");
    expect(input.setRawMode.mock.calls.map(([mode]) => mode)).toEqual([true, false]);
  });

  it.each([
    [reference, "USER_IP", "FAIL"],
    [other, "OTHER_IP", "PASS"],
    ["not-an-ip", null, "INCONCLUSIVE"],
    ["2001:db8::1", null, "INCONCLUSIVE"]
  ])("classifies an observation without exposing its address", (observed, addressClass, result) => {
    expect(classifyTrackerObservationAddress(reference, observed)).toEqual({ addressClass, result });
  });

  it("returns INCONCLUSIVE before asking for a magnet if public reference is unavailable", async () => {
    const run = await execute({ noReference: true });
    expect(run.report).toMatchObject({
      result: "INCONCLUSIVE", errorCode: "PUBLIC_IP_REFERENCE_INCONCLUSIVE",
      publicIpReferenceObtained: false
    });
    expect(run.asks).not.toHaveBeenCalled();
    expect(run.client.addDownload).not.toHaveBeenCalled();
  });

  it("aborts on a preexisting infohash and never deletes it", async () => {
    const run = await execute({ existing: true });
    expect(run.report.errorCode).toBe("TEST_DOWNLOAD_ALREADY_EXISTS");
    expect(run.client.addDownload).not.toHaveBeenCalled();
    expect(run.client.deleteDownload).not.toHaveBeenCalled();
    expect(run.downloads.has(hash)).toBe(true);
  });

  it("uses production's default hops and metadata mode, then deletes only this run's download", async () => {
    const run = await execute();
    expect(run.report).toMatchObject({
      anonymityConfigurationVerified: true, effectiveHops: 2,
      downloadRegistered: true, addressClass: "OTHER_IP", result: "PASS",
      downloadRemoved: true, temporaryDirectoryRemoved: true, cleanup: "OK"
    });
    const options = run.client.addDownload.mock.calls[0][2];
    expect(options).toMatchObject({ onlyMetadata: true });
    expect(options).not.toHaveProperty("anonHops");
    expect(options).not.toHaveProperty("safeSeeding");
    expect(run.client.deleteDownload).toHaveBeenCalledOnce();
    expect(run.client.deleteDownload).toHaveBeenCalledWith(hash, true);
    expect(run.downloads.has("b".repeat(40))).toBe(true);
  });

  it("does not delete a same-hash download whose destination does not match this run", async () => {
    const run = await execute({ wrongOwner: true });
    expect(run.report).toMatchObject({
      result: "INCONCLUSIVE", errorCode: "TEST_DOWNLOAD_OWNERSHIP_UNVERIFIED",
      cleanup: "CLEANUP_FAILED", temporaryDirectoryRemoved: true
    });
    expect(run.client.deleteDownload).not.toHaveBeenCalled();
  });

  it("cleans the exact isolated download even if Tribler returns an unexpected hash", async () => {
    const run = await execute({ wrongReturnedHash: true });
    expect(run.report.errorCode).toBe("TEST_DOWNLOAD_REGISTRATION_UNVERIFIED");
    expect(run.client.deleteDownload).toHaveBeenCalledWith("c".repeat(40), true);
    expect(run.downloads.has("c".repeat(40))).toBe(false);
    expect(run.downloads.has("b".repeat(40))).toBe(true);
  });

  it.each([
    [{ enabled: false, hops: 0, safeSeeding: true }],
    [{ enabled: true, hops: 0, safeSeeding: true }],
    [{ enabled: true, hops: 2, safeSeeding: false }],
    [null]
  ])("aborts before adding if anonymous defaults are unverified or unsafe", async (defaults) => {
    const run = await execute({ defaults });
    expect(run.report.errorCode).toBe("ANONYMITY_CONFIGURATION_UNVERIFIED");
    expect(run.asks).not.toHaveBeenCalled();
    expect(run.client.addDownload).not.toHaveBeenCalled();
  });

  it("never writes API keys, magnets, infohashes, tracker tokens or raw addresses", async () => {
    const run = await execute({ observed: reference });
    const all = run.output + JSON.stringify(run.report);
    expect(run.report).toMatchObject({ addressClass: "USER_IP", result: "FAIL" });
    expect(all).toContain("CRITICAL PRIVACY FINDING");
    for (const secret of ["fixture-api-key", magnet, hash, "example-token", reference, other]) {
      expect(all).not.toContain(secret);
    }
  });

  it("sanitizes a REST error containing an API key before writing the report", async () => {
    const { client } = fixture();
    client.getAnonymityDefaults.mockRejectedValue(new Error("fixture-api-key"));
    const output = [];
    const report = await runTrackerObservationTest({
      client, config, ask: vi.fn(), reference: vi.fn(), write: (line) => output.push(line)
    });
    expect(report.errorCode).toBe("ANONYMITY_CONFIGURATION_UNVERIFIED");
    expect(output.join("\n") + JSON.stringify(report)).not.toContain("fixture-api-key");
    expect(client.addDownload).not.toHaveBeenCalled();
  });

  it("treats malformed observed addresses as INCONCLUSIVE", async () => {
    const run = await execute({ observed: "none shown" });
    expect(run.report).toMatchObject({
      result: "INCONCLUSIVE", externalObservationReceived: false, addressClass: null
    });
  });
});
