import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStremioAddonConfigs } from "../src/streams/stremio-addon-config";
import { createStreamResolver, createUrlPolicy } from "../src/streams/factory";
import { silentLogger, testConfig } from "./helpers";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function config(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "stremio-addons-"));
  directories.push(directory);
  const path = join(directory, "addons.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("Stremio addon configuration", () => {
  it("loads several enabled and disabled addons", () => {
    expect(loadStremioAddonConfigs(config([
      { id: "one", name: "One", manifestUrl: "https://one.example/manifest.json" },
      { id: "two", name: "Two", manifestUrl: "http://127.0.0.1:7200/manifest.json", enabled: false }
    ]))).toEqual([
      { id: "one", name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true, contentTypes: { movie: true, series: true, anime: true } },
      { id: "two", name: "Two", manifestUrl: "http://127.0.0.1:7200/manifest.json", enabled: false, contentTypes: { movie: true, series: true, anime: true } }
    ]);
  });

  it("registers several configured addons independently in diagnostics", () => {
    const path = config([
      { id: "one", name: "One", manifestUrl: "https://one.example/manifest.json" },
      { id: "two", name: "Two", manifestUrl: "http://127.0.0.1:7200/manifest.json", enabled: false }
    ]);
    const appConfig = testConfig({
      streamProviders: ["stremio_addons"],
      stremioAddonProvidersFile: path
    });
    const resolver = createStreamResolver([], appConfig, silentLogger, createUrlPolicy(appConfig));
    expect(resolver.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stremio-addon-one", type: "stremio_addon", enabled: true }),
      expect.objectContaining({ id: "stremio-addon-two", type: "stremio_addon", enabled: false })
    ]));
  });

  it.each([
    "https://user:secret@example.com/manifest.json",
    "https://example.com/manifest.json?token=secret",
    "https://example.com/manifest.json#secret",
    "file:///tmp/manifest.json",
    "https://example.com/not-manifest"
  ])("rejects unsafe or nonstandard manifest URL %s", (manifestUrl) => {
    expect(() => loadStremioAddonConfigs(config([{ id: "bad", name: "Bad", manifestUrl }])))
      .toThrow(/manifestUrl/);
  });
  it("accepts up to 32 configured addons", () => {
    const addons = Array.from({ length: 32 }, (_, index) => ({
      id: `addon-${index}`,
      name: `Addon ${index}`,
      manifestUrl: `https://addon-${index}.example/manifest.json`
    }));

    expect(
      loadStremioAddonConfigs(config(addons))
    ).toHaveLength(32);
  });

  it("rejects more than 32 configured addons", () => {
    const addons = Array.from({ length: 33 }, (_, index) => ({
      id: `addon-${index}`,
      name: `Addon ${index}`,
      manifestUrl: `https://addon-${index}.example/manifest.json`
    }));

    expect(() =>
      loadStremioAddonConfigs(config(addons))
    ).toThrow(/at most 32 entries/);
  });
});

describe("Stremio addon content-type configuration", () => {
  const base = { id: "fixture", name: "Fixture", manifestUrl: "https://addon.example/manifest.json" };

  it("defaults the whole policy and omitted fields to true", () => {
    expect(loadStremioAddonConfigs(config([base]))[0]?.contentTypes).toEqual({
      movie: true, series: true, anime: true
    });
    const parsed = loadStremioAddonConfigs(config([{ ...base, contentTypes: { movie: false } }]))[0];
    expect(parsed?.contentTypes).toEqual({ movie: false, series: true, anime: true });
    expect(Object.isFrozen(parsed?.contentTypes)).toBe(true);
  });

  it.each([null, [], "movie", 1])("rejects non-object contentTypes %s", (contentTypes) => {
    expect(() => loadStremioAddonConfigs(config([{ ...base, contentTypes }]))).toThrow(/contentTypes/);
  });

  it.each([null, 0, "false", [], {}])("rejects non-boolean policy value %s", (movie) => {
    expect(() => loadStremioAddonConfigs(config([{ ...base, contentTypes: { movie } }]))).toThrow(/contentTypes.movie/);
  });

  it("rejects unknown contentTypes keys", () => {
    expect(() => loadStremioAddonConfigs(config([{ ...base, contentTypes: { movies: false } }]))).toThrow(/unknown key/);
  });
});
