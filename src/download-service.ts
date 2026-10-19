import { ActiveStreamError, ManagedDownloadNotFoundError, MetadataTimeoutError, NoSeedsError, NoVideoFileError, RetentionConflictError, TriblerError, UnsafeFileSelectionError } from "./errors";
import { safeErrorDetails, type Logger } from "./logger";
import type { ManagedDownloadStore } from "./managed-download-store";
import { extractInfohash, normalizeTorrentSource } from "./source";
import { TriblerClient } from "./tribler-client";
import type { TriblerStreamingMetrics } from "./tribler-streaming-metrics";
import type { AppConfig, DownloadOwnership, ManagedDownload, TriblerDownload, TriblerFile } from "./types";
import { isDangerousFile, listVideoFiles, selectMainVideo } from "./video-selection";

export interface ResolvedStream {
  infohash: string;
  file: TriblerFile;
  url: string;
}

export interface PreferredFile {
  name: string;
  size: number;
}

export interface TorrentInspection {
  infohash: string;
  files: TriblerFile[];
}

export const EPHEMERAL_TTL_MS = 30 * 60 * 1_000;
export const RETAINED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MEANINGFUL_PLAYBACK_BYTES = 4 * 1024 * 1024;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const abortError = (): Error => signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DownloadService {
  private readonly managed = new Map<string, ManagedDownload>();
  private readonly sourceHashes = new Map<string, string>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly client: TriblerClient,
    private readonly config: AppConfig,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly store?: ManagedDownloadStore,
    private readonly metrics?: TriblerStreamingMetrics
  ) {
    for (const record of store?.load() ?? []) this.managed.set(record.infohash.toLowerCase(), record);
  }

  private persist(): void {
    this.store?.save([...this.managed.values()]);
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    void this.cleanupOldDownloads().catch((error: unknown) => {
      this.log.error("Initial download cleanup failed", { error: safeErrorDetails(error) });
    });
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOldDownloads().catch((error: unknown) => {
        this.log.error("Download cleanup failed", { error: safeErrorDetails(error) });
      });
    }, this.config.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private remember(infohash: string, ownership: DownloadOwnership): ManagedDownload {
    const normalized = infohash.toLowerCase();
    const existing = this.managed.get(normalized);
    if (existing) {
      existing.lastAccess = this.now();
      this.persist();
      return existing;
    }
    const record: ManagedDownload = {
      infohash: normalized,
      createdAt: this.now(),
      lastAccess: this.now(),
      ownership,
      ...(ownership === "BRIDGE_OWNED" ? { retention: "EPHEMERAL" as const } : {}),
      servedBytes: 0,
      activeStreams: 0
    };
    this.managed.set(normalized, record);
    this.persist();
    return record;
  }

  private async ensureDownload(
    source: string,
    signal?: AbortSignal,
    forceMetadataOnly = false
  ): Promise<{ infohash: string; ownership: DownloadOwnership; metadataOnly: boolean; needsResume: boolean }> {
    const expectedInfohash = extractInfohash(source);
    const rememberedInfohash = this.sourceHashes.get(source);
    if (rememberedInfohash) {
      const existing = await this.client.getDownload(rememberedInfohash, signal);
      if (existing) {
        const ownership = this.managed.get(rememberedInfohash)?.ownership ?? "EXTERNAL";
        return {
          infohash: rememberedInfohash,
          ownership,
          metadataOnly: false,
          needsResume: ownership === "BRIDGE_OWNED" && existing.status.toUpperCase() === "STOPPED"
        };
      }
      this.sourceHashes.delete(source);
    }
    if (expectedInfohash) {
      const existing = await this.client.getDownload(expectedInfohash, signal);
      if (existing) {
        this.log.info("Using existing Tribler download", { infohash: expectedInfohash });
        const ownership = this.managed.get(expectedInfohash)?.ownership ?? "EXTERNAL";
        return {
          infohash: expectedInfohash,
          ownership,
          metadataOnly: false,
          needsResume: ownership === "BRIDGE_OWNED" && existing.status.toUpperCase() === "STOPPED"
        };
      }
    }

    try {
      const metadataOnly = forceMetadataOnly || (
        this.config.torrentSafetyMode === "balanced" && source.toLowerCase().startsWith("magnet:?")
      );
      const added = await this.client.addDownload(source, signal, { onlyMetadata: metadataOnly });
      this.sourceHashes.set(source, added.infohash.toLowerCase());
      this.log.info("Torrent submitted to Tribler", {
        infohash: added.infohash,
        safetyMode: this.config.torrentSafetyMode,
        metadataOnly
      });
      return { infohash: added.infohash.toLowerCase(), ownership: "BRIDGE_OWNED", metadataOnly, needsResume: false };
    } catch (error) {
      if (expectedInfohash && error instanceof TriblerError) {
        const racedDownload = await this.client.getDownload(expectedInfohash, signal);
        if (racedDownload) return { infohash: expectedInfohash, ownership: "EXTERNAL", metadataOnly: false, needsResume: false };
      }
      throw error;
    }
  }

  private async waitForMetadataStop(infohash: string, signal?: AbortSignal): Promise<void> {
    const startedAt = this.now();
    const timeoutMs = Math.min(this.config.metadataTimeoutMs, 10_000);
    while (this.now() - startedAt < timeoutMs) {
      const download = await this.client.getDownload(infohash, signal);
      if (!download) throw new TriblerError(`Tribler download ${infohash} disappeared before resume`);
      if (download.error || download.status.toUpperCase() === "STOPPED_ON_ERROR") {
        throw new TriblerError(`Tribler download failed: ${download.error ?? download.status}`);
      }
      if (download.status.toUpperCase() === "STOPPED") return;
      await delay(Math.min(this.config.pollIntervalMs, 100), signal);
    }
    throw new MetadataTimeoutError(infohash, timeoutMs);
  }

  private async waitForFiles(infohash: string, signal?: AbortSignal): Promise<TriblerFile[]> {
    const startedAt = this.now();
    while (this.now() - startedAt < this.config.metadataTimeoutMs) {
      let files: TriblerFile[] = [];
      try {
        files = await this.client.getFiles(infohash, signal);
      } catch (error) {
        if (!(error instanceof TriblerError) || error.status !== 404) throw error;
      }
      if (files.length > 0) return files;

      const download = await this.client.getDownload(infohash, signal);
      if (download?.error) throw new TriblerError(`Tribler download failed: ${download.error}`);
      const status = download?.status.toUpperCase() ?? "";
      if (status.includes("ERROR")) throw new TriblerError(`Tribler download entered ${download?.status ?? "error"}`);
      const elapsed = this.now() - startedAt;
      if (download && elapsed >= this.config.noSeedsTimeoutMs && download.num_seeds === 0 && download.num_peers === 0) {
        throw new NoSeedsError(infohash, this.config.noSeedsTimeoutMs);
      }
      await delay(this.config.pollIntervalMs, signal);
    }
    throw new MetadataTimeoutError(infohash, this.config.metadataTimeoutMs);
  }

  private bridgeUrl(infohash: string, file: TriblerFile): string {
    const filename = encodeURIComponent(file.name.split(/[\\/]/).pop() ?? "video");
    return `${this.config.publicBaseUrl}/play/${infohash}/${file.index}/${filename}`;
  }

  async inspect(sourceInput: string, signal?: AbortSignal): Promise<TorrentInspection> {
    const source = normalizeTorrentSource(sourceInput);
    const { infohash, ownership } = await this.ensureDownload(source, signal, true);
    const record = this.remember(infohash, ownership);
    const files = await this.waitForFiles(infohash, signal);
    const videos = listVideoFiles(files);
    if (ownership === "BRIDGE_OWNED") {
      await this.client.selectFiles(infohash, [], signal);
      await this.client.stopDownload(infohash, signal);
    }
    record.lastAccess = this.now();
    this.persist();
    this.log.info("Torrent video variants inspected", { infohash, variants: videos.length, metadataOnly: ownership === "BRIDGE_OWNED" });
    return { infohash, files: videos };
  }

  async resolve(
    sourceInput: string,
    requestedFileIndex?: number,
    signal?: AbortSignal,
    preferredFile?: PreferredFile
  ): Promise<ResolvedStream> {
    const resolveStarted = performance.now();
    const source = normalizeTorrentSource(sourceInput);
    try {
      const { infohash, ownership, metadataOnly, needsResume } = await this.ensureDownload(source, signal);
      const record = this.remember(infohash, ownership);
      const metadataStarted = performance.now();
      const files = await this.waitForFiles(infohash, signal);
      if (this.metrics) {
        this.metrics.metadataWaitCount += 1;
        this.metrics.metadataWaitMs += Math.round(performance.now() - metadataStarted);
      }
      const normalizedPreferredName = preferredFile?.name.replaceAll("\\", "/").toLowerCase();
      const preferredSize = preferredFile?.size;
      const preferred = normalizedPreferredName
        ? files.find((candidate) => {
            const name = candidate.name.replaceAll("\\", "/").toLowerCase();
            const sameName = name === normalizedPreferredName || name.endsWith(`/${normalizedPreferredName}`);
            return sameName && (!preferredSize || candidate.size === preferredSize);
          })
        : undefined;
      const file = requestedFileIndex === undefined
        ? preferred ?? selectMainVideo(files)
        : files.find((candidate) => candidate.index === requestedFileIndex);

      if (!file) {
        if (requestedFileIndex !== undefined) throw new Error(`File index ${requestedFileIndex} does not exist`);
        throw new NoVideoFileError(infohash);
      }
      if (isDangerousFile(file)) throw new UnsafeFileSelectionError(file.name);

      const selectionStarted = performance.now();
      await this.client.selectFiles(infohash, [file.index], signal);
      if (this.metrics) {
        this.metrics.fileSelectionCount += 1;
        this.metrics.fileSelectionMs += Math.round(performance.now() - selectionStarted);
      }
      if (metadataOnly || needsResume) {
        const resumeStarted = performance.now();
        if (metadataOnly) await this.waitForMetadataStop(infohash, signal);
        await this.client.resumeDownload(infohash, signal);
        if (this.metrics) {
          this.metrics.resumePreparationCount += 1;
          this.metrics.resumePreparationMs += Math.round(performance.now() - resumeStarted);
        }
      }
      record.selectedFileIndex = file.index;
      record.selectedFileName = file.name;
      record.lastAccess = this.now();
      this.persist();
      this.log.info("Video selected", { infohash, fileIndex: file.index, fileName: file.name, size: file.size });
      return { infohash, file, url: this.bridgeUrl(infohash, file) };
    } finally {
      if (this.metrics) {
        this.metrics.resolveCount += 1;
        this.metrics.resolveMs += Math.round(performance.now() - resolveStarted);
      }
    }
  }

  async selectFile(infohash: string, fileIndex: number, signal?: AbortSignal): Promise<ResolvedStream> {
    const files = await this.client.getFiles(infohash, signal);
    const file = files.find((candidate) => candidate.index === fileIndex);
    if (!file) throw new Error(`File index ${fileIndex} does not exist`);
    if (isDangerousFile(file)) throw new UnsafeFileSelectionError(file.name);
    await this.client.selectFiles(infohash, [fileIndex], signal);
    const record = this.remember(infohash, "EXTERNAL");
    record.selectedFileIndex = file.index;
    record.selectedFileName = file.name;
    this.persist();
    return { infohash: infohash.toLowerCase(), file, url: this.bridgeUrl(infohash.toLowerCase(), file) };
  }

  beginStream(infohash: string): void {
    const record = this.remember(infohash, "EXTERNAL");
    record.activeStreams += 1;
    record.lastAccess = this.now();
    this.persist();
  }

  endStream(infohash: string, deliveredBytes = 0): void {
    const record = this.managed.get(infohash.toLowerCase());
    if (record) {
      record.activeStreams = Math.max(0, record.activeStreams - 1);
      if (record.ownership === "BRIDGE_OWNED" && deliveredBytes > 0) {
        record.servedBytes += deliveredBytes;
        if (this.config.downloadRetentionMode === "smart" && record.retention === "EPHEMERAL" &&
            record.servedBytes >= MEANINGFUL_PLAYBACK_BYTES) record.retention = "RETAINED";
      }
      record.lastAccess = this.now();
      this.persist();
    }
  }

  async cancelDownload(infohash: string, removeData = false, signal?: AbortSignal): Promise<void> {
    const record = this.managed.get(infohash.toLowerCase());
    if (record?.activeStreams) throw new ActiveStreamError(infohash);
    await this.client.deleteDownload(infohash, removeData, signal);
    this.managed.delete(infohash.toLowerCase());
    this.persist();
    this.log.info("Download cancelled", { infohash, removeData });
  }

  pin(infohash: string): ManagedDownload {
    const record = this.managed.get(infohash.toLowerCase());
    if (!record) throw new ManagedDownloadNotFoundError(infohash);
    if (record.ownership !== "BRIDGE_OWNED") throw new RetentionConflictError("External downloads cannot be pinned");
    record.retention = "PINNED";
    record.lastAccess = this.now();
    this.persist();
    return { ...record };
  }

  unpin(infohash: string): ManagedDownload {
    const record = this.managed.get(infohash.toLowerCase());
    if (!record) throw new ManagedDownloadNotFoundError(infohash);
    if (record.ownership !== "BRIDGE_OWNED") throw new RetentionConflictError("External downloads cannot be unpinned");
    if (record.retention !== "PINNED") throw new RetentionConflictError("Download is not pinned");
    record.retention = "RETAINED";
    record.lastAccess = this.now();
    this.persist();
    return { ...record };
  }

  async diagnostics(signal?: AbortSignal): Promise<Array<TriblerDownload & { bridge?: ManagedDownload }>> {
    const downloads = await this.client.listDownloads(signal);
    return downloads.map((download) => {
      const record = this.managed.get(download.infohash.toLowerCase());
      return { ...download, ...(record ? { bridge: { ...record } } : {}) };
    });
  }

  async cleanupOldDownloads(): Promise<number> {
    const now = this.now();
    const expired = [...this.managed.values()].filter((record) => this.shouldAutoDelete(record, now));
    let removed = 0;
    for (const record of expired) {
      try {
        await this.client.deleteDownload(record.infohash, this.config.cleanupRemoveData);
        this.managed.delete(record.infohash);
        this.persist();
        removed += 1;
        this.log.info("Old bridge download cleaned", {
          infohash: record.infohash,
          removeData: this.config.cleanupRemoveData
        });
      } catch (error) {
        if (error instanceof TriblerError && error.status === 404) {
          this.managed.delete(record.infohash);
          this.persist();
        }
        else throw error;
      }
    }
    return removed;
  }

  private shouldAutoDelete(record: ManagedDownload, now: number): boolean {
    if (record.ownership !== "BRIDGE_OWNED" || record.activeStreams > 0 || record.retention === "PINNED" ||
        this.config.downloadRetentionMode === "keep_all") return false;
    const ttl = this.config.downloadRetentionMode === "ephemeral" || record.retention === "EPHEMERAL"
      ? EPHEMERAL_TTL_MS : RETAINED_TTL_MS;
    return record.lastAccess < now - ttl;
  }
}
