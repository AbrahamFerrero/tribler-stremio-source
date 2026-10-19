import { randomBytes } from "node:crypto";
import { sanitizeSourceRequestHeaders, type SourceHeaderScope, type SourceRequestHeaders } from "../network/http-privacy";
import type { NormalizedStreamSource } from "../streams/types";
import type { PlaybackBackend, PlayableStream } from "./types";
import { RepresentationState } from "./representation";

export const MAX_HLS_RESOURCE_ENTRIES = 4_096;

interface PlaybackAuthority {
  expiresAt: number;
  sourceToken?: string;
  resources: Set<string>;
}
interface StoredAuthority {
  session: PlaybackAuthority;
  representation: RepresentationState;
  children: Set<string>;
}
interface StoredSource extends StoredAuthority { source: NormalizedStreamSource }
interface StoredHlsResource extends StoredAuthority {
  url: string;
  isMediaSegment: boolean;
  requestHeaders?: SourceRequestHeaders;
  sourceHeaderScope?: SourceHeaderScope;
}

class PlaybackTokenError extends Error {
  constructor(reason: "expired" | "invalid") {
    super(reason === "expired" ? "Playback token expired" : "Playback token unknown or invalid");
    this.name = reason === "expired" ? "PlaybackTokenExpiredError" : "PlaybackTokenInvalidError";
  }
}

export class PlaybackManager {
  private readonly sources = new Map<string, StoredSource>();
  private readonly hlsResources = new Map<string, StoredHlsResource>();
  private readonly sessions = new Set<PlaybackAuthority>();
  private readonly authorities = new WeakMap<RepresentationState, StoredAuthority>();

  constructor(
    private readonly backends: PlaybackBackend[],
    private readonly ttlMs = 60 * 60_000,
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now
  ) {
    if (ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("Invalid playback token limits");
  }

  private createSession(sourceToken?: string): PlaybackAuthority {
    const session = { expiresAt: this.now() + this.ttlMs, resources: new Set<string>(), ...(sourceToken ? { sourceToken } : {}) };
    this.sessions.add(session);
    return session;
  }

  private live(session: PlaybackAuthority): boolean {
    return this.sessions.has(session) && session.expiresAt > this.now();
  }

  private authority(session: PlaybackAuthority): StoredAuthority {
    const representation: RepresentationState = new RepresentationState(() => this.authorities.has(representation) && this.live(session));
    const authority = { session, representation, children: new Set<string>() };
    this.authorities.set(representation, authority);
    return authority;
  }

  register(source: NormalizedStreamSource): string {
    this.cleanup();
    if (this.sources.size >= this.maxEntries) {
      const oldest = [...this.sources.values()].sort((a, b) => a.session.expiresAt - b.session.expiresAt)[0];
      if (oldest) this.revoke(oldest.session);
    }
    const token = this.newToken();
    const session = this.createSession(token);
    this.sources.set(token, { source, ...this.authority(session) });
    return token;
  }

  private newToken(pending = new Set<string>()): string {
    let token: string;
    do { token = randomBytes(24).toString("base64url"); }
    while (this.sources.has(token) || this.hlsResources.has(token) || pending.has(token));
    return token;
  }

  registerHlsResource(url: string, isMediaSegment = false): string {
    return this.registerHlsResources([{ url, isMediaSegment }])[0]!;
  }

  // Parent is an internal capability captured before async I/O; commit never renews it.
  registerHlsResources(resources: readonly { url: string; isMediaSegment: boolean }[], sourceHeaders?: SourceRequestHeaders, scope?: SourceHeaderScope, parent?: RepresentationState): string[] {
    if (resources.length > MAX_HLS_RESOURCE_ENTRIES) throw new Error("HLS playlist has too many resources");
    const urls = resources.map(({ url }) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("HLS resource URL is invalid");
      return parsed.toString();
    });
    const owner = parent ? this.authorities.get(parent) : undefined;
    if (parent && (!owner || !this.live(owner.session))) {
      if (owner) this.revoke(owner.session);
      throw new Error("HLS parent token is unknown or expired");
    }
    // Reuse only within the same parent and header scope.
    const headers = scope ? sanitizeSourceRequestHeaders(sourceHeaders) : undefined;
    const identity = (url: string, segment: boolean, h?: SourceRequestHeaders, s?: SourceHeaderScope): string => JSON.stringify([url, segment, h, s]);
    const existing = new Map<string, string>();
    for (const token of owner?.children ?? []) {
      const child = this.hlsResources.get(token)!;
      existing.set(identity(child.url, child.isMediaSegment, child.requestHeaders, child.sourceHeaderScope), token);
    }
    const pending = new Set<string>();
    const tokens = urls.map((url, index) => {
      const key = identity(url, resources[index]!.isMediaSegment, headers, scope);
      const token = existing.get(key) ?? this.newToken(pending);
      existing.set(key, token);
      pending.add(token);
      return token;
    });
    const removed = new Set<string>();
    const toRemove = [...(owner?.children ?? [])].filter(token => !pending.has(token));
    while (toRemove.length > 0) {
      const token = toRemove.pop()!;
      removed.add(token);
      for (const child of this.hlsResources.get(token)?.children ?? []) toRemove.push(child);
    }
    const added = [...pending].filter(token => !this.hlsResources.has(token));
    const retained = owner ? owner.session.resources.size - removed.size : 0;
    if (retained + added.length > MAX_HLS_RESOURCE_ENTRIES) throw new Error("HLS session has too many resources");

    // Validation is complete. The entire commit is synchronous.
    this.cleanup();
    if (owner && (!this.authorities.has(owner.representation) || !this.live(owner.session))) throw new Error("HLS parent token is unknown or expired");
    for (const token of removed) this.removeResource(token);
    let required = this.hlsResources.size + added.length - MAX_HLS_RESOURCE_ENTRIES;
    if (required > 0) {
      // Stable insertion order breaks equal-activity ties. Active sessions can be evicted.
      const oldest = [...this.sessions].filter(session => session !== owner?.session && session.resources.size > 0)
        .sort((a, b) => a.expiresAt - b.expiresAt);
      for (const session of oldest) {
        required -= session.resources.size;
        this.revoke(session);
        if (required <= 0) break;
      }
    }
    if (tokens.length === 0) { owner?.children.clear(); return []; }
    const session = owner?.session ?? this.createSession();
    const indices = new Map(tokens.map((token, index) => [token, index]));
    for (const token of added) {
      const index = indices.get(token)!;
      this.hlsResources.set(token, {
        ...this.authority(session), url: urls[index]!, isMediaSegment: resources[index]!.isMediaSegment,
        ...(headers ? { requestHeaders: Object.freeze({ ...headers }) } : {}),
        ...(scope ? { sourceHeaderScope: Object.freeze({ ...scope }) } : {})
      });
      session.resources.add(token);
    }
    if (owner) { owner.children.clear(); for (const token of pending) owner.children.add(token); }
    return tokens;
  }

  prepareHlsResource(token: string): NormalizedStreamSource & { hlsMediaSegment: boolean; representation: RepresentationState } {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error("Invalid HLS resource token");
    const resource = this.hlsResources.get(token);
    if (!resource || !this.live(resource.session)) {
      if (resource) this.revoke(resource.session);
      throw new Error("HLS resource token is unknown or expired");
    }
    resource.session.expiresAt = this.now() + this.ttlMs;
    return {
      providerId: "hls_proxy", type: new URL(resource.url).protocol === "https:" ? "https" : "http",
      url: resource.url, hlsMediaSegment: resource.isMediaSegment, representation: resource.representation,
      ...(resource.requestHeaders ? { requestHeaders: resource.requestHeaders } : {}),
      ...(resource.sourceHeaderScope ? { sourceHeaderScope: resource.sourceHeaderScope } : {})
    };
  }

  async prepare(token: string, signal?: AbortSignal): Promise<PlayableStream> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new PlaybackTokenError("invalid");
    const stored = this.sources.get(token);
    if (!stored) throw new PlaybackTokenError("invalid");
    const checkedAt = this.now();
    if (stored.session.expiresAt <= checkedAt) {
      this.revoke(stored.session);
      throw new PlaybackTokenError("expired");
    }
    const backend = this.backends.find(candidate => candidate.canHandle(stored.source));
    if (!backend) throw new Error("No playback backend supports this source");
    stored.session.expiresAt = checkedAt + this.ttlMs;
    const playable = await backend.prepare(stored.source, signal);
    return playable.kind === "direct" ? { ...playable, representation: stored.representation } : playable;
  }

  private removeResource(token: string): void {
    const resource = this.hlsResources.get(token);
    if (!resource) return;
    resource.representation.clear();
    resource.children.clear();
    this.authorities.delete(resource.representation);
    resource.session.resources.delete(token);
    this.hlsResources.delete(token);
  }

  private revoke(session: PlaybackAuthority): void {
    for (const token of session.resources) this.removeResource(token);
    if (session.sourceToken) {
      const source = this.sources.get(session.sourceToken);
      if (source) { source.representation.clear(); source.children.clear(); this.authorities.delete(source.representation); }
      this.sources.delete(session.sourceToken);
    }
    this.sessions.delete(session);
  }

  private cleanup(): void {
    const now = this.now();
    for (const session of this.sessions) if (session.expiresAt <= now) this.revoke(session);
  }

  activeTokenCount(): number { this.cleanup(); return this.sources.size; }
}
