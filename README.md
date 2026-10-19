# Tribler Stremio Bridge

Documentation for the **v1.3.0 candidate (unreleased)**. See the [release notes](docs/releases/v1.3.0.md) and [changelog](CHANGELOG.md). Package metadata is aligned to v1.3.0; publication remains pending. v1.3 is in feature freeze.

This personal, independent project explores neutral multimedia engineering for experimentation and household use. It is a professional portfolio project with engineering direction and QA by Abraham Ferrero, developed with AI assistance. It is not officially affiliated with Stremio or Tribler. The first public source release is being prepared under [PolyForm Noncommercial 1.0.0](LICENSE); publication remains pending.

A local Stremio bridge that resolves video sources and plays them through direct HTTP/HTTPS or BitTorrent via Tribler. The bridge does not implement a BitTorrent client: Tribler is the only BitTorrent backend and both services remain on the same computer.

The localhost API validates the local Host and effective listener port. Discovery requires
the exact `https://web.stremio.com` Origin; `/auto` and `/play` also accept native requests
without Origin, Referer or Fetch Metadata. `/source` and `/hls` retain their opaque capabilities.
Administrative routes, including diagnostics, require an independent `BRIDGE_ADMIN_TOKEN`
(32 random bytes encoded as 64 hex characters) through `Authorization: Bearer <token>`
and a native HTTP client without browser context headers. Administration is disabled when
the variable is absent. Keep the secret in the process environment or a local secret manager;
never pass it in installation/playback URLs. See [HTTP contracts](docs/http-api-contracts.md)
and [security limits](SECURITY.md). Compatibility with other clients requires verification.

## Architecture

```text
Stremio
  |
  v
Local Node bridge
  |
  +-- StreamProviderRegistry
  |     +-- catalog and manual providers
  |     +-- local or external metadata provider
  |     `-- standard Stremio addon providers
  |
  v
StreamResolver
  |
  v
PlaybackManager
  +-- DirectHttpPlaybackBackend
  `-- TriblerPlaybackBackend
          |
          v
       Tribler
```

The optional external provider can be the local Python host:

```text
ExternalHttpStreamProvider -- localhost --> Python Adapter Host
                                           |
                                           v
                                   isolated Kodi-compatible worker
                                           |
                                           v
                         locally installed compatible resolver/module
```

Catalogs describe media. `StreamProvider` instances produce normalized sources. `StreamResolver` validates, deduplicates, ranks, and retains selection metadata. `PlaybackManager` serves direct HTTP(S) through the hardened transport or delegates the torrent to Tribler.

## Capabilities

- Local Stremio addon for movies and episodes.
- Configurable catalogs, manual providers, local JSON, external HTTP providers, and standard Stremio addons.
- Direct HTTP/HTTPS playback with `Range` and seek support. Valid HLS playlists are rewritten to opaque local child-resource routes; playlist URLs and every child request remain subject to the same outbound policy.
- Stremio direct streams accept bounded `behaviorHints.proxyHeaders.request` data for `Referer`, `Origin`, `User-Agent`, `Accept`; outgoing requests enforce the [recipient-scoped privacy policy](docs/http-recipient-privacy.md). Source User-Agent and exact Referer require local authorization.
- BitTorrent playback through Tribler, including file selection, cancellation, and cleanup of managed downloads.
- Explicit Direct and Tribler stream choices; a failed Direct request never starts a Tribler download.
- Persistent bridge-owned download retention with pin/unpin controls and active-stream protection.
- Bounded, per-request Tribler read-ahead buffering; `/health` exposes aggregated streaming metrics.
- Episodic Stremio identity retained as IMDb, season, and episode.
- `fileIndex` is retained or recovered only when correlation by `infoHash` is unambiguous.
- Opt-in provider diagnostics, buffer benchmarks, and runtime/privacy audits.

## Quick start on Windows

Requires Node.js 20 or newer and a local Tribler REST API with its own key. The CI configuration targets Node 20 and Python 3.11 on Linux and Windows; this is a configured matrix, not a claim that every client/version combination has passed. Python is optional for the adapter path.

```powershell
git clone <repository-url>
Set-Location tribler-streamio
npm ci
Copy-Item .env.example .env
```

Before starting, edit `.env` with Tribler's loopback URL and local REST key. Optional administrative access requires an independent `BRIDGE_ADMIN_TOKEN` supplied through a local secret manager or process environment: 32 cryptographically random bytes encoded as 64 hexadecimal characters. Without it, administrative routes are disabled. Never reuse the Tribler key or put either secret in a URL. Start Tribler locally, then run:

```powershell
npm run dev
```

Install this local manifest in the intended Stremio client:

```text
http://127.0.0.1:7000/manifest.json
```

The starter `.env.example` presents Sintel, an open movie by the Blender Foundation licensed under CC BY 3.0. Internet Archive discovery remains available by setting `CATALOG_PROVIDER=internet-archive`; check each item's rights before playback. Existing local configurations are unaffected.

See [third-party example media](docs/third-party-media.md) for Big Buck Bunny and Sintel attribution, WebTorrent reference provenance, and the limits of remote variants. Linking examples, obtaining media in opt-in tests and redistributing media bytes have separate obligations.

No TypeScript or Python edits are needed to configure a supported integration.

## Public and local configuration

| Publishable | Local and Git-ignored |
|---|---|
| `.env.example` | `.env` |
| `config/*.example.json` | `config/*.local.json` |
| settings examples | local `*.local.env`, settings, and profiles |

Copy the required templates before configuring them:

```powershell
Copy-Item config/catalog-sources.example.json config/catalog-sources.local.json
Copy-Item config/stremio-addons.example.json config/stremio-addons.local.json
```

Then reference the local files from `.env`:

```dotenv
CATALOG_SOURCES_FILE=./config/catalog-sources.local.json
STREAM_PROVIDER_STREMIO_ADDONS_FILE=./config/stremio-addons.local.json
```

Templates use synthetic values. Secrets stay in `.env`; configuration JSON must contain only environment-variable names in `headersFromEnv` when an integration requires authentication.

### Stremio addon content types

Each entry in `config/stremio-addons.local.json` may have a `contentTypes` object with optional boolean `movie`, `series`, and `anime` fields. Omit the object or an individual field to enable that content type. `enabled: false` remains the provider-wide master switch. A provider with `enabled: true` and `contentTypes.movie: false` stays globally enabled but makes no addon request for movies.

Episodes use the `series` policy. An exact `anime` classification or `stremio.type` of `anime` selects the `anime` policy even for a movie or episode. Titles, genres, provider names, and ID namespaces do not select it. This is a manual static policy: the bridge does not learn, score, disable, or modify providers automatically. See the neutral [addon config example](config/stremio-addons.example.json).

Enable providers with `STREAM_PROVIDERS`. `catalog`, `manual`, `local_json`, `external_http`, and `stremio_addons` are supported identifiers. An `ExternalHttpStreamProvider` may target HTTPS or one exact local endpoint; every playback URL it returns remains untrusted and is revalidated.

Stream providers can supply content evidence as `metadata.identity` on a candidate, using `kind` (or `type`), `title`, `year`, `season`, `episode`, or `externalIds`. The resolver filters supported explicit contradictions before deduplication/ranking and checks measured evidence after probing; missing evidence can stay eligible. Bounded structured labels and candidate/effective resource facts participate only under the current qualification rules. Arbitrary display text and matching provider-declared IDs are not independent proof of identity. `/providers` reports the last resolve's `identityRejections` count without source URLs or identity values.

For IMDb movie requests, the bridge preserves the exact Stremio video ID as `externalIds.imdb`. Optionally set `STREMIO_MOVIE_METADATA_BASE_URL` to a trusted Stremio addon base directory, such as `https://your-trusted-meta-addon.example/`. The bridge requests its standard `meta/movie/<IMDb ID>.json` resource before resolving streams. A response with the same ID and type `movie` can supply the requested title and an optional year. The endpoint is independent of stream providers and uses bounded requests, URL/redirect validation and caching. The same configured base can supply validated series title/year metadata; it does not supply exact episode duration. Failed or incomplete metadata never suppresses streams. Different titles alone do not reject a candidate. Bounded explicit contradictions can reject it; a structured different movie title with a compatible year can remain admitted as SUSPICIOUS. Missing evidence does not establish a match. See the [Identity limits](docs/releases/v1.3.0.md#identity-and-presentation).

## Stream ranking

The bundled [ranking policy](config/stream-ranking.default.json) scores direct probe health and latency, torrent seed availability, and resolution. Transport-verified HTTPS/HLS receives a strong preference over weak torrents; timeout and transient failures remain lower-ranked when the URL is otherwise admissible. A completed non-transient HTTP 4xx response is excluded. Strong torrents can still outrank uncertain direct sources. Existing codec and file-size adjustments remain in the scorer. Verification describes bounded media/transport evidence, not semantic identity or sustained playback. Current compact labels use `HTTP✓` or `HTTPS✓` for verified transport and separate `ID✓`, `ID!`, or `ID?` markers where the bridge classifies identity. A marker may be absent for an unclassified source; even `ID✓` is bounded corroboration, not audiovisual proof.

To tune the ordering without editing TypeScript, copy the policy to `config/stream-ranking.local.json`, edit its numeric weights, and set `STREAM_RANKING_CONFIG_FILE=./config/stream-ranking.local.json` in `.env`. The file is local and ignored by Git. The bridge rejects missing, malformed, or out-of-range configured policies at startup. `DIRECT_HTTP_PROBE_ENABLED=true` enables verification; with the probe disabled, direct sources have unknown health and cannot be labelled verified. The probe uses the existing hardened outbound transport.

Cache-first probing is integrated and covered by controlled regressions; its real-world causal benefit was not isolated by an A/B comparison, so no percentage improvement is claimed. `STREMIO_ADDON_REQUEST_TIMEOUT_MS` defaults to 5000 ms in this candidate. An 8000 ms setting is a local recommendation, not a new production default.

An HTTPS-labelled source stays on HTTPS during playback. Direct and Tribler are separate Stremio choices; a Direct failure does not switch to Tribler.

## Managed downloads

Set `DOWNLOAD_RETENTION_MODE` in `.env` to `smart` (default), `ephemeral`, or `keep_all`. Bridge-created downloads start with a 30-minute idle retention period. In `smart` mode, meaningful playback promotes them to a seven-day idle retention period; `ephemeral` always uses the short period, and `keep_all` disables automatic removal. Existing external Tribler downloads are never removed by bridge cleanup. Active streams and pinned bridge-owned downloads are also protected from automatic removal.

`GET /downloads` shows selected diagnostics behind administrative Bearer authentication (see below); it is not a universal metadata secrecy boundary. `POST /downloads/:infohash/pin` retains a bridge-owned download until it is unpinned; `DELETE /downloads/:infohash/pin` returns it to `RETAINED` state, subject to the configured mode's idle period. `DELETE /downloads/:infohash` rejects an active stream. Retention state survives bridge restart.

## Optional Python Adapter Host

The Python host is an independent local process. Use it only when you need a Kodi-compatible resolver:

```powershell
python-adapter-host/start-local.ps1
```

Configure it from `.env` through `PYTHON_ADAPTER_*`, including the local addon, settings, profile, and P2P metadata profile. The module, callable, and source are read only at process start. No HTTP payload can select them.

See [python-adapter-host/README.md](python-adapter-host/README.md) for the worker contract and limits. Third-party addons, modules, ZIPs, profiles, and settings are not distributed.

## Movies and episodes

For an episodic request, the bridge retains Stremio's `videoId` and includes IMDb, season, and episode in normalized identity. Episodic torrents are supported when deterministic selection exists:

- `fileIndex` is passed through to Tribler.
- If a source returns additional metadata, the adapter may recover `fileIndex` and filename only from a unique `infoHash` match.
- If the file cannot be identified safely in a multi-file torrent, the source is rejected fail-closed.

The bridge does not simply select the primary file from an ambiguous pack.

## Security and privacy

The bridge binds to `127.0.0.1`. Incoming Host must match the listener authority and port; forwarded headers do not authorize requests. `PUBLIC_BASE_URL` must use the supported local HTTP root profile.

`/health`, `/providers`, `/resolve`, `/downloads` and its descendants require `Authorization: Bearer <BRIDGE_ADMIN_TOKEN>` and no Origin, Referer or Fetch Metadata headers. Correct credentials do not admit browser contexts. Catalog/meta/stream discovery accepts only the exact `https://web.stremio.com` Origin with the documented context checks; there is no native discovery exception. Native players may access `/auto` and `/play` without those context headers. Manifest access is public after Host validation; `/source` and `/hls` require valid opaque capabilities and permit wildcard CORS.

Origin and native-header checks are compatibility and browser-context controls. Local processes can forge them, and a process holding a playback token can use its capability. This is not authentication of Stremio or protection from a compromised same-user process. See [HTTP contracts](docs/http-api-contracts.md#required-localhost-boundary) for exact statuses and preflight rules.

BitTorrent traffic is delegated to Tribler; Node contains no direct BitTorrent client. Direct HTTP/HTTPS sources go through a transport that blocks private destinations, revalidates redirects, validates DNS, and pins the connection to a validated IP. Playback tokens are opaque and temporary.

The transport minimizes source headers, restricts them to the entry origin or explicitly configured recipients, and never forwards cookies, `Authorization`, or forwarding headers. Referer is absent by default; an explicit source requirement is reduced to origin-only unless an exact value is locally authorized. HTTPS-to-HTTP propagation is blocked. The supported Windows launcher filters the Python host environment before process creation; direct/embedded entry points reject Tribler variables at startup but cannot undo interpreter inheritance. Workers apply bounded IPC, filtered environments and audit-hook filesystem restrictions. Locally installed modules remain trusted code; these controls are not an operating-system sandbox.

Direct HTTPS does not hide the public client IP from the media server. Historical local runtime observations cover only their measured process/window; they do not prove anonymity against peers, trackers, DHT, PEX, DNS or an external observer, or certify this candidate.

`/health` distinguishes a ready bridge from a degraded configured provider and an unavailable Tribler endpoint. It returns HTTP 503 when any enabled provider is in an error state, even when Tribler and other providers remain operational. `/providers` provides the corresponding sanitized provider status.

See [SECURITY.md](SECURITY.md) and [PRIVACY_AUDIT.md](PRIVACY_AUDIT.md) for the boundaries and evidence model.

## Diagnostics and validation

The commands below are developer gates, not results from this documentation pass. Existing test families and evidence limits are summarized in the [release notes](docs/releases/v1.3.0.md#qa-and-evidence). Administrative diagnostics require the Bearer header described above.

```powershell
npm run security:repo
npm run typecheck
npm run lint
npm run test:all
npm run test:acceptance
npm run test:security
npm run coverage
npm run build
npm audit
npm audit --omit=dev
Set-Location python-adapter-host
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python -m coverage run --branch -m unittest discover -s tests -v
python -m coverage report --include=adapter_host/*
```

Opt-in tools:

```powershell
npm run benchmark:tribler-buffer
npm run benchmark:tribler-swarm
npm run privacy:runtime
npm run privacy:tracker-observation
```

To diagnose a configured episodic integration without starting playback or downloads:

```powershell
$env:DIAGNOSTIC_EPISODE_IDS="tt1234567:1:1,tt1234567:1:2"
$env:DIAGNOSTIC_MOVIE_ID="tt1234567"
npm run diagnose:episodic-streams
```

Scripts keep temporary artifacts in ignored directories and emit sanitized results.

See [provider quality evaluation](docs/provider-quality-evaluation.md) for the Stremio and Kodi developer tools, and [latency follow-up](FUTURE_WORK.md#resolution-latency-and-provider-availability) for historical evidence limits, the decision to retain production defaults and unapproved design options. [Checkpoint C](FUTURE_WORK.md#checkpoint-c-functional-acceptance) research is closed with accepted limitations and PARTIAL functional evidence; implementation of Python contracts is separate from unmet functional acceptance.

`/health` includes cumulative `triblerStreaming` counters. Compare two snapshots to inspect resolution, metadata wait, file selection and resume preparation, then Tribler response headers, first byte from Tribler, first byte written by the bridge, prebuffer, queue waits and underruns. The counters contain timings and byte counts only; they never include torrent sources, upstream URLs, tokens, or credentials.

## Known limitations

- Availability depends on configured external providers and their APIs. Standard addon support does not promise compatibility with all Stremio versions; the exact Origin profile can reject other clients.
- Identity is bounded and incomplete; PR6 and 43 deferred STRICT dimensions remain open. Transport verification does not establish the requested content.
- HLS sessions expire after inactivity and may be evicted under capacity pressure; unsupported playlist features and upstream changes can prevent playback. See [token lifecycle](docs/hls-token-lifecycle.md).
- HTTPS labels prohibit silent downgrade; unsupported TLS or upstream requirements fail rather than weaken transport policy.
- An ambiguous multi-file torrent is rejected for episodes.
- The local privacy audit does not prove global network anonymity.
- The Python/Kodi compatibility layer deliberately implements a limited subset, and the audit hook does not replace an operating-system sandbox.
- BitTorrent performance depends on the swarm, seeds, and Tribler configuration; buffering cannot make a source with insufficient bitrate sustainable.

## License

The first public v1.3 source release is prepared under the unmodified [PolyForm Noncommercial License 1.0.0](LICENSE), SPDX `PolyForm-Noncommercial-1.0.0`. Copyright © 2026 Abraham Ferrero; preserve the [Required Notice](NOTICE). When published, the source will be publicly available under these terms. This is source-available software, not OSI open source.

The license permits use, modification, forks and redistribution for its permitted purposes, including noncommercial purposes. Those grants do not require separate prior permission. Follow the full license, including its notice requirements: recipients must receive its terms or official URL and the Required Notice. Uses outside its grants need separate authorization from the relevant rights holders. Abraham Ferrero reserves commercial licensing of material over which he holds the necessary rights; this does not offer rights in third-party material.

This license applies to project-authored material offered under it to the extent the licensor holds the necessary rights. Dependencies, externally installed modules/addons, media, logos and trademarks retain their own terms; see [third-party example media](docs/third-party-media.md). This notice does not assert exclusive ownership of every file or relicense third-party work.

Earlier private development snapshots carried an MIT license notice. The present change records the license selected for the first public source release; it does not rewrite that history or purport to revoke rights already granted for earlier copies. See [contribution and redistribution guidance](CONTRIBUTING.md).
