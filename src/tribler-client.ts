import { TriblerError } from "./errors";
import type { TriblerDownload, TriblerFile } from "./types";

interface DownloadsResponse {
  downloads: TriblerDownload[];
}

interface FilesResponse {
  infohash: string;
  files: TriblerFile[];
}

interface AddDownloadResponse {
  started: boolean;
  infohash: string;
}

interface AddDownloadOptions {
  onlyMetadata?: boolean;
  destination?: string;
  completedDir?: string;
}

interface TriblerAnonymityDefaults {
  enabled: boolean;
  hops: number;
  safeSeeding: boolean;
}

export type TriblerEndpointRecovery = () => Promise<string | undefined>;

const INFOHASH_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export class TriblerClient {
  private recoveryPending: Promise<string | undefined> | undefined;

  constructor(
    private baseUrl: string,
    private readonly apiKey: string,
    private readonly requestTimeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly recoverEndpoint?: TriblerEndpointRecovery
  ) {}

  private async recoverAfterRefusal(error: unknown): Promise<boolean> {
    if (!(error instanceof TypeError) || (error.cause as { code?: unknown } | undefined)?.code !== "ECONNREFUSED") return false;
    if (!this.recoverEndpoint) return false;
    const failedEndpoint = this.baseUrl;
    this.recoveryPending ??= this.recoverEndpoint().catch(() => undefined).finally(() => { this.recoveryPending = undefined; });
    const recovered = await this.recoveryPending;
    if (!recovered) return false;
    // A concurrent request may already have installed this same recovered URL.
    if (recovered === this.baseUrl) return recovered !== failedEndpoint;
    this.baseUrl = recovered;
    return true;
  }

  private validateInfohash(infohash: string): void {
    if (!INFOHASH_PATTERN.test(infohash)) throw new Error("Invalid infohash");
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch (error) {
      if (error instanceof SyntaxError) throw new TriblerError("Tribler returned malformed JSON");
      throw error;
    }
  }

  private async request(path: string, init: RequestInit = {}, timeout = this.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Tribler request timed out")), timeout);
    const onAbort = (): void => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const send = async (): Promise<Response> => {
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "error",
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new TriblerError(`Tribler returned HTTP ${response.status}`, response.status, details.slice(0, 2_000));
      }
      return response;
    };

    try {
      try {
        return await send();
      } catch (error) {
        if (!await this.recoverAfterRefusal(error)) throw error;
        return await send();
      }
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listDownloads(signal?: AbortSignal): Promise<TriblerDownload[]> {
    const response = await this.request("/api/downloads", signal ? { signal } : {});
    const payload = await this.readJson<DownloadsResponse>(response);
    return payload.downloads ?? [];
  }

  async getAnonymityDefaults(signal?: AbortSignal): Promise<TriblerAnonymityDefaults | undefined> {
    const response = await this.request("/api/settings", signal ? { signal } : {});
    const payload = await this.readJson<{
      settings?: { libtorrent?: { download_defaults?: {
        anonymity_enabled?: unknown; number_hops?: unknown; safeseeding_enabled?: unknown;
      } } }
    }>(response);
    const defaults = payload.settings?.libtorrent?.download_defaults;
    if (typeof defaults?.anonymity_enabled !== "boolean" ||
        !Number.isSafeInteger(defaults.number_hops) ||
        typeof defaults.safeseeding_enabled !== "boolean") return undefined;
    return {
      enabled: defaults.anonymity_enabled,
      hops: defaults.anonymity_enabled ? defaults.number_hops as number : 0,
      safeSeeding: defaults.safeseeding_enabled
    };
  }

  async getDownload(infohash: string, signal?: AbortSignal): Promise<TriblerDownload | undefined> {
    this.validateInfohash(infohash);
    const downloads = await this.listDownloads(signal);
    return downloads.find((download) => download.infohash.toLowerCase() === infohash.toLowerCase());
  }

  async addDownload(uri: string, signal?: AbortSignal, options: AddDownloadOptions = {}): Promise<AddDownloadResponse> {
    const response = await this.request("/api/downloads", {
      method: "PUT",
      body: JSON.stringify({ uri, ...(options.onlyMetadata ? { only_metadata: true } : {}),
        ...(options.destination ? { destination: options.destination } : {}),
        ...(options.completedDir ? { completed_dir: options.completedDir } : {}) }),
      ...(signal ? { signal } : {})
    });
    return this.readJson<AddDownloadResponse>(response);
  }

  async getFiles(infohash: string, signal?: AbortSignal): Promise<TriblerFile[]> {
    this.validateInfohash(infohash);
    const response = await this.request(`/api/downloads/${infohash}/files`, signal ? { signal } : {});
    const payload = await this.readJson<FilesResponse>(response);
    return payload.files ?? [];
  }

  async selectFiles(infohash: string, fileIndices: number[], signal?: AbortSignal): Promise<void> {
    this.validateInfohash(infohash);
    await this.request(`/api/downloads/${infohash}`, {
      method: "PATCH",
      body: JSON.stringify({ selected_files: fileIndices }),
      ...(signal ? { signal } : {})
    });
  }

  async resumeDownload(infohash: string, signal?: AbortSignal): Promise<void> {
    this.validateInfohash(infohash);
    await this.request(`/api/downloads/${infohash}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "resume" }),
      ...(signal ? { signal } : {})
    });
  }

  async stopDownload(infohash: string, signal?: AbortSignal): Promise<void> {
    this.validateInfohash(infohash);
    await this.request(`/api/downloads/${infohash}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "stop" }),
      ...(signal ? { signal } : {})
    });
  }

  async deleteDownload(infohash: string, removeData: boolean, signal?: AbortSignal): Promise<void> {
    this.validateInfohash(infohash);
    await this.request(`/api/downloads/${infohash}`, {
      method: "DELETE",
      body: JSON.stringify({ remove_data: removeData }),
      ...(signal ? { signal } : {})
    });
  }

  streamUrl(infohash: string, fileIndex: number): string {
    this.validateInfohash(infohash);
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) throw new Error("Invalid file index");
    return `${this.baseUrl}/api/downloads/${infohash}/stream/${fileIndex}`;
  }

  streamHeaders(range?: string): Headers {
    const headers = new Headers();
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);
    if (range) headers.set("Range", range);
    return headers;
  }
}
