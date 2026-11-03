# US-1506 — diagnostic report usability and context

Historical checkpoint. The [2026-11-03 closure QA](v1.5-technical-closure.md)
supersedes the local technical readiness suspension below. Earlier browser and
product evidence remains scoped to its original revision, not the current v7 tree.

Date: 2026-10-25. Local working-tree product correction; **candidate preparation
remains suspended pending owner review of the result**. No commit, publication,
private-history import or exact-candidate CI claim is made.

## Verified base and feasibility

Independent checkout `.worktrees/us-1501-diagnostics`, branch
`work/us-1501-diagnostics`, HEAD/public base
`18267ac0975f50e201c812db02d1c43cbb2d51ce`. Only origin:
`https://github.com/AbrahamFerrero/tribler-stremio-source.git`. Branch, HEAD,
status, tracked diff, untracked files, remotes and empty staged diff were inspected.
The pre-task non-ignored file/hash inventory is held in ignored `.cache/us1506/`.
The original private checkout was not modified. All earlier work remains uncommitted.

Phase 0 inspected actual addon/media-item construction, registry, resolver hooks,
recorder/controller, HTTP policy, CLI/exporter/HTML and current privacy/publication
documentation. The binding source-history separation and no-secrets/no-real-reports
rules remain in force. No additional section-E publication guardrail was available
in the inspected public checkout; no compliance or publication approval is inferred.

| Fact | Actual observation boundary and limit |
| --- | --- |
| Requested content | Normalized media item at resolve entry, after addon/catalog enrichment. Store title only if available and not the request-ID fallback; kind and optional episode coordinates are known. No identity is guessed from filenames/locators. |
| Enabled/disabled | Same registry eligibility computation as production; no extra isEnabled call selects or changes work. |
| Invocation/outcome | Call-local callback immediately before resolve, at actual returned arrays and at bridge-owned timeout/cancellation/error paths. No global last-run diagnostic is attributed to a concurrent resolution. |
| Counts/intake | Actual returned array length; actual slice handed to resolver; their difference. Counts before provider-internal filters are not available. |
| Candidate provenance | Bounded ordinal array aligned with actual Promise.all group flattening; empty occurrence references carry it through the existing resolver stages. An upstream providerId claim cannot substitute for the invoking provider. |
| Rejection/ranking | Existing explicit rejection hooks and existing post-quota ranking fields, without recomputation or altered decisions. |
| Final output | Resolver final-stage occurrence observed. Addon registration/publication happens after finally closes capture; Stremio receipt/display and playback remain NOT OBSERVED. No post-resolution channel or recorder reopening was added. |

This extension does not require weaker network/auth/SSRF policies, raw source
retention or modified playback. The unavailable addon/client-delivery observation
is documented rather than fabricated. US-1504 remains deferred.

## Explicit privacy contract revision

This story authorizes a narrowly scoped exception to the previous context-free
design. **Anonymous DiagnosticRecorder events still never receive title/provider
name strings, original objects, URLs, query IDs, credentials, headers, magnets,
infohashes, personal paths, free errors or private-value hashes.** Private context
is a separate sensitive controller vault, opted into for one session only.

| Mode | Stored/exported context | Authority |
| --- | --- | --- |
| Anonymized, default | Content kind, Provider 1-style ordinals, ephemeral candidate IDs, safe transport/height, observed states/counts/decisions | Existing start/report API and explicit CLI export; no private vault captured |
| Private local, explicit | Same anonymous data plus a validated available requested title, kind/episode coordinates and registered provider ID/name | New `/diagnostics/private/start` and `/diagnostics/private/report`, under the unchanged first localhost/native Bearer policy; CLI `--mode private` |

Normal GET report/status and anonymous JSON/HTML never expose the vault, even if
the session opted into private capture. Private context cannot be retroactively
recovered from an anonymous capture. Root/body/query extras do not opt in.
Both new operations retain method/body/query validation, no-store, no CORS and
the same Host/Origin/Referer/Fetch Metadata/Bearer checks. No HTML/file-path endpoint
or remote access was introduced. Capture remains OFF initially and after restart.

Projection rejects suspicious URL/path/credential/token/hash/markup labels before
storage. Limits are title 160 code units, provider ID/name 96 each, 64 provider
contexts and 32 KiB per-resolution private context. Original 10 reservations,
four concurrent captures, 256 candidates, 2048 events/resolution, 8192 events/session
and 2 MiB aggregate DTO limits remain. Context consumes that same byte budget;
32 KiB is not additional unaccounted space. Production limits remain unchanged.
Label omission is conservative and may withhold a legitimate label that resembles
a forbidden value; unavailable context is never reconstructed from secret data.

The vault is the only retained private-context owner; adapters do not buffer titles
or names between asynchronous callbacks. Handles retain IDs/controller only. Stop,
expiry and restart revoke writes before finalization; final context shares the one
report's original maximum five-minute retention, with no read renewal. Explicit
exported files remain owner-managed copies outside Git, just like existing exports.
No automatic persistence was added. New registry observations do not log context;
the existing registry failure warning was also minimized to omit its provider ID.
This is a documented privacy adjustment, not a claim that broader R-020 is closed.

New technical reports are **v2**, with closed REQUEST, PROVIDER_STATE,
PROVIDER_COUNTS and SOURCE events added. Legacy v1 report validation/export remains;
v1 rejects v2-only events instead of mislabelling schema compatibility. Private
JSON has its own v1 wrapper `{version,privacy:"PRIVATE_LOCAL",report,context}`.
It is rejected by the ordinary report validator. Anonymization validates the wrapper
and rebuilds only report, excluding the whole private namespace by construction.

## Human report and synthetic demonstration

The primary view now has a search selector, requested content, provider cards with
outcome/counts, compact stage counts, source cards and explicit rejection reasons.
Source N is scoped to its resolution, with transport/known quality, registered
origin, phases, latest observed Identity/probe state and final selection/position.
Missing quality is explicitly unobserved. Unknown disappearance causes stay unknown;
normalized/deduplicated observed survivor counts do not invent a per-source cause.
Scores, UUIDs and timeline are expandable technical information. Capture truncation
and private/anonymized notices are visible before the cards. Source selection and
filters use human labels, with technical IDs only as internal values.

English is initial regardless of browser locale. Every new label, explanation,
limitation and accessibility label has typed en/es translations. Unknown languages
and report modes are rejected. Existing advanced commands remain usable.

```text
npm.cmd run diagnostic -- demo
npm.cmd run diagnostic -- demo --mode anonymized
npm.cmd run diagnostic -- capture --mode private --output .cache/private-report.html
npm.cmd run diagnostic -- capture --mode anonymized --output .cache/anonymous-report.html
```

Demo defaults to the private view with **invented** content, never real owner data.
It runs the actual registry/resolver/controller/recorder/export flow with purpose-built
in-memory synthetic providers and no external network or invented diagnostic events.
Six synthetic providers include two returning 2/3
entries, zero, disabled, thrown failure and an actual short abortable timeout.
Per search: 5 intake entries → 4 after normalization → 3 after deduplication → 3
final candidates. One explicit KIND_CONFLICT rejects an episode for a movie request;
one other occurrence disappears and remains INSUFFICIENT_EVIDENCE. No cause is
fabricated for that occurrence. Three invented searches have distinct titles.

The actual CLI demo was executed, not substituted by tests. Final private and
anonymous HTML/JSON artifacts were also generated from the same validated capture
for exact projection comparison, in an ignored `.cache/us1506/evidence-*` directory.
Paths are delivered locally with the task result; no report payload, real media,
provider inventory or personal filesystem path was added to Git. Earlier real-smoke
and demo artifacts were not edited or used as this story's synthetic evidence.

## Real browser and visual review

**Executed:** Chrome 155.0.8059.85, fresh headless profile, file URLs, es-ES browser
locale, page network emulated offline before navigation. Both final modes passed:

- English initial rendering; en→es→en switching; all static translations/ARIA and
  dynamic search/provider/source labels; dataset unchanged.
- Search switching without cross-contamination; provider result/zero/disabled/failure/
  timeout distinctions; 5 source cards and 3 selected candidates for each search.
- Identity filtering, human candidate labels, keyboard activation opening technical
  detail and focusing the timeline; technical detail initially collapsed.
- No primary UUID text or horizontal document overflow at 1280×1000; private title/
  provider names present only in private mode. JSON equals the embedded HTML data;
  anonymous equals the private wrapper's projected report exactly.
- No product JavaScript/console errors or report-initiated external requests.
  Injecting an unsigned script as a negative control produced a script-src CSP
  violation and did not execute. The expected negative control is separate from
  the clean product run.

Local Spanish screenshots include top-level private/anonymous views and source-card
views. They were inspected visually. That review exposed a source-card error: an
explicit rejection during NORMALIZED initially displayed PROVIDER as the last phase
and the earlier unclassified Identity. The card now incorporates real rejection/
pre-probe observations; focused and real-browser regressions verify NORMALIZED plus
the explicit contradiction. No extra decision was computed to fix presentation.
This review is not a mobile/browser-matrix or screen-reader certification.

## Gates, failures and repetition

Windows NT 10.0.26200.0, win32 x64; Node v22.23.2, npm 10.9.8, Vitest 4.1.12.
All commands ran from the isolated checkout. Two workers cap contention; no timeout,
coverage threshold, lint rule, resolver quota or security check was relaxed.

| Command | Actual result |
| --- | --- |
| Initial compatibility selection (8 diagnostic/CLI/export/integration/security files), `npx.cmd vitest run … --maxWorkers=2` | 89 passed / 3 failed: two old demo readers expected an anonymous root, one expected SNAPSHOT as the first event |
| Focused context/private API/export/workflow/resolver selection | 66 passed / 5 files, then 138 / 6 files including stream resolver; later UI selection 51 / 4 files |
| `npx.cmd vitest run tests/diagnostic-context.test.ts tests/integration/diagnostic-resolver.test.ts --maxWorkers=2` | 35 passed / 2 files after descriptor-work bound regression |
| `npm.cmd run test:integration -- --maxWorkers=2` | 245 passed / 14 files, 5.76 s |
| `npm.cmd run test:security -- --maxWorkers=2` | 73 passed / 7 files, 22.55 s |
| `npm.cmd run test:all -- --maxWorkers=2` | Initial complete runs: 1749 passed / 100 files; final closure: 1750 / 100 files, 38.22 s |
| `npm.cmd run coverage -- --maxWorkers=2` | Initial complete runs: 1792 passed / 101 files; final closure: 1793 / 101 files |
| `npm.cmd run test:acceptance -- --maxWorkers=2` | 43 passed / 1 file, 5.40 s |
| `npm.cmd run test:system -- --maxWorkers=2` | 18 passed / 1 file, 13.11 s; V8 disabled by script |
| `npm.cmd run typecheck` | Exit 0 initially and at repeated checks |
| `npm.cmd run lint` | Private-validator issues corrected; final closure exit 0 |
| `npm.cmd run build` | Exit 0 initially and at final closure |
| `npm.cmd run security:repo` | Exit 0 initially; repeated with documentation |
| `npm.cmd audit --json` | Exit 0, zero declared vulnerabilities |
| `npm.cmd audit --omit=dev --json` | Exit 0, zero declared vulnerabilities |
| `git diff --check` | Exit 0; repeated at closure |

Final privacy review additionally caught Express generating an automatic ETag for
the private body. A new private-response assertion first failed (3 passed / 1 failed),
then the private response switched to bounded JSON end without automatic digest
generation. The anonymous endpoint's established behavior is unchanged. The six-file
private/anonymous HTTP, context and CLI regression selection, typecheck, lint and
build were rerun after that small header correction; the complete suite/coverage
totals above precede that correction and are not relabelled as exact-final reruns.
That post-correction selection passed **64 tests / 6 files**; typecheck, lint and
build each returned exit 0. Private responses carry no ETag; the normal endpoint's
response/content contract remains covered by its existing regressions.

Final production coverage: statements 89.28% (6156/6895), branches 86.45%
(5809/6719), functions 92.92% (1024/1102), lines 93.63% (4961/5298).
Suite counts overlap and must not be summed. The final complete runs include the
descriptor-work bound and corrected human last-phase/Identity presentation.

The pre-task manifest had 370 files. US-1506 adds six non-ignored files and changes
23 existing files; the other 347 files remain byte-identical. Historical checkpoint
QA, lockfile, addon, application/policy wiring, production networking/probes/scoring
and Python/Kodi sources are preserved. The publication inventory must be refreshed
for any future candidate; earlier manifests are checkpoint evidence, not final approval.

The 23 new context/private-boundary cases cover per-resolution content, provider
interleaving, invocation versus zero/disabled/pending work, actual timeout versus
failure/cancellation, intake counts, provenance, explicit/unknown rejection paths,
private/anonymous projection, language/search filters, stop/expiry/restart, provider/
byte overflow, recorder failures, forbidden-value/accessor canaries, v1/v2 validation
and native authorized private capture/export. Existing ON/OFF tests retain exact
source/order/Identity/probe/upstream-count comparisons. Existing JSON/HTML injection,
CSP/dictionary/path/junction/no-overwrite and HTTP boundary regressions remain.

Initial compatibility tests were updated for the explicit new contract, not weakened:
the demo reader validates its private wrapper and anonymous projection while retaining
source/ranking/no-network assertions; the overflow test locates the provider snapshot
and still requires 300 actual / 256 observed and unchanged production results. The
registry logging regression now requires no provider identifier while preserving its
safe-error assertions. The shared DOM harness was moved unchanged for reuse.

The standalone expanded demo initially exited before producing HTML: an unref'ed
deadline with no referenced pending work let Node exit while its timeout provider
was unresolved. The demo now uses actual abortable timer work, and real CLI artifact
existence is checked. No PASS was inferred from that initial exit-0-without-artifact.
Lint found a control-character regex, unsafe prototype comparison and redundant
assertions in the new validator; all were corrected without disabling rules. Visual
review found the last-phase/Identity issue above. Descriptor extraction was further
bounded to 256 characters per inspected field, using data descriptors without
invoking source accessors; oversized data displays unobserved quality. Production
height/scoring logic was not changed. Earlier timing intermittencies keep their
undetermined cause; passing capped runs do not resolve them.

No fresh dependency install, Python coverage rerun, Linux/macOS execution, hosted CI,
real provider/media campaign, Stremio/Tribler client run or mobile/screen-reader
smoke was performed in US-1506. Synthetic-only browser/fixture evidence is intentional.
The lockfile/dependency graph is unchanged; zero npm advisories do not remediate the
previously documented embedded tooling issue. PR6, R-020 and Identity STRICT remain open.

## Basic impact measurement

Command: `node --expose-gc --import tsx .cache/us1506/benchmark.mjs`. Current resolver
with 32 deterministic candidates, one in-memory provider and an injected policy
lookup, no probes/outbound requests. 100 warmups per mode, five rotated rounds of
100 samples (500 measured per mode). Timing covers resolve and observer finish;
capture start/stop/export are outside it. Every result is deeply equal, with exactly
one provider call and 32 policy callbacks per resolution in every mode.

| Current mode | p50 ms | p95 ms | min–max ms |
| --- | ---: | ---: | ---: |
| OFF | 0.7615 | 1.2905 | 0.6985–1.8862 |
| Anonymized ON | 3.1883 | 4.9901 | 2.9798–7.2629 |
| Private ON | 3.2884 | 5.2209 | 3.0271–7.7275 |

Private p50 added 0.1001 ms over anonymous in this fixture; anonymous added 2.4268 ms
over OFF. No threshold or universal regression claim is asserted. This is a mode
comparison in the current tree, not a causal before/after US-1505 benchmark. Shared
process/JIT, OS scheduling, GC between batches and one retained report influence it;
many-provider/real-network latency is not characterized. Sampled heap maxima were
29,393,272 / 29,588,592 / 29,422,552 bytes for OFF/anonymous/private; whole-process
max RSS 105,112 KiB. Sampling misses transient peaks and cannot prove no leak.

## Review and remaining evidence gaps

The synthetic private view answers: requested invented title; six named registered
providers; actual returned/intake counts; five source paths; three final resolver
options; one explicit kind conflict; one unattributed disappearance. The anonymous
view preserves those facts with title omitted and local provider labels. Unknown
content, provider-internal discovery, unavailable quality, comparator group,
pre-quota ranking, addon publication, actual Stremio receipt/display and playback
are visibly unobserved rather than guessed. Candidate preparation remains suspended
for product review, with exact-SHA QA/CI and publication/risk approval still separate.
