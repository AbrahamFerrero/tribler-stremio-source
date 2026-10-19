import { describe, expect, it } from "vitest";
import { PlaybackManager } from "../src/playback/manager";
import type { PlaybackBackend } from "../src/playback/types";

describe("PlaybackManager", () => {
  it("uses an opaque token and keeps each token on its selected backend", async () => {
    const direct: PlaybackBackend = {
      id: "direct", canHandle: (source) => source.type === "https",
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const torrent: PlaybackBackend = {
      id: "torrent", canHandle: (source) => source.type === "magnet",
      prepare: () => Promise.resolve({ kind: "redirect", url: "http://127.0.0.1:7000/play/hash/1/file" })
    };
    const manager = new PlaybackManager([direct, torrent]);
    const directToken = manager.register({ providerId: "test", type: "https", url: "https://media.example/video.mp4" });
    const torrentToken = manager.register({
      providerId: "test", type: "magnet", magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`
    });
    expect(directToken).not.toContain("http");
    expect((await manager.prepare(directToken)).kind).toBe("direct");
    expect((await manager.prepare(torrentToken)).kind).toBe("redirect");
    expect((await manager.prepare(directToken)).kind).toBe("direct");
    await expect(manager.prepare("invalid")).rejects.toThrow(/token/);
  });

  it("keeps an active source token past its original absolute expiry", async () => {
    let now = 0;
    const direct: PlaybackBackend = {
      id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const manager = new PlaybackManager([direct], 60_000, 10, () => now);
    const token = manager.register({ providerId: "test", type: "https", url: "https://media.example/video.mp4" });
    for (const instant of [50_000, 100_000, 150_000]) {
      now = instant;
      await expect(manager.prepare(token)).resolves.toMatchObject({ kind: "direct" });
    }
  });

  it("creates independent high-entropy tokens and expires idle tokens", async () => {
    let now = 1_000;
    const direct: PlaybackBackend = {
      id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const manager = new PlaybackManager([direct], 100, 10, () => now);
    const source = { providerId: "test", type: "https" as const, url: "https://media.example/video.mp4" };
    const first = manager.register(source);
    const second = manager.register(source);
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("media");
    expect(manager.activeTokenCount()).toBe(2);
    now = 1_100;
    await expect(manager.prepare(first)).rejects.toMatchObject({ name: "PlaybackTokenExpiredError" });
    expect(manager.activeTokenCount()).toBe(0);
  });

  it("expires after inactivity and never revives expired or unknown tokens", async () => {
    let now = 0;
    const direct: PlaybackBackend = {
      id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const manager = new PlaybackManager([direct], 100, 10, () => now);
    const token = manager.register({ providerId: "test", type: "https", url: "https://media.example/video.mp4" });
    now = 50;
    await expect(manager.prepare(token)).resolves.toMatchObject({ kind: "direct" });
    now = 151;
    await expect(manager.prepare(token)).rejects.toMatchObject({ name: "PlaybackTokenExpiredError" });
    await expect(manager.prepare(token)).rejects.toMatchObject({ name: "PlaybackTokenInvalidError" });
    await expect(manager.prepare("A".repeat(32))).rejects.toMatchObject({ name: "PlaybackTokenInvalidError" });
    await expect(manager.prepare("malformed")).rejects.toMatchObject({ name: "PlaybackTokenInvalidError" });
    expect(manager.activeTokenCount()).toBe(0);
  });

  it("evicts the least recently used live source token at capacity", async () => {
    let now = 0;
    const direct: PlaybackBackend = {
      id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const manager = new PlaybackManager([direct], 100, 2, () => now);
    const source = { providerId: "test", type: "https" as const, url: "https://media.example/video.mp4" };
    const active = manager.register(source);
    now = 10;
    const idle = manager.register(source);
    now = 50;
    await expect(manager.prepare(active)).resolves.toMatchObject({ kind: "direct" });
    now = 60;
    const newest = manager.register(source);
    expect(manager.activeTokenCount()).toBe(2);
    await expect(manager.prepare(idle)).rejects.toMatchObject({ name: "PlaybackTokenInvalidError" });
    await expect(manager.prepare(active)).resolves.toMatchObject({ kind: "direct" });
    await expect(manager.prepare(newest)).resolves.toMatchObject({ kind: "direct" });
  });

  it("cleans idle entries and still bounds registrations after renewals", async () => {
    let now = 0;
    const direct: PlaybackBackend = {
      id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const manager = new PlaybackManager([direct], 100, 2, () => now);
    const source = { providerId: "test", type: "https" as const, url: "https://media.example/video.mp4" };
    const active = manager.register(source);
    now = 1;
    manager.register(source);
    now = 90;
    await expect(manager.prepare(active)).resolves.toMatchObject({ kind: "direct" });
    now = 102;
    expect(manager.activeTokenCount()).toBe(1);
    manager.register(source);
    expect(manager.activeTokenCount()).toBe(2);
    manager.register(source);
    expect(manager.activeTokenCount()).toBe(2);
  });

  it("bounds in-memory token entries", () => {
    const direct: PlaybackBackend = {
      id: "direct", canHandle: () => true,
      prepare: (source) => Promise.resolve({ kind: "direct", source })
    };
    const manager = new PlaybackManager([direct], 1_000, 2, () => 1_000);
    const source = { providerId: "test", type: "https" as const, url: "https://media.example/video.mp4" };
    manager.register(source);
    manager.register(source);
    manager.register(source);
    expect(manager.activeTokenCount()).toBe(2);
  });

  it("keeps HLS child origins behind separate expiring opaque tokens", () => {
    let now = 1_000;
    const direct: PlaybackBackend = { id: "direct", canHandle: () => true, prepare: (source) => Promise.resolve({ kind: "direct", source }) };
    const manager = new PlaybackManager([direct], 100, 2, () => now);
    const token = manager.registerHlsResource("https://media.example/segment.ts?temporary=secret");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(token).not.toContain("media");
    expect(manager.prepareHlsResource(token)).toMatchObject({ type: "https" });
    now = 1_100;
    expect(() => manager.prepareHlsResource(token)).toThrow(/expired/);
    expect(() => manager.registerHlsResource("javascript:alert(1)")).toThrow(/invalid/);
  });
});
