# Changelog

## [1.3.0] - 2026-10-20

Public source release v1.3.0. Linux and Windows hosted CI passed on base commit `98211a9d2e33c333193983bb9525b2a92dd364c2`; see the release notes for the exact run and its scope. See [v1.3.0 notes](docs/releases/v1.3.0.md) for compatibility, evidence and accepted limits.

### Added

- Bounded bridge-owned Identity states and separate public transport/identity markers, supported by synthetic characterization and integration fixtures.
- Startup-local Python resolver profiles, aggregate callables and SourcePack discovery contracts; registry fairness and known-zero-seed filtering.
- Localhost Host/context policy and independent Bearer authentication for administrative reads and writes. Administration is disabled without a configured secret.

### Changed

- The public v1.3 source release is available under [PolyForm Noncommercial 1.0.0](LICENSE), with a [Required Notice](NOTICE) and [contribution guidance](CONTRIBUTING.md). Earlier private snapshots carried MIT notices; their history and third-party rights are preserved.
- Direct probing recovers cached results before allocating fresh network slots and reapplies current qualification and URL policy.
- HLS descendants share bounded session inactivity authority; child replacement, expiry and eviction revoke obsolete capabilities.
- Recipient-scoped source headers, conditional representation binding, provider credential redirect boundaries and HLS text minimization retain explicit limits.
- Compact stream presentation omits unverified generic provider language labels and upstream free text from the supported direct output.
- Python startup environment filtering, Node/Python logging and public error boundaries are hardened; bodyless HTTP responses are handled safely.
- Repository fixtures use synthetic evaluation data; working-tree hygiene does not sanitize inherited private history.

### Evidence and deferred work

- Existing tests cover controlled HTTP, resolver, adapter, worker and process boundaries. This documentation pass does not rerun full Node/Python suites or establish real BitTorrent, audiovisual or Stremio UI acceptance.
- PR6 remains open: 41 provenance/composition dimensions and two dependent ranking dimensions are deferred unmet requirements. Identity remains frozen. R-020 remains open with bounded residual risk provisionally accepted for v1.3. Advanced localhost hardening remains deferred; current localhost controls have recorded Desktop validation and accepted residual risks.
- Checkpoint C research is closed with PARTIAL functional evidence; additional SourcePack utility and Kodi audiovisual precision remain unproven.
- The embedded development-tool dependency risk remains temporarily accepted for local integration; see [dependency review](docs/dependency-security-review.md). A clean npm audit does not certify that bundle.

## [1.2.1] - 2026-09-26

### Fixed

- Direct HTTP/HTTPS playback tokens now renew their one-hour TTL on valid use and expire after inactivity.
- At capacity, source-token eviction selects the earliest expiry so recently active playback remains eligible.
- Safe diagnostics distinguish expired from invalid playback tokens without exposing token or source values.
- Vitest exclusion globs remain literal in Linux CI.

### Known limitation

- HLS resource tokens retain their absolute TTL; their lifecycle needs a separate review.

## [1.2.0] - 2026-09-25

### Added

- Optional trusted Stremio movie metadata lookup supplies title, year, and runtime for source qualification.
- Bounded MP4 `moov/mvhd` and HLS VOD runtime checks reject clearly wrong-duration movies in either direction when reliable request metadata is available. Unknown runtime remains eligible.

### Changed

- Direct HTTP/HTTPS probing better distinguishes playable media from document and archive responses, deterministic HTTP failures, and rejected redirects. Probe work is shared more fairly across providers within the existing limits.
- HLS probing checks required MAP, KEY, session-key, and selected audio dependencies before advertising a source; playlist token registration and candidate backfill remain bounded.
- Explicit identity contradictions are filtered while sparse and localized source labels remain eligible. Provider diagnostics report rejection counts without source details.

### Tested

- Local acceptance regressions cover wrong-duration and unrelated media, healthy-source survival, playback bytes, HLS dependencies, and probe budget behavior.
- Recall smoke found no reproduced regression from the recent MP4 probing changes.

### Known limitations

- Runtime-based identity checks remain fail-open when a reliable media duration cannot be determined. `Verified` indicates transport/media verification, not content identity.

## [1.1.0] - 2026-09-23

### Added

- Explicit Direct HTTP/HTTPS and Tribler choices in Stremio, with separate playback paths and no silent transport fallback.
- Bridge-owned torrent lifecycle with `smart`, `ephemeral`, and `keep_all` retention modes, persistent ownership state, pin/unpin operations, and active-stream deletion protection.
- Provider concurrency limits and failure isolation, plus system coverage for provider outages and bridge restart.

### Changed

- Direct playback and seek qualification now covers real HTTPS `206` range responses; Tribler playback and seek were verified against real Tribler and in Stremio Desktop.
- Removed the unsupported CodeQL workflow for this private personal repository. Repository safety checks, security tests, dependency audits, and the main CI workflow remain.

### Security

- `/downloads` now exposes only selected diagnostic fields and redacts URL-like names instead of returning arbitrary Tribler response fields.
- Malformed Tribler JSON and bridge error responses no longer reflect upstream content in public endpoints.

### Tested

- AC1–AC10 passed, including the manual Stremio journey.
- Local release gate: 272 non-acceptance Node tests, 13 system-acceptance tests, 21 security tests, 285 tests under Node coverage, and 54 Python tests.
- Both npm dependency audits reported zero advisories.

### Known limitations

- One real Tribler seek took about 27 seconds while downloading at about 750 KB/s. This remains a performance investigation, not a v1.1.0 release blocker.
- Provider availability and the local Python/Kodi compatibility layer retain the limits described in [SECURITY.md](SECURITY.md) and [README.md](README.md).

## [1.0.0] - 2026-09-17

### Added

- Localhost-only Stremio bridge with modular catalog and stream-provider architecture.
- Standard Stremio addon providers, local/external metadata providers and an optional Python resolver host.
- Isolated Kodi-compatible workers for locally installed resolver modules.
- Direct HTTP/HTTPS playback and BitTorrent playback delegated exclusively to Tribler.
- Movie and episodic resolution with deterministic `fileIndex` handling.
- Range/seek support, bounded Tribler read-ahead buffering, stream ranking/deduplication and aggregate streaming metrics.
- Provider diagnostics, buffer benchmarks, runtime privacy audit tooling and sanitized public configuration examples.

### Changed

- Episodic identity preserves IMDb, season and episode through stream resolution.
- Ambiguous multi-file episode torrents fail closed instead of selecting a presumed main video.
- Public examples and local configuration now use a consistent `.example` / `.local` split.

### Security

- Localhost-only control surface and isolation of the Tribler API secret.
- Hardened outbound HTTP with SSRF, DNS and redirect validation plus minimized headers and opaque playback tokens.
- No direct BitTorrent implementation in Node; playback is delegated to Tribler.
- Python worker configuration is startup-local only and cannot be selected through HTTP.

### Tested

- Node suite: 250 non-acceptance tests and 7 system-acceptance tests.
- Python suite: 54 tests.
- Repository safety scan, typecheck, lint, coverage baselines and production build.
- Local Tribler runtime playback audit and episodic metadata/provider boundary coverage.

### Known limitations

- Provider availability and external APIs remain outside the bridge's control.
- Ambiguous multi-file episode torrents are rejected.
- Local privacy observations do not prove global network anonymity.
- The Python/Kodi compatibility layer intentionally supports a limited API subset.
