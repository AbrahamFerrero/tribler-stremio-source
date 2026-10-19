# Provider quality evaluation

This is the operational guide for the Stremio D1 and Kodi D2b developer tools.
They observe configured providers and make real upstream/probe requests; they
do not start playback, connect to Tribler, or change provider selection,
scheduling, ranking, timeouts or probe budgets. Availability and content identity
require separate evidence. Keep inputs and reports local and outside Git.

## Stremio provider evaluation (D1)

Run this developer-only command explicitly with a JSON file of media identities. Set `STREAM_PROVIDER_STREMIO_ADDONS_FILE` in `.env` to an existing addon config first:

```powershell
$env:TRIBLER_URL = "http://127.0.0.1:54528"
$env:DIRECT_HTTP_PROBE_ENABLED = "true"
npm run evaluate:stremio-providers -- --input .\\my-evaluation-items.json
npm run evaluate:stremio-providers -- --input .\\my-evaluation-items.json --json
```

The addon config path must exist. An explicit environment override takes precedence over `.env`; an override to a missing file reports `EVALUATION_FAILED: addon configuration unavailable`. The command uses the configured, enabled Stremio addons, the normal identity resolver, URL policy, DirectStreamProbe, and StreamResolver. It makes real addon and media probe requests. No Tribler connection is made. `TRIBLER_URL` is needed only because the shared bridge configuration validates it. The tool does not choose a corpus; supply a local input or corpus file explicitly. The command fails if the direct probe is disabled.

The input is a JSON array of 1 to 100 items. Each item requires `type` and `videoId`, using the exact Stremio type and native ID expected by an addon. Optional fields are `kind` (`movie`, `series`, or `episode`), `title`, `year`, `seriesTitle`, `season`, `episode`, `externalIds`, and `classifications`. The flat input file is bounded to 65,536 bytes. Supply authoritative `seriesTitle` for Python episodic sources; an episode title is not a substitute. Requested runtime is not carried by this CLI input parser. The bridge's existing identity helper fills IMDb movie and episode IDs when supplied. Other namespaces must be supplied explicitly; this tool does not convert IDs between databases.

```json
[
  { "type": "movie", "videoId": "tt1234567" },
  { "type": "series", "videoId": "tt7654321:1:2" },
  {
    "type": "anime",
    "videoId": "kitsu:123",
    "kind": "episode",
    "season": 1,
    "episode": 2,
    "externalIds": { "kitsu": "kitsu:123" },
    "classifications": ["anime"]
  }
]
```

The evaluator uses the same parsed `contentTypes` policy and Stremio addon provider as normal stream resolution. An item disabled by a provider's manual policy produces zero counts for that provider without contacting its manifest or stream endpoint. This policy does not alter evaluator scoring or select providers automatically.

The resolver checks each addon's manifest capabilities and ID prefixes. A provider that does not support an identity contributes zero counts for that item.

### D1 metrics

Each row represents an enabled configured addon, including one with no useful result. `Raw` counts HTTP/HTTPS URL entries in addon responses. `Qual` counts Direct candidates that passed the resolver's normalization, identity, and URL policy checks. `Dedupe` counts Direct candidates remaining after provider and cross-provider deduplication. Cross-provider duplicates belong to the winning provider. `Turns` counts Direct candidates selected by the probe scheduler and given probe metadata. `Net` counts selected turns that passed the probe cache and deadline checks and started a network attempt. A single attempt may make additional bounded requests for media validation; `Net` counts attempts, not HTTP requests.

`Verified` counts successful probe verification. `Reject` counts deterministic route, archive, document, and completed non-transient client errors as classified by the resolver. `Budget` counts selected turns marked `budget_exhausted`. `Uncertain` counts remaining selected turns, including transient errors and reachable but unverified responses. `Admit` counts Direct candidates admitted after probe and identity checks. `Final` counts Direct results surviving provider caps and ranking. `Items` is the number of evaluated items with at least one final Direct result from that provider.

`Reject%` is deterministic rejects divided by selected turns. `V/Turn`, `A/Turn`, and `F/Turn` are Verified, admitted, and final Direct counts divided by selected turns. `Item%` is contributing items divided by evaluated items. A zero denominator produces zero. JSON output uses the full metric names and ratios from 0 to 1.

Quality, diversity and cost sections contain sanitized provider names/IDs and aggregates. Both JSON reports also include `identityPrecision` with bounded, sanitized display and numeric diagnostics, which can retain requested titles and candidate presentation text. See the [diagnostic contract](evaluation-diversity.md#observation-only-identity-precision-audit) for fields and limits. Reports exclude media IDs, source URLs, query strings, tokens, cookies, magnets and raw source metadata; candidate keys stay in memory. Do not treat the full JSON report as aggregate-only. Treat the results as observational evidence for manual provider review. They do not change scheduling or automatically disable providers. This D1 command evaluates Stremio addons only; Python/Kodi resolver provenance is outside its scope.

## Kodi source evaluation (D2b)

Run explicitly from the repository root with an input file using the shared D1
item format above. The local `.env` must select the Python adapter's
resolver configuration, and the direct probe must be enabled. `TRIBLER_URL` is
needed only by shared bridge configuration validation; the evaluator never
connects to Tribler and removes Tribler variables from the Python child environment.

```powershell
$env:DIRECT_HTTP_PROBE_ENABLED = "true"
npm run evaluate:kodi-sources -- --input .\my-evaluation-items.json
npm run evaluate:kodi-sources -- --input .\my-evaluation-items.json --json
```

The input is a JSON array of 1 to 100 D1 evaluation items. A movie example is
`[{"type":"movie","videoId":"tt1254207","title":"Big Buck Bunny","year":2008}]`.
`type` and `videoId` are required; `title`, `seriesTitle`, `kind`, `year`, `season`, `episode`,
`externalIds`, and `classifications` follow the D1 input rules. Give Python
sources a real title and year when their contracts need them. The tool has no
permanent corpus and does not write candidate data to files.

The fixed Node CLI starts `python -B -m adapter_host.evaluate_kodi_sources` with
bounded stdin/stdout and captured, suppressed stderr. Media input cannot choose
the executable, Python module, profile, or inner source. The Python helper reads
the existing local profile configuration and calls D2a's
`evaluation_source_ids()` and `evaluate_source()` on each enabled SourcePack or
external scraper package profile. Each call uses the existing disposable worker,
its timeout, 100-result evaluation scan, 256 KB worker IPC bound, and cleanup.
A failed inner source gets a source error count and zero candidates for that
item; other sources continue. Parent/child errors expose only fixed categories.

Enabled `callable_stream_resolver` profiles are also supported as one stable
`(profileId, sourceId="profile")` row per item: a **profile-level evaluation unit
for non-decomposable callable resolvers**. This diagnostic source ID does not name
an upstream source. D2b calls the existing manager's normal `resolve(media)` with
the existing disposable worker and configured result cap. It never calls the
inner-source APIs for a callable or sends an evaluation-source argument to its
worker. Empty and failed calls retain the same row (respectively `ok`/zero and
`error`/zero), preserving the report roster. The shared structural counts, Node
quality evaluator, resolver, probe and identity diagnostics are unchanged. Runtime
HTTP resolution and the worker's inner-source allowlist are unchanged.

### D2b metrics

`Cand`, `Direct`, and `Torrent` describe candidates returned by D2a after the
adapter's own normalization and filtering, before cross-source deduplication
and profile result caps. For callable profile-level rows, the normal manager
already applies normalization, deduplication and the configured result cap.
`Seed+`, `Seed?`, and `Seed0` count returned torrent
candidates with positive, missing, and known-zero seed values. `Drop0`
counts returned candidates that the current Python registry would exclude,
using the same predicate as normal registry hygiene. Raw invalid candidates
discarded earlier inside the adapters cannot be counted.
A valid empty source and a SourcePack source whose `_run` hid a failure can be
indistinguishable; an observed worker error increments `Errors`.

JSON `distinct`, `exclusive` and `shared` (table `Exclusive` and `Shared`) use Python's existing
`deduplication_key()` within each media item. A distinct identity is credited
to every source that returned it. `Exclusive` appears in one source;
`Shared` appears in at least two. Counts sum across input items. Identity
strings, URLs, magnets, hashes, settings, and raw metadata never appear in
the report.

For the evaluation funnel, every `(profileId, innerSourceId)` becomes a
synthetic StreamProvider. Its returned candidates go through the existing
StreamResolver, URL policy, DirectStreamProbe, and D1 ProviderQualityEvaluation
trace. `EvalTurns` counts selected Direct probe turns; JSON `evalNet` counts turns
that started a network attempt; `V`, `U`, `R`, and `Budget` count Verified,
uncertain, deterministic reject, and budget exhausted outcomes. `Admit` and
`Final` count Direct candidates surviving the resolver's admission and final
provider cap; `Items` counts input items with final Direct contribution.
JSON includes full names, stage counts, ratios, definitions, and report version 3.

**These compare inner-source quality under the evaluator's fair synthetic-provider
scheduling; they are not a reconstruction of normal `external_http` scheduling.**
In the synthetic StreamResolver funnel, a cross-provider duplicate is credited
to its deterministic winning provider. This is separate from the structural
`Shared` count, which credits every source. The normal production path still
aggregates Python sources into one Node `external_http` provider.

## Corpus, cohorts, diversity, cost and comparison

Both CLIs accept exactly `--input <path>` or `--corpus <path>`, optionally
followed by `--json`; the selector comes first and `--json` last. For example:

```powershell
npm run evaluate:stremio-providers -- --corpus .\my-evaluation-corpus.json --json
npm run evaluate:kodi-sources -- --corpus .\my-evaluation-corpus.json --json
npm run compare:evaluations -- --baseline .\baseline.json --candidate .\candidate.json
```

The version 1 corpus envelope, version 3 report fields, cohort and anime-shape
segments, item coverage, seed evidence, overlap ownership, identity diagnostics
and offline comparison compatibility are defined in [evaluation diversity](evaluation-diversity.md).
Flat input contributes only to `all`; corpus cases also enter their media class,
`mainstream`/`long-tail` cohort and combined segments. These overlapping views
must not be summed as disjoint populations. Original Node-normalized owners
receive `admittedOwned`/`finalOwned` credit; `finalWinner` credits only the
resolver winner. D2b Python structural ownership remains a separate measure.
Exclusive coverage is observed marginal coverage, not a causal removal study.

For D1, `cost` counts provider evaluations, observed stream-resource requests and responses, errors, and resolver diagnostic latency. Request counts come from the provider request event before the stream fetch; a policy or route failure can therefore count an attempted resource request without a completed network response. They do not separately include manifest fetches. Latency percentiles use nearest rank; this wall-clock observation includes the normal configured Stremio provider path. Request IDs and candidate identities stay in memory only and do not appear in reports.

For D2b, `cost` records each source or callable profile evaluation's calls, errors, and elapsed milliseconds. Time includes the D2b disposable worker execution and is not normal production `external_http` wall-clock scheduling. It uses nearest-rank p50 and p95. The report includes no worker path, command, media ID, candidate identity, or URL.

Neither a zero result nor a failed, unexamined, timed-out or budget-exhausted
probe proves upstream absence. Verification demonstrates media reachability
under the probe contract; it does not certify the requested title or sustained
playback. Unknown seeds do not mean zero, and seed counts do not prove swarm
availability. Synthetic source quality cannot predict normal mixed-provider
competition or justify automatic provider disablement or changed defaults.

The existing [Python registry contract](../python-adapter-host/README.md#aggregate-result-hygiene)
uses round-robin and known-zero-seed filtering in normal aggregation. D2b
evaluates sources separately before that aggregation; `Drop0` is a would-drop
observation, not a count of removed production results. Keep these evidence
levels separate when comparing a normal `/resolve` response with a D2b report.

For implementation checks, see the existing [D1 tests](../tests/provider-quality-evaluation.test.ts),
[D2b Node tests](../tests/kodi-source-quality-evaluation.test.ts),
[D2b Python tests](../python-adapter-host/tests/test_d2b_evaluation.py) and
[F1 tests](../tests/story-f1-evaluation.test.ts). These fixture checks do not
certify live availability. No evaluation or live smoke is run by this cleanup.
