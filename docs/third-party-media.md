# Third-party example media

This source repository contains references to remote media, not copies of the
films. The project's PolyForm Noncommercial 1.0.0 code license does not relicense
films, logos, trademarks or third-party assets. The references below are examples,
not endorsements or availability guarantees.

## Works and attribution

**Big Buck Bunny — copyright 2008, Blender Foundation**, Peach open movie project,
[project and license information](https://peach.blender.org/about/).
The project's published terms identify
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
They require the complete ending credits for screening/broadcast of the full
movie/documentary, and identify separate attribution for excerpts/DVD duplication
and for site/DVD-ROM material. Individually marked textures may have their own
attribution. This notice credits the work; it does not replace credits required
when showing or distributing media.

**Sintel — copyright Blender Foundation**, Durian open movie project,
[project information](https://durian.blender.org/about/) and
[sharing terms](https://durian.blender.org/sharing/).
The published terms identify
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
Redistributing, screening or broadcasting the movie requires its full credit
scroll; other reuse requires attribution to Blender Foundation and the project
site. The terms exclude logos/trademarks and clearly identified non-project
material. Referencing Sintel does not grant rights to those excluded items.

Evidence reviewed **2026-10-18**: WebTorrent's text listing was readable directly;
the official Peach About and Durian About/Sharing text was available through
indexed search results. Direct retrieval of those project pages returned 402,
so this is not a claim of a complete fresh retrieval of every linked term.
The license deed was readable. No torrent or film was downloaded for this review.

## References and consumers

| Source | Remote reference / declared format | Consumers and limits |
| --- | --- | --- |
| `config/catalog-sources.example.json` | BBB magnet and HTTPS MP4; declared filename `Big Buck Bunny.mp4`, size 276134947 bytes | Example JSON catalog/provider configuration; declarations are not new measurements. |
| `src/examples/big-buck-bunny.ts` | Shared BBB HTTPS MP4 URL and size constant | Imported by the two example servers below; not a bundled MP4. |
| `src/examples/test-stream-provider.ts` | BBB HTTPS and magnet, declared 720p H.264 | External HTTP provider fixture; tests use controlled responses. `scripts/benchmark-tribler-swarm.mjs` reads its magnet literal; `scripts/privacy-runtime-tribler-playback.ts` imports it. Those opt-in tools may obtain media through Tribler. |
| `src/examples/test-stremio-addon.ts` | BBB HTTPS MP4, declared 720p H.264 and size | Standard addon fixture and its protocol tests; other `1.1.1.1` test locators are validation inputs, not verified authorized media servers. |
| `scripts/benchmark-tribler-buffer.mjs` | Sintel BTIH; `/play/<BTIH>/5/Sintel.mp4` | Opt-in Tribler benchmark, using `LEGAL_TEST_MAGNET` from operator configuration. Index 5 is a code selection, not a verified file/encode mapping. |

The starter `.env.example` supplies a Sintel magnet for the configured catalog
(`src/catalog/factory.ts`, `src/source.ts`). Protocol tests comparing these
constants/URLs do not establish current remote bytes or content identity.

## Exact locators and WebTorrent provenance

[WebTorrent Free Torrents](https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/free-torrents.md)
lists Big Buck Bunny with BTIH `dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c`
and Sintel with BTIH `08ada5a7a6183aae1e09d831df6748d566095a10`.
This establishes the public listing provenance of these identifiers, not a
verification of today's served bytes or all rights in every remote variant.
The repository uses a different subset of trackers from that listing.

BBB HTTPS URL:

```text
https://webtorrent.io/torrents/Big%20Buck%20Bunny/Big%20Buck%20Bunny.mp4
```

BBB magnet in the catalog and provider example:

```text
magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent
```

Sintel starter magnet:

```text
magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent
```

The `xs` torrent URLs are `https://webtorrent.io/torrents/big-buck-bunny.torrent`
and `https://webtorrent.io/torrents/sintel.torrent`. BBB's `ws` webseed base is
`https://webtorrent.io/torrents/`. Tracker endpoints are
`udp://tracker.opentrackr.org:1337` and, for BBB,
`wss://tracker.openwebtorrent.com`. These are remote network destinations;
their presence in text does not mean they were contacted during validation.

## Linking, obtaining and redistributing

1. **Linking:** keeping URLs, magnets and attribution in source does not bundle
   film bytes. This notice covers that source-reference boundary.
2. **Obtaining during an opt-in test:** deliberately running a remote playback,
   benchmark or privacy runner can request media from servers or through Tribler.
   Operators must check the chosen content, rights and network configuration;
   code/protocol test success is not that check.
3. **Redistributing bytes:** a future artifact containing downloaded films,
   excerpts or encodes needs its own variant/rights review and applicable credits,
   license notices and modification disclosures. Preserve full credit sequences
   where required. This notice alone does not complete that artifact review.

No mirror's credit preservation, exact encode, current size, torrent file list,
benchmark file-index selection or audiovisual identity has been verified here.
The MP4 filename and 720p/H.264 fields are example declarations, not inspected
codec results. No claim is made that the HTTPS copy equals a selected torrent
file. An altered remote variant may need additional attribution or permission;
verify the actual material before redistributing it. Do not infer a license for
unrelated third-party media from these two open-movie references.
