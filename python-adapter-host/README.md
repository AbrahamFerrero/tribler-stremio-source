# Python Adapter Host

Project-authored adapter and fixture code is prepared for the first public source
release under [PolyForm Noncommercial 1.0.0](../LICENSE), with the
[Required Notice](../NOTICE) and [contribution guidance](../CONTRIBUTING.md).
Publication remains pending. Externally installed modules/addons and media retain
their own licenses and attribution; the project license does not relicense them.

An optional local service that translates Kodi-compatible resolvers into normalized sources for the bridge. It listens only on `127.0.0.1`, runs each resolution in a fresh worker, and does not know the Tribler API.

## Start

From the repository root, create `.env` from `.env.example` and configure the `PYTHON_ADAPTER_*` variables. Then start it:

```powershell
python-adapter-host/start-local.ps1
```

Configure the endpoint as the bridge's local external provider, for example `http://127.0.0.1:7100/resolve`. The bridge allows only that exact URL as a control channel; returned stream URLs still pass normal validation.

## Local configuration

```dotenv
PYTHON_ADAPTER_KODI_RESOLVER_ENABLED=true
PYTHON_ADAPTER_KODI_ADDON_PATH=C:\absolute\path\to\local-kodi-addon
PYTHON_ADAPTER_KODI_ADDON_ID=script.module.local
PYTHON_ADAPTER_KODI_MODULE=adapter_host.kodi.adapters.p2p_metadata
PYTHON_ADAPTER_KODI_CALLABLE=resolve
PYTHON_ADAPTER_KODI_SOURCE_MODULE=local_p2p_module.sources.metadata_source
PYTHON_ADAPTER_KODI_SOURCE_ID=example_p2p
PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING=provider.example_p2p
PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE=capture-streams
PYTHON_ADAPTER_KODI_SETTINGS_FILE=C:\absolute\path\to\private-settings.json
PYTHON_ADAPTER_KODI_PROFILE_PATH=C:\absolute\path\to\kodi-data
PYTHON_ADAPTER_KODI_WORKER_TIMEOUT_SECONDS=5
```

These variables, the addon, and its settings are local and are not versioned. The `p2p_metadata` profile calls a source with a `source()` factory and a `sources(query, {})` operation; the identifier and enablement setting are defined in the local environment. `capture-streams` retains file-selection metadata only when an `infoHash` correspondence is unique. For another third-party interface, add a small adapter of your own or configure the supported module without changing the bridge.

## Resolver profile configuration

`AdapterSettings.kodi_profiles` is an immutable tuple of `KodiResolverProfile` values. Both the legacy environment above and the new startup-local JSON file use this model. At startup, `default_registry()` registers `ExampleResolver` first, followed by one `KodiInstalledResolver.from_profile()` per profile in configuration order. Each instance has its own ID, name, worker manager, and immutable worker configuration. The existing `ResolverRegistry` remains the only orchestrator.

Disabled profiles remain visible in `/resolvers` with `enabled: false` and `status: disabled`; the registry does not execute them. Constructing their managers still validates addon/settings paths, as in the legacy path, so even disabled profiles need valid local addon/settings locations. Construction never imports the addon or starts a worker. With no profiles, diagnostics retain the disabled, unconfigured `kodi_installed` entry. IDs colliding with an existing resolver (including `example_authorized`) are rejected by the registry's existing duplicate protection.

Each resolver copies its profile's `adapterConfig` into its immutable `KodiWorkerConfig`. The parent constructs a fresh sanitized environment for each disposable worker and sets `PYTHON_ADAPTER_KODI_PROFILE_CONFIG` to that worker's data only. The block is a JSON object without an envelope, encoded compactly with sorted keys and ASCII escapes, with the same 4,096-byte bound as `adapterConfig`. Invalid internal data is rejected rather than truncated. No settings-file contents or parent environment values are added to the block. Inherited `PYTHON_ADAPTER_KODI_*` variables are removed before the worker-specific block is set.

For `p2p_metadata`, the block has this shape (the source module/ID/setting are required; response mode defaults to `none`):

```json
{"sourceEnabledSetting":"provider.example_p2p","sourceId":"example_p2p","sourceModule":"local_p2p_module.sources.metadata_source","sourceResponseMode":"capture-streams"}
```

The adapter accepts only those fields and the response modes `none` and `capture-streams`. Missing/malformed data, unexpected fields, invalid values, and unsupported modes fail through the existing sanitized worker error path. The adapter never falls back to `PYTHON_ADAPTER_KODI_SOURCE_*`. The config block is startup data; `/resolve` cannot supply or override it.

`/resolve` uses `ResolverRegistry.resolve_with_outcomes()` to obtain streams and immutable per-resolver outcomes from that invocation. Only participating, enabled configured profile IDs count toward availability; ExampleResolver and disabled profiles do not. Any operational profile yields `200`, including a valid empty response. If every participating configured profile fails, the response is `503 {"error":"configured resolvers unavailable"}`. With no enabled profiles, the optional behavior remains `200`. Global request expiry remains `504`, and disconnects cancel the existing work.

The registry still bounds, normalizes and deduplicates candidates. Valid survivors of filtering or truncation count as operational even when diagnostics report `invalid_result`; an entirely invalid result does not. Kodi exposes IPC-validated candidates to that existing registry boundary while preserving its normalized direct `resolve()` API. IPC violations (including an oversized worker response) still fail closed; they are not eligible for registry truncation. `/resolvers` remains shared diagnostic state and is never consulted for HTTP availability. Legacy `kodi_installed` uses the same request-local path.

The safe template is [`config/kodi-resolvers.example.json`](../config/kodi-resolvers.example.json). A private copy named `config/kodi-resolvers.local.json` is already excluded by the repository's `*.local.json` rule. Replace synthetic paths with your own external addon/settings/profile locations. Select the file with:

```dotenv
# Relative to python-adapter-host when using start-local.ps1:
PYTHON_ADAPTER_KODI_RESOLVERS_FILE=../config/kodi-resolvers.local.json
```

The UTF-8 JSON root must contain exactly `version: 1` and a `profiles` array (possibly empty). Each profile requires `id`, `name`, `enabled`, `addonPath`, `addonId`, `module`, `callable`, `workerTimeoutSeconds`, and `adapterConfig`. `settingsFile` and `profilePath` may be omitted or null. Unknown fields and duplicate JSON keys are rejected. Paths inside the JSON are relative to the configuration file's directory; legacy paths and the file selector remain relative to the process working directory. Parsing never imports an addon or creates profile directories. Addon/settings existence checks remain in the existing worker construction path.

Supplying a nonblank file selector together with **any other `PYTHON_ADAPTER_KODI_*` variable** is a startup error, including empty variables, `RESOLVER_ENABLED=false`, and `SOURCE_*` variables. Remove those legacy variables when selecting a file; configurations are never merged. A blank file selector is treated as unset.

Validation limits:

- File: 65,536 bytes; at most 32 profiles; unique IDs matching the existing resolver rule `[a-zA-Z0-9_.-]{1,64}`; nonempty names of at most 128 characters.
- Worker timeout: a finite JSON number greater than zero and at most 300 seconds. Enabled profiles must stay below the host resolver timeout, which remains below the request timeout.
- `adapterConfig`: JSON object, at most 4,096 bytes when compactly encoded with ASCII escapes, four container levels (root is level one), and 128 total values and object keys. Only finite JSON data is accepted. Objects become read-only mappings and arrays become tuples internally; caller-owned containers are copied before freezing. There is no expression evaluation or executable interpretation. Configuration must contain non-secret data only; credential-like keys (including nested keys) and Tribler connection fields are rejected using the same name filter as the worker environment. Credentials, cookies, tokens, passwords, and settings-file contents must not be placed in `adapterConfig`.

Legacy configuration produces one profile with ID `kodi_installed` and name `Installed Kodi resolver`, retaining its enablement, paths, module, callable, addon ID, and timeout. An unconfigured/disabled host has an empty tuple; a fully configured disabled legacy profile is retained. The four supplied `SOURCE_*` values are captured narrowly as `sourceModule`, `sourceId`, `sourceEnabledSetting`, and `sourceResponseMode` in `adapter_config` (whitespace trimmed; response mode lowercased). These values are read once at startup and then follow the same profile-to-worker JSON transport as file profiles. Changing global `SOURCE_*` variables after parsing has no effect on configured workers.

## Security boundaries

- On Windows, use `start-local.ps1` for host environment isolation before Python process creation. It resolves the local Python executable in the parent, then supplies only `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`, intended `PYTHON_ADAPTER_*` settings (local `.env` overrides inherited settings), and fixed UTF-8 settings. It does not change the parent environment or working directory. PATH, proxies, unrelated secrets and inherited Python startup variables are excluded. Windows PowerShell 5.1 and PowerShell 7 use the same `ProcessStartInfo.EnvironmentVariables` API.
- Direct `python -m adapter_host` and embedded `create_server` refuse service startup when either Tribler variable is present, even empty or with mixed case. This checks before configuration loading or socket creation, including explicit settings/registry callers. These interpreters already received their initial environment; imports and Python startup hooks may already have run. Callers needing process-creation isolation must provide a minimal child environment or use the Windows launcher. Other inherited variables are not filtered in direct/embedded modes.
- The HTTP request accepts media data only; it cannot specify a module, callable, path, addon, settings, or profile.
- The parent process validates the module, callable, addon, limits, and timeout before creating the worker.
- The worker receives a minimal environment without keys, cookies, tokens, `TRIBLER_URL`, or `TRIBLER_API_KEY`.
- Workers cannot create child processes, and the audit hook restricts file paths to the addon, profile, explicit settings, and Python runtime. This is defense in depth, not an operating-system sandbox for hostile extensions.
- stdin/stdout IPC is bounded JSON; module stdout and stderr are redirected or sanitized.

Credential-name filtering is not a content detector: a secret hidden under an
innocuous configuration key cannot be identified reliably. Startup configuration
must remain non-secret even when it passes validation.

Do not copy downloaded modules, profiles, ZIPs, or settings into the repository. Keep only project-authored files under `adapter_host/` and synthetic fixtures under `tests/fixtures/`.

## Tests

```powershell
Set-Location python-adapter-host
python -m unittest discover -s tests -v
```

Tests use a project-authored fake addon and cover isolation, timeouts, request validation, fail-closed `fileIndex` recovery, episodes, and the local Node E2E. They do not contact external providers or add downloads.

### Profile and package validation criteria

The maintained A/B regression evidence is in the existing tests below. A loader,
constructor mock or cleared manager counter alone does not prove worker isolation
or process cleanup.

| Boundary | Required assertions and existing tests |
| --- | --- |
| Profile isolation and legacy compatibility | Real workers must observe only their own configuration in both sequential orders and during barrier-confirmed overlap, including parent-environment poisoning and failing/timed-out siblings. See [profile isolation tests](tests/test_kodi_profile_isolation.py). |
| Invocation-local availability | Exercise healthy/empty survivors, all-configured failures, ExampleResolver non-masking, disabled profiles, partial-invalid output, dedupe, result caps and overlapping requests with contradictory outcomes. See [HTTP availability tests](tests/test_http_availability.py). |
| Request and process boundaries | Exercise real HTTP selector rejection and disconnect cleanup in [HTTP API tests](tests/test_http_api.py); bounded IPC/stdout/stderr, denied subprocesses and actual worker exit after timeout/cancellation in [worker tests](tests/test_kodi_worker.py). Cleanup assertions require the observed process exit code; independent teardown must reap a survivor after a failed assertion. |
| External package contract | Preserve query types, season zero, authoritative series-title mapping, capabilities, provider-local capture and ambiguity refusal, malformed siblings, iterator failure, bounds, guarded directory enumeration and two-profile execution. See [package tests](tests/test_external_scraper_package.py). |
| Node-to-worker composition | Use the existing [Node E2E test](tests/test_e2e_node_bridge.py) and [spawned bridge system tests](../tests/system/bridge-process.test.ts) for their exercised paths; helper success alone does not establish this evidence level. |

Python host-process coverage does not trace disposable workers. Their evidence
comes from assertions crossing the real process boundary. Historical mutation
controls support only the properties they actually falsified; ordinary real-path
coverage is not automatically mutation-verified, and neither establishes a
comprehensive mutation score or an operating-system sandbox.

Historical A/B reports are retained in an external local archive with original
relative paths, provenance and verified recovery hashes. Their recorded passes
cover the multi-profile foundation and package discovery contract, not v1.3
release readiness, remote availability, peer availability or certified playback.
User-reported UI-triggered host counts do not independently prove Stremio rows
or playback. Historical timings and test totals are not current validation runs;
short deadline tests may be sensitive to competing gate load. This documentation
consolidation does not rerun those gates or extend their conclusions.


## External scraper packages (Checkpoint B)

`ExternalScraperPackageAdapter` uses the existing disposable worker and profile registry.
The [two-profile template](../config/kodi-external-scrapers.example.json) uses two
project-authored packages with the same module and callable. Copy it to your ignored
`config/kodi-resolvers.local.json`, select trusted local installations, and enable the desired profiles.
Disabled profiles still require valid addon/settings paths as described above.
No third-party code or private settings are distributed with this project.

Both profiles select `adapter_host.kodi.adapters.external_scraper_package`, callable `resolve`.
The complete adapter configuration is:

```json
{"packageModule": "scraper_package_a", "folders": ["torrents"]}
```

Each profile selects its own package module, addon ID, paths and private settings.
Optional `responseMode` accepts `none` (default) or `capture-streams`. Capture reuses
legacy client-response compatibility separately for each provider, recovering file selection
only for a unique normalized infoHash. Ambiguous hashes remain untouched. This is local
profile configuration; HTTP input cannot change it. Providers without the compatible client
path retain their normal behavior. No additional requests are made.
Only `torrents` is supported. The worker validates these exact fields before importing the
package. HTTP input cannot select them. Provider enablement belongs to each package's
existing local settings (`provider.<name>`), supplied through the existing settings file;
the adapter does not override those settings or request all disabled providers.

The fixed operation is `package.sources(specified_folders=["torrents"])`, then each
returned class's `sources(media_data, {})`. Calls are sequential in package order. Known
incompatible movie/episode providers are skipped. Enumeration and raw scanning use the
existing 100-item worker hard bound; output uses the configured worker limit. Normalized
duplicates retain the first provider's result using the existing dedupe key. The registry
continues to deduplicate across profiles and enforce the combined limit.

The factory returns `(module_name, source_class)` pairs. Each provider receives
its own deep-copied query and empty host dictionary; package-local settings and
directory storage remain the installed package's responsibility.

Movies need a known IMDb ID, title and year. Episodes use the available IMDb ID, title,
season and episode. Optional authoritative `seriesTitle` is carried separately from the
episode `title` and mapped to `tvshowtitle`; absent series title and year stay empty.
The host validates `seriesTitle` as nonempty text of at most 300 characters when supplied.
Aliases are an empty list. No metadata is invented or fetched. Title-based episode providers may
return nothing when the series title is unavailable. Season/show pack discovery is not
called; a result marked as a package requires an explicit file index for episode requests.
Other episode candidates retain the existing release-marker/file-selection checks.

Query year, season and episode values are decimal text, including season zero;
an unavailable episode year is an empty string. Capture observes only the already
loaded provider module and restores its scoped observer on exceptions. Node's
existing bounded trusted series-metadata lookup supplies authoritative series
title before external episode resolution; lookup failure leaves it absent and
resolution continues. It does not infer an episode title or exact episode runtime.

Package enumeration through `xbmcvfs.listdir` validates both the directory and
each child target, including symlinks, against the existing authorized paths.

Provider exceptions and non-iterable output are isolated. If every attempted provider
fails and no valid sources survive, the worker fails with sanitized diagnostics. A successful
empty provider is operational. Packages may themselves conceal failures as empty lists;
this adapter cannot distinguish those from an actual empty scrape. One slow provider can
consume the disposable worker's timeout; no additional scheduler or provider threads exist.
Direct HTTP results must pass the existing candidate checks and remain untrusted at playback.

See [profile and package validation criteria](#profile-and-package-validation-criteria)
for the maintained regression references and limits of the historical A/B evidence.

## Callable stream resolvers (Checkpoint C)

`CallableStreamResolverAdapter` adapts one explicitly configured trusted local function
inside the existing disposable Kodi worker. The [disabled fixture profile](../config/kodi-callable.example.json)
can be copied into an ignored local profile file, enabled, and selected with
`PYTHON_ADAPTER_KODI_RESOLVERS_FILE`. Relative paths resolve against that file's directory.
The fixture uses Big Buck Bunny identity, its existing authorized torrent hash, and the
repository's public-literal fixture video URL; tests return data without fetching media.
For your own trusted installation, configure its addon path, ID, settings and target.
No third-party code is included or imported by the host.

The worker entrypoint is `adapter_host.kodi.adapters.callable_stream_resolver.resolve`.
`adapterConfig` requires exactly `targetModule`, `targetCallable`, and `resultMode`.
Names must be bounded Python identifiers (dotted modules, a single public callable);
entrypoint modules `default`/`service` and private module segments are rejected.
The profile/config machinery bounds, copies and freezes configuration at startup.
Adapter-specific validation happens at startup and again inside the worker. The selected
module must resolve physically below the configured addon `lib` or `resources/lib`
directory. These fixed roots are discovered at startup and again in the worker;
no `pythonRoot` option is accepted. `foo` may resolve from `lib/foo.py`, and
`resources.lib.scraper` from `resources/lib/scraper.py` (regular or namespace
packages). The addon root supplies only the package prefix, not target authority.
Package chains and cached module origins are checked before invocation; external
packages, targets outside these roots and escaping symlinks are rejected. Standard
root directories themselves must not be redirected by symlinks. The existing
filesystem guard still permits reads in the addon and writes only in the profile. HTTP fields, metadata,
external ID namespaces, headers and Stremio context cannot select code or configuration.

The adapter introspects only the declared subset of the known discovery keywords.
Both the full nine-keyword signature and shorter declared subsets are accepted;
unknown required or required positional-only arguments fail with a sanitized error.
IMDb is normalized when known, otherwise `None`. Movies map to `content_type="movie"`;
complete episodes map to `"tv"` with integer season/episode (including season zero).
Series requests and incomplete episodes return no results. Movie title, authoritative
`seriesTitle`, known year, and a present valid decimal TMDb ID supply identity overrides.
Absent known optional identity, callback and provider-selection values are `None`.
Unknown optional parameters keep their callable defaults, including recursion flags.
An episode title never substitutes for its series title. No IDs or titles are fetched or
fabricated. No arbitrary kwargs, argument DSL, classes or expressions are supported.

`resultMode="streams"` accepts a direct iterable of final stream dictionaries;
`"tuple"` accepts `(streams, failed_providers, was_canceled)` or
`(streams, failed_providers, empty_providers, was_canceled)`, with a boolean final flag.
The cancellation flag must be boolean and the collection iterable even when
canceled; canceled calls return no results. Diagnostics
are ignored. The adapter scans at most the existing 100-item worker bound and emits at
most the configured worker result limit. Existing normalization and deduplication retain
the first valid result in iteration order. Malformed entries are discarded individually;
import/call/iterator failures discard partial output and become sanitized worker errors.
Timeout, cancellation, output bytes and process cleanup use the existing process manager.

Only final stream fields from the existing `StreamSource` contract are copied. URL-based
HTTP/HTTPS video results, magnets and info hashes use existing normalizers; arbitrary
metadata, headers and behavior hints are discarded. For the `url` field, Kodi `url|Header=value` syntax is reduced to the base URL
before normal validation; everything after the first pipe is discarded without parsing
or forwarding headers. Magnets containing a pipe are rejected. Legacy P2P candidates (`hash`, `name`, GiB sizes, hoster tokens or packs) require
a different contract and are not guessed or converted. No episode-pack discovery or
file-selection inference is added. Python may pass structurally valid, credential-free
opaque HTTP/HTTPS URLs as unproven candidates; dangerous filename and URL-path suffixes
are rejected, including percent-encoded dangerous pathname suffixes. Python performs no
network probing and does not certify playability. Node URL policy and DirectStreamProbe
remain responsible for network validation and media evidence before opaque admission.
HLS playlist and child/segment validation remain in the existing Node pipeline.
Returned URLs remain untrusted data subject to Node's unchanged playback policy.

### Callable addon settings and empty discovery

`settingsFile` is a private UTF-8 JSON object of string keys and string values. The
existing worker loader reads that file for each disposable worker; `xbmcaddon.getSetting()`
returns `""` for an absent key. The compatibility runtime does not import defaults from
the addon's `resources/settings.xml`, and `setSetting()` changes only worker memory.
Maintain persistent choices in the private JSON selected by the local resolver profile,
not in `adapterConfig`, HTTP requests or the generic callable adapter. Keep it ignored
by Git; do not publish real settings, profiles, addon paths or credentials.

Some installed implementations require both a discovery master switch and individual
provider switches. Inspect the trusted installation's settings definitions and selection
logic, and persist only the choices you intend to use. Missing settings do not inherit
Kodi XML defaults. Retain reviewed choices when regenerating private JSON and restart
the host after changing startup profiles. No provider defaults are imposed by the adapter.

`enabled: true`, resolver `status: ok`, and HTTP 200 certify configuration/operation,
not that an individual provider ran or returned media. A valid empty result remains
valid. Even with explicit provider enablement, public provider availability is
nondeterministic. See [Checkpoint C status and regression evidence](#checkpoint-c-status-and-regression-evidence)
for the distinction between implemented contracts, historical evidence and functional acceptance.

The project-authored fixture covers both result modes, identity mapping, optional IDs,
malformed/empty/canceled results, bounds, failure sanitization, real worker cleanup and
HTTP injection attempts. The E2E uses the existing Node `ExternalHttpStreamProvider`
client, a real Python host, registry, resolver, worker and callable. These are deterministic
integration/system checks, not real provider playback certification. Live provider
availability is nondeterministic. Checkpoint C research is closed by the
2026-10-17 scope decision; functional evidence remains PARTIAL and the useful
SourcePack contribution requirement is unmet and deferred. See the
[approved decision](../FUTURE_WORK.md#checkpoint-c-functional-acceptance). The existing Python audit
guard remains a best-effort boundary for trusted code, not an OS sandbox for hostile addons.

The headless compatibility runtime also installs `xbmcplugin`. Its only supported
functions are `addDirectoryItems(handle, items, totalItems=0)` (returns `True`),
`setContent(handle, content)` and
`endOfDirectory(handle, succeeded=True, updateListing=False, cacheToDisc=True)`
(both return `None`). These are inert directory UI acknowledgements: arguments are
not consumed or retained, and no network, filesystem, command, plugin or playback
action occurs. Legacy plugin/player bindings remain passive; `setResolvedUrl` and
active player/UI actions raise PermissionError.


### Generic aggregate and SourcePack discovery

The callable adapter uses only these discovery keywords: `imdb_id`, `content_type`,
`season`, `episode`, `progress_callback`, `target_providers`, `override_title`,
`override_year`, `tmdb_id`. Signature and tuple rules are described above.

`adapter_host.kodi.adapters.source_pack.resolve` discovers flat local Python modules in a
configured package and its configured folders, then instantiates only their `source` class.
See `config/kodi-source-pack.example.json` for a disabled project-authored fixture profile.
Optional `adapterConfig.sourceIds` is a nonempty list of exact discovered module IDs,
for example `["fixture_sources.en.01_legacy"]`. When omitted, the adapter discovers
and runs all modules in the configured folders as before. When present, it restricts
that already authorized discovery set in discovered order; unknown IDs fail closed.
It grants no authority to import arbitrary modules and cannot be supplied through HTTP.
`sourcePackage` and `sourceFolders` are startup-local selectors. Module selection never
comes from HTTP or from the addon UI settings. Addon dependencies must be locally installed
and imports remain subject to `AddonPythonRoots` and the existing worker filesystem guard.

`maxProviderModules` defaults to 64 (strict integer range 1-128), `maxProviderWorkers` to 8
(strict integer range 1-8), with at most eight distinct flat folders. Enumeration/imports and
output order are deterministic. Each provider has an isolated instance and fresh argument
collections. A bounded thread pool runs providers inside the existing disposable worker;
the existing process manager retains hard timeout, cancellation and final cleanup authority.
Per-provider scanning, output bounds and dedupe reuse the existing limits and helpers.

Only the legacy and TMDb-aware `movie`, `tvshow`, `episode` signatures, and the two
`sources(url, hostDict[, hostprDict])` contracts are accepted. Missing identity methods or
unsupported signatures are skipped independently. Only authoritative `seriesTitle` supplies
`tvshowtitle`; episodes without it return zero. No metadata blob or episode-title fallback is
used. Host collections are empty; absent external IDs/year/premiere use empty
sentinels. No ResolveURL, debrid, catalog enrichment or Kodi playback is implemented.

The exact legacy identity signatures are:

```text
movie(imdb, title, localtitle, aliases, year)
tvshow(imdb, tvdb, tvshowtitle, localtvshowtitle, aliases, year)
episode(url, imdb, tvdb, title, premiered, season, episode)
```

The identifier-aware variants insert `tmdb` immediately after `imdb`. Optional
provider resolution accepts `resolve(url)` on that same provider instance.

Debrid-only, local, magnet/torrent and non-HTTP results are excluded. Direct candidates
with a known HTTP video/manifest pathname skip provider resolution. Opaque direct URLs
receive at most one `source.resolve(url)` attempt when available; a safe opaque result
(including the unchanged URL) may leave Python as an unproven candidate. Without a
provider resolver, safe opaque direct HTTP/HTTPS candidates may also leave Python.
Indirect candidates require one provider resolution and a supported HTTP video/manifest
pathname afterward; unresolved opaque indirect results remain rejected. Filename hints
cannot promote a wrapper to a final path or skip resolution. No ResolveURL/debrid
capability is added. Kodi pipe instructions are stripped; raw headers, cookies,
authentication, `info`, arbitrary metadata and source context never leave the adapter.
A bounded worker stderr summary counts direct, resolved, rejected intermediate, excluded and
invalid candidates for future HosterResolver work. Counters never enter StreamSource output.

Legacy libraries can bind passive Kodi UI/player names at import time. The stand-ins grant
no UI/player capability; active playback/UI entrypoints raise PermissionError. Directory
calls remain inert. Legacy path aliases delegate to the existing confined filesystem helpers;
`xbmcvfs.makeLegalFilename` is explicitly denied, because path translation does not
sanitize filenames.

SourcePack identity aliases contain the supplied movie title or authoritative series
title, without catalog enrichment. `adapterConfig.aliasesFormat` is a startup-only
contract setting: `list` (default) or `json` for packs whose identity methods decode
aliases with JSON. Each provider receives isolated mutable entries in list mode.
Host dictionaries remain empty until a supported hoster capability supplies them;
no ResolveURL/debrid capability is provided. A successful resolver's diagnostic
result count is measured before global
hygiene and can exceed its response contribution after filtering, deduplication
and the bounded round-robin merge described below.

## D2a local inner-source provenance

`KodiWorkerProcessManager.evaluation_source_ids()` and
`evaluate_source(media, source_id)` are developer-only, in-memory Python APIs for
SourcePack and external scraper package profiles. They are not HTTP routes and
are never called by normal `/resolve`. Construct the manager from an existing
locally configured `KodiResolverProfile` using `KodiInstalledResolver.from_profile()`;
its `manager` exposes these methods. Enumeration uses the profile's configured
package and folder list. Evaluation invokes one enumerated source in a fresh
bounded worker. The source ID is a local method argument, never a media or HTTP
field. Unknown IDs fail inside the worker.

Each returned list contains that source's normalized candidates before
cross-source deduplication and the profile result cap. Lists retain duplicates,
including candidates also returned by another source. The caller can count
Direct and torrent candidates and compare existing deduplication keys in memory;
D2a does not assign one owner to a duplicate or calculate quality. The existing
100-result worker scan and 256 KB IPC bound still apply. SourcePack's existing
`_run` failure behavior can yield an empty list for a failed source; external
package source failures retain any candidates produced before the failure, as in
normal aggregation. An empty list alone does not distinguish failure from a
valid empty source. Enumeration includes configured
sources that may return zero results for a given media item. No candidate data is
logged or persisted by this API. Caller-written reports must omit URLs, magnets,
credentials, and private paths.

Normal worker requests still contain only `requestId` and `media`. Normal
responses still contain `ok`, `results`, and `unsupportedCount`; normal adapter
aggregation, registry hygiene, and Node `external_http` are unchanged. The
additional worker operation requires an explicit local `--evaluation-source`
argument supplied only by the process manager methods above. It returns a
bounded source-ID list for enumeration or the same validated candidate response
for a single source. It cannot be selected through `/resolve`.

## Aggregate result hygiene

The registry collects bounded normalized resolver groups, then traverses them
round-robin by position in registration order. It considers every bounded group
before applying the configured global cap (default and hard maximum: 100).
This prevents one earlier group from filling every slot while later distinct
results go unseen; it is not a reservation for each inner source or a guarantee
that every resolver appears under all caps and duplicates. Per-resolver limits
still apply before merging, and Node retains its existing admission and ranking.

Known `seeds == 0` magnet/torrent candidates are excluded before consuming global
slots. Missing seed counts remain eligible; HTTP/HTTPS candidates are unaffected
even if they carry zero seeds. There is no cached-availability exception. Torrent
dedupe uses infoHash plus explicit fileIndex (filenames are only hints); distinct
file indexes remain separate. Other sources use `deduplication_key()`. A duplicate
torrent with stronger positive seeds replaces the stored candidate without moving
its merge slot; otherwise the first encountered candidate remains. Later bounded
groups can improve evidence even when the global output would already be full.
These are local hygiene rules, not swarm or functional-availability certification.

Per-resolver `resultCount` is the normalized group count before global hygiene.
Request-local operational outcomes are also determined before that merge: a valid
empty group, or one later entirely filtered/deduplicated/capped, can still make
`/resolve` operational. HTTP 200 therefore does not promise a nonempty response
or useful playback. The invocation-local 200/503/504 contract above remains in force.

## Checkpoint C status and regression evidence

**Research CLOSED with accepted limitations (2026-10-17); functional evidence
PARTIAL.** This approved scope closure is not complete acceptance or a frozen-criteria
PASS. Stremio technical utility and Kodi Callable historical marginal technical
contribution are demonstrated; Kodi audiovisual
identity remains pending. Correct additional SourcePack utility is not demonstrated.
The mandatory functional requirement remains unmet and explicitly deferred,
alongside Kodi audiovisual precision. Environmentally invalid resolutions
are not negative evidence. Further provider evaluation campaigns were outside the scope of this checkpoint and require separate validation.
Implementation and deterministic regression coverage exist; both families and
the callable and SourcePack contracts above are maintained
against current code. Historical PASS labels describe the recorded checkpoint,
not a fresh execution of those tests or live providers in this documentation lot.

| Area | Current interpretation and maintained evidence |
| --- | --- |
| Callable and SourcePack architecture | Implemented using existing immutable profiles and disposable workers. See [callable tests](tests/test_callable_stream_resolver.py), [SourcePack tests](tests/test_source_pack.py), [Kodi compatibility tests](tests/test_kodi_compat.py) and [Node/host E2E](tests/test_e2e_node_bridge.py). |
| Empty aliases and alias codec mismatch | Corrected: supplied movie/authoritative series title aliases, isolated mutable arguments and startup-only `aliasesFormat`. SourcePack tests cover real-worker list/JSON and episode contracts. |
| Registration-order aggregate monopoly and zero-seed slots | Corrected by bounded round-robin, filtering and stronger duplicate evidence. See [result hygiene tests](tests/test_result_hygiene.py), including deterministic 100-result sharing, distinct file indexes and HTTP dedupe. This does not prove live SourcePack contribution. |
| Source selection and opaque Direct URLs | Later bounded `sourceIds` selection and opaque Direct handling are implemented. SourcePack tests verify discovered-order selection, unknown-ID refusal, HTTP selector rejection, final direct paths avoiding unnecessary resolve calls, and unresolved indirect rejection. Python emits unproven Direct candidates; Node still validates/probes. |
| Operational availability | [HTTP availability tests](tests/test_http_availability.py) cover valid empties, healthy survivors, all-configured failure, partial-invalid output, caps and overlapping invocation-local outcomes. Operational status is distinct from useful media. |

Discovery can return no candidates, and a reachable media response can be a short
sample reused across unrelated requests. Neither outcome establishes requested
content or useful SourcePack contribution. Aggregate-callable HLS transport
success does not establish SourcePack success or a Stremio UI journey. These
limitations remain relevant; private implementation counts, availability results
and media measurements are retained only in the external archive. No live rerun
or new availability claim is made.

The historical claim that a DirectStreamProbe HLS/206 change was still pending
is superseded by the current implementation and its existing probe tests. Its
test totals, coverage and timings likewise remain historical. Disposable worker
code is not traced by host-process coverage; real-process assertions supply that
boundary evidence. No previous pass certifies sustained playback or remote supply.

The complete original report, including historical counts and limitations, is
preserved in the independent external v1.3 evaluations/Checkpoint C archive with
relative paths, source commit/blob, byte sizes and verified recovery SHA-256.
The [approved decision and deferred requirements](../FUTURE_WORK.md#checkpoint-c-functional-acceptance)
retain HosterResolver, real useful SourcePack contribution, remaining availability
and playback gaps. Historical implementation success does not satisfy those
requirements; the scope closure accepts their deferral without changing criteria.

For the separate D2b synthetic funnel, commands, structural counts and inference
limits, see [provider quality evaluation](../docs/provider-quality-evaluation.md#kodi-source-evaluation-d2b).
