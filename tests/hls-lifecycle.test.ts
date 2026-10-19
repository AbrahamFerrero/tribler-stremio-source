import { describe, expect, it } from "vitest";
import { MAX_HLS_RESOURCE_ENTRIES, PlaybackManager } from "../src/playback/manager";
import type { RepresentationState } from "../src/playback/representation";

const source = { providerId: "fixture", type: "https" as const, url: "https://media.example/master.m3u8" };
const resources = (...names: string[]) => names.map(name => ({ url: `https://media.example/${name}`, isMediaSegment: name.endsWith(".ts") }));
async function fixture(max = 10) {
  let time = 0;
  const manager = new PlaybackManager([{ id: "direct", canHandle: () => true, prepare: s => Promise.resolve({ kind: "direct", source: s }) }], 100, max, () => time);
  const token = manager.register(source);
  const parent = (await manager.prepare(token)).representation!;
  const register = (names: string[], authority: RepresentationState = parent) => manager.registerHlsResources(resources(...names), undefined, undefined, authority);
  return { manager, token, parent, register, at: (instant: number) => { time = instant; } };
}

describe("bounded HLS playback authority", () => {
  it("keeps late unvisited segments, keys, maps and nested playlists alive through sibling activity", async () => {
    const f = await fixture();
    const [variant] = f.register(["variant.m3u8"]);
    const v = f.manager.prepareHlsResource(variant!);
    const [media] = f.register(["media.m3u8"], v.representation);
    const m = f.manager.prepareHlsResource(media!);
    const [early, late, key, map] = f.register(["early.ts", "late.ts", "key.bin", "init.mp4"], m.representation);
    for (const time of [90, 180, 270]) { f.at(time); f.manager.prepareHlsResource(early!); }
    for (const token of [late, key, map, variant, media, early]) expect(f.manager.prepareHlsResource(token!).url).toContain("media.example");
    await expect(f.manager.prepare(f.token)).resolves.toMatchObject({ kind: "direct" });
    f.at(370);
    for (const token of [late, early, variant, media]) expect(() => f.manager.prepareHlsResource(token!)).toThrow(/expired/);
    expect(() => f.register(["revived.ts"], m.representation)).toThrow(/expired/);
    await expect(f.manager.prepare(f.token)).rejects.toThrow(/token/);
  });

  it("reuses overlapping live resources and revokes removed resources and their bindings", async () => {
    const f = await fixture();
    const [old, shared] = f.register(["old.ts", "shared.ts"]);
    const representation = f.manager.prepareHlsResource(old!).representation;
    const observation = representation.begin(undefined);
    const etag = observation.observe("https://media.example/old.ts", "a".repeat(64), '"upstream"', true)!;
    const next = f.register(["shared.ts", "new.ts"]);
    expect(next[0]).toBe(shared);
    expect(() => f.manager.prepareHlsResource(old!)).toThrow(/expired/);
    expect(representation.begin(etag).binding).toBeUndefined();
    expect(observation.observe("https://media.example/old.ts", "a".repeat(64), '"upstream"', true)).toBeUndefined();
    for (let i = 0; i < MAX_HLS_RESOURCE_ENTRIES + 1; i++) f.register(["shared.ts", `live-${i}.ts`]);
    expect(f.manager.prepareHlsResource(shared!).url).toContain("shared.ts");
  });

  it("preserves every repeated key or map reference across an unchanged playlist reload", async () => {
    const f = await fixture();
    const original = f.register(["key.bin", "init.mp4", "a.ts", "key.bin", "init.mp4", "b.ts"]);
    f.at(90); f.manager.prepareHlsResource(original[2]!);
    f.register(["key.bin", "init.mp4", "a.ts", "key.bin", "init.mp4", "b.ts"]);
    f.at(180); f.manager.prepareHlsResource(original[2]!);
    for (const token of original) expect(f.manager.prepareHlsResource(token).url).toContain("media.example");
  });

  it("evicts entire least-active sessions deterministically and clears source and child authority", async () => {
    const f = await fixture();
    const [a] = f.register(["a.ts"]);
    f.at(1);
    const other = f.manager.register(source);
    const otherParent = (await f.manager.prepare(other)).representation!;
    const [b] = f.register(["b.ts"], otherParent);
    f.at(2); f.manager.prepareHlsResource(a!);
    f.manager.registerHlsResources(resources(...Array.from({ length: MAX_HLS_RESOURCE_ENTRIES - 1 }, (_, i) => `${i}.ts`)));
    expect(() => f.manager.prepareHlsResource(b!)).toThrow(/expired/);
    await expect(f.manager.prepare(other)).rejects.toThrow(/token/);
    expect(otherParent.begin(undefined).active()).toBe(false);
    expect(f.manager.prepareHlsResource(a!).url).toContain("a.ts");
  });

  it("rejects an oversized active tree transactionally without evicting its ancestors", async () => {
    const f = await fixture();
    const [variant] = f.register(["variant.m3u8"]);
    const parent = f.manager.prepareHlsResource(variant!).representation;
    expect(() => f.register(Array.from({ length: MAX_HLS_RESOURCE_ENTRIES }, (_, i) => `${i}.ts`), parent)).toThrow(/too many resources/);
    expect(f.manager.prepareHlsResource(variant!).url).toContain("variant");
  });

  it("revokes descendants of removed variants while preserving unchanged variants and their children", async () => {
    const f = await fixture();
    const [old, retained] = f.register(["old.m3u8", "retained.m3u8"]);
    const oldParent = f.manager.prepareHlsResource(old!).representation;
    const keptParent = f.manager.prepareHlsResource(retained!).representation;
    const [removedSegment] = f.register(["removed.ts"], oldParent);
    const [keptSegment] = f.register(["kept.ts"], keptParent);
    f.register(["retained.m3u8"]);
    for (const token of [old, removedSegment]) expect(() => f.manager.prepareHlsResource(token!)).toThrow(/expired/);
    expect(() => f.register(["resurrected.ts"], oldParent)).toThrow(/expired/);
    expect(f.manager.prepareHlsResource(keptSegment!).url).toContain("kept.ts");
  });

  it("breaks equal-activity capacity ties by session registration order and rejects invalid batches atomically", () => {
    const manager = new PlaybackManager([], 100, 10, () => 0);
    const first = manager.registerHlsResource("https://media.example/first.ts");
    const second = manager.registerHlsResource("https://media.example/second.ts");
    expect(() => manager.registerHlsResources([...resources("valid.ts"), { url: "file:///invalid", isMediaSegment: true }])).toThrow(/invalid/);
    expect(manager.prepareHlsResource(first).url).toContain("first.ts");
    manager.registerHlsResources(resources(...Array.from({ length: MAX_HLS_RESOURCE_ENTRIES - 1 }, (_, i) => `${i}.ts`)));
    expect(() => manager.prepareHlsResource(first)).toThrow(/expired/);
    expect(manager.prepareHlsResource(second).url).toContain("second.ts");
  });

  it("does not resurrect authority when concurrent work finishes at expiry or after source eviction", async () => {
    const f = await fixture(1);
    const [child] = f.register(["child.ts"]);
    const held = f.manager.prepareHlsResource(child!).representation;
    f.at(100);
    const results = await Promise.allSettled([Promise.resolve().then(() => f.manager.prepareHlsResource(child!)), f.manager.prepare(f.token)]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(() => f.register(["late.ts"], held)).toThrow(/expired/);
    const fresh = await fixture(1);
    const [evicted] = fresh.register(["evicted.ts"]);
    fresh.manager.register(source);
    expect(() => fresh.manager.prepareHlsResource(evicted!)).toThrow(/expired/);
    expect(() => fresh.register(["late.ts"])).toThrow(/expired/);
  });
});
