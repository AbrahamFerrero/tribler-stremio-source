import { spawnSync } from "node:child_process";
import { join } from "node:path";
import express from "express";
import { getRouter } from "stremio-addon-sdk";
import { describe, expect, it, vi } from "vitest";
import { createAddon } from "../../src/addon";
import type { DownloadService } from "../../src/download-service";
import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { PlaybackManager } from "../../src/playback/manager";
import { defaultStreamRankingPolicy } from "../../src/streams/ranking-policy";
import { getBridgeIdentityState, StreamProviderRegistry, StreamResolver } from "../../src/streams/resolver";
import type { NormalizedStreamSource } from "../../src/streams/types";
import { silentLogger } from "../helpers";
import request from "../http-client";

const cases: Array<{ fields: Record<string, string>; points: number; label?: string }> = [
  ...["en\n", "en\t", "\ten", "e\u0000n", "en\u007f", "en\u200b", "\u00a0en", "en\u202e",
    "en" + " ".repeat(126) + "PRIVATE_OPAQUE", "en PRIVATE_OPAQUE", "<b>en</b>", "en/eng"]
    .map(value => ({ fields: { language: value, audio: value }, points: 0 })),
  { fields: { language: "en\n", audio: "ja" }, points: 1, label: "Japanese audio" },
  { fields: { language: "en", audio: "ja\n" }, points: 2 },
  { fields: { language: " en ", audio: " en " }, points: 3, label: "English audio" },
  { fields: { language: "ES / ENG", audio: "ENG+JPN" }, points: 3, label: "English/Japanese audio" },
  { fields: { audio: " Dual   audio " }, points: 1, label: "Dual audio" },
  { fields: { audio: " Multi " }, points: 1, label: "Multi audio" },
  { fields: { audio: " English subs " }, points: 0, label: "English subtitles" }
];

describe("original Python metadata through real normalization and public Node ranking", () => {
  // 5 s Python child + 19 scenarios * 1 s registry allowance + 6 s loopback HTTP/assertions.
  it.each([false, true])("preserves recall, whole claims and literal F through callable=%s", async callable => {
    const base = (hex: string) => ({ type: "magnet", infoHash: hex.repeat(40),
      magnet: `magnet:?xt=urn:btih:${hex.repeat(40)}` });
    // Deliberately filter the child environment: the Python boundary receives no Tribler config/secrets.
    const allowed = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"];
    const result = spawnSync("python", ["-B", join(process.cwd(), "python-adapter-host", "tests", "fixtures", "scoring_metadata_bridge.py")], {
      env: Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
      input: JSON.stringify({ callable, cases: cases.map(({ fields }) => [base("a"), { ...base("b"), ...fields }]) }),
      encoding: "utf8", timeout: 5000, windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const groups = JSON.parse(result.stdout) as Array<{ streams: NormalizedStreamSource[]; statuses: string[] }>;
    expect(groups).toHaveLength(cases.length);
    for (const [index, scenario] of cases.entries()) {
      const group = groups[index]!;
      expect(group.statuses).toEqual(["ok"]);
      expect(group.streams).toHaveLength(2);
      const registry = new StreamProviderRegistry(1000, silentLogger);
      registry.register({ id: "synthetic", name: "Synthetic", isEnabled: () => true,
        resolve: () => Promise.resolve(group.streams) });
      let admitted: readonly NormalizedStreamSource[] = [];
      const resolver = new StreamResolver(registry, new ExternalUrlPolicy(), undefined, {
        stage: (stage, sources) => { if (stage === "admitted") admitted = sources; }
      });
      const playback = new PlaybackManager([]);
      const register = vi.spyOn(playback, "register");
      try {
        const addon = createAddon({} as DownloadService, silentLogger, [], "http://127.0.0.1:7000", undefined,
          resolver, playback, undefined, { rankingDetails: true, rankingPolicy: defaultStreamRankingPolicy });
        const response = await request(express().use(getRouter(addon))).get("/stream/movie/tt9999999999.json");
        expect(response.status).toBe(200);
        const streams = (response.body as { streams: Array<{ name: string; title: string; url: string }> }).streams;
        expect(admitted).toHaveLength(2);
        expect(admitted.map(getBridgeIdentityState)).toEqual(["UNKNOWN", "UNKNOWN"]);
        const order = scenario.points > 0 ? ["b", "a"] : ["a", "b"];
        expect(register.mock.calls.map(([source]) => source.infoHash)).toEqual(order.map(hex => hex.repeat(40)));
        expect(streams.map(s => s.name)).toEqual(["Tribler · ID?", "Tribler · ID?"]);
        const expected = order.map((hex, i) => {
          const points = hex === "b" ? scenario.points : 0;
          const score = `#${i + 1} · Score ${-12 + points}`;
          const components = `Avail -12 · Res +0 · Size +0 · Codec +0 · Meta +${points} · Net +0`;
          return hex === "b" && scenario.label ? `${scenario.label}\n${score} · ${components}` : `${score}\n${components}`;
        });
        expect(streams.map(s => s.title)).toEqual(expected);
        streams.forEach((stream, i) => {
          expect(stream.url).toBe(`http://127.0.0.1:7000/source/${register.mock.results[i]!.value}/stream`);
          expect(Object.keys(stream).sort()).toEqual(["behaviorHints", "name", "title", "url"]);
        });
        expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_OPAQUE|magnet:|metadata|language|audio"|<b>|\u200b|\u202e/);
      } finally { register.mockRestore(); }
    }
  }, 30_000);
});
