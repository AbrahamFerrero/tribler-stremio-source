// tracker observer observes a tracker announce, not peer/piece anonymity.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { extractInfohash } from "../src/source.ts";
import { TriblerClient } from "../src/tribler-client.ts";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const samePath = (a, b) => typeof a === "string" && typeof b === "string" &&
  (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const ownedAt = (download, directory) => download && samePath(download.destination, directory) &&
  samePath(download.completed_dir, directory);

export function validateTrackerObservationMagnet(value) {
  if (typeof value !== "string" || value.length > 8192 || !/^magnet:\?/i.test(value)) return undefined;
  const hash = extractInfohash(value);
  if (!hash) return undefined;
  const params = new URLSearchParams(value.slice(value.indexOf("?") + 1));
  const trackers = params.getAll("tr").map((tracker) => {
    try {
      const url = new URL(tracker);
      return ["http:", "https:", "udp:"].includes(url.protocol) && url.hostname ? url.hostname : undefined;
    } catch { return undefined; }
  });
  if (!trackers.length || trackers.some((host) => !host)) return undefined;
  return { infoHash: hash, trackerHostnames: trackers };
}

// Tribler's /api/downloads exposes tracker replies, but its raw status can contain URLs or tokens.
export function classifyTrackerObservationTracker(trackers, magnetTrackerHostnames) {
  if (!Array.isArray(trackers)) return "UNKNOWN";
  const matching = trackers.filter((tracker) => {
    if (typeof tracker?.url !== "string") return false;
    try { return magnetTrackerHostnames.has(new URL(tracker.url).hostname); }
    catch { return false; }
  });
  if (!matching.length) return "UNKNOWN";
  if (matching.some(({ status }) => status === "Working")) return "REPLIED";
  if (matching.some(({ status }) => typeof status === "string" &&
      /^(?:Error:|HTTP status code|Timeout|Not working|Warning:)/.test(status))) return "ERROR";
  if (matching.every(({ status }) => status === "Not contacted yet")) return "PENDING";
  return "UNKNOWN";
}

export function classifyTrackerObservationAddress(reference, observed) {
  if (isIP(reference ?? "") !== 4 || !isIP(observed ?? "")) {
    return { addressClass: null, result: "INCONCLUSIVE" };
  }
  if (isIP(observed) !== 4) return { addressClass: null, result: "INCONCLUSIVE" };
  return observed === reference
    ? { addressClass: "USER_IP", result: "FAIL" }
    : { addressClass: "OTHER_IP", result: "PASS" };
}

export async function obtainPublicIp(fetcher = fetch) {
  const endpoints = ["https://api4.ipify.org", "https://checkip.amazonaws.com"];
  const values = [];
  for (const endpoint of endpoints) {
    const response = await fetcher(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("PUBLIC_IP_REFERENCE_INCONCLUSIVE");
    const value = (await response.text()).trim();
    if (isIP(value) !== 4) throw new Error("PUBLIC_IP_REFERENCE_INCONCLUSIVE");
    values.push(value);
  }
  if (values[0] !== values[1]) throw new Error("PUBLIC_IP_REFERENCE_INCONCLUSIVE");
  return values[0];
}

// Raw TTY mode prevents the magnet and observed address from being echoed.
export function readHiddenLine(prompt, maximum, input = process.stdin, output = process.stdout,
  timeoutMs = 300_000) {
  if (!input.isTTY || !input.setRawMode) {
    return Promise.reject(new Error("INTERACTIVE_TERMINAL_REQUIRED"));
  }
  output.write(prompt);
  return new Promise((done, fail) => {
    let value = "";
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      input.removeListener("data", receive);
      input.pause();
      input.setRawMode(false);
      output.write("\n");
      if (error) fail(error); else done(value);
    };
    const receive = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("ABORTED"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
        value += String.fromCharCode(byte);
        if (value.length > maximum) return finish(new Error("INPUT_TOO_LONG"));
      }
    };
    input.setRawMode(true);
    input.on("data", receive);
    input.resume();
    timer = setTimeout(() => finish(new Error("INPUT_TIMEOUT")), timeoutMs);
  });
}

export async function runTrackerObservationTest({
  client, config, ask = readHiddenLine, reference = obtainPublicIp,
  write = (line) => process.stdout.write(line + "\n"), wait = pause,
  root = process.cwd(), runId = randomBytes(12).toString("hex")
}) {
  const report = {
    test: "tracker-observation-torrent-address", triblerAvailable: false,
    anonymityConfigurationVerified: false, effectiveHops: null,
    publicIpReferenceObtained: false, magnetValid: false, infoHashPresent: false,
    trackerCount: 0, downloadRegistered: false, trackerStatus: "UNKNOWN",
    externalObservationReceived: false,
    addressClass: null, result: "INCONCLUSIVE", downloadRemoved: false,
    temporaryDirectoryRemoved: false, cleanup: "OK", errorCode: null
  };
  let infoHash, cleanupHash, directory, directoryCreated = false;
  let submitted = false, createdByThisRun = false;
  try {
    try { await client.listDownloads(); report.triblerAvailable = true; }
    catch { throw new Error("TRIBLER_UNAVAILABLE"); }
    let defaults;
    try { defaults = await client.getAnonymityDefaults(); }
    catch { throw new Error("ANONYMITY_CONFIGURATION_UNVERIFIED"); }
    if (!defaults?.enabled || !Number.isSafeInteger(defaults.hops) ||
        defaults.hops < 1 || defaults.safeSeeding !== true) {
      throw new Error("ANONYMITY_CONFIGURATION_UNVERIFIED");
    }
    report.anonymityConfigurationVerified = true;
    report.effectiveHops = defaults.hops;
    write("triblerAvailable: yes; anonymityConfigurationVerified: yes; effectiveHops: " + defaults.hops);

    let userPublicIp;
    try { userPublicIp = await reference(); }
    catch { throw new Error("PUBLIC_IP_REFERENCE_INCONCLUSIVE"); }
    if (isIP(userPublicIp) !== 4) throw new Error("PUBLIC_IP_REFERENCE_INCONCLUSIVE");
    report.publicIpReferenceObtained = true;
    write("publicIpReferenceObtained: yes");

    write("Open tracker observer -> Torrent Address detection -> Activate -> Copy magnet -> Paste here.");
    const magnet = await ask("Magnet (hidden): ", 8192);
    const parsed = validateTrackerObservationMagnet(magnet);
    if (!parsed) throw new Error("INVALID_TRACKER_OBSERVATION_MAGNET");
    infoHash = parsed.infoHash;
    cleanupHash = infoHash;
    const magnetTrackerHostnames = new Set(parsed.trackerHostnames);
    report.magnetValid = true; report.infoHashPresent = true;
    report.trackerCount = parsed.trackerHostnames.length;
    write("magnetValid: yes; infoHashPresent: yes; trackerCount: " + report.trackerCount);
    if (await client.getDownload(infoHash)) throw new Error("TEST_DOWNLOAD_ALREADY_EXISTS");

    directory = resolve(root, ".inspection-work", "privacy-tracker-observation", runId);
    const parent = dirname(directory);
    await mkdir(parent, { recursive: true });
    if (!samePath(await realpath(parent), parent)) throw new Error("UNSAFE_TEST_DESTINATION");
    await mkdir(directory);
    directoryCreated = true;
    if (await client.getDownload(infoHash)) throw new Error("TEST_DOWNLOAD_ALREADY_EXISTS");

    // Production calls this same client method without anon_hops/safe_seeding overrides.
    // Only the destination is isolated; balanced mode keeps its metadata-only start.
    submitted = true;
    const added = await client.addDownload(magnet, undefined, {
      onlyMetadata: config.torrentSafetyMode === "balanced",
      destination: directory, completedDir: directory
    });
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(added.infohash ?? "")) {
      cleanupHash = added.infohash.toLowerCase();
    }
    if (added.started !== true || added.infohash?.toLowerCase() !== infoHash) {
      throw new Error("TEST_DOWNLOAD_REGISTRATION_UNVERIFIED");
    }
    write("Waiting for external tracker observation...");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const download = await client.getDownload(infoHash);
      if (download) {
        if (!ownedAt(download, directory)) throw new Error("TEST_DOWNLOAD_OWNERSHIP_UNVERIFIED");
        createdByThisRun = true;
        if (download.hops !== defaults.hops || download.anon_download !== true ||
            download.safe_seeding !== true) {
          throw new Error("ANONYMITY_CONFIGURATION_UNVERIFIED");
        }
        if (typeof download.status !== "string" || download.status.toUpperCase().includes("ERROR")) {
          throw new Error("TRIBLER_DOWNLOAD_ERROR");
        }
        report.downloadRegistered = true;
        break;
      }
      await wait(3000);
    }
    if (!report.downloadRegistered) throw new Error("TRIBLER_REGISTRATION_TIMEOUT");
    // Keep this download active while Tribler has a bounded chance to announce.
    for (let poll = 0; poll < 18; poll++) {
      const download = await client.getDownload(infoHash);
      if (!ownedAt(download, directory)) throw new Error("TEST_DOWNLOAD_OWNERSHIP_UNVERIFIED");
      if (download.hops !== defaults.hops || download.anon_download !== true ||
          download.safe_seeding !== true) throw new Error("ANONYMITY_CONFIGURATION_UNVERIFIED");
      if (typeof download.status !== "string" || download.status.toUpperCase().includes("ERROR")) {
        throw new Error("TRIBLER_DOWNLOAD_ERROR");
      }
      report.trackerStatus = classifyTrackerObservationTracker(download.trackers, magnetTrackerHostnames);
      if (report.trackerStatus === "REPLIED") break;
      await wait(5_000);
    }
    write("trackerStatus: " + report.trackerStatus);
    write("Return to tracker observer. Wait for Torrent Address detection; paste ONLY its IP (Enter if none).");
    const observed = (await ask("Observed IP (hidden; Enter if none): ", 64)).trim();
    const classification = classifyTrackerObservationAddress(userPublicIp, observed);
    report.externalObservationReceived = Boolean(isIP(observed));
    report.addressClass = classification.addressClass;
    report.result = classification.result;
    if (report.result === "FAIL") write("CRITICAL PRIVACY FINDING: tracker observed USER_IP.");
  } catch (error) {
    report.errorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message : "TEST_ERROR";
  } finally {
    if (submitted && cleanupHash && directory) {
      try {
        const download = await client.getDownload(cleanupHash);
        if (ownedAt(download, directory)) createdByThisRun = true;
        if (createdByThisRun && ownedAt(download, directory)) {
          await client.deleteDownload(cleanupHash, true);
          report.downloadRemoved = !(await client.getDownload(cleanupHash));
        } else if (!download) {
          report.downloadRemoved = true;
        } else {
          report.cleanup = "CLEANUP_FAILED";
        }
      } catch { report.cleanup = "CLEANUP_FAILED"; }
    }
    if (directoryCreated) {
      try {
        if (samePath(await realpath(dirname(directory)), dirname(directory))) {
          let entry, safeEntry = true;
          try { entry = await lstat(directory); } catch (error) {
            if (error.code !== "ENOENT") safeEntry = false;
          }
          if (safeEntry && (!entry || (entry.isDirectory() && !entry.isSymbolicLink() &&
              samePath(await realpath(directory), directory)))) {
            await rm(directory, { recursive: true, force: true });
          }
          try { await stat(directory); } catch (error) {
            if (error.code === "ENOENT") report.temporaryDirectoryRemoved = true;
          }
        }
        if (!report.temporaryDirectoryRemoved) report.cleanup = "CLEANUP_FAILED";
      } catch { report.cleanup = "CLEANUP_FAILED"; }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try {
    const config = loadConfig();
    const client = new TriblerClient(config.triblerUrl, config.triblerApiKey, config.streamHeaderTimeoutMs);
    report = await runTrackerObservationTest({ client, config });
  } catch {
    report = { test: "tracker-observation-torrent-address", result: "INCONCLUSIVE",
      errorCode: "PROJECT_CONFIGURATION_UNAVAILABLE" };
  }
  process.stdout.write(JSON.stringify(report) + "\n");
  process.stdout.write("tracker observer tracker observation only; peer/piece anonymity is not proven. Result: " + report.result + ".\n");
  if (report.cleanup === "CLEANUP_FAILED") process.stdout.write("CLEANUP_FAILED\n");
  process.exitCode = report.result === "FAIL" || report.errorCode ||
    report.cleanup === "CLEANUP_FAILED" ? 1 : 0;
}
