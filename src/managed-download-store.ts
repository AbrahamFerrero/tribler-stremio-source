import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeErrorDetails, type Logger } from "./logger";
import type { ManagedDownload } from "./types";

const INFOHASH_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

interface StoredStateV1 {
  version: 1;
  downloads: Array<{ infohash: string; createdAt: number; lastAccess: number; owned: boolean; activeStreams?: number; selectedFileIndex?: number; selectedFileName?: string }>;
}

interface StoredStateV2 {
  version: 2;
  downloads: ManagedDownload[];
}

export interface ManagedDownloadStore {
  load(): ManagedDownload[];
  save(downloads: ManagedDownload[]): void;
}

export class FileManagedDownloadStore implements ManagedDownloadStore {
  constructor(private readonly path: string, private readonly log: Logger) {}

  load(): ManagedDownload[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredStateV1 | StoredStateV2>;
      if (!Array.isArray(parsed.downloads)) return [];
      if (parsed.version === 1) return (parsed as StoredStateV1).downloads.flatMap((record) => {
        if (!record || !INFOHASH_PATTERN.test(record.infohash) || !record.owned) return [];
        if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.lastAccess)) return [];
        return [{ infohash: record.infohash.toLowerCase(), createdAt: record.createdAt, lastAccess: record.lastAccess,
          ownership: "BRIDGE_OWNED", retention: "RETAINED", servedBytes: 0, activeStreams: 0,
          ...(Number.isSafeInteger(record.selectedFileIndex) ? { selectedFileIndex: record.selectedFileIndex } : {}),
          ...(typeof record.selectedFileName === "string" ? { selectedFileName: record.selectedFileName } : {}) }];
      });
      if (parsed.version !== 2) return [];
      return (parsed as StoredStateV2).downloads.flatMap((record) => {
        if (!record || !INFOHASH_PATTERN.test(record.infohash) || record.ownership !== "BRIDGE_OWNED") return [];
        if (record.retention !== "EPHEMERAL" && record.retention !== "RETAINED" && record.retention !== "PINNED") return [];
        if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.lastAccess) || !Number.isFinite(record.servedBytes)) return [];
        return [{ ...record, infohash: record.infohash.toLowerCase(), activeStreams: 0 }];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.warn("Could not read managed download state", {
          error: safeErrorDetails(error)
        });
      }
      return [];
    }
  }

  save(downloads: ManagedDownload[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      const state: StoredStateV2 = {
        version: 2,
        downloads: downloads.filter((record) => record.ownership === "BRIDGE_OWNED").map((record) => ({ ...record, activeStreams: 0 }))
      };
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      this.log.warn("Could not persist managed download state", {
        error: safeErrorDetails(error)
      });
    }
  }
}
