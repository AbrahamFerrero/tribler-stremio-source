# US-1502: passive resolver diagnostic integration

Local review: 2026-10-25, Asia/Tokyo. Scope: synthetic Windows verification of
passive diagnostic capture, with no release/publication or real playback claim.

## Checkout and preserved work

Before editing, branch, HEAD, status and tracked diff were inspected in the existing
isolated `.worktrees/us-1501-diagnostics` clone. Branch remains
`work/us-1501-diagnostics`, HEAD remains public base
`18267ac0975f50e201c812db02d1c43cbb2d51ce`. The initial state matched US-1501:
four tracked modified files (SECURITY, HTTP contracts, app and local request policy),
plus untracked diagnostic modules, two tests, design and US-1501 QA documentation.
There was no staged diff. These changes remain present; existing US-1501 tests and
its historical QA document were not edited, and all 28 existing tests still pass.

No refs were changed, no new checkout/branch was created, and no commit, push, PR,
merge, tag or publication was performed. There is no new implementation commit SHA:
US-1501 and US-1502 remain a combined uncommitted local diff against the public base.
The original private checkout was not used for implementation or modified.

## Resulting implementation

- `resolver.ts` accepts an optional observation factory. Each invocation reserves
  capture synchronously before providers, composes a local observer with the existing
  legacy trace, and finishes in `finally`. No callbacks are swapped on the shared resolver.
  Existing awaits remain unchanged; diagnostic code adds no await, I/O or request.
- `factory.ts` carries that optional factory; `app.ts` supplies one controller to both
  administrative controls and the real resolver. OFF/quota-skipped calls create no
  diagnostic adapter or occurrence references. Legacy tracing retains its own behavior.
- `diagnostics/resolver-observer.ts` minimizes immediately. State consists of a weak
  map keyed by empty occurrence references, bounded integer sets and validated numeric
  DTOs. Original sources, arrays, hook entries, components objects, query items and
  arbitrary provider IDs are never retained by the adapter or recorder.
- `diagnostics/events.ts` closes and validates the expanded flat schema. Snapshot
  counts distinguish actual source counts from bounded observable occurrences.
  Candidate Identity/probe observations, pre-probe decisions, explicit rejections,
  continuity/ranking gaps and completion outcomes are closed enums. Final rank positions
  and seven finite numbers (total plus six components) have fixed bounds; extra fields
  and accessors remain invalid.
- Controller handles add best-effort active/truncate/interrupted-finish operations.
  All US-1501 TTL, reservations, concurrency, candidate/event/byte limits, report retention,
  HTTP authorization and no-persistence contracts remain in force. Diagnostic-only
  reference and ranking arrays are bounded to 256; legacy trace consumers retain their
  existing full snapshots. Overflow truncates capture without slicing production results.

The pipeline's qualification, normalization, dedupe, probe scheduling, scoring, Identity,
production quotas and final ordering decisions were not changed. `addon.ts`, scoring,
normalization, dedupe, direct probe, config, logger, package metadata and lockfile are
unchanged. The new observation code consumes the existing hooks and bridge Identity
WeakMap; it imports no normalization, scoring, dedupe or qualification implementation.
HTTP policy/router changes from US-1501 are preserved without further changes here.

## Evidence and known gaps

The 16 new integration tests exercise the real resolver and cover:

- Exact ON/OFF source results, Identity states, order, dedupe/admission, provider calls,
  outbound request sequences, probe diagnostics and production probe/final quotas.
- OFF reference allocation avoidance and reservation before provider work; two shared
  resolver invocations with stage-interleaved callbacks and isolated IDs; legacy hooks.
- Distinct occurrence IDs for repeated copies of the same source object.
- CORROBORATED, UNKNOWN, UNCLASSIFIED and SUSPICIOUS observations; explicit pre-probe
  external-ID rejection and measured-runtime contradiction; failed probes and survival.
- Exact final technical score and six components under an alternative effective policy,
  with final occurrence/position correlation. Mutating hook score objects later does
  not mutate the captured DTO. Non-finite scores, missing references and mismatched
  ranking/snapshot counts produce explicit gaps.
- Final quota removals with insufficient cause evidence, without a fictitious earlier
  ranking snapshot. Candidate disappearance never invents a dedupe or admission reason.
- A 300-candidate production result while diagnostics records actual provider count 300,
  observes only 256 occurrences and becomes TRUNCATED. Twelve simultaneous production
  invocations all finish despite only four captures and ten reservations.
- Stop, injected-clock expiry, cancellation, observer factory/callback/finalization
  failures, recorder failure and unchanged propagation of an original production error.
  Observer failure cases compare results and outbound request sequences with baseline.
- Private synthetic canaries in locators, titles, query/provider IDs, metadata, headers,
  magnets, infohashes, tokens and errors; no such values enter diagnostic reports.
- An enlarged numeric-event workload that reaches the 2 MiB DTO guard before 8192
  events, independently of the resolution event cap.
- The real Stremio HTTP route using createApp: equal public order/presentation ON/OFF,
  administrative capture counters, no additional upstream requests, and comparison of
  opaque playback capabilities by route/shape rather than literal random-token value.

The effective comparator Identity group is not emitted by the existing hook. It is
omitted with IDENTITY_GROUP/UNOBSERVED instead of being recalculated from Identity.
Observed Identity state remains separately available. Ranking is post-quota only;
there is no pre-quota ranking snapshot. Unexplained disappearance is
CONTINUITY/INSUFFICIENT_EVIDENCE, and missing reference/ranking evidence is UNOBSERVED.
CLOSED means closure of accepted events, not proof of complete traceability.

## Commands and observed results

Windows NT 10.0.26200.0 / win32 x64, PowerShell, Node v22.23.2, npm 10.9.8,
Vitest 4.1.12. Dependencies and lockfile were reused without updates.
`npm.cmd` avoids the local npm.ps1 execution-policy restriction.

| Actual command | Result |
| --- | --- |
| `npx.cmd vitest run tests/integration/diagnostic-resolver.test.ts tests/diagnostics.test.ts tests/security/diagnostic-http.test.ts --maxWorkers=2` | Final exit 0: 44 tests / 3 files |
| Selective regression command below | Exit 0: 180 tests / 9 files |
| `npm.cmd run test:all -- --maxWorkers=2` | Exit 0: 1679 tests / 93 files; 36.99 s |
| `npm.cmd run coverage -- --maxWorkers=2` | Final exit 0: 1722 tests / 94 files; 41.64 s |
| `npm.cmd run test:acceptance` | Exit 0: 43 tests / 1 file; 6.22 s |
| `npm.cmd run test:system` | Exit 0: 18 tests / 1 file, V8 disabled; 14.66 s |
| `npm.cmd run test:security` | Exit 0: 64 tests / 5 files |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run lint` | Final exit 0 |
| `npm.cmd run build` | Exit 0 |
| `npm.cmd run security:repo` | Exit 0; all publishable files scanned |
| `npm.cmd audit --json` | Exit 0: zero declared vulnerabilities |
| `npm.cmd audit --omit=dev --json` | Exit 0: zero declared production vulnerabilities |
| `git diff --check` | Exit 0 |

Final V8 coverage: statements 89.24% (5441/6097), branches 86.35% (5170/5987),
functions 92.98% (902/970), lines 93.30% (4485/4807). An earlier coverage run also
passed 1722 tests in 43.61 s; the final run includes the added missing-reference,
ranking-count mismatch and detached-score assertions. System tests ran separately
without V8 as required. Full-suite logs and audit JSON are local ignored artifacts
under `.cache/us1502-*`, not repository content.

Selective regression command (run after the first focused suite):

```powershell
npx.cmd vitest run tests/integration/diagnostic-resolver.test.ts tests/diagnostics.test.ts tests/security/diagnostic-http.test.ts tests/stream-resolver.test.ts tests/stream-identity-ranking.test.ts tests/identity-pre-probe-observability.test.ts tests/identity-probe-scheduling-regression.test.ts tests/integration/public-identity-order.test.ts tests/security/localhost-boundary.test.ts --maxWorkers=2
```

Initial focused execution: 40 passed / 2 failed, across 42 tests. Both failures were
new fixture/assertion errors. The runtime-conflict fixture returned 200, which did not
supply the existing MP4 range-runtime evidence needed for that rejection; it was corrected
to honor the requested byte range with coherent 206/Content-Range. The public-route test
expected original filenames, but the existing safe public contract uses stream.mp4;
assertions now compare quality order/presentation and opaque capability shape. Production
decisions were not changed to satisfy either expectation. That suite then passed 42/42;
two additional concurrency/legacy/quota tests brought it to 44/44.

One intermediate lint run failed on an unbound legacy-method assertion in the new test.
The test now retains the mock function directly; lint subsequently passed. Additional
assertions for missing references, count mismatch and detached numeric projection were
added after the first broad run; the final focused and coverage runs include them.

No US-1502 broad regression, acceptance, system, security or audit failure was observed.
The two-worker flags bound test resource use without changing repository test configuration,
deadlines, expectations or production scheduling. US-1501's historical broad-run failures
remain recorded with undetermined cause; this finite passing campaign does not resolve
intermittency or establish a causal explanation.

## Limits and readiness

No Linux/macOS run, hosted CI, separate Python suite/coverage, real provider/Tribler/Kodi/
Stremio playback smoke, prolonged playback or performance benchmark was executed. Synthetic
equivalence is bounded to the tested fixtures and does not certify every hostile local
trace consumer or upstream object. Legacy trace consumers still own their original access
and exception contracts; only the new diagnostic observer is contained by this integration.

The minimal passive integration is ready for US-1503's separately scoped presentation/export
work. There is still no CLI, external JSON report endpoint, HTML, persistence, telemetry,
playback correlation or Python/Kodi internal capture. Existing localhost/Bearer controls
remain required. PR6, Identity STRICT, R-020 and embedded dependency limitations retain
their existing scope; this work makes no new risk acceptance or release readiness claim.
