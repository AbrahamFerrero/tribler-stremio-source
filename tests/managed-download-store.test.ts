import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileManagedDownloadStore } from "../src/managed-download-store";
import { silentLogger } from "./helpers";

const hash = "d".repeat(40);
const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("managed download store lifecycle migration", () => {
  it("migrates v1 ownership conservatively and persists v2 with inactive streams", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tribler-store-"));
    directories.push(directory);
    const path = join(directory, "managed.json");
    await writeFile(path, JSON.stringify({ version: 1, downloads: [{
      infohash: hash.toUpperCase(), createdAt: 10, lastAccess: 20, owned: true, activeStreams: 7,
      selectedFileIndex: 2, selectedFileName: "feature.mkv"
    }] }));
    const store = new FileManagedDownloadStore(path, silentLogger);

    expect(store.load()).toEqual([{
      infohash: hash, createdAt: 10, lastAccess: 20, ownership: "BRIDGE_OWNED", retention: "RETAINED",
      servedBytes: 0, activeStreams: 0, selectedFileIndex: 2, selectedFileName: "feature.mkv"
    }]);
    store.save([{ infohash: hash, createdAt: 10, lastAccess: 30, ownership: "BRIDGE_OWNED", retention: "PINNED",
      servedBytes: 4_194_304, activeStreams: 9, selectedFileIndex: 2, selectedFileName: "feature.mkv" }]);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2, downloads: [{ activeStreams: 0, retention: "PINNED" }] });
    expect(new FileManagedDownloadStore(path, silentLogger).load()[0]).toMatchObject({
      ownership: "BRIDGE_OWNED", retention: "PINNED", servedBytes: 4_194_304, activeStreams: 0
    });
  });
});
