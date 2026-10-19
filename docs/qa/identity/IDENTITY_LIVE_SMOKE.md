# Opt-in identity live observations

Run from the repository root using the existing `.env` and configured catalogs/providers. An explicit user-supplied --corpus path is required. The existing corpus loader validates the JSON (1–100 cases, at most 64 KiB); no configuration is written. Use synthetic, freely licensed or explicitly authorized inputs for public examples.

```powershell
npx.cmd tsx scripts/identity-live-smoke.ts --corpus "C:\private-qa\synthetic-corpus.json" --quick
npx.cmd tsx scripts/identity-live-smoke.ts --corpus "C:\private-qa\synthetic-corpus.json" --full
npx.cmd tsx scripts/identity-live-smoke.ts --corpus "C:\private-qa\synthetic-corpus.json" --quick --json
```

QUICK is the default when no mode is supplied. It selects at most twelve cases, round-robin across populated media-class/cohort groups, with groups and case IDs sorted deterministically. Each populated group receives a turn before a second case is selected from any group; smaller and uneven corpora are supported. FULL traverses all supplied validated cases in that same order, subject to the existing deadline. Selection never depends on corpus identity, input order or provider results. Mainstream/long-tail are corpus labels, not current availability or content truth.

| Bound | QUICK | FULL |
| --- | --- | --- |
| Global deadline | 90 seconds | 180 seconds |
| Cases | at most 12 | all validated cases, at most 100 |
| Provider resolutions per case | at most 4 | at most 4 |
| Provider concurrency | at most 2 | at most 2 |
| Initial probe slots per case | at most 4 | at most 8 |
| Existing maximum probe attempts including backfill | at most 8 | at most 16 |
| Shared probe deadline per case | at most 1.5 seconds | at most 3 seconds |
| Provider timeout | at most 3 seconds | at most 3 seconds |
| Trusted movie metadata lookup | at most 1.5 seconds and remaining global time | same |

Smaller user limits and disabled probes are preserved. Overrides exist only in memory. Enabled providers are grouped using the existing closed provider-family taxonomy. Family order and member order rotate deterministically by case index. Each family receives one slot before additional members are sampled, with at most four providers per case. With more than four enabled families, the omitted family rotates too; external HTTP has no reserved slot. The configured provider list is not reordered or modified. Configured and selected-distinct counts are reported separately from completed calls. The external provider's normal longer worker timeout may exceed the QUICK allowance; a QA timeout does not establish server failure or unavailable content. Manifest/capability/ID/type checks and provider logic remain unchanged.

The CLI reuses existing corpus/input validation, provider constructors/factories/policies, registry/resolver, ranking, protected DirectTransport, shared DirectStreamProbe cache, bridge-owned confidence and Case 53 eligibility. It performs no playback, token registration, full media download, automatic retries, human verdict assignment or FULL escalation. Ctrl+C aborts remaining work. The resolver receives the global signal, and the sampling wait is independently bounded so a stalled provider promise cannot block report generation. Metadata uses the supported bounded trusted lookup; exact episodes never receive series-wide duration. Missing trusted movie runtime is reported, not filled from upstream claims.

The table/JSON provides safe corpus IDs/cohorts, execution outcomes, provider-family counts, all six stage counts, HTTP/HTTPS/torrent counts, actual probe starts/cache hits, verified/uncertain/failed/exhausted and unexamined counts, measured MP4/HLS VOD facts, real measured rejection events, eligible/excluded reviews, direct survivors and observed confidence. Absent classification remains `unclassified`. Final confidence is counted only on final sources; rejected confidence is counted from actual measured rejection events. Pending provider outcomes in a partial sample are explicit. Provider timeout counters include registry cancellation. No disappearance count is converted into a candidate rejection reason.

`probed` is a snapshot size, not a count of network starts. Unexamined direct candidates have no probe metadata; they are not silently counted as explicit `budget_exhausted`. Verified MP4 MIME and measured MP4 duration are different observations. Media HTTP attempts are counted at the validated pinned boundary, including redirects and MP4/HLS dependencies; cache hits can reuse observations without starting another probe. **There is no exact global HTTP request cap**: provider discovery, manifests, trusted metadata and their redirects can add requests outside the media counter. Normal byte/depth/redirect/DNS/SSRF/header/timeout protections remain in force.

Empty rejected-source review also uses this closed diagnostic schema:

```powershell
npx.cmd tsx scripts/review-rejected-source.ts tt1234567
```

For example, the deterministic offline zero-source fixture with probe enabled reports:

```text
providers selected/calls/errors/timeouts/empty=1/1/0/0/1
stages raw/normalized/dedup/probed/admitted/final=0/0/0/0/0/0
probe starts/cache/verified/uncertain/failed/exhausted/unexamined=0/0/0/0/0/0/0
measured MP4/HLS=0/0; measured rejects=0; review eligible/excluded=0/0; final direct=0
observations (non-exclusive): NO_RAW_SOURCES, NO_DIRECT_SOURCES, NO_PROBE_STARTS, NO_VERIFIED_MP4, NO_MEASURED_REJECTION, INSUFFICIENT_EVIDENCE
```

The actual CLI additionally displays media attempts and observed confidence. Conditions are non-exclusive facts, not a selected root cause. Zero measured rejects does not prove correct content; zero eligible reviews does not prove healthy providers; no reviewed sources does not prove absence of identity risk. Missing runtime still allows diagnostic resolution, but cannot manufacture a measured-runtime review candidate. Interactive selection, isolated playback and the separate explicit CONTENT TRUTH/RULE VERDICT flow remain as documented in [Local rejected-source review](#local-rejected-source-review).

Output contains only closed counters/enums and validated corpus IDs, never provider names, raw errors, titles, filenames, upstream locators, queries, headers, magnets or infohashes. JSON is printed only; if saving reports, use a private location outside the repository. Do not commit real private reports or terminal transcripts. The offline suite imports only runner helpers and uses existing controlled HTTP fixtures; `npm test` never invokes the live CLI.

Local P1 hygiene replaces the private corpus dependency with the [synthetic evaluation fixture](../../standard-evaluation-corpus.md); private inputs remain external and explicitly supplied. Historical private corpus and report blobs remain reachable in private development history, which must not be published. The definitive public source snapshot must be created with a new root history and must not inherit those blobs. Before publication, review the exact snapshot, manifest, reachable history and documentation for private QA material; publication remains pending approval. Prior live smoke measurements remain in a private local QA note; no live run is required by the offline suite.

## Local rejected-source review

This explicitly invoked QA process inspects one real, post-probe measured-runtime rejection. It never adds that source to normal Stremio output or changes REJECT/CONTRADICTION. The first version supports verified HTTP(S) MP4 (`video/mp4`, `mp4_mvhd`); HLS, torrents, pre-probe rejects and other reasons remain unavailable.

From an interactive terminal in the repository, with the existing local provider configuration and trusted movie metadata lookup available:

```powershell
npx.cmd tsx scripts/review-rejected-source.ts tt1234567
```

Replace the example with the requested movie's IMDb ID. The command accepts no source URL, addon path, runtime override or arbitrary configuration from HTTP. It performs one resolution using the existing provider factory and unchanged probe settings. Trusted movie runtime is required for measured-rejection review; when unavailable, diagnostic resolution can still run without inventing runtime. No eligible reject means no listener and no playback handle. A disabled probe will not produce a reviewable reject. Empty results now print safe, non-exclusive stage/provider/probe/rejection/eligibility observations instead of an unexplained list; see the diagnostic schema above.

1. Read the safe session list: temporary candidate ID, provider family, rejection stage/reason, internal state, protocol/verified probe and numeric runtime difference. Candidate claims and upstream locators are omitted.
2. Paste one temporary candidate ID, or leave blank to cancel. Only that selection creates an isolated listener bound to `127.0.0.1` and an opaque playback token. Open the printed localhost handle manually in VLC or another local player. There is no autoplay, listing endpoint or normal-app debug route.
3. Enter **CONTENT TRUTH** explicitly: `CORRECT_CONTENT`, `WRONG_CONTENT` or `INCONCLUSIVE`.
4. Separately enter **RULE VERDICT**: `RULE_SUPPORTED`, `RULE_FALSIFIED`, `IMPLEMENTATION_BUG`, `HARNESS_GAP` or `UPSTREAM_UNKNOWN`. Neither dimension has a default. Correct content rejected according to the current contract may be `CORRECT_CONTENT` + `RULE_FALSIFIED`; this is not converted into PASS.
5. The process prints only the chosen temporary ID and the two manual verdicts, then closes the listener and releases its candidates/tokens. Record real review results in a private worksheet **outside this repository**. Do not redirect the terminal transcript into tracked files: it contains a short-lived local playback capability. Never persist upstream URLs, query strings, headers or other private metadata.

The session has an absolute five-minute lifetime including resolution and selection. Tokens cannot renew that deadline, and a session allows only one selected playback source. At most sixteen eligible rejects are retained; later ones are not offered. Press Ctrl+C to cancel and release resources. Start a fresh process for another candidate; IDs/tokens do not carry between sessions.

Playback reuses `PlaybackManager`, `DirectHttpPlaybackBackend`, `proxyDirectHttp` and the same protected `DirectTransport`. URL/DNS/SSRF/redirect/header checks run again on each request. QA also requires MP4 MIME on playback, suppresses upstream response metadata and refuses HTML/HLS changes. GET, HEAD and valid Range requests use the existing proxy behavior. Unknown tokens, expired sessions and remote Origin/Host requests fail closed; no upstream error details are returned.

The deterministic Case 53 fixture reads actual media bytes through this path and proves inspection capability and isolation. Its generated MP4 metadata fixture is **not an audiovisual content-truth result**. Live human review may fail because a source expires, changes media, requires unsupported headers, or exceeds normal transport bounds; record that limitation without bypassing protections. R-020 remains open; this mechanism does not claim to settle unrelated privacy or compatibility issues.
