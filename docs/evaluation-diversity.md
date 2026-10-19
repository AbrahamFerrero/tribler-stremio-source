# Evaluation corpus and diversity (Story F1)

Both evaluators accept their existing flat `--input <path>` and a versioned `--corpus <path>`. A corpus is a bounded local JSON file with 1 to 100 cases:

```json
{
  "version": 1,
  "id": "fixture-v1",
  "cases": [
    {
      "id": "movie-01",
      "mediaClass": "movie",
      "cohort": "mainstream",
      "item": { "type": "movie", "videoId": "tt1234567" }
    }
  ]
}
```

`mediaClass` is `movie`, `series`, or `anime`; `cohort` is `mainstream` or `long-tail`. IDs must be safe and unique. The same validated D1 item parser handles both modes. F1 supplies only test fixtures; it does not select a standard media corpus. The report records corpus ID, version, and SHA-256 fingerprint of validated cases, with no case payloads or media IDs. Flat input gets a `manual` corpus and only an `all` segment.

A corpus case contributes to `all`, its media class, its cohort, and the combined `mediaClass/cohort` segment. Thus movie, series, and anime each have mainstream and long-tail views when those cases are present. Segment counts sum per item; repeated identities on different items are counted again.

In JSON report schema version 3, `segments[].sources` describes Node-normalized ownership. `distinct` counts unique resolver dedupe identities supplied by a source; `shared` has at least two original owners, and `exclusive` has one. `overlapShare` and `exclusiveShare` divide by `distinct`, with zero for an empty denominator. `admittedOwned` and `finalOwned` credit every original owner when an identity reaches those stages. `admittedExclusive` and `finalExclusive` credit single-owner identities. `finalWinner` credits the provider ID on the final resolver result. This preserves original ownership even when deterministic cross-provider deduplication picks another source.

`verifiedDirectOwned`, `uncertainDirectOwned`, `budgetExhaustedDirectOwned`, and `deterministicRejects` credit the probed winner's evidence to its original owners. Torrent seed categories count distinct normalized torrent identities per owner with positive, missing, or known-zero seed evidence. For duplicate candidates from the same owner and identity, any positive seed value takes precedence, then known zero, then unknown; each distinct identity contributes one bucket. This aggregates availability evidence only and does not change D2b Python structural seed counts or production ranking. Missing seed data stays unknown. Direct overlap uses exact normalized URLs, including query strings; torrent overlap uses the resolver's exact hash/file or torrent-URL identity. There is no fuzzy equivalence or swarm probe. These exclusive counts are observed marginal coverage, not a causal estimate of what removing a provider would do.

`segments[].pairs` contains intersection, union, Jaccard, directional coverage, admitted intersection, and final-owned intersection. Stremio reports all pairs among its at most 32 configured addons. Kodi reports only actual positive overlaps, at most five highest-intersection overlaps per source, ordered by intersection descending then IDs; `pairSummary` states total overlapping pairs, emitted pairs, and truncation. D2b's existing Python `distinct`, `shared`, and `exclusive` remain separate adapter-level structural metrics. Its Node synthetic-provider segments are not normal production `external_http` scheduling.

Cost is reported as components, with no composite score. Latency uses nearest-rank p50 and p95, plus count, total, mean, and max milliseconds. D1 request counts are provider stream-resource request events, emitted before the stream fetch; they count attempts even if route validation later prevents a response. Separate manifest fetches are excluded. D2b elapsed time includes disposable-worker evaluation; it is not normal `external_http` wall-clock scheduling. Diversity and cost sections contain aggregates only: no media IDs, candidate metadata, dedupe keys, URLs, query strings, cookies, tokens, magnets, hashes, settings, or worker paths. Optional identity diagnostics are described below.

For a manual baseline workflow, keep a local version 3 JSON report, make a deliberate configuration change, run the same corpus again, then compare:

```powershell
npm run evaluate:stremio-providers -- --corpus .\fixture-corpus.json --json > .\baseline.json
# Make a manual local configuration change, then run the same corpus again.
npm run evaluate:stremio-providers -- --corpus .\fixture-corpus.json --json > .\candidate.json
npm run compare:evaluations -- --baseline .\baseline.json --candidate .\candidate.json
```

The offline comparator prints concise factual deltas by default; add `--json` for machine-readable comparison. It requires matching report version, evaluator kind, corpus ID, corpus version, and corpus fingerprint. Legacy v2 reports remain readable with their original field meanings, but v2 and v3 cannot be compared. It reports factual overall and per-segment numeric deltas, aligned pair deltas, and added or removed sources; it makes no provider decision and does not invoke either evaluator, Python, or the network. Keep report files local.

## Observation-only Identity Precision Audit

This is the historical observer baseline, not the refined Phase 3/4 identity
confidence model. `MATCH` is not semantically equivalent to `CORROBORATED`:
exact resource-title text can earn `MATCH` without the refined movie-year or
episode-coordinate positive matrix. Localized resource titles can be
`SUSPICIOUS` here while the refined contract leaves uncertain alternatives
`UNKNOWN`. These categories remain observational and do not change ranking.

Evaluation CLIs additionally enable `identityPrecision.diagnostics` (schema version 1).
Existing aggregate `providers[].stages` counters and assessment rules are unchanged;
other audit callers retain the aggregate-only default. No new network request or
metadata enrichment is performed.

Each retained observation contains a one-based `evaluationIndex` (the position in
the input corpus), a zero-based stage-local `candidateIndex`, safe `providerId`,
`stage`, `assessment`, `reasons`, and a bounded evidence object. Candidate indices
are not stable identities across stages. There are at most 1,000 observations per
stage (6,000 total); `droppedByStage` reports omitted observations while aggregate
counters continue counting every assessed candidate. The final stage has its own
quota and cannot be displaced by provider-stage observations.

Reasons follow the existing assessment branches, in their original precedence:
`SHARED_IDENTITY_CONTRADICTION`, `MEASURED_RUNTIME_CONTRADICTION`,
`RESOURCE_TITLE_MATCH`, `RESOURCE_TITLE_DISAGREEMENT`,
`STRUCTURED_EXTERNAL_ID_MATCH`, and `NO_INDEPENDENT_CORROBORATION`.
The shared contradiction reason deliberately does not reimplement the production
predicate to guess a more specific cause. Resource-title disagreement remains
observational and does not reject candidates.

Optional evidence includes requested title/kind/year/coordinates/runtime, candidate
presentation and filename or resource basename, numeric structured identity, and
the existing probe status/runtime/numeric resource observations. For resource-title
comparisons it also includes the already computed normalized title keys, only when
their original display text passes sanitization. Display strings
are limited to 160 characters and omitted entirely when they contain disallowed
characters, locator/credential markers, domain-like text, or long opaque identifiers.
Evidence never copies external IDs, URLs, query strings, headers, hashes, magnets,
settings, paths, or arbitrary provider metadata. Raw provider-stage probe evidence
is still removed by existing normalization before assessment. Missing display text
does not affect the reason or assessment. Old reports without diagnostics remain
valid; the existing offline comparator still compares aggregate metrics only.

Both evaluator JSON reports include an additive `identityPrecision` field with aggregate `MATCH`, `UNKNOWN`, `SUSPICIOUS`, and `CONTRADICTION` counts by safe provider ID and resolver stage. The existing comparator does not compare these new counters. Provider-stage counts cover structurally normalized candidates, including identity rejections; subsequent stages follow the existing resolver funnel and deduplication winner attribution.

`CONTRADICTION` uses the same shared structured identity, resource identity and independently measured runtime rules as production. `MATCH` means exact normalized resource-title corroboration or a matching explicit external ID, not verified content. `SUSPICIOUS` means an independently available filename/resource title differs from the requested title; localized titles may also land here. Presentation text alone, even an exact echo of the request, gives `UNKNOWN`. Generic or missing resource evidence also gives `UNKNOWN`. Textual assessment never filters, ranks, or changes transport verification.

Resource identity includes bounded season/episode markers (`S01E01`, `S01.E01`, `Ep1`, `Episode-1` and their supported separators), and unambiguous release years. Original URL basenames are checked independently of echoed provider filenames. Parsing and year enrichment remain frozen at their current bounded behavior. Episode resource-year hard rejection is deferred while runtime is prioritized: neither presentation filename year nor independently observed resource year rejects an otherwise compatible episode. Existing bounded numeric observations remain internal to production; evaluation diagnostics may summarize them; a differing resource title may still be observationally `SUSPICIOUS`. An episode resource year is extracted only before an explicit marker; later dates and conflicting years remain no year evidence. Trusted series lookup currently accepts exact `YYYY` or a valid numeric year; series year ranges remain unsupported.

After successful media probing, only numeric resource identity observations from validated effective URLs and the bounded selected HLS playlist path are retained. Post-probe structural contradictions participate in the existing bounded backfill predicate and are counted in `identityRejections`. Audit stages show them as `CONTRADICTION` at `probed`, absent from `admitted` and `final`. Transport failures alone do not create identity evidence. Opaque `master.m3u8` resources remain `UNKNOWN`; their media admission still follows the existing transport checks.

Runtime qualification compares trusted request duration with an independent measurement. The request path is validated metadata -> `NormalizedMediaItem.runtimeSeconds` -> verified MP4 `mvhd` or complete HLS VOD duration -> shared `measuredRuntimeMismatch` -> resolver admission. Previously, series lookup returned only title/year, addon enrichment assigned runtime only for movies, and `measuredRuntimeMismatch` explicitly required `kind === "movie"`. Movie lookup also skipped runtime enrichment when an owning catalog already supplied title/year. It now fills missing movie runtime in that case; the measured comparison accepts a requested movie or exact episode with an independently supplied trusted runtime. Series-wide runtime is ineligible. Raw providers cannot supply trusted probe evidence.

Exact episode runtime is currently unavailable from the supported Cinemeta series path. On 2026-10-03, public schema inspections of three series responses found 192, 225 and 880 video entries, with no `runtime`, `duration`, `runtimeSeconds` or `durationSeconds` on any entry, including exact S01E01 entries. Series-level runtime was present; it is not an exact episode duration. The [Stremio metadata documentation](https://stremio.github.io/stremio-addon-sdk/api/responses/meta.html) describes runtime on meta objects and optional programme runtime on video objects, but that does not establish such evidence on the inspected series entries. Existing fixtures likewise supply coordinates/titles/air dates, not episode duration. These live responses also exceeded the existing 128 KiB lookup bound; that bound remains unchanged. No live payload was saved as a permanent fixture. Series runtime, air-date differences and a typical episode length are never propagated as requested episode runtime. Synthetic episode runtime tests supply trusted exact request metadata directly to the resolver; they do not imply that Cinemeta enrichment currently obtains it.

For independently measured movie runtime, reject only when the absolute gap is strictly greater than `max(10 minutes, 30% of the trusted expected duration)`. The ten-minute floor protects credits differences; 30% leaves room for moderate alternate cuts, playback-speed differences and approximate metadata. It retains the existing long-feature recall controls and allows 71 -> 90 minutes, yet rejects 107 -> 20 and 71 -> 22 minutes. For episodes, only trusted runtime belonging to the exact requested S/E qualifies, with the smaller tolerance `max(3 minutes, 20% of the expected duration)`. This allows 10 -> 9/12, 22 -> 21/25, 45 -> 44/50 and 60 -> 48/72 minutes, while rejecting 10 -> 14, 22 -> 12/50 and 45 -> 32/22 minutes. Movie and episode rules intentionally differ: a measured 14-minute candidate survives a 10-minute movie request but contradicts a 10-minute episode. Equality at either tolerance boundary survives. These are gross-content checks, not proof of identity: unusually different cuts can still cross the threshold. Unavailable/invalid expected or measured runtime, incomplete/live HLS, unsupported containers and unverified observations remain fail-open for runtime. Without trusted exact episode runtime, there is no runtime-based episode rejection. Weak standalone provider movie-duration labels retain their previous rule (gap >30 minutes AND >25%); they do not establish an episode runtime.

Measured contradictions now increment `identityRejections` and request bounded replacement probes through the same existing predicate as structural resource contradictions. Cache hits retain measurements but qualification uses the current request. The audit uses the identical measured rule at `probed`; no runtime-only contradiction reaches `admitted` or `final`. This allows rejection of opaque wrong-duration MP4/HLS without relying on filenames whenever trusted expected duration exists. Existing structured ID/coordinate and movie-year contradictions remain decisive. Existing resource kind/coordinate evidence remains a fallback; episode resource-year admission is deferred. A different series with matching S/E can still survive when exact requested or measured runtime is unavailable. Live/incomplete HLS and unsupported/uninspectable containers can likewise evade the runtime check; this does not bypass transport admission. Opaque resources without any remaining strong contradiction remain `UNKNOWN` and pass identity qualification.

Aggregate sections retain no requested IDs, titles, candidate texts or basenames. Optional identity diagnostics retain only the sanitized display text and numeric summaries described above. No section retains URLs, URL queries, tokens, headers, cookies, magnets or private paths. Supply requested title/year in evaluation inputs when available; these harnesses do not enrich corpus identities through a live metadata lookup. The existing CLI input parser does not carry requested runtime. Runtime assessment is available to shared-trace callers that supply it, and is exercised with deterministic MP4/HLS resolver fixtures.

## Version 3 content coverage

Identity counts above and `segments[].pairs` retain their v2 exact normalized stream-identity meaning. `coveragePairs` is separate: its intersection and union count items covered by both or either source, with Jaccard and directional containment. The corresponding `final*` fields use original owners of final identities. Stremio emits all pairs, including zero-intersection pairs. Kodi emits every positive co-coverage pair, with no zero filler and no coverage-pair quota; `coveragePairSummary` reports equal positive and emitted counts with `truncated: false`. The five-pairs-per-source Kodi bound still applies only to identity `pairs`. Coverage pair validation uses the actual roster's unordered-pair maximum (99 sources permit 4,851 pairs per segment). The local JSON evaluator fails explicitly if a report exceeds the 32 MB offline report limit; it never truncates positive pairs to fit.

Each source row has eight item counts. `coveredItems` counts items with at least one normalized identity owned by that source; `soleCoveredItems` counts items where it is the only owner of any identity. `eligibleItems` counts an item when the source owns at least one health-eligible identity; `soleEligibleItems` counts it when no other source owns an eligible identity, even if another source has only known-zero or rejected candidates. For torrents, the strongest same-owner seed evidence determines eligibility: positive or unknown is eligible, known zero is not. Direct identities are eligible only if that identity reaches the existing admitted stage. These are observations and do not change production seed filtering or Direct admission. `coveragePairs` separately includes eligible intersection, union, Jaccard, and directional containment computed from these eligible item sets. `admittedItems` and `finalOwnedItems` count items with at least one original identity at those resolver stages. `soleFinalOwnedItems` counts items where it is the only original owner represented among final identities. `finalWinnerItems` counts items with at least one final identity won by the source. Multiple streams for one item count once in each item field. The resolver's final list is a subset of admitted, so `finalOwnedItems <= admittedItems`.

`torrentPositiveSeedsExclusive`, `torrentZeroSeedsExclusive`, and `torrentUnknownSeedsExclusive` classify only exact-identity-exclusive torrent identities, using the strongest evidence from duplicate candidates of the same owner. They do not count Direct identities. The three buckets sum to that owner's exclusive torrent identity count.

Anime cases retain all old segments and additionally enter `anime/movie` or `anime/episode` by normalized item kind, plus the matching cohort/shape segment. Only applicable segments appear.

Stremio `rawReturned` counts objects in the diagnostic stream array with a parseable HTTP(S) URL or a recognized infohash before qualification and result caps; malformed values and notices without a stream locator do not count. `rawDirect` retains its old prefix-based raw HTTP(S) count. Kodi `returnedItems`, `directItems`, `positiveSeedTorrentItems`, `zeroSeedTorrentItems`, `unknownSeedTorrentItems`, and `noPositiveSeedTorrentItems` count items once from each source's adapter-normalized batch. The last field requires at least one torrent and no positive-seed torrent, so Direct-only items are excluded. These batches do not expose invalid or earlier-dropped worker results. Kodi source rows now include stable synthetic `id: kodi-N` alongside safe profile and source IDs.
