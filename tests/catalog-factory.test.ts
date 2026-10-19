import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogProviders } from "../src/catalog/factory";
import { testConfig } from "./helpers";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("catalog source file", () => {
  it("loads several enabled providers and skips disabled entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tribler-catalog-test-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "sources.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      providers: [
        {
          kind: "static",
          id: "first",
          name: "First catalog",
          type: "movie",
          items: [{ id: "one", name: "One", torrent: "a".repeat(40) }]
        },
        {
          kind: "static",
          id: "second",
          name: "Second catalog",
          type: "series",
          items: [{ id: "two", name: "Two", streams: [] }]
        },
        {
          kind: "json",
          enabled: false,
          id: "disabled",
          name: "Disabled",
          catalogUrl: "https://example.test/items"
        }
      ]
    }));

    const providers = createCatalogProviders(testConfig({ catalogSourcesFile: file }));
    expect(providers.map((provider) => provider.definition.id)).toEqual(["first", "second"]);
    expect(await providers[0]?.list({ type: "movie", skip: 0 })).toHaveLength(1);
  });

  it("rejects duplicate ids", () => {
    const directory = mkdtempSync(join(tmpdir(), "tribler-catalog-test-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "sources.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      providers: [
        { kind: "static", id: "same", name: "One", items: [] },
        { kind: "static", id: "same", name: "Two", items: [] }
      ]
    }));
    expect(() => createCatalogProviders(testConfig({ catalogSourcesFile: file }))).toThrow(/unique/);
  });
});
