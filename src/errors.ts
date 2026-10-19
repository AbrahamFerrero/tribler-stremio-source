export class TriblerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "TriblerError";
  }
}

export class MetadataTimeoutError extends Error {
  constructor(readonly infohash: string, timeoutMs: number) {
    super(`Tribler did not obtain torrent metadata within ${timeoutMs} ms`);
    this.name = "MetadataTimeoutError";
  }
}

export class NoSeedsError extends Error {
  constructor(readonly infohash: string, timeoutMs: number) {
    super(`No seeds or peers were found for ${infohash} within ${timeoutMs} ms`);
    this.name = "NoSeedsError";
  }
}

export class NoVideoFileError extends Error {
  constructor(readonly infohash: string) {
    super(`Torrent ${infohash} contains no supported video file`);
    this.name = "NoVideoFileError";
  }
}

export class UnsafeFileSelectionError extends Error {
  constructor(readonly fileName: string) {
    super(`Refusing to stream a potentially executable file: ${fileName}`);
    this.name = "UnsafeFileSelectionError";
  }
}

export class ActiveStreamError extends Error {
  constructor(infohash: string) { super(`Download ${infohash} has an active stream`); this.name = "ActiveStreamError"; }
}

export class ManagedDownloadNotFoundError extends Error {
  constructor(infohash: string) { super(`Managed download ${infohash} was not found`); this.name = "ManagedDownloadNotFoundError"; }
}

export class RetentionConflictError extends Error {
  constructor(message: string) { super(message); this.name = "RetentionConflictError"; }
}
