# Stream identity coverage and characterization

Historical checkpoints: initial characterization **2026-10-03**, decision reconciliation **2026-10-11**, and the dated refinement checkpoints below. The map and inventory describe those checkpoints, not a new audit of the release tree. Phase 0–2 characterization is historical evidence; Phase 2.5 consolidates the refined [canonical acceptance contract](IDENTITY_ACCEPTANCE.md), now 78 criteria. The [campaign](IDENTITY_QA_CAMPAIGN.md) is the operating plan. No production/test changes or new executions are part of this consolidation.

In the historical sections, “current”, “now” and “pending” refer to their own
checkpoint. Counts from different checkpoints must not be combined. The
[campaign checkpoint of 2026-10-17](IDENTITY_QA_CAMPAIGN.md#verified-state-and-metric-boundaries)
records the later 43-dimension state without promoting whole-AC coverage.

## Phase 0: frozen state and production path

The initial characterization mapped the production path below, including measured
runtime, bounded resource evidence, series title/year enrichment and non-decisive
episode resource-year behavior. This historical map does not assert complete
implementation of the later composition contract.

| Stage | Production files at the checkpoint | What the stage does |
| --- | --- | --- |
| Application/public request | `src/app.ts`, `src/addon.ts`, `src/streams/factory.ts`, `src/streams/types.ts` | Builds the requested media item, preserves exact video ID, chooses catalog/provider wiring, registers only surviving playback sources and publishes diagnostics. |
| Trusted metadata | `src/metadata/movie-metadata.ts` | Validates bounded ID/type/title/year and optional movie runtime; safe bounded redirects/cache/concurrency. Series lookup supplies validated title/year, **no exact episode runtime**. |
| Provider request identity | `src/streams/stremio-episode-identity.ts`, `addon-request-identity.ts`, `media-id-mapper.ts`, `stremio-addon-manifest.ts`, `content-type-policy.ts`, `stremio-addon-config.ts` | Preserves exact episode request identity, validates compatible namespaces/types and provider enablement; does not infer alternate database IDs. Paths without a directory prefix in this row are under `src/streams/`. |
| Candidate intake | `src/streams/providers/{catalog-stream-provider,manual-stream-provider,local-json-stream-provider,remote-json-stream-provider,external-http-stream-provider,stremio-addon-stream-provider}.ts`, `src/streams/normalization.ts`, `src/source.ts`, `src/video-selection.ts` | Adapters obtain bounded candidates; shared normalization validates structural inputs, strips provider-supplied probe metadata and retains the bounded explicit identity shape. Structural video names are media hints, not proof of identity. |
| Shared qualification | `src/streams/identity-qualification.ts` | Checks kind, external IDs, episode S/E, movie year and separate declared movie duration; parses bounded filename/original resource facts. Episode year mismatch is **not** a hard reject. |
| Pre-probe resolver | `src/streams/resolver.ts`, `src/streams/stream-deduplication.ts`, `src/streams/scoring.ts`, `src/streams/ranking-policy.ts` | Normalizes, rejects supported contradictions, validates URL policy, deduplicates and schedules probes. Raw per-provider intake is bounded at 100; final distinct retention is bounded at 50. |
| Independent measurement/resource observation | `src/streams/direct-stream-probe.ts`, `src/streams/mp4-runtime.ts`, `src/hls-playlist.ts` | Measures verified bounded MP4 mvhd or complete HLS VOD; derives bounded numeric facts from successful validated effective media/selected video-playlist URLs. Failed/unsafe transport supplies no effective identity. |
| Protected transport | `src/network/{outbound-transport,url-policy,dns,http-privacy}.ts` | Validates DNS, redirects and endpoints and sanitizes source headers; independently protects origin access. |
| Post-probe qualification | `src/streams/resolver.ts`, `src/streams/identity-qualification.ts` | Applies measured runtime and effective resource contradictions, increments existing identity-rejection counts, uses existing bounded backfill, then applies media eligibility/ranking. |
| Playback/public output | `src/playback/manager.ts`, `src/playback/backends.ts`, `src/addon.ts`, `src/app.ts`, `src/logger.ts` | Registers survivors under opaque local tokens and exposes bounded diagnostics/logs. Playback evidence is separate from content identity. |
| Observational audit | `src/streams/identity-precision-evaluation.ts`, `src/streams/provider-quality-evaluation.ts`, `src/streams/source-diversity-evaluation.ts`, `src/streams/kodi-source-quality-evaluation.ts`, `scripts/evaluate-stremio-providers.ts`, `scripts/evaluate-kodi-sources.ts` | Shared qualification supplies contradiction categories; independent resource text/IDs supply observational corroboration. Reports retain aggregate enums and safe provider IDs, not locators. Audit does not change admission. Diversity source overlap is not content identity correctness. |

Movies use `max(10 min, 30%)`; exact episodes use `max(3 min, 20%)`, strict greater-than rejection. Episode tests can exercise the conditional rule by injecting `NormalizedMediaItem.runtimeSeconds`. The supported production series metadata lookup does not obtain or propagate exact episode duration; no typical series runtime is substituted. This campaign does not restart the runtime investigation or count previous live schema observations as fresh manual acceptance proof.

### Actual test inventory

The inventory was derived from files/imports/cases at the characterization checkpoint. Supporting tests below materially constrain identity provenance, request wiring, recall, deduplication or privacy; they are not all semantic content-identity tests.

| Family | Actual files | Evidence scope |
| --- | --- | --- |
| Shared identity/audit | `tests/identity-precision-qa.test.ts`, `tests/identity-runtime.test.ts`, `tests/resource-identity.test.ts`, `tests/identity-precision-evaluation.test.ts` | Helper and real resolver/component cases, synthetic measured MP4/HLS, resource provenance, observational categories and bounded properties. |
| Trusted/request metadata | `tests/movie-metadata.test.ts`, `tests/stremio-episode-identity.test.ts`, `tests/addon-request-identity.test.ts` | Metadata validation and mapping; helper success is not public route propagation. |
| Resolution/media | `tests/stream-resolver.test.ts`, `tests/direct-stream-probe.test.ts`, `tests/mp4-runtime.test.ts`, `tests/hls-playlist.test.ts` | Shared filters, media eligibility, bounded measurement, scheduling and HLS transport. MP4/HLS parser tests alone do not prove request wiring. |
| Real adapter boundaries | `tests/external-http-stream-provider.test.ts`, `tests/stremio-addon-stream-provider.test.ts` | Actual adapter request serialization and normalization with substituted HTTP boundary. |
| Source identity/recall support | `tests/stream-result-hygiene.test.ts`, `tests/source-request-headers.test.ts`, `tests/content-type-policy.test.ts`, `tests/stream-ranking-policy.test.ts`, `tests/scoring.test.ts`, `tests/source.test.ts`, `tests/video-selection.test.ts`, `tests/playback-manager.test.ts`, `tests/json-provider.test.ts`, `tests/stremio-addon-config.test.ts` | Candidate bounds, URL/header/file-index dedup identity, type routing, ranking, file selection and playback registration. None establishes that compatible content is actually the requested title. |
| Evaluation support | `tests/provider-quality-evaluation.test.ts`, `tests/kodi-source-quality-evaluation.test.ts`, `tests/story-f1-evaluation.test.ts`, `tests/story-f2-evaluation.test.ts`, `tests/standard-evaluation-corpus.test.ts` | Observer neutrality, report sanitation and overlap/cost/corpus schemas. “Identity” in diversity tests often means source identity, not semantic match. The balanced evaluation fixture is synthetic contract data, not an identity campaign corpus. |
| Integration | `tests/integration/stremio-movie-metadata.test.ts`, `tests/integration/stremio-addon-provider.test.ts`, `tests/integration/bridge.test.ts`, `tests/integration/standard-stremio-addon-fixture.test.ts`, `tests/integration/direct-http-playback.test.ts` | Public enrichment or real adapter/resolver/playback layering; direct playback/standard fixtures mainly prove routing and privacy, not semantic contradiction matrices. |
| Acceptance | `tests/acceptance/dirty-upstream.test.ts` | Real public HTTP app, controlled upstream HTTP servers, real configured adapters/metadata/probe/playback. Node runs in the test process; no spawned bridge/Python is proven here. |
| System | `tests/system/bridge-process.test.ts` | Spawned bridge and controlled dependencies; some cases include Python adapter process. Synthetic identity matrix has direct probing disabled, so it proves neither measured runtime nor effective redirect identity. |
| Safety/privacy support | `tests/outbound-transport.test.ts`, `tests/url-policy.test.ts`, `tests/security-boundaries.test.ts`, `tests/security/adversarial-boundaries.test.ts`, `tests/privacy-boundaries.test.ts`, `tests/privacy-runtime-audit.test.ts` | Protected evidence provenance, aggregate/public sanitation and local Tribler boundary. Runtime-audit classifier tests are not actual observed runtime privacy or content identity. |
| Opt-in observation | `tests/privacy-tracker-observation.test.mjs` | Existing opt-in external observation, not run or counted as campaign manual identity proof. |
| Fixtures, not independent proof | `tests/helpers.ts`, `tests/mp4-fixture.ts`, `tests/acceptance/dirty-upstream.ts`, `tests/fixtures/python-adapter-client.ts` | Controlled external boundaries and process support. No fixture/test edits were made. |

## Reading the coverage map

`COVERED` means existing assertions exercise the stated bounded requirement at its required level. `PARTIAL` means related evidence exists but a required level, variant, provenance path or scope is missing. `UNCOVERED` means no current assertion proves the requirement. `DECISION_REQUIRED` describes unresolved policy at earlier historical checkpoints; no current product-policy row has that status after explicit human year-policy approval. Counts are criteria counts, never test counts.

Every evidence code in the map resolves to an **exact file and exact case below**, with the path/level it proves. This keeps rows readable without claiming a parser proves the bridge. An em dash means no claimed evidence at that level. Property cells refer to existing deterministic mutation/permutation cases, not generated/exhaustive property testing. Manual evidence is absent for this campaign.

### Exact focused/component evidence references

| Code | Exact file / case | What path it actually proves |
| --- | --- | --- |
| Q1 | `tests/identity-precision-qa.test.ts` — `qualifies $label through the shared resolver` | Component: fake provider → real registry/normalization/shared resolver; table covers matching/conflicting ID/year, movie/episode kind and episode S/E, not metadata lookup. |
| Q2 | Same file — `keeps sparse, localized and ambiguous presentation fail-open: %s` | Component: direct candidate labels and explicit metadata titles, including an unrelated title, survive a real resolver without probing. |
| Q3 | Same file — describe `independently measured %s runtime without filename identity`, case `$item.kind expected $expected min / measured $measured min => admitted $admitted` | Component: supplied requested item → real resolver/probe → injected HTTP boundary with actual synthetic MP4/HLS bytes; **no expected-runtime metadata wiring**. |
| Q4 | Same file — `preserves each type's exact tolerance boundaries and fails open on invalid observations`; `intentionally admits %s -> %s minutes for a movie and rejects it for an exact episode` | Focused: direct helper thresholds/invalid values/type distinction; the second case constructs probe metadata directly. |
| Q5 | Same file — `requires verified supported runtime evidence, ignoring provider duration claims for episodes` | Focused: helpers reject only supported verified measurements; does not exercise raw provider normalization. |
| Q6 | Same file — `backfills a measured episode contradiction within existing limits and reuses cached measurements` | Component: manually supplied exact runtime + real HLS probe/resolver verifies one replacement, cache reuse and identity accounting. |
| Q7 | Same file — `keeps the survivor set invariant under reversal and a deterministic shuffle`; `preserves every existing decision after duplicate noise and additional strong contradictions` | Component/property: small fixed candidate sets with probing disabled and below intake/final caps. |
| Q8 | Same file — `classifies $label without changing production admission` | Component: real resolver plus observational audit distinguishes canonical resources, generic/presentation-only labels, title disagreement and shared contradictions. |
| Q9 | Same file — `admits unverified transport without making it an identity contradiction`; `does not infer runtime from multipart names or filesize` | Component: known video survives a 503 without contradiction; no-probe multipart candidates are not assigned a runtime. |
| R1 | `tests/resource-identity.test.ts` — `recognizes release marker %s without inventing a season`; `qualifies movie resource %s independently of a misleading label`; `qualifies episode coordinates in %s while deferring release-year rejection` | Focused: shared helper reads bounded original basename/filename facts and preserves non-decisive episode-year behavior under approved AC-ID-028. |
| R2 | Same file — `keeps malformed or conflicting markers ambiguous: %s`; `decodes only the final component, ignores token/query/fragment and refuses malformed or non-media names` | Focused: helper returns no contradiction for unusable/ambiguous resource evidence; this does not imply malformed URLs pass normalization. |
| R3 | Same file — `defers episode resource-year rejection while keeping coordinate contradictions independent of echoed metadata` | Focused: filename/title echoes cannot mask original URL coordinates; conflicting episode year alone remains non-rejecting. |
| R4 | Same file — `shares URL evidence across normalized provider families before any probe` | Component: three fabricated provider family IDs feed the shared resolver; real adapters are not all involved. |
| R5 | Same file — `qualifies $label after safe validated redirects without retaining a locator` | Component, multiple real layers: real resolver/probe/validated DirectTransport with pinned socket request replaced, including episodic movie rejection and year-only episode survival. |
| R6 | Same file — `backfills structural post-probe rejections within the existing limit, preserving evidence in the probe cache` | Component: real validated redirect/probe/resolver bounded replacement and cached numeric evidence. |
| R7 | Same file — `records only safe numeric evidence from selected HLS variant URLs`; `blocks unsafe redirects without resource evidence or identity rejection counts`; `does not promote an episode-shaped failed response into identity evidence` | Component: validated transport/probe/resolver rejects unsafe/failed media without invented identity and retains numeric-only evidence from successful selected playlists. |
| E1 | `tests/identity-precision-evaluation.test.ts` — `uses shared strong contradictions and only independent corroboration for MATCH`; `keeps an episode's resource-title disagreement observational while year hard rejection is deferred` | Focused: audit/helper classification, including episode title disagreement without year contradiction. |
| E2 | Same file — `applies identical shared filtering to all normalized provider families while observing title ambiguity`; `retains aggregate enums only and ignores provider-supplied probe evidence` | Component/focused: fabricated providers share resolver filtering; provider-stage audit renormalizes and drops forged measurements, reports aggregates. |
| M1 | `tests/movie-metadata.test.ts` — `preserves a bounded runtime without requiring it for valid movie identity`; `bounds responses and ignores invalid or ambiguous years without losing a valid title` | Component: real trusted lookup validation with injected fetch; no public media-item propagation. |
| M2 | Same file — `does not manufacture exact episode runtime from series runtime or episode air dates`; `uses the series endpoint and keeps validated name and year` | Component: real series lookup returns title/year only; no exact-duration positive extraction case. |
| SR1 | `tests/stream-resolver.test.ts` — `rejects explicit episode and media-kind contradictions while leaving missing evidence eligible` | Component: fake provider → real resolver rejects wrong S/E/movie kind for an episode; keeps compatible series and an unrelated sparse label. |
| SR2 | Same file — `rejects a different structured movie prefix while keeping matching and generic stream labels`; `keeps different titles and years eligible without a requested year, but rejects a different IMDb ID` | Component: explicit movie year/ID qualification; also deliberately admits unrelated title-only/compatible-year labels. |
| SR3 | Same file — `does not let one candidate year claim hide a conflicting structured release year` | Component: real resolver rejects presentation year conflicting with request despite matching metadata year. |
| SR4 | Same file — `preserves Starfarer recall across localized, generic, opaque, HTTP and unverified sources`; `rejects opaque direct URLs when the probe is disabled` | Component: fixture-labelled transports preserve bounded recall; opaque eligibility still requires probe. The recall fixture labels were subsequently replaced with invented identities; the bounded contract is unchanged. |
| T1 | `tests/direct-stream-probe.test.ts` — `measures %s MP4 with at most one bounded extra range`; `fails open on an invalid MP4 follow-up Range without reading further`; `derives and caches bounded HLS VOD duration from the fetched media playlist` | Component: actual probe with fake transport measures or leaves duration unknown and caches observation; no trusted requested-runtime lookup. |
| T2 | `tests/mp4-runtime.test.ts` — `treats truncated mvhd, zero timescale and unsupported version as unknown`; `tests/hls-playlist.test.ts` — `measures only complete bounded VOD media playlists` | Focused: independent duration parsers distinguish valid complete measurement from unknown. |
| P1 | `tests/provider-quality-evaluation.test.ts` — `keeps normal resolver contents and ordering when observation is enabled`; `attributes stages and probe outcomes without retaining or emitting URLs` | Component: audit/trace is admission-neutral and redacts source observations; it does not prove title correctness. |
| W1 | `tests/addon-request-identity.test.ts` — `preserves an exact catalog video ID ahead of base or mapped IDs`; `does not fabricate an IMDb ID for an episode missing season or episode` | Focused: exact request mapping and missing-coordinate guard. |
| W2 | `tests/stremio-addon-stream-provider.test.ts` — `maps direct HTTP URLs structurally, including opaque paths, sanitizes proxy request headers and ignores unsupported targets`; `tests/external-http-stream-provider.test.ts` — `keeps an IMDb episode identity exact without inventing either title` | Component: actual adapter mapping/serialization with HTTP boundary substituted; not full public bridge qualification. |

### Exact integration evidence references

| Code | Exact file / case | What path it actually proves |
| --- | --- | --- |
| I1 | `tests/integration/stremio-movie-metadata.test.ts` — `rejects only the contradictory 2020 movie before registering playback` | Integration: public SDK route + real trusted lookup and raw addon adapter → resolver → playback registration, with direct probing absent. |
| I2 | Same file — `fetches trusted runtime even when the owning catalog already supplies movie title/year` | Integration: public route and trusted movie runtime enrichment with catalog-owned identity → actual synthetic MP4 measurement via injected transport → reject 22-minute/retain 90-minute candidates for 71-minute movie. |
| I3 | Same file — `enriches the external IMDb episode with seriesTitle while preserving exact video identity` | Integration: real createApp/public route → real series lookup and external HTTP request; asserts duration is absent from serialized request, **not** from internal requested item or measured episode qualification. The adapter omits runtime from requests regardless. |
| I4 | Same file — `rejects weak multiline runtime after an inconclusive HLS probe while retaining a source without duration` | Integration: public requested movie enrichment + synthetic raw addon text → inconclusive HLS probe, textual-duration rejection and no-duration recall. The initial pre-probe characterization predates the supported verified-measurement override; neither form proves audiovisual identity. |
| I5 | Same file — `reproduces the six-candidate unenriched control with the same raw stream shape`; `keeps streams available when trusted meta supplies a title without a year`; `keeps streams available when metadata lookup times out` | Integration: public route preserves candidates under absent/unusable expected year; unrelated explicit titles are included in the fixture. |
| I6 | `tests/integration/stremio-addon-provider.test.ts` — `qualifies structured movie labels from raw addon JSON when the request carries title and year`; `sends an exact IMDb episode identity to a series-capable addon and keeps direct playback` | Integration: real raw addon adapter → resolver → playback with manually supplied requested item; no trusted metadata acquisition. |

### Exact acceptance/system evidence references

All `A` references are `tests/acceptance/dirty-upstream.test.ts`, describe `dirty upstream public-route acceptance`: real public HTTP app/fixtures and production metadata/adapters/transport/probe/playback; not a spawned bridge. All `S` references are `tests/system/bridge-process.test.ts` with a spawned bridge.

| Code | Exact case | What path/variant it proves |
| --- | --- | --- |
| A1 | `compares both runtime directions when a large final MP4 index starts after mdat`; `uses a complete early mvhd in an oversized fast-start moov to reject a short movie` | Acceptance: trusted public movie runtime → actual bounded MP4 bytes → shorter/longer rejection, close-duration admission and invalid measurement survival. |
| A2 | `rejects a short complete VOD by playlist duration while a film-length sibling plays`; `keeps VOD duration variants and HLS playlists without complete VOD evidence` | Acceptance: public movie trusted duration + actual complete HLS measurement, positive variants, incomplete/event duration fail-open and local HLS playback. |
| A3 | `keeps localized and sparse playable movies while rejecting independent identity mutations` | Acceptance/property: public movie year/type/declared duration conflicts reject before probing; localized/sparse sources remain playable in two candidate orders. |
| A4 | `keeps eligible presentation mutations while composing strong contradictions with quality metadata` | Acceptance/property: label/quality mutations and two-source order permutations cannot mask explicit year/media failure. “Localized” is a synthetic mutation, not an authoritative alias. |
| A5 | `keeps a safe redirect playable while refusing redirected private targets and loops` | Acceptance: public transport/playback admission with successful redirect and blocked/looping alternatives, not effective basename identity decisions. |
| A6 | `does not trust provider-supplied probe fields or a video URL with a dangerous filename` | Acceptance: raw addon forgery cannot skip actual probing; unsafe filename is dropped before fetching; no specific forged duration assertion. |
| A7 | `deduplicates repeated URLs before a two-candidate probe cap in either raw order`; `keeps a distinct candidate after 50 raw URL duplicates` | Acceptance/property: exact URL duplicate recall under the tested caps/order, not arbitrary conflicting duplicate metadata or more than 100 raw candidates. |
| A8 | `keeps a healthy candidate after 50 explicit identity contradictions`; `backfills a deterministic failed probe without hiding a playable sibling` | Acceptance: pre-probe contradiction noise and deterministic HTTP failure backfill retain a public playable sibling; not post-probe runtime contradiction backfill. |
| A9 | `keeps a playable provider sibling through a slow failure and recovery in either provider order`; `gives a later provider a probe slot before an early provider exhausts the shared budget` | Acceptance: two-provider transport opportunity/failure isolation, not contradiction preservation under cross-provider metadata dedup winners. |
| A10 | `keeps an opaque ranged Matroska source while rejecting completed XML 403 and HTML`; `keeps an opaque playable MP4 when the requested movie has no structured contradiction` | Acceptance: sparse/opaque actual media eligibility and local playback, distinct from positive content identification. |
| S1 | `qualifies synthetic movie and episode matrices through one real bridge after a permitted metadata redirect` | System: public movie/episode metadata enrichment + pre-probe label/filename/original URL kind/year/S/E qualification and diagnostics privacy; probe disabled, episode-year-only survives. |
| S2 | `A03 returns an opaque episode stream without publishing the producer's identity filename`; `A04/A05/A09 resolve movie and episode torrents through both processes and preserve fileIndex` | System: exact request identity through spawned bridge/adapter and local playback/backend selection; not exact-runtime enrichment or content verification. |

### Refined Phase 2.5 AC-to-evidence map

AC-ID-001–059 retain stable IDs; statuses below assess the refined contract. Historical initial counts remain recorded separately. Existing MATCH assertions are observation-only and do not automatically prove CORROBORATED under the new positive matrix.

| AC | Requirement | Focused | Integration | Acceptance | System | Property | Manual | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-ID-001 | Independent matching movie external ID | Q1, E1 | — | — | — | — | — | PARTIAL |
| AC-ID-002 | Conflicting external ID | Q1, SR2 | — | — | — | — | — | PARTIAL |
| AC-ID-003 | Compatible movie year and refined positive boundary | Q1 | I1, I6 | A3 | S1 | — | — | PARTIAL |
| AC-ID-004 | Incompatible movie year | Q1, R1, SR3 | I1, I6 | A3, A4 | S1 | A4 | — | PARTIAL |
| AC-ID-005 | Episodic candidate for movie | Q1, R1 | — | A3 | S1 | — | — | COVERED |
| AC-ID-006 | Compatible measured movie runtime | Q3, Q4 | I2 | A1, A2 | — | — | — | COVERED |
| AC-ID-007 | Gross measured movie mismatch | Q3, Q4 | I2 | A1, A2 | — | — | — | COVERED |
| AC-ID-008 | Missing expected movie duration | Q3, Q9 | — | — | — | — | — | PARTIAL |
| AC-ID-009 | Missing media duration | Q3, T1, T2 | — | A1, A2 | — | — | — | COVERED |
| AC-ID-010 | Generic movie label | Q2, Q8 | I1 | A3, A10 | S1 | — | — | COVERED |
| AC-ID-011 | Opaque verified movie | SR4 | — | A10 | — | — | — | COVERED |
| AC-ID-012 | Localized movie recall | Q2, SR4 | — | A3, A4 | S1 | A3 | — | PARTIAL |
| AC-ID-013 | Explicit different movie title: admit/suspicious | Q2, SR2 | I5 | — | S1 | — | — | PARTIAL |
| AC-ID-014 | Different title plus strong conflict | Q1, SR2 | I1 | A3 | S1 | — | — | COVERED |
| AC-ID-015 | Separate textual duration rule | Q5 | I4 | A3 | S1 | — | — | PARTIAL |
| AC-ID-016 | Runtime claim provenance | Q5, E2 | — | A6 | — | — | — | PARTIAL |
| AC-ID-017 | Exact episode S/E | Q1, R1 | I3, I6 | — | S1 | — | — | COVERED |
| AC-ID-018 | Wrong season | Q1, R1 | — | — | S1 | — | — | COVERED |
| AC-ID-019 | Wrong episode | Q1, R1 | — | — | S1 | — | — | COVERED |
| AC-ID-020 | Movie kind for episode | SR1 | — | — | — | — | — | PARTIAL |
| AC-ID-021 | Series title variation: unknown without reliable identity | R1, E1 | — | — | — | — | — | PARTIAL |
| AC-ID-022 | Generic episode label | Q1, R1 | I3 | — | S1 | — | — | COVERED |
| AC-ID-023 | Compatible exact episode runtime | Q3, Q4 | — | — | — | — | — | PARTIAL |
| AC-ID-024 | Gross exact episode runtime mismatch | Q3, Q4, Q6 | — | — | — | — | — | PARTIAL |
| AC-ID-025 | Exact duration unavailable | Q3, M2 | I3 (request only) | — | — | — | — | PARTIAL |
| AC-ID-026 | Explicit different series title: admit/suspicious | E1, SR1 | — | — | — | — | — | PARTIAL |
| AC-ID-027 | Ambiguous episode resource | R2 | — | — | — | — | — | PARTIAL |
| AC-ID-028 | Episode resource/release year is non-decisive | R1, R3, R5, E1 | — | — | S1 | — | — | PARTIAL |
| AC-ID-029 | Date after episode marker | R1 | — | — | — | — | — | PARTIAL |
| AC-ID-030 | Filename evidence independent of label | R1, R3 | I6 | A3, A4 | S1 | — | — | PARTIAL |
| AC-ID-031 | Original basename independent of echo | R1, R3, R4 | — | — | S1 | — | — | PARTIAL |
| AC-ID-032 | Validated effective resource | R5, R6, R7 | — | — | — | — | — | PARTIAL |
| AC-ID-033 | Generic master playlist | Q8, R5 | — | A2 | — | — | — | COVERED |
| AC-ID-034 | Malformed URL product rejection | R2, W2 | — | — | — | — | — | PARTIAL |
| AC-ID-035 | Conflicting markers | R2 | — | — | — | — | — | PARTIAL |
| AC-ID-036 | Query/fragment/token isolation | R2, R7 | — | — | — | — | — | PARTIAL |
| AC-ID-037 | Unsafe redirect without invented identity | R7 | — | A5 | — | — | — | COVERED |
| AC-ID-038 | Failed response without effective identity | R7 | — | — | — | — | — | PARTIAL |
| AC-ID-039 | Ambiguous/multiple/range year is fail-open | M1, R2 | — | — | — | — | — | PARTIAL |
| AC-ID-040 | Untrusted transliteration: unknown/recall | Q2, SR2 | — | A3 | S1 | — | — | PARTIAL |
| AC-ID-041 | Untrusted alternate title: unknown/recall | Q2, SR2 | I5 | A4 | — | — | — | PARTIAL |
| AC-ID-042 | Metadata-poor provider | Q2 | I5 | A3, A10 | S1 | — | — | COVERED |
| AC-ID-043 | Playable HLS recall | Q3, T2 | — | A2 | — | — | — | COVERED |
| AC-ID-044 | Playable MP4 recall | Q3, T1 | I2 | A1, A10 | — | — | — | COVERED |
| AC-ID-045 | Safe HTTP and HTTPS parity | SR4, W2 | I6 | A1, A2 (HTTP) | — | — | — | PARTIAL |
| AC-ID-046 | No-duration recall | Q3, Q9 | I5 | A3, A10 | — | — | — | COVERED |
| AC-ID-047 | Order invariance | Q7 | — | A3, A4, A9 | — | Q7, A3, A4, A9 | — | PARTIAL |
| AC-ID-048 | Duplicate invariance | Q7 | — | A7 | — | Q7, A7 | — | PARTIAL |
| AC-ID-049 | Noise monotonicity | Q7 | — | A8 | — | Q7 | — | PARTIAL |
| AC-ID-050 | Provider expansion preserves contradictions | R4, E2 | — | A9 (opportunity only) | — | — | — | PARTIAL |
| AC-ID-051 | Generic/echo labels cannot corroborate | Q8, E1 | — | — | — | — | — | COVERED |
| AC-ID-052 | Equivalent pre/post strong evidence | R1, R5 | — | — | — | — | — | PARTIAL |
| AC-ID-053 | Contradiction bounded backfill | Q6, R6 | — | A8 (HTTP failure only) | — | — | — | PARTIAL |
| AC-ID-054 | Locator privacy | R7, E2, P1 | — | A10 (opaque playback) | S1 | — | — | PARTIAL |
| AC-ID-055 | Trusted movie runtime propagation | M1, Q3 | I2 | A1, A2 | — | — | — | COVERED |
| AC-ID-056 | Exact trusted episode runtime propagation | — | — | — | — | — | — | UNCOVERED |
| AC-ID-057 | No inferred series duration | M2 | I3 (request only) | — | — | — | — | PARTIAL |
| AC-ID-058 | Independent contradiction cannot be masked | Q5, R3, SR3 | I1 | A3, A4 | S1 | A4 | — | PARTIAL |
| AC-ID-059 | Exact requested video ID | W1, W2 | I3, I6 | — | S2 | — | — | COVERED |
| AC-ID-060 | State/disposition/transport separation | Q8, Q9, E1 | I1 | A3 | S1 | — | — | PARTIAL |
| AC-ID-061 | Independent evidence provenance | Q8, E1, E2 | — | A6 (probe forgery only) | — | — | — | PARTIAL |
| AC-ID-062 | Movie positive matrix | Q8, E1, Q1 | — | — | — | — | — | PARTIAL |
| AC-ID-063 | Episode positive matrix | Q1, R1, E1 | I3 (request only) | — | S1 (numeric only) | — | — | PARTIAL |
| AC-ID-064 | No lexical/title-only corroboration | Q8, E1 | — | — | — | — | — | PARTIAL |
| AC-ID-065 | Clear title boundary/token-soup unknown | R2, E1 (related parser only) | — | — | — | — | — | PARTIAL |
| AC-ID-066 | Precise suspicious title/admit distinction | Q2, Q8, E1 | I5 (survival only) | — | — | — | — | PARTIAL |
| AC-ID-067 | Alias/lookup neutrality | Q2, SR2 | I5 | A3, A4 (recall only) | — | — | — | PARTIAL |
| AC-ID-068 | Structural aliases/taxonomy isolation | SR1, W2; K1–K3 | — | — | — | — | — | PARTIAL |
| AC-ID-069 | Compact transport marker/public protocol | — | — | — | — | — | — | UNCOVERED |
| AC-ID-070 | Public identity confidence/contradiction absence | Q8 | I1 (absence only) | A3 (absence only) | S1 (absence only) | — | — | PARTIAL |
| AC-ID-071 | Compact numeric formatting/wrapping | UI1 (legacy formatter) | — | — | — | — | — | PARTIAL |
| AC-ID-072 | Summary/internal/ranking separation | UI1, UI2, P1 | — | — | — | — | — | PARTIAL |
| AC-ID-073 | Complete candidate/stage/reason trace | E2, P1 | — | — | S1 (aggregate only) | — | — | PARTIAL |
| AC-ID-074 | Disappearance decision domains | P1 | — | A7–A9 (outcomes only) | — | — | — | PARTIAL |
| AC-ID-075 | Trace/reject-playback privacy | R7, E2, P1 | — | A10 (survivor handles only) | S1 (public privacy only) | — | — | PARTIAL |
| AC-ID-076 | Human Stremio visual/survivor/reject smoke | — | — | — | — | — | — | UNCOVERED |
| AC-ID-077 | Two-dimensional falsifiable adjudication | — | — | — | — | — | — | UNCOVERED |
| AC-ID-078 | Generic AC revision and original-smoke rerun | — | — | — | — | — | — | UNCOVERED |

### Phase 2.5 refinement coverage notes

| Refined ACs | Existing evidence and remaining gap |
| --- | --- |
| 001, 003, 060–064 | Q1/Q8/E1 prove related ID/title/numeric observations and admission. Current audit can return MATCH for title text alone and can downgrade an ID match on textual disagreement. It does not implement the independent-ID or immediately delimited title/year and series/S-E positive matrix. AC-ID-003 changes COVERED → PARTIAL; positive evidence scope was tightened. |
| 006–009, 015, 023–025, 055–057 | Runtime remains negative-only. Local movie threshold is max(10 min, 30%); exact episode threshold max(3 min, 20%), strict greater-than. Q3/Q4 prove supplied-item thresholds, I2/A1/A2 prove movie public wiring. AC-ID-056 stays UNCOVERED: series lookup supplies no exact S/E runtime. No runtime coverage is upgraded. |
| 012, 013, 021, 026, 040, 041, 065–067 | The title-only disposition decision is closed: qualified high-confidence different-work text is SUSPICIOUS/ADMIT; untrusted alternate/localized text or token soup is UNKNOWN/ADMIT. Q2/SR2/I5/A3/A4 prove related survival, not reliable alias truth or the refined classification boundary. The current resourceTitle parser can classify unknown extra tokens as different text; clean delimiter/token-soup neighbours are not proven. AC-ID-013/026/041 change DECISION_REQUIRED → PARTIAL, not COVERED. |
| 028, 039 | Both policies are now explicitly human-approved and change DECISION_REQUIRED → PARTIAL with no added tests/evidence. AC-ID-028: R1/R3/R5/E1 and S1 characterize year-only episode survival, but complete before/after-marker, release/dub/remaster/edition/pack/air-date variants and manual/public acceptance proof remain missing. AC-ID-039: M1/R2 exercise related metadata ambiguity and no-evidence parsing, but do not prove every multiple/range-year variant through qualified provenance and public resolution. One explicit unambiguous qualified movie year may contradict; ambiguous year alone may not. Neither criterion is upgraded to COVERED. |
| 042, 051, 054, 058 | Generic/echo neutrality, supported contradiction precedence and existing sanitized aggregate/public output remain bounded evidence. New detailed trace/privacy and public CORROBORATED propagation are separately partial; no aggregate count proves them. |
| 068 | Option A/R-006 is approved on the prior read-only local audit. SR1 explicitly exercises nested type:movie rejection and compatible kind:series. K1–K3 separate policy/routing/transport; W2 exercises adapter mapping. Complete real-adapter/custom-module nested-evidence and taxonomy-neighbour contract matrices do not exist, so coverage remains PARTIAL despite the resolved decision. |
| 069–072 | Current addon output uses Direct plus the old summary, lacks ID markers and does not propagate refined confidence. UI1 proves a legacy formatter, not compact MB/GB/seconds markers or public wrapping. UI2/P1 constrain current scoring/observer neutrality, not a complete confidence/presentation separation matrix. AC-ID-069 is UNCOVERED; related 070–072 are PARTIAL. |
| 073–075 | Current observational stages are provider/normalized/deduplicated/probed/admitted/final, not a complete per-candidate stable decision trace. E2/P1/S1 prove some aggregates/privacy; A7–A9 prove bounded pipeline outcomes. Opaque trace IDs, first decisive reasons, NOT_REACHED, all disappearance domains and reject-playback handles are not proven. PARTIAL, never inferred from survivor playback. |
| 076–078 | No existing human visual/reject-review adjudication or original-smoke revision evidence is claimed. UNCOVERED; the documented workflow is a requirement, not execution evidence. |

### Additional exact evidence references

| Code | Exact file / case | Scope |
| --- | --- | --- |
| K1 | `tests/content-type-policy.test.ts` — `uses structural movie and series classes without heuristics`; `uses explicit anime classification or Stremio type before structural kind` | Focused policy selection; no candidate structural-kind proof. |
| K2 | `tests/stremio-addon-stream-provider.test.ts` — `applies anime policy to explicit classifications and Stremio type before structural kind` | Real provider policy boundary with substituted HTTP; not nested kind evidence. |
| K3 | `python-adapter-host/tests/test_callable_stream_resolver.py` — assertions of discovery `content_type` at lines 70 and 94 | Python callable request movie/tv routing, not candidate identity. |
| UI1 | `tests/scoring.test.ts` — `keeps incomplete metadata valid and formats a compact, degrading summary` | Existing legacy summary only; not the refined public presentation. |
| UI2 | Same file — `keeps codec differences small and extracts a known codec from a release title` | Existing internal scoring facts only; does not prove codec omission in the public summary. |

No current test needs alteration merely to keep Option A. The nested type fixture is `tests/stream-resolver.test.ts:203`; nested kind fixtures are in that file at lines 176/182/201/205, `tests/identity-runtime.test.ts:123`, `tests/resource-identity.test.ts:90`, and `tests/identity-precision-qa.test.ts:34–37,258`. These are exact evidence anchors, not new tests. The full new matrix and expected current confidence/presentation/trace failures belong to Phase 3.

## Historical contract review findings and remaining evidence gaps

These Phase 0–2 findings are retained for traceability; tests remain unchanged. Phase 2.5 closes title-only disposition and alternate-title scope, but survival alone still does not prove refined confidence or alias truth. Year-policy decisions are now approved; their implementation/evidence gaps remain PARTIAL. Review current assertions against the canonical refined contract before future implementation.

| Exact test | Current assertion | Behavior protected / why potentially broader than intended | AC needing review |
| --- | --- | --- | --- |
| `tests/identity-precision-qa.test.ts` — `keeps sparse, localized and ambiguous presentation fail-open: %s`, row `Synthetic Northern Signal` | Real resolver returns one candidate and zero identity rejections even though both presentation and `metadata.identity.title` explicitly name a different title. | Treats unrelated declared identity like generic/localized recall without proving an alias or intended match. | AC-ID-013, AC-ID-041 |
| `tests/identity-runtime.test.ts` — `allows moderate differences and missing requested runtime` | `identityMismatch` is false for `Other Name (2013) 1080p`. | Compatible year/runtime protects any other explicit title, not just a translated title; direct helper does not prove public metadata provenance. | AC-ID-013, AC-ID-012 |
| Same file — `keeps generic and unrelated title-only candidates fail-open` | Generic label and `Unrelated Movie` both yield no mismatch. | Conflates insufficient labeling with an affirmative unrelated title claim; helper-only result must not become a universal product recall guarantee. | AC-ID-013 |
| `tests/stream-resolver.test.ts` — `rejects a different structured movie prefix while keeping matching and generic stream labels` | Every label after the first three survives, including `Other Title (2011) 1080p`. | Test name suggests identity/title qualification, but assertion mainly rejects incompatible year; arbitrary same-year title is protected as a positive. | AC-ID-013, AC-ID-041 |
| Same file — `keeps different titles and years eligible without a requested year, but rejects a different IMDb ID` | Unrelated explicit title/year is retained when requested year is absent; explicit different IMDb ID is rejected. | Good independent-ID negative control, but unrelated affirmative title is still a recall positive without proving the refined confidence state. | AC-ID-013 |
| Same file — `rejects explicit episode and media-kind contradictions while leaving missing evidence eligible` | Unrelated sparse label survives with compatible series candidate. | Strong kind/S/E negatives are sound, but arbitrary series text has no alias/content proof. | AC-ID-026 |
| `tests/integration/stremio-movie-metadata.test.ts` — `reproduces the six-candidate unenriched control with the same raw stream shape`; `keeps streams available when trusted meta supplies a title without a year`; `keeps streams available when metadata lookup times out` | All six raw fixture labels remain available under absent enrichment/year, including a different explicit movie title/year. | Public wiring proof is real, but availability assertions do not prove the refined SUSPICIOUS/UNKNOWN distinction. | AC-ID-013, AC-ID-041 |
| `tests/acceptance/dirty-upstream.test.ts` — `keeps eligible presentation mutations while composing strong contradictions with quality metadata` | `Localized (1994)` survives alongside matching year and actual playable bytes. | Proves text tolerance and contradiction precedence, not that the arbitrary replacement is a valid localized/alternate title. | AC-ID-012, AC-ID-040, AC-ID-041 |
| `tests/identity-precision-qa.test.ts` — `intentionally admits %s -> %s minutes for a movie and rejects it for an exact episode`; describe `independently measured %s runtime without filename identity` | Direct helper fabricated probe metadata, or supplied requested `runtimeSeconds`, produce the expected episode decisions. | Threshold contract is sound; treating it as deployed exact-runtime protection would ignore the missing metadata acquisition/propagation route. | AC-ID-023, AC-ID-024, AC-ID-056 |
| `tests/integration/stremio-movie-metadata.test.ts` — `enriches the external IMDb episode with seriesTitle while preserving exact video identity` | Outgoing adapter request has no `runtimeSeconds`; one stream survives without an exact runtime measurement. | `ExternalHttpStreamProvider` never serializes runtime, so that assertion cannot detect an accidentally inferred internal episode duration. M2 proves lookup output and source inspection shows no series-duration assignment, but the public runtime decision is not tested here. | AC-ID-025, AC-ID-057 |
| `tests/resource-identity.test.ts` — `decodes only the final component, ignores token/query/fragment and refuses malformed or non-media names` | `identityMismatch` returns false when no usable resource identity can be parsed. | “No contradiction” from a helper is not “ADMIT” through the public product: normalization, URL policy and media eligibility can reject first. | AC-ID-034, AC-ID-036 |
| `tests/identity-precision-qa.test.ts` — `keeps the survivor set invariant under reversal and a deterministic shuffle`; `preserves every existing decision after duplicate noise and additional strong contradictions` | Fixed small probe-disabled sets retain the same survivors. | Names can suggest universal set invariance; raw caps, probe budgets, tie winners and conflicting duplicate evidence are outside these experiments. | AC-ID-047, AC-ID-048, AC-ID-049 |

### Evidence masking: protected facts and remaining gap

Inspection did **not** find an assertion requiring a matching presentation year to hide a supported movie year/kind/S/E/ID contradiction. `SR3`, `R3`, `A4` and `S1` explicitly protect the opposite behavior. Year-only episode mismatch is non-decisive under approved AC-ID-028, not a masking bug. However, `E1` audit title selection prefers filename over original basename, and source deduplication chooses a candidate rather than proving comprehensive merged identity evidence: no existing expansion property proves every conflicting duplicate/adapter combination. Keep AC-ID-050/052 partial; do not invent or fix a production defect from this audit.

## Most important false-confidence gaps

1. **Conditional episode runtime is not public protection today.** Numeric rules and real synthetic measurement pass through components, but no supported trusted exact-episode metadata route is proven. Series runtime must remain unused.
2. **A playable source, historical MATCH or refined CORROBORATED is not correct content.** Generic/opaque media, unrelated same-year titles, similar-duration content and unmeasurable media can survive; declared text is not an authoritative alias relation.
3. **Effective resource decisions lack public acceptance proof.** R5–R7 exercise real protected layers with the socket boundary replaced. Existing acceptance safe redirects prove safety/playability, not the post-redirect basename contradiction matrix.
4. **System matrix has probing disabled.** Its public kind/year/S/E and privacy assertions must not be used as system runtime/effective-resource coverage.
5. **Bounded properties are narrow.** No current property covers unrestricted provider expansion, raw cap starvation, conflicting duplicate metadata, all tie winners or changing network evidence.
6. **Manual recall evidence is absent.** Fixture localization/transliteration examples intentionally cannot establish actual alias relationships or Stremio UI behavior. No live provider audit was run for this campaign.
7. **Malformed/ambiguous parsing is not admission.** Helper no-evidence results and media/transport fail-closed results belong to different layers; rejected unsafe/failed responses must not inflate identity-contradiction counts.

## Historical Phase 0–2 characterization execution

At the initial Phase 0–2 checkpoint, documents were created before the recorded test execution and existing tests were run without edits. Results below are historical; they were not rerun for Phase 2.5 documentation consolidation. No implementation cycle, new corpus or Phase 3 is represented by these results.

| Command | Result |
| --- | --- |
| Existing focused identity and boundary files (`npx vitest run`, exact selection below) | PASS — 34 files, 611 tests; Vitest duration 3.76 s |
| `npm run test:integration` | PASS — 5 files, 39 tests; Vitest duration 1.53 s |
| `npm run test:acceptance` | PASS — 1 file, 43 tests; Vitest duration 5.53 s |
| `npm run test:system` | PASS — 1 file, 13 tests; Vitest duration 7.92 s |

The focused selection was the following existing files (all paths under `tests/`, all with `.test.ts` extension): `identity-precision-qa`, `identity-runtime`, `resource-identity`, `identity-precision-evaluation`, `movie-metadata`, `stremio-episode-identity`, `addon-request-identity`, `stream-resolver`, `direct-stream-probe`, `mp4-runtime`, `hls-playlist`, `external-http-stream-provider`, `stremio-addon-stream-provider`, `stream-result-hygiene`, `source-request-headers`, `content-type-policy`, `stream-ranking-policy`, `scoring`, `source`, `video-selection`, `playback-manager`, `json-provider`, `stremio-addon-config`, `provider-quality-evaluation`, `kodi-source-quality-evaluation`, `story-f1-evaluation`, `story-f2-evaluation`, `standard-evaluation-corpus`, `outbound-transport`, `url-policy`, `security-boundaries`, `privacy-boundaries`, `privacy-runtime-audit`, `security/adversarial-boundaries`.

No baseline failures occurred in these commands. The system suite invoked its existing controlled Python process fixture; no Python files or Python implementation were edited and no separate Python investigation/suite was run.

Initial Phase 0–2 audit counts: **59 criteria — 27 COVERED, 26 PARTIAL, 1 UNCOVERED, 5 DECISION_REQUIRED**. These historical numbers do not describe the refined Phase 2.5 set. Green characterization does not fill missing evidence levels.

The initial characterization did not edit production or tests. Those historical
results do not certify implementation of the refined contract.

## Phase 2.5 consolidation checkpoint

Refined coverage after explicit year-policy approval: **78 criteria — 26 COVERED, 47 PARTIAL, 5 UNCOVERED, 0 DECISION_REQUIRED**. Those are historical Phase 2.5 counts; the 2026-10-11 reconciliation below attributes the revised map separately. Changes from the original checkpoint are one tightened positive criterion (003: COVERED → PARTIAL), three closed title decisions (013/026/041: DECISION_REQUIRED → PARTIAL), two explicitly human-approved year decisions (028/039: DECISION_REQUIRED → PARTIAL), and nineteen added criteria (060–078: fifteen PARTIAL, four UNCOVERED). No count increase represents a new test run or new implementation proof.

R-006/provenance is resolved by approved Option A. AC-ID-028 and AC-ID-039 are settled fail-open policies; there are zero current DECISION_REQUIRED product-policy rows. Policy refinement was complete at that checkpoint; this is not a claim that later implementation or evidence gaps are closed. Public exact-episode runtime, refined positive/confidence propagation, compact presentation, complete rejection traces, local reject-playback and human review remain evidence/implementation gaps, not silently reopened product decisions.

The Phase 2.5 documentation checks verified AC uniqueness, references and counts.
No test/build/coverage execution was attributed to that documentation checkpoint.

## Approved-decision reconciliation - 2026-10-11

D-078 to D-100, recorded in the canonical acceptance contract, qualify the existing 78 ACs in canonical acceptance. No AC ID was added/removed, no production behavior changed and no coverage was upgraded by approval alone. Historical checkpoints/counts above remain dated evidence, not the reconciled current total.

Reconciled map at 2026-10-11: **78 criteria - 20 COVERED, 53 PARTIAL, 5 UNCOVERED, 0 DECISION_REQUIRED**. Six COVERED -> PARTIAL downgrades are justified by changed required semantics, not test failure/count inflation:

| ACs | Exact existing evidence retained | Newly approved gap |
| --- | --- | --- |
| 004, 030, 031 | Q1/R1/SR3/I1/I6/A3/A4/S1 (004); R1/R3/I6/A3/A4/S1 (030); R1/R3/R4/S1 (031) | D-084 refers to approved ID-EXT-05: matching independent ID + conflicting qualified resource year must be SUSPICIOUS/ADMIT. Wrong-year rejection tests do not prove this counter-anchor composition. |
| 015 | Q5/I4/A3/S1 | D-091 Case 30: compatible independently measured duration overrides contradictory textual duration. Standalone text-rule and separate measurement tests do not prove the combined real pipeline. |
| 058 | Q5/R3/SR3/I1/A3/A4/S1 | D-082/093 require comparable ID scope, same-resource origin disputes and strong-versus-strong SUSPICIOUS composition. Existing negative-wins controls do not prove those exceptions. |
| 054 | R7/E2/P1/A10/S1 | D-100 includes hostile presentation/error canaries and minimization across logs/traces/artifacts, not only opaque URL tokenization and existing aggregate sanitation. R-020 blocks final privacy implementation design/freeze. |

Already-PARTIAL rows remain partial: 001/002/050/061 (origin provenance/ID disputes), 028/063 (incompatible episode production year blocks positive confidence, never year-only reject), 032/036/062 (validated effective positives, D-090 non-empty-query SUSPICIOUS cap), 053 (D-097 vertical sibling/quota/backfill semantics), 069-075 (D-098 real state-to-public propagation and D-100 complete trace/reject privacy). No approval is new execution evidence. D-092 retains the strict movie 30% threshold and resolves R-016; its historical live calibration is reported in the local log, not rerun or converted into new coverage here. D-095 supersedes provisional D-094: sparse recall stays UNKNOWN/ADMIT; v1.4 selection and R-018 yield research do not alter v1.3 admission/ranking. R-019 remains separate route-competition design; R-020 remains open despite semantically closed FAM-14.

The historical campaign distinguished a controlled HLS smoke from an inconclusive opt-in provider observation. Neither proves audiovisual identity, public exact-episode duration or HLS prevalence; neither upgrades an AC. Documentation validation checks 78 unique stable IDs, map totals and the final doc-only diff; no production/test suite rerun is implied.

## Identity refinement foundation checkpoint - 2026-10-12

PR 3 adds real, bridge-owned UNKNOWN after conservative admission checks and CONTRADICTION at the existing measured-runtime rejection decision. The harness observes production state/event by in-process reference, without a legacy confidence oracle. Cases 30/recall/negative and 49 now expose the required internal states; 03 remains unclassified because request-echo provenance cannot be established from its structured candidate ID. Candidate/resource positive anchors and equivalent-resource pending claims are conservatively unclassified; CORROBORATED/SUSPICIOUS and public markers remain pending. The historical criterion map stays partial where full provenance/composition/propagation is required; this does not upgrade whole ACs or claim complete confidence coverage. The [campaign evidence index](IDENTITY_QA_CAMPAIGN.md#evidence-index-and-minimal-history) maps the retained foundation regressions; the 18 manually closed identityState dimensions and validation belong to this historical checkpoint. QA inventory remains 53/84/10/94, with 119 unresolved dimensions.

## QA rejected-source review integration checkpoint

Case 53 now proves real local inspection of a selected post-probe measured MP4 reject: exact GET bytes, HEAD, Range, isolated opaque tokens and listener cleanup while normal Stremio retains only its healthy sibling. Production reason/state and verified probe evidence select the candidate; the harness does not infer eligibility from disappearance. The single rejectReviewAvailable dimension is closed, leaving **118** unresolved dimensions with the same **53/84/10/94** inventory. AC-ID-075 gains bounded integration evidence through protected playback/transport, not complete live/UI/privacy coverage; AC-ID-076/077 still require actual human review. The manual procedure and independent verdict fields are implemented, with no inferred fixture content truth. Refer to [Local rejected-source review](IDENTITY_LIVE_SMOKE.md#local-rejected-source-review) and the [campaign evidence index](IDENTITY_QA_CAMPAIGN.md#evidence-index-and-minimal-history) for the retained regressions and remaining R-020 limitations. Validation counts here belong to this historical checkpoint.


## Identity Refinement PR8 - Bounded pre-probe observations

Optional production events now identify normalized-stage kind/S-E rejections by call-local opaque occurrence reference, decision, exact closed reason and CONTRADICTION; later stages are explicitly NOT_REACHED in the QA report. Clean opaque candidates meeting the existing conservative predicate expose pre-probe UNKNOWN separately from later effective-resource or measured state. The real resolver/protected synthetic transport/createAddon harness proves duplicates, healthy siblings, request-echo/static-ID non-promotion, non-identity failure isolation, unchanged instrumentation off/on survival/order/attempts/scores/public tokens and event privacy. Existing measured MP4 reject-review eligibility remains unchanged.

Ten supported dimensions close (24/25 preProbeIdentityState; 48 identityState/preProbeDecision/rejectionReason; 08-negative/15/16-negative/21-negative/22 identityState), leaving **62**, with canonical **53/84/10/94** inventory unchanged. AC-ID-060/073/074/075 gain bounded integration evidence; complete staged disappearance classification, live/UI evidence, broader R-020 privacy and candidate-ID independence remain partial/blocked. Year/ID/weak-text rejection confidence/reasons are not newly classified. The [campaign evidence index](IDENTITY_QA_CAMPAIGN.md#evidence-index-and-minimal-history) maps scheduling and pre-probe regressions; accounting and validation here belong to the historical PR8 checkpoint. No whole AC is promoted to complete.

## Structured movie-title concern checkpoint — 2026-10-16

At the 2026-10-16 title-concern checkpoint, the official runner recorded 94 BASELINE passes and 54 discrepancies across 24 STRICT failures. One bounded D-081 title family closes two dimensions: Case 11 now emits real final SUSPICIOUS and public ID! while remaining admitted. Inventory at that checkpoint was **53 main cases / 84 scenarios / 10 guardrails / 94 tests; 52 pending dimensions across 23 STRICT failures**. The 78-criterion map and whole-AC statuses remain unchanged.

`tests/identity-qa/intake.test.ts` Case 11 supplies the title/year via real static External HTTP intake. `tests/identity-admitted-unknown.test.ts` adds protected integration evidence for AC-ID-013/060/066/070: explicit structured different movie title + compatible year, dedupe in both producer orders, cache reclassification, existing public rendering and instrumentation neutrality. Boundary controls preserve free/alternate presentation UNKNOWN, unclassified missing-year/ID claims, applicable hard rejection and healthy sibling recall. No inferred alias relation, independent-ID proof, measured-runtime positive promotion or audiovisual truth is claimed.

The correction is final-admission confidence only. Pre-probe SUSPICIOUS instrumentation, broader title/resource/ID composition, episode title concerns, complete trace, SYSTEM title-confidence proof and manual/UI evidence remain incomplete. Existing real effective-resource/runtime and safety implementations are reused. The [campaign evidence index](IDENTITY_QA_CAMPAIGN.md#evidence-index-and-minimal-history) maps the retained title-concern regressions. Diagnosis, RED/GREEN and gates here belong to the historical 2026-10-16 checkpoint; no acceptance expectation changes or coverage promotion.
