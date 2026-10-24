import express from "express";
import request from "./http-client";
import { getRouter } from "stremio-addon-sdk";
import { describe, expect, it, vi } from "vitest";
import { createAddon } from "../src/addon";
import type { DownloadService } from "../src/download-service";
import { ExternalUrlPolicy } from "../src/network/url-policy";
import { PlaybackManager } from "../src/playback/manager";
import { TriblerPlaybackBackend } from "../src/playback/backends";
import { StreamProviderRegistry, StreamResolver } from "../src/streams/resolver";
import { publicStreamFilename, rankedStreamDescription, safeStreamDescription, streamSummary } from "../src/streams/presentation";
import { defaultStreamRankingPolicy } from "../src/streams/ranking-policy";
import { scoreStream, streamScoreComponents } from "../src/streams/scoring";
import type { NormalizedStreamSource, StreamProvider } from "../src/streams/types";
import { DirtyUpstream } from "./acceptance/dirty-upstream";
import { fixturePrivacySafe, observePipeline } from "./identity-qa/harness";
import { mp4Fixture } from "./mp4-fixture";
import { silentLogger } from "./helpers";
import { StremioAddonStreamProvider } from "../src/streams/providers/stremio-addon-stream-provider";
import { ExternalHttpStreamProvider } from "../src/streams/providers/external-http-stream-provider";
import { logger } from "../src/logger";

const movie = { id: "tt9999999999", kind: "movie" as const, title: "Synthetic Meridian", externalIds: {} };
const privateText = "ordinary-private-phrase-opaque";
const provider = (sources: NormalizedStreamSource[]): StreamProvider => ({
  id: "fixture", name: "Fixture", isEnabled: () => true, resolve: () => Promise.resolve(sources)
});

describe("public provider presentation boundary", () => {
  it.each([
    [{ audio: "ja", title: "English subtitles" }, "Japanese audio · English subtitles"],
    [{ audio: "ja" }, "Japanese audio"],
    [{ title: "English subtitles" }, "English subtitles"],
    [{ language: "en" }, undefined],
    [{ audio: privateText, title: privateText }, undefined]
  ] satisfies Array<[Partial<NormalizedStreamSource>, string | undefined]>)(
    "formats opt-in F using only available safe labels %#", (fields, labels) => {
      const source: NormalizedStreamSource = { providerId: "fixture", type: "magnet", seeds: 31,
        resolution: "1080p", sizeBytes: 5 * 1024 ** 3, codec: "HEVC", ...fields };
      const metadata = (source.language === "en" ? 2 : 0) + (source.audio === "ja" ? 1 : 0);
      const score = `#7 · Score ${162 + metadata}`;
      const parts = `Avail +100 · Res +42 · Size +12 · Codec +8 · Meta +${metadata} · Net +0`;
      const original = structuredClone(source);
      const name = streamSummary(source);
      const result = rankedStreamDescription(source, 7, defaultStreamRankingPolicy)!;
      expect(result).toBe(labels ? `${labels}\n${score} · ${parts}` : `${score}\n${parts}`);
      expect(result.split("\n")).toHaveLength(2);
      expect(result).not.toMatch(/·\s*·|\n\s*\n/);
      expect(result).not.toContain(privateText);
      expect(streamSummary(source)).toBe(name);
      expect(source).toEqual(original);
    }
  );

  it("uses the supplied policy and bounds independent numeric rounding to 0.035 points", () => {
    const policy = structuredClone(defaultStreamRankingPolicy);
    policy.quality["1080p"] = 45;
    policy.torrent.seedScorePerDoubling = 18;
    for (const seeds of [undefined, 0, 2, 31]) {
      const source: NormalizedStreamSource = { providerId: "fixture", type: "magnet", ...(seeds === undefined ? {} : { seeds }),
        resolution: "1080p", sizeBytes: Math.round(31.234567 * 1024 ** 3), codec: "HEVC", language: "en", audio: "ja" };
      const values = Object.values(streamScoreComponents(source, policy)) as number[];
      const total = scoreStream(source, policy);
      expect(values.reduce((sum, value) => sum + value, 0)).toBe(total);
      const result = rankedStreamDescription(source, 1, policy)!;
      const score = Number(/Score (-?\d+(?:\.\d+)?)/.exec(result)![1]);
      const parts = [...result.matchAll(/(?:Avail|Res|Size|Codec|Meta|Net) ([+-]\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      expect(parts).toHaveLength(6);
      parts.forEach((part, i) => expect(Math.abs(part - values[i]!)).toBeLessThanOrEqual(0.005 + 1e-10));
      expect(Math.abs(score - total)).toBeLessThanOrEqual(0.005 + 1e-10);
      expect(Math.abs(parts.reduce((sum, value) => sum + value, 0) - score)).toBeLessThanOrEqual(0.035 + 1e-10);
      expect(result).not.toMatch(/\d+\.\d{3}|\+-|-0(?: ·|$)/);
      expect(result).toContain("Res +45");
      expect(result).toContain("Size -");
      expect(result).toContain("Net +0");
    }
    const zero = { providerId: "fixture", type: "magnet" as const };
    const nearZero = structuredClone(policy); nearZero.torrent.unknownSeeds = 0; nearZero.quality.unknown = 0;
    expect(rankedStreamDescription(zero, 1, nearZero)).toBe("#1 · Score 0\nAvail +0 · Res +0 · Size +0 · Codec +0 · Meta +0 · Net +0");
    expect(rankedStreamDescription({ ...zero, seeds: -0.0001 }, 1, policy)).not.toContain("-0");
  });

  it("fails closed on non-finite calculated values and invalid public positions", () => {
    const source: NormalizedStreamSource = { providerId: "fixture", type: "magnet", audio: "ja" };
    for (const position of [0, -1, 1.5, Infinity]) {
      expect(rankedStreamDescription(source, position, defaultStreamRankingPolicy)).toBe("Japanese audio");
    }
    expect(rankedStreamDescription({ ...source, seeds: NaN }, 1, defaultStreamRankingPolicy))
      .toBe("Japanese audio\n#1 · Score -11 · Avail -12 · Res +0 · Size +0 · Codec +0 · Meta +1 · Net +0");
    const invalidPolicy = structuredClone(defaultStreamRankingPolicy);
    invalidPolicy.torrent.unknownSeeds = NaN;
    expect(rankedStreamDescription(source, 1, invalidPolicy)).toBe("Japanese audio");
  });

  it.each([
    [{ audio: "Dual" }, "Dual audio"],
    [{ audio: "MULTI" }, "Multi audio"],
    [{ audio: "  DuAl   AuDiO  " }, "Dual audio"],
    [{ audio: " multi  audio " }, "Multi audio"],
    [{ audio: "ES/EN" }, "Spanish/English audio"],
    [{ audio: "ENG+JPN" }, "English/Japanese audio"],
    [{ audio: " JA , EN " }, "Japanese/English audio"],
    [{ audio: "ES / ENG", title: "English subs" }, "Spanish/English audio · English subtitles"],
    [{ audio: "ENG+JPN", title: "Dual audio | English subs" }, "English/Japanese audio · English subtitles"],
    [{ audio: "en+ja", title: "Multi audio" }, "English/Japanese audio · Multi audio"],
    [{ audio: "Dual", title: "Multi audio | English subs" }, "English subtitles"],
    [{ audio: "en/ja", title: "French audio | English subs" }, "English subtitles"],
    [{ audio: "en/ja", title: "English audio" }, undefined],
    [{ language: "en", audio: "Dual", title: "English subs" }, "Dual audio · English subtitles"],
    [{ language: "ES/EN" }, undefined],
    [{ title: "Dual" }, undefined],
    [{ title: "Multi" }, undefined],
    [{ title: "Dual | English subs" }, undefined],
    [{ title: "ES/EN" }, undefined],
    [{ title: "Audio: ENG+JPN" }, undefined]
  ] satisfies Array<[Partial<NormalizedStreamSource>, string | undefined]>)(
    "recognizes bounded audio-field labels without widening title or generic language semantics %#", (fields, expected) => {
      expect(safeStreamDescription({ providerId: "fixture", type: "magnet", ...fields })).toBe(expected);
    }
  );

  it("rejects whole malformed, repeated, regional and hostile audio lists without extracting codes", () => {
    for (const audio of ["EN/ZZ", "XXX+JPN", "EN/EN", "EN/ENG", "JA+JPN", "EN/ES/JA", "EN++JA",
      "EN,+JA", "/EN", "EN/", "EN JA", "English/Japanese", "VOSE", "VOSTFR", "DUAL LATINO",
      "EN/JA extra", "https://fixture.invalid/EN/JA", "EN/JA?token=private", "EN+JA,token=private",
      "EN/JA | private", "<b>EN/JA</b>", "EN/JA\u0000", "EN/JA\u200b", "EN/JA\u202e", "EN/JA\n",
      "EN/JA" + " ".repeat(501), "EN/JA/".repeat(100)]) {
      expect(safeStreamDescription({ providerId: "fixture", type: "magnet", audio })).toBeUndefined();
    }
  });

  it("omits whole labels at the public bounds with two-language audio declarations", () => {
    expect(safeStreamDescription({ providerId: "fixture", type: "magnet", language: "en",
      audio: "en/ja", title: "Multi audio | English subs" }))
      .toBe("English/Japanese audio · Multi audio");
    expect(safeStreamDescription({ providerId: "fixture", type: "magnet", language: "Portuguese",
      audio: "pt/hu", title: "Portuguese subtitles" }))
      .toBe("Portuguese/Hungarian audio · Portuguese subtitles");
  });

  it.each([
    [{ language: "en" }, undefined],
    [{ audio: "Japanese" }, "Japanese audio"],
    [{ title: "Audio: Japanese" }, "Japanese audio"],
    [{ title: "English subs" }, "English subtitles"],
    [{ title: "Subs: English" }, "English subtitles"],
    [{ language: "en", audio: "Japanese", title: "English subs" }, "Japanese audio · English subtitles"],
    [{ language: "ja", title: "English subs" }, "English subtitles"],
    [{ audio: "Japanese", title: "English audio | French subs" }, "French subtitles"],
    [{ audio: "ja", title: "Audio: Japanese | English subs" }, "Japanese audio · English subtitles"],
    [{ title: "English subs | French subtitles" }, undefined],
    [{ language: "English subs" }, undefined],
    [{ audio: "English subs" }, "English subtitles"],
    [{ language: "en/ja", audio: "Japanese or English", title: "Synthetic English Journey" }, undefined],
    [{}, undefined]
  ] satisfies Array<[Partial<NormalizedStreamSource>, string | undefined]>)(
    "preserves provider declaration semantics %#", (fields, expected) => {
      const source: NormalizedStreamSource = { providerId: "fixture", type: "magnet", ...fields };
      expect(safeStreamDescription(source)).toBe(expected);
      if (source.language === "en" && !source.audio) expect(safeStreamDescription(source) ?? "").not.toContain("English audio");
    }
  );

  it("keeps the existing component and total output bounds with generic and explicit declarations", () => {
    for (const language of ["en", "Portuguese", "Hungarian"]) {
      const result = safeStreamDescription({ providerId: "fixture", type: "magnet", language,
        audio: "Portuguese", title: "Dual audio | Portuguese subtitles" })!;
      expect(result.length).toBeLessThanOrEqual(53);
      expect(result.split(" · ").length).toBeLessThanOrEqual(3);
      expect(result).not.toContain("English audio");
    }
  });

  it("rejects unsafe or free text in every presentation field before recognizing labels", () => {
    for (const value of ["https://fixture.invalid/?audio=English", "token=private", "C:/private/English",
      "<b>English</b>", "English\u0000", "English\u200b", "English\u202e", "English\u2066",
      "Korean", "English" + " ".repeat(501), "English subs extra", "English%20subs"]) {
      for (const field of ["language", "audio", "title"]) {
        expect(safeStreamDescription({ providerId: "fixture", type: "magnet", [field]: value })).toBeUndefined();
      }
    }
  });

  it("keeps equal HTTPS streams distinct when unverified generic language labels are omitted", async () => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const sources = ["hu", "ja"].map(language => ({ providerId: "fixture", type: "https" as const,
        url: `https://127.0.0.1:7443/media/${language}.mp4?signature=${privateText}`,
        title: privateText, filename: privateText + ".mp4", resolution: "1080p", language,
        requestHeaders: { Accept: "video/mp4" } }));
      await observePipeline(movie, upstream, [provider(sources)], {
        fixtureUrls: sources.map(source => source.url),
        pinnedRequest: () => Promise.resolve(new Response(Uint8Array.from(mp4Fixture(6420)), { headers: { "Content-Type": "video/mp4" } })),
        sensitiveValues: [privateText], inspect: ({ publicSources }) => {
          expect(publicSources).toHaveLength(2);
          expect(new Set(publicSources.map(p => p.stream.url)).size).toBe(2);
          expect(publicSources.map(p => p.stream.title).sort()).toEqual([undefined, undefined]);
          for (const { source, stream } of publicSources) {
            expect(stream.name).toBe(streamSummary(source));
            expect(stream.name).toBe("HTTPS · ID? · 1080p");
            expect(stream.url).toMatch(/\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
            expect(source.url).toBe(sources.find(s => s.language === source.language)!.url);
            expect(source.title).toBe(privateText); expect(source.filename).toBe(privateText + ".mp4");
            expect(source.requestHeaders?.Accept).toBe("video/mp4");
          }
          expect(fixturePrivacySafe(publicSources.map(p => p.stream), [privateText])).toBe(true);
        }
      });
    } finally { await upstream.close(); }
  });

  it("recognizes only complete closed descriptors with bounded deterministic output", () => {
    const source: NormalizedStreamSource = { providerId: "fixture", type: "magnet" };
    expect(safeStreamDescription({ ...source, language: " HUN ", audio: "Dual audio",
      title: "English subtitles · Audio: Japanese · English subtitles" })).toBe("Japanese audio · Dual audio · English subtitles");
    expect(safeStreamDescription({ ...source, audio: "jpn" })).toBe("Japanese audio");
    expect(safeStreamDescription({ ...source, title: "Hungarian audio | Subtitles: English | Multi audio" }))
      .toBe("Hungarian audio · Multi audio · English subtitles");
    expect(safeStreamDescription({ ...source, title: "English audio · Japanese audio · Dual audio · Multi audio · English subtitles · French subtitles" })).toBeUndefined();
    for (const value of [undefined, "Synthetic Hungarian Journey", "English", "EN/ES", "AAC 5.1", "unknown", "English dubbed",
      "English audio extra", "Audio: English/private", "https://fixture.invalid/English audio", "<b>English audio</b>",
      "https://fixture.invalid/?token=opaque · English audio", "English audio · opaque private phrase",
      "English audio\n", "English audio\u0000", "English audio\u200b", "English audio\u202e", "English audio\u2066", "x".repeat(501), "English audio · ".repeat(9)]) {
      expect(safeStreamDescription({ ...source, ...(value === undefined ? {} : { title: value }) })).toBeUndefined();
    }
    expect(safeStreamDescription({ ...source, title: "English audio", filename: "Japanese audio.mkv",
      url: "https://fixture.invalid/?audio=Japanese", metadata: { language: "Japanese" } })).toBe("English audio");
    expect(safeStreamDescription({ ...source, filename: "English audio.mkv", quality: "English audio",
      url: "https://fixture.invalid/?audio=English", metadata: { language: "English" } })).toBeUndefined();
  });

  it.each([
    "https://fixture.invalid/private?signature=ordinary-private-phrase-opaque",
    "https://fixture.invalid/English%20audio?token=ordinary-private-phrase-opaque",
    "https%3A%2F%2Fuser%3Aordinary-private-phrase-opaque%40fixture.invalid",
    "ordinary-private-phrase-opaque", "api_key=ordinary-private-phrase-opaque /private/path",
    "English audio\nordinary-private-phrase-opaque\u0000", "<b>English audio</b>ordinary-private-phrase-opaque",
    "Synthetic Hungarian Journey ordinary-private-phrase-opaque", "Unknown Provider ordinary-private-phrase-opaque",
    "English audio\u202eordinary-private-phrase-opaque", "English subs\u2066ordinary-private-phrase-opaque",
    "EN/JA?token=ordinary-private-phrase-opaque", "Dual|ordinary-private-phrase-opaque",
    "EN+JA,secret=ordinary-private-phrase-opaque",
    "ordinary-private-phrase-opaque".repeat(100)
  ])("omits hostile descriptor %# from public JSON, playback handles, diagnostics and logs", async value => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    const output: string[] = [];
    const spies = ["log", "warn", "error"].map(method => vi.spyOn(console, method as "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    }));
    try {
      const url = upstream.media("/media/private.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      const observation = await observePipeline(movie, upstream, [provider([{ providerId: "fixture", type: "http", url,
        title: value, audio: value, language: value, filename: privateText + ".mp4" }])], {
        log: logger, logOutput: output, sensitiveValues: [privateText, value], inspect: async ({ publicSources, playback }) => {
          expect(publicSources).toHaveLength(1);
          const { stream } = publicSources[0]!;
          expect(Object.hasOwn(stream, "title")).toBe(false);
          expect(fixturePrivacySafe(stream, [privateText, value])).toBe(true);
          const invalid = await playback.prepare("invalid").catch((error: Error) => error.message);
          expect(fixturePrivacySafe(invalid, [privateText, value])).toBe(true);
        }
      });
      expect(observation.dimensions.publicPrivacy).toBe(true);
      expect(observation.dimensions.logPrivacy).toBe(true);
      expect(fixturePrivacySafe(output, [privateText, value])).toBe(true);
    } finally { spies.forEach(spy => spy.mockRestore()); await upstream.close(); }
  });

  it.each([
    ["stremio", false], ["stremio", true], ["external", false], ["external", true]
  ])("handles %s upstream descriptors (generic language only: %s) through controlled provider HTTP and public addon HTTP", async (kind, genericOnly) => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const url = upstream.media("/media/descriptor.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" });
      upstream.streams = [{ url, description: genericOnly ? "Language: en" : "Audio: Japanese · English subs", name: "1080p" }];
      const endpoint = upstream.media("/media/resolve", { contentType: "application/json",
        body: JSON.stringify({ streams: [{ type: "http", url, language: "en",
          ...(genericOnly ? {} : { audio: "Japanese", title: "English subs" }) }] }) });
      const endpointPolicy = new ExternalUrlPolicy({ allowedLoopbackUrls: [endpoint, upstream.url("/manifest.json"), upstream.url(`/stream/movie/${movie.id}.json`)] });
      const actual = kind === "stremio" ? new StremioAddonStreamProvider({ id: "fixture", name: "Fixture", enabled: true,
        manifestUrl: upstream.url("/manifest.json"), timeoutMs: 1000, manifestTtlMs: 1000, endpointPolicy: () => endpointPolicy })
        : new ExternalHttpStreamProvider({ url: endpoint, timeoutMs: 1000, policy: endpointPolicy });
      await observePipeline(movie, upstream, [actual], { sensitiveValues: [privateText], inspect: ({ publicSources }) => {
        expect(publicSources).toHaveLength(1);
        expect(publicSources[0]!.stream.title).toBe(genericOnly ? undefined : "Japanese audio · English subtitles");
        if (kind === "stremio" && genericOnly) expect(publicSources[0]!.source.title).toBe("Language: en");
        if (kind === "external") expect(publicSources[0]!.source.language).toBe("en");
        expect(publicSources[0]!.stream.name).toBe(streamSummary(publicSources[0]!.source));
        expect(fixturePrivacySafe(publicSources[0]!.stream, [privateText])).toBe(true);
      } });
      expect(upstream.count(kind === "stremio" ? `/stream/movie/${movie.id}.json` : "/media/resolve")).toBe(1);
    } finally { await upstream.close(); }
  });

  it("carries audio-field modes and pairs through provider HTTP and public addon HTTP without losing sources", async () => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const cases: Array<[Partial<NormalizedStreamSource>, string | undefined]> = [
        [{ audio: "Dual" }, "Dual audio"],
        [{ audio: "MULTI" }, "Multi audio"],
        [{ audio: "ES/EN", title: "English subs" }, "Spanish/English audio · English subtitles"],
        [{ audio: "ENG+JPN", title: "Dual audio | English subs" }, "English/Japanese audio · English subtitles"],
        [{ audio: "JA, EN" }, "Japanese/English audio"],
        [{ language: "ES/EN", title: "Dual" }, undefined],
        [{ audio: "EN/ZZ" }, undefined],
        [{ audio: "EN/JA?token=" + privateText }, undefined]
      ];
      const sources = cases.map(([fields], index) => {
        const base = upstream.media(`/media/labels-${index}`, { body: mp4Fixture(6420), contentType: "video/mp4",
          range: "honor", requiredQuery: "?signature=" + privateText });
        const url = base + "?signature=" + privateText; upstream.allowMediaUrl(url);
        return { type: "http" as const, url, resolution: "1080p", filename: privateText + ".mp4",
          requestHeaders: { Accept: "video/mp4" }, ...fields };
      });
      const endpoint = upstream.media("/media/labels-resolve", { contentType: "application/json", body: JSON.stringify({ streams: sources }) });
      const actual = new ExternalHttpStreamProvider({ url: endpoint, timeoutMs: 1000,
        policy: new ExternalUrlPolicy({ allowedLoopbackUrls: [endpoint] }) });
      const observation = await observePipeline(movie, upstream, [actual], { sensitiveValues: [privateText],
        inspect: ({ publicSources, snapshots }) => {
          expect(publicSources).toHaveLength(cases.length);
          expect(new Set(publicSources.map(({ stream }) => stream.url)).size).toBe(cases.length);
          for (const { source, stream } of publicSources) {
            const index = sources.findIndex(original => original.url === source.url);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(stream.title).toBe(cases[index]![1]);
            expect(source.audio).toBe(sources[index]!.audio);
            expect(source.language).toBe(sources[index]!.language);
            expect(source.filename).toBe(privateText + ".mp4");
            expect(source.requestHeaders?.Accept).toBe("video/mp4");
            expect(stream.name).toBe(streamSummary(source));
            expect(stream.url).toMatch(/\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
          }
          for (const stage of ["normalized", "deduplicated", "probed", "admitted", "final"] as const) {
            expect(snapshots.get(stage)).toHaveLength(cases.length);
          }
          expect(fixturePrivacySafe(publicSources.map(({ stream }) => stream), [privateText])).toBe(true);
        }
      });
      expect(observation.probeRequests).toBe(cases.length);
      expect(upstream.count("/media/labels-resolve")).toBe(1);
    } finally { await upstream.close(); }
  });

  it.each(["embedded-url", "encoded", "plain-text", "normal", "missing"])(
    "%s remains private through real qualification and the public route", async variant => {
      const upstream = new DirtyUpstream(); await upstream.listen();
      try {
        const locator = "https://fixture.invalid/path?signature=" + privateText;
        const title = variant === "embedded-url" ? "prefix " + locator + " suffix"
          : variant === "encoded" ? encodeURIComponent(locator)
          : variant === "normal" ? "Normal.Release.1080p.x265" : privateText;
        const filename = variant === "missing" ? undefined : variant === "normal" ? "Normal.Release.1080p.x265.mp4"
          : "prefix-" + encodeURIComponent(privateText) + "-query.mp4";
        const plain = upstream.media("/media/video.mp4", { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor",
          requiredQuery: "?signature=" + privateText });
        const url = plain + "?signature=" + privateText; upstream.allowMediaUrl(url);
        const source: NormalizedStreamSource = { providerId: "fixture", type: "http", url, title,
          ...(filename ? { filename } : {}), resolution: "1080p " + privateText, codec: "HEVC " + privateText,
          language: privateText, audio: privateText, quality: privateText, sizeBytes: 2 * 1024 ** 3,
          requestHeaders: { Accept: "video/mp4" } };
        const observation = await observePipeline(movie, upstream, [provider([source])], {
          sensitiveValues: [privateText, locator, title, ...(filename ? [filename] : [])],
          inspect: async ({ publicSources, playback }) => {
            expect(publicSources).toHaveLength(1);
            const { source: internal, stream } = publicSources[0]!;
            expect(fixturePrivacySafe(stream, [privateText, locator, title, ...(filename ? [filename] : [])])).toBe(true);
            expect(stream.name).toContain("1080p"); expect(stream.name).not.toContain("HEVC");
            expect(stream.name).toContain("2.0GiB"); expect(stream.title).toBeUndefined();
            expect(stream.url).toMatch(/\/source\/[A-Za-z0-9_-]{32}\/stream\.mp4$/);
            expect(internal.url === url && internal.title === title && internal.filename === filename).toBe(true);
            expect(internal.requestHeaders?.Accept).toBe("video/mp4");
            const token = /\/source\/([A-Za-z0-9_-]{32})\//.exec(stream.url)![1]!;
            expect((await playback.prepare(token)).source === internal).toBe(true);
          }
        });
        expect(observation.dimensions.publicPrivacy).toBe(true);
      } finally { await upstream.close(); }
    }
  );

  it("keeps two equal-title sources distinct with safe attributes and independent tokens", async () => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const sources = [720, 1080].map(height => ({ providerId: "fixture", type: "http" as const,
        url: upstream.media(`/media/${height}.mp4`, { body: mp4Fixture(6420), contentType: "video/mp4", range: "honor" }),
        title: privateText, resolution: `${height}p`, codec: "H.264" }));
      await observePipeline(movie, upstream, [provider(sources)], { inspect: ({ publicSources }) => {
        expect(publicSources).toHaveLength(2);
        expect(new Set(publicSources.map(p => p.stream.url)).size).toBe(2);
        expect(new Set(publicSources.map(p => p.stream.name)).size).toBe(2);
        expect(fixturePrivacySafe(publicSources.map(p => p.stream), [privateText])).toBe(true);
      } });
    } finally { await upstream.close(); }
  });

  it("keeps HLS's generic suffix tied to actual probe evidence", async () => {
    const upstream = new DirtyUpstream(); await upstream.listen();
    try {
      const vod = upstream.vod("presentation", 2);
      await observePipeline(movie, upstream, [provider([{ providerId: "fixture", type: "http", url: vod.master,
        title: privateText, filename: privateText + ".m3u8" }])], { inspect: ({ publicSources }) => {
        expect(publicSources).toHaveLength(1);
        expect(publicSources[0]!.source.directHttp?.hls).toBe(true);
        expect(publicSources[0]!.stream.url.endsWith("/stream.m3u8")).toBe(true);
        expect(publicSources[0]!.source.filename === privateText + ".m3u8").toBe(true);
      } });
    } finally { await upstream.close(); }
  });

  it.each([
    [{ language: "en" }, undefined],
    [{}, undefined],
    [{ title: "Language: en" }, undefined],
    [{ language: "en", title: "English subtitles", audio: "Dual" }, "Dual audio · English subtitles"]
  ] satisfies Array<[Partial<NormalizedStreamSource>, string | undefined]>)("preserves torrent metadata and playback while omitting unverified language claims %#", async (fields, expected) => {
    const resolve = vi.fn<DownloadService["resolve"]>().mockResolvedValue({ url: "http://127.0.0.1:7000/fixture-playback" } as Awaited<ReturnType<DownloadService["resolve"]>>);
    const service = { resolve } as unknown as DownloadService;
    const source: NormalizedStreamSource = { providerId: "fixture", type: "magnet", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      filename: privateText + ".mkv", fileIndex: 7, sizeBytes: 768 * 1024 ** 2,
      resolution: "1080p", codec: "AV1", seeds: 28, ...fields };
    const original = structuredClone(source);
    const registry = new StreamProviderRegistry(100, silentLogger); registry.register(provider([source]));
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy());
    const playback = new PlaybackManager([new TriblerPlaybackBackend(service)]);
    const register = vi.spyOn(playback, "register");
    const addon = createAddon(service, silentLogger, [], "http://127.0.0.1:7000", undefined, resolver, playback);
    const response = await request(express().use(getRouter(addon))).get("/stream/movie/" + movie.id + ".json");
    expect(response.status).toBe(200);
    const streams = (response.body as { streams: Array<{ name: string; title?: string; url: string }> }).streams;
    expect(streams).toHaveLength(1); expect(fixturePrivacySafe(streams, [privateText])).toBe(true);
    expect(streams[0]!.name).toBe("Tribler · ID? · 1080p · 768MiB · 28 seeds");
    expect(streams[0]!.title).toBe(expected);
    expect(streams[0]!.url.endsWith("/stream.mkv")).toBe(true);
    const token = /\/source\/([A-Za-z0-9_-]{32})\//.exec(streams[0]!.url)![1]!;
    await playback.prepare(token);
    expect(source).toEqual(original);
    expect(register.mock.calls[0]![0]).toEqual({ ...original, infoHash: "a".repeat(40) });
    expect(resolve).toHaveBeenCalledWith(source.magnet, 7, undefined, { name: source.filename, size: source.sizeBytes });
  });

  it("drops unknown auxiliary text and invalid numeric attributes while canonicalizing recognized values", () => {
    const source: NormalizedStreamSource = { providerId: privateText, type: "magnet", title: privateText, filename: privateText,
      language: privateText, audio: privateText, quality: privateText, codec: privateText, resolution: privateText,
      sizeBytes: Infinity, seeds: NaN };
    expect(streamSummary(source)).toBe("Tribler"); expect(publicStreamFilename(source)).toBe("stream");
    expect(streamSummary({ ...source, language: "en/es" })).toBe("Tribler");
    expect(streamSummary({ ...source, resolution: "4K" })).toBe("Tribler · 2160p");
    expect(publicStreamFilename({ ...source, filename: privateText + ".exe" })).toBe("stream");
    expect(publicStreamFilename({ ...source, type: "https", url: "https://fixture.invalid/opaque", directHttp: {
      verified: true, rangeSupported: true, status: "verified", contentType: "video/mp4" } })).toBe("stream.mp4");
  });
});
