import { describe, expect, it, vi } from "vitest";
import { DownloadService, EPHEMERAL_TTL_MS, MEANINGFUL_PLAYBACK_BYTES, RETAINED_TTL_MS } from "../src/download-service";
import { ActiveStreamError, NoSeedsError, RetentionConflictError, UnsafeFileSelectionError } from "../src/errors";
import { TriblerClient } from "../src/tribler-client";
import { TriblerStreamingMetrics } from "../src/tribler-streaming-metrics";
import { silentLogger, testConfig } from "./helpers";

const hash = "c".repeat(40);

describe("DownloadService", () => {
  it("waits for metadata, selects the main file and builds a local URL", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValueOnce(undefined).mockResolvedValue({
      infohash: hash, name: "movie", status: "DOWNLOADING", progress: 0, speed_down: 1,
      speed_up: 0, num_peers: 1, num_seeds: 1
    });
    vi.spyOn(client, "addDownload").mockResolvedValue({ started: true, infohash: hash });
    vi.spyOn(client, "getFiles")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { index: 0, name: "sample.mkv", size: 10, included: true, progress: 0 },
        { index: 1, name: "Feature.mp4", size: 1_000, included: true, progress: 0 }
      ]);
    const select = vi.spyOn(client, "selectFiles").mockResolvedValue();
    const metrics = new TriblerStreamingMetrics();
    const service = new DownloadService(client, testConfig(), silentLogger, Date.now, undefined, metrics);

    const resolved = await service.resolve(hash);

    expect(resolved.file.index).toBe(1);
    expect(resolved.url).toBe(`http://127.0.0.1:7000/play/${hash}/1/Feature.mp4`);
    expect(select).toHaveBeenCalledWith(hash, [1], undefined);
    expect(metrics.snapshot()).toMatchObject({ resolveCount: 1, metadataWaitCount: 1, fileSelectionCount: 1 });
  });

  it("reports a torrent with no seeds instead of waiting forever", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValue({
      infohash: hash, name: "dead", status: "DOWNLOADING", progress: 0, speed_down: 0,
      speed_up: 0, num_peers: 0, num_seeds: 0
    });
    vi.spyOn(client, "getFiles").mockResolvedValue([]);
    const service = new DownloadService(client, testConfig({ noSeedsTimeoutMs: 2 }), silentLogger);

    await expect(service.resolve(hash)).rejects.toBeInstanceOf(NoSeedsError);
  });

  it("inspects every video variant using metadata only and stops payload download", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValue(undefined);
    const add = vi.spyOn(client, "addDownload").mockResolvedValue({ started: true, infohash: hash });
    vi.spyOn(client, "getFiles").mockResolvedValue([
      { index: 0, name: "movie.720p.mp4", size: 700, included: true, progress: 0 },
      { index: 1, name: "movie.1080p.mkv", size: 1_500, included: true, progress: 0 },
      { index: 2, name: "readme.txt", size: 10, included: true, progress: 0 }
    ]);
    const select = vi.spyOn(client, "selectFiles").mockResolvedValue();
    const stop = vi.spyOn(client, "stopDownload").mockResolvedValue();
    const service = new DownloadService(client, testConfig(), silentLogger);

    const inspected = await service.inspect(hash);

    expect(inspected.files.map((file) => file.index)).toEqual([1, 0]);
    expect(add).toHaveBeenCalledWith(`magnet:?xt=urn:btih:${hash}`, undefined, { onlyMetadata: true });
    expect(select).toHaveBeenCalledWith(hash, [], undefined);
    expect(stop).toHaveBeenCalledWith(hash, undefined);
  });

  it("starts bridge-created downloads as EPHEMERAL and cleans only after the short TTL", async () => {
    let now = 1_000;
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValue(undefined);
    vi.spyOn(client, "addDownload").mockResolvedValue({ started: true, infohash: hash });
    vi.spyOn(client, "getFiles").mockResolvedValue([
      { index: 0, name: "feature.mkv", size: 1_000, included: true, progress: 0 }
    ]);
    vi.spyOn(client, "selectFiles").mockResolvedValue();
    const remove = vi.spyOn(client, "deleteDownload").mockResolvedValue();
    vi.spyOn(client, "listDownloads").mockResolvedValue([{ infohash: hash, name: "feature", status: "DOWNLOADING", progress: 0, speed_down: 0, speed_up: 0, num_peers: 0, num_seeds: 0 }]);
    const service = new DownloadService(client, testConfig(), silentLogger, () => now);
    await service.resolve(hash);
    expect((await service.diagnostics())[0]?.bridge).toMatchObject({ ownership: "BRIDGE_OWNED", retention: "EPHEMERAL" });
    service.beginStream(hash);
    now = EPHEMERAL_TTL_MS + 1_001;
    await expect(service.cleanupOldDownloads()).resolves.toBe(0);
    service.endStream(hash);
    now += EPHEMERAL_TTL_MS + 1;
    await expect(service.cleanupOldDownloads()).resolves.toBe(1);
    expect(remove).toHaveBeenCalledWith(hash, false);
  });

  it("never cleans EXTERNAL downloads, including active streams", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValue({ infohash: hash, name: "external", status: "DOWNLOADING", progress: 0, speed_down: 0, speed_up: 0, num_peers: 0, num_seeds: 0 });
    vi.spyOn(client, "getFiles").mockResolvedValue([{ index: 0, name: "external.mkv", size: 1_000, included: true, progress: 0 }]);
    vi.spyOn(client, "selectFiles").mockResolvedValue();
    const remove = vi.spyOn(client, "deleteDownload").mockResolvedValue();
    vi.spyOn(client, "listDownloads").mockResolvedValue([{ infohash: hash, name: "external", status: "DOWNLOADING", progress: 0, speed_down: 0, speed_up: 0, num_peers: 0, num_seeds: 0 }]);
    const service = new DownloadService(client, testConfig(), silentLogger, () => RETAINED_TTL_MS * 2);
    await service.resolve(hash);
    service.beginStream(hash);
    await expect(service.cleanupOldDownloads()).resolves.toBe(0);
    expect((await service.diagnostics())[0]?.bridge).toMatchObject({ ownership: "EXTERNAL", activeStreams: 1 });
    expect(() => service.pin(hash)).toThrow(RetentionConflictError);
    expect(remove).not.toHaveBeenCalled();
  });

  it("promotes meaningful smart playback, keeps tiny playback ephemeral, and honors mode and pin transitions", async () => {
    let now = 1_000;
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValue(undefined);
    vi.spyOn(client, "addDownload").mockResolvedValue({ started: true, infohash: hash });
    vi.spyOn(client, "getFiles").mockResolvedValue([{ index: 0, name: "feature.mkv", size: 10_000_000, included: true, progress: 0 }]);
    vi.spyOn(client, "selectFiles").mockResolvedValue();
    const remove = vi.spyOn(client, "deleteDownload").mockResolvedValue();
    vi.spyOn(client, "listDownloads").mockResolvedValue([{ infohash: hash, name: "feature", status: "DOWNLOADING", progress: 0, speed_down: 0, speed_up: 0, num_peers: 0, num_seeds: 0 }]);
    const service = new DownloadService(client, testConfig(), silentLogger, () => now);
    await service.resolve(hash);
    service.beginStream(hash); service.endStream(hash, 1);
    expect((await service.diagnostics())[0]?.bridge?.retention).toBe("EPHEMERAL");
    service.beginStream(hash); service.endStream(hash, MEANINGFUL_PLAYBACK_BYTES);
    expect((await service.diagnostics())[0]?.bridge?.retention).toBe("RETAINED");
    now += EPHEMERAL_TTL_MS + 1;
    await expect(service.cleanupOldDownloads()).resolves.toBe(0);
    now += RETAINED_TTL_MS;
    await expect(service.cleanupOldDownloads()).resolves.toBe(1);
    expect(remove).toHaveBeenCalledOnce();

    const ephemeral = new DownloadService(client, testConfig({ downloadRetentionMode: "ephemeral" }), silentLogger, () => now);
    await ephemeral.resolve(hash); ephemeral.beginStream(hash); ephemeral.endStream(hash, MEANINGFUL_PLAYBACK_BYTES);
    expect((await ephemeral.diagnostics())[0]?.bridge?.retention).toBe("EPHEMERAL");
    const keepAll = new DownloadService(client, testConfig({ downloadRetentionMode: "keep_all" }), silentLogger, () => now + RETAINED_TTL_MS * 2);
    await keepAll.resolve(hash);
    expect(keepAll.pin(hash)).toMatchObject({ retention: "PINNED" });
    expect(keepAll.unpin(hash)).toMatchObject({ retention: "RETAINED", lastAccess: now + RETAINED_TTL_MS * 2 });
    await expect(keepAll.cleanupOldDownloads()).resolves.toBe(0);
  });

  it("rejects manual deletion while a stream is active", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    const service = new DownloadService(client, testConfig(), silentLogger);
    service.beginStream(hash);
    await expect(service.cancelDownload(hash)).rejects.toBeInstanceOf(ActiveStreamError);
  });
  it("in balanced mode selects the video before resuming a metadata-only download", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        infohash: hash, name: "movie", status: "DOWNLOADING", progress: 0, speed_down: 0,
        speed_up: 0, num_peers: 0, num_seeds: 0
      })
      .mockResolvedValueOnce({
        infohash: hash, name: "movie", status: "STOPPED", progress: 0, speed_down: 0,
        speed_up: 0, num_peers: 0, num_seeds: 0
      });
    const add = vi.spyOn(client, "addDownload").mockResolvedValue({ started: true, infohash: hash });
    vi.spyOn(client, "getFiles").mockResolvedValue([
      { index: 0, name: "installer.exe", size: 50, included: true, progress: 0 },
      { index: 1, name: "Feature.mkv", size: 1_000, included: true, progress: 0 }
    ]);
    const select = vi.spyOn(client, "selectFiles").mockResolvedValue();
    const resume = vi.spyOn(client, "resumeDownload").mockResolvedValue();
    const service = new DownloadService(client, testConfig({ torrentSafetyMode: "balanced" }), silentLogger);

    await service.resolve(hash);

    expect(add).toHaveBeenCalledWith(`magnet:?xt=urn:btih:${hash}`, undefined, { onlyMetadata: true });
    expect(select).toHaveBeenCalledWith(hash, [1], undefined);
    expect(resume).toHaveBeenCalledWith(hash, undefined);
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(resume.mock.invocationCallOrder[0] ?? 0);
  });

  it("refuses an explicitly selected executable without rejecting the torrent itself", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    vi.spyOn(client, "getDownload").mockResolvedValue({
      infohash: hash, name: "bundle", status: "DOWNLOADING", progress: 0, speed_down: 1,
      speed_up: 0, num_peers: 1, num_seeds: 1
    });
    vi.spyOn(client, "getFiles").mockResolvedValue([
      { index: 0, name: "Feature.mp4", size: 1_000, included: true, progress: 0 },
      { index: 1, name: "setup.exe", size: 100, included: true, progress: 0 }
    ]);
    const service = new DownloadService(client, testConfig(), silentLogger);

    await expect(service.resolve(hash, 1)).rejects.toBeInstanceOf(UnsafeFileSelectionError);
  });

  it("selects HTTP torrent files immediately without waiting for a metadata stop", async () => {
    const client = new TriblerClient("http://127.0.0.1:9999", "key", 100);
    const add = vi.spyOn(client, "addDownload").mockResolvedValue({ started: true, infohash: hash });
    vi.spyOn(client, "getFiles").mockResolvedValue([
      { index: 3, name: "Archive_Feature.mp4", size: 1_000, included: true, progress: 0 }
    ]);
    const select = vi.spyOn(client, "selectFiles").mockResolvedValue();
    const resume = vi.spyOn(client, "resumeDownload").mockResolvedValue();
    const service = new DownloadService(client, testConfig({ torrentSafetyMode: "balanced" }), silentLogger);

    await service.resolve("https://archive.example/item/archive.torrent");

    expect(add).toHaveBeenCalledWith(
      "https://archive.example/item/archive.torrent",
      undefined,
      { onlyMetadata: false }
    );
    expect(select).toHaveBeenCalledWith(hash, [3], undefined);
    expect(resume).not.toHaveBeenCalled();
  });
});
