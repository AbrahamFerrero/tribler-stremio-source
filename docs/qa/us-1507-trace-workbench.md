# US-1507 — Trace Workbench: local QA

The 2026-10-25 presentation and initial 2026-10-26 correction records below are
historical. The final QA and local consolidation record at the end supersedes
their gate results and Git state. No v1.5 publication is implied.

Date: 2026-10-25 (Asia/Tokyo). Presentation-only change. Release preparation remains
paused pending owner acceptance. No commit, push, PR, merge, tag or publication.

## Source and preservation

Verified before edits: independent clone `.worktrees/us-1501-diagnostics`, branch
`work/us-1501-diagnostics`, HEAD `18267ac0975f50e201c812db02d1c43cbb2d51ce`.
The only remote is public `https://github.com/AbrahamFerrero/tribler-stremio-source.git`.
US-1506 source, context/privacy model, fixtures, CLI and historical QA were inspected.
Its implementation was already uncommitted and remains preserved. No private
checkout/history was modified or imported. No AGENTS.md was found in this workspace.

Pre-task SHA-256 inventory: 376 non-ignored files, stored only in ignored
`.cache/us1507/baseline.json`. Final comparison: 371 unchanged, five edited:

- `src/diagnostics/html-report.ts`: matrix, inspector, filters, compact provider table,
  pipeline and graphite responsive styling; unchanged validator and hash-pinned CSP.
- `src/diagnostics/i18n.ts`: typed English/Spanish Workbench labels and explanations.
- `tests/diagnostic-dom-harness.ts`: find dynamically constructed inspector heading.
- `tests/diagnostic-context.test.ts`: inspect rejection details in the new inspector.
- `docs/diagnostics.md`: usage, evidence semantics and limitations.

Added `tests/diagnostic-workbench.test.ts` and this QA document. No production file
outside the report renderer/dictionaries changed. DTOs, controller, recorder, access,
TTL/quotas, resolver/providers, Identity, probes, scoring, networking, playback and
Python/Kodi are byte-identical to the pre-task inventory. Dependencies unchanged.

## UX and evidence semantics

Primary flow: select search → read Source N across six stages → identify × or ? →
select source/stage → inspect available evidence and limits. UUIDs/event codes remain
in advanced details. Sources are keyed by resolution ID plus candidate ID, with
per-resolution human ordinals. A repeated candidate UUID in another resolution is
covered by regression. Switching searches resets filters/selection; language retains
selection. Pipeline/global outcome counts are independent of filtering; Visible is
filtered. Outcome/provider/stage/state/source filters intersect.

Observed green ● uses actual OBSERVATION, SOURCE at provider intake, or PRE_PROBE at
normalized. Explicit REJECTION × takes precedence at its recorded stage, with its
actual reason. A candidate-specific CONTINUITY GAP ? establishes missing continuity,
never its cause. Other absent observations are — unavailable. Missing cells are ◒
when capture is incomplete; known observations/rejections still display. Global
truncation conservatively marks missing evidence incomplete even in closed searches.
No stage is filled from count differences or ranking alone. Final membership requires
an actual FINAL observation. Final rank and seven score numbers (total plus six
components) are shown only from captured RANKING. Last reached stage follows pipeline
order, including an explicit rejection/pre-probe observation. There are no timings.

Provider table uses actual observed execution states and returned/delivered counts;
zero and disabled/not invoked remain distinct. Final survivors count attributed
candidate FINAL observations only when a FINAL snapshot exists. Provider-internal
pre-filter discovery totals remain unavailable. English/Spanish, native buttons,
visible focus, selected-row indication and descriptive cell labels use text/symbols
alongside color. Narrow screens scroll the matrix horizontally and put inspector below.

Privacy modes and data boundary are unchanged. Both fresh HTMLs embed exactly the
validated JSON exports; anonymized JSON exactly equals the private wrapper's report.
Titles and registered names appear only in private mode. Safe textContent construction,
JSON delimiter escaping, existing secret/URL/path rejection, default-deny hash CSP and
2 MiB DTO / 4 MiB HTML ceilings remain covered by the existing regression suites.

## Executed gates

Windows, Node v22.23.2, Chrome 155.0.8059.85. Logs are ignored `.cache/us1507/`.
No skipped gate is represented as passing. Counts overlap and must not be added.

| Command | Actual result |
| --- | --- |
| New matrix tests, `npx.cmd vitest run tests/diagnostic-workbench.test.ts --maxWorkers=2` | 8 passed |
| `npm.cmd run test:all -- --maxWorkers=2` | 1758 passed, 101 files, 41.21 s |
| `npm.cmd run test:integration -- --maxWorkers=2` | 245 passed, 14 files, 6.04 s |
| `npm.cmd run test:security -- --maxWorkers=2` | 73 passed, 7 files, 23.68 s |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run build` | Exit 0 |
| `npm.cmd run security:repo` | Exit 0 |
| `git diff --check` | Exit 0 |
| Fresh CLI synthetic private demo, then validated private/anonymized HTML and JSON exports | Exit 0; four artifacts exist |
| Real Chrome smoke for both file URLs | Exit 0; browser-results.json |
| Real Chrome near-ceiling rendering/filter benchmark | Exit 0; performance.json |

The general suite includes export, CLI, workflow, integration, HTTP privacy/security,
injection, CSP, empty/truncated reports and missing observations. New tests cover all
six cell mappings, rejection vs unknown-cause labels, source/cell inspector focus and
scores, filter intersections/global counts, provider attribution, reused UUIDs across
searches, selection resets, language persistence and empty reports.

First compatibility run: 27 passed / 1 failed because an older card test expected
Identity details inline; it was updated to select the row and assert those same facts
in the inspector. Initial new suite: 7 passed / 1 failed because the test mutated the
UUID used by its own replacement loop; saved the old UUID before replacement. Final
suite above passes. First edit script failed on Python's Windows default decoding
before modifying source; reran with UTF-8. No validation/test policy was weakened.
Coverage, acceptance/system suites, dependency audit, Linux/macOS, hosted CI and real
provider/media campaigns were not rerun for this presentation change.

## Real browser and visual evidence

Used the existing local CDP harness, adapted in ignored `.cache/us1507/browser-smoke.mjs`.
Fresh synthetic private and anonymized exports, Chrome headless with file URLs,
Spanish browser locale and offline page emulation. Both modes passed:

- English initially, Spanish and English switching; static/dynamic labels and ARIA.
- Three independent searches, six provider statuses, five matrix rows, three final
  sources, one KIND_CONFLICT rejection and one unknown-cause disappearance.
- Outcome filters (3 final / 1 rejected / 1 unknown / 5 all), provider filtering,
  observed-state filtering, selection and focused inspector with rejection details.
- Native Enter activation from a focused source button; focus reaches inspector heading.
- 1280×1000 desktop and 390×844 narrow viewport, no document horizontal overflow;
  matrix has intentional internal horizontal scrolling. Inspector stacks below.
- Private-only title/provider identities; no UUIDs in primary rows/selectors.
- Embedded data unchanged by interaction. Zero external page requests, zero runtime
  exceptions and zero console errors during clean product runs.
- Unsigned injected-script negative control blocked by script-src CSP in both modes.

Initial sandboxed Chrome runs died before page verification because GPU subprocesses
could not start. Retried outside execution sandbox with approval and fresh profiles;
no browser sandbox/security flag was disabled. A harness assertion still expected
old card wording; updated it to the new unknown-cause label. A PowerShell encoding
round-trip corrupted two local harness literals; corrected those assertions in UTF-8.
Final browser run passed in both modes. These failed harness/startup attempts are not
product PASS evidence. No additional browser testing dependency was installed.

Artifacts and screenshots are ignored, synthetic and local only. Exact paths are in
`.cache/us1507/artifacts.json`, under
`.cache/us1507/evidence-d113de46-bb62-4e4b-a00d-b4f4779cd766/`:

- `report-private.html`, `report-anonymized.html` and corresponding validated JSONs.
- `private-desktop.png`, `anonymous-desktop.png` (complete desktop pages).
- `private-mobile.png`, `anonymous-mobile.png` (matrix/inspector narrow viewport).
- Additional Spanish screenshots retained from interaction smoke.

Private desktop/mobile and anonymized desktop screenshots were inspected visually.
They show a compact graphite trace table, green observed stages, red explicit kind
conflict, amber continuity gap, visible selection and contextual inspector. Mobile
preserves the table with local scrolling; there is no claim of a full mobile device
or screen-reader certification.

## Performance

Generated a real bounded recorder DTO with 7482 events / six searches, 256 candidate
rows in the selected search; 2,092,377 JSON bytes (near 2,097,152 ceiling), 2,151,763 HTML
bytes (below 4 MiB). Capture is truncated by the existing shared byte budget. Ranking-
only events intentionally exercise unavailable/incomplete stage evidence, not invented
final membership. No quota was raised. Immutable per-candidate evidence is cached.

Single local Chrome run: export validation/serialization/write 143.3 ms; file navigation
through readiness of 256 rows 395.7 ms (includes CDP/polling). Twelve alternating final/
all filter updates, including forced layout: 15.8–85.0 ms. Samples in performance.json.
Zero external requests/runtime exceptions. This is a local synthetic observation,
not a hardware-independent performance guarantee or leak/heap assessment.

## Remaining limits and final Git state

No added observability: provider-internal discovery, comparator group, pre-quota
ranking, addon/client receipt, playback and missing-cause attribution remain unavailable.
Unknown filter means recorded candidate continuity gaps, not every absent stage cell.
The inspector may retain a selected source while filters hide its row; choosing another
source or search updates it. Large technical event tables remain available under details.
Mobile requires horizontal matrix navigation. No screen-reader/browser-matrix testing.
No UUID rotation or changed anonymization semantics. Publication remains NOT READY;
US-1504 playback work stays deferred.

Final branch/HEAD/remotes unchanged. Index remains empty. Existing ten tracked modified
paths and prior untracked v1.5 implementation remain uncommitted; the new UI/QA files
are also untracked as part of that existing implementation directory. No Git mutation
or publication command was run. Release preparation stays paused for owner review.


## 2026-10-26 — Title, causality and matrix corrections (US-1507)

This record supersedes the earlier presentation-only scope and its unresolved
causal attribution limits. Work stayed exclusively in the independent nested
repository `.worktrees/us-1501-diagnostics`, branch `work/us-1501-diagnostics`.
Before edits: HEAD `69c67946a26cf52ab86782ec0080d5c1b2cea5b1`, clean working tree.
No repository, branch or remote was changed. No commit, push, PR, merge, tag or
publication was performed. No real media, configuration, provider corpus or report
was used. No external release-guardrails file was required or searched for.

### Verified causes and changes

1. `createStreamMediaItem()` deliberately leaves `title` empty for an episode
   without catalog metadata. The existing addon enrichment populates `seriesTitle`
   using its existing series metadata lookup, leaving `title` untouched. The
   diagnostic adapter read only `title`. It now captures optional private
   `seriesTitle` with the existing strict label validation and shared byte budget.
   This field is necessary to distinguish a reliable series label from the generic
   historical requested title without redefining old contexts. Fresh episode views
   display series name or its absence, season/episode and episode title unavailable;
   they do not assert a generic catalog name to be an episode title. Historical
   contexts keep their original rendering. Anonymized exports discard the entire
   private namespace. No addon changes or extra metadata queries were needed.
2. The recorder previously received Identity-specific rejections, but had no
   callback for many actual normalization/URL, duplicate, probe admission and quota
   discards. Adapter snapshots therefore produced unattributed continuity gaps.
   New passive `exclusion` hooks execute at existing discard branches. Admission
   reasons are emitted by the actual boolean predicate branches; there is no
   post-hoc inference from status or count differences. Closed `EXCLUSION` DTOs
   contain only random occurrence ID, stage and reason. Technical report V3 is
   selected monotonically when an exclusion is captured. V1/V2 reject V3 events,
   remain readable, and gain no inferred historical causes. Existing Identity
   `REJECTION` events and frozen qualification logic are unchanged. Generic
   `IDENTITY_REJECTION` reports an existing filter decision without assigning a
   new contradiction classification.
3. `evidence().reached` previously included every `PRE_PROBE`, including REJECT,
   and REJECTION as positive stage evidence. Positive stages now require individual
   OBSERVATION evidence (SOURCE for intake). PRE_PROBE CONTINUE does not prove
   normalization; URL policy still follows it. PRE_PROBE REJECT marks NORMALIZED
   rejection, even if its specific reason is unknown. An explicit exclusion marks
   its actual decision stage without adding that stage to the survived-stage list.
   Snapshots and rankings never fill individual missing cells. Truncation remains
   uncertain. The inspector shows survived stages separately from the last stage
   with evidence, observed probe status and causal decision. For unknown losses it
   also shows the last actual observation. Summary causes are grouped by search,
   reason and stage, while per-source details remain accessible.

The observed historical 39→38→38→16 case was not replayed or retroactively
reclassified. Eleven unreachable plus eleven budget observations do not establish
its historical causes. Fresh fixtures verify that a 404 can cause deterministic
admission rejection, an unreachable .mp4 can survive, an actual shared deadline
can cause PROBE_BUDGET_EXHAUSTED rejection, and a scheduler-cap candidate with no
probe observation is rejected as PROBE_MISSING. A stand-alone budget_exhausted or
unreachable observation without a decision stays INSUFFICIENT_EVIDENCE.

### Modified files

- `src/streams/resolver.ts`: optional exclusion contract and passive hooks at existing
  discard decisions; same predicates, comparison operators, order and returned sources.
- `src/diagnostics/events.ts`: closed stage/reason validator and EXCLUSION DTO.
- `src/diagnostics/controller.ts`: monotonic technical V3 selection.
- `src/diagnostics/report-model.ts`: strict V1/V2/V3 event compatibility validation.
- `src/diagnostics/resolver-observer.ts`: sanitized exclusion projection, suppression
  of unknown gaps only for observed decisions, opt-in series label.
- `src/diagnostics/private-context.ts`: strictly optional episode-only series label.
- `src/diagnostics/html-report.ts`: actual stage evidence, exclusion rendering,
  grouped summary, last available observation and explicit episode/series labels.
- `src/diagnostics/i18n.ts`: typed English/Spanish causal and title labels.
- `tests/diagnostic-corrections.test.ts` (new): synthetic regressions for these defects.
- `tests/diagnostic-context.test.ts`: dedupe expectation now checks actual exclusion.
- `tests/integration/diagnostic-resolver.test.ts`: actual duplicate/quota causes and
  exclusion-callback failure isolation, preserving ON/OFF parity assertions.
- `docs/diagnostics.md` and this QA record: updated contract, behavior and evidence.

Addon, Identity qualification/scoring, probe implementation, networking, provider
requests, playback, auth, HTTP routes, URL policy implementation, CSP construction,
dependencies and quotas were not modified. With capture OFF, no new observer map,
reference object, callback closure or reason-event object is allocated; exclusion
helper allocation and admission callbacks are conditional on active trace hooks.
Existing OFF reference-allocation and observer-failure tests still apply.

### Executed verification

Logs are ignored local synthetic artifacts in `.cache/us1507-corrections/`.
Node v22.23.2, Vitest v4.1.12, Windows. Counts overlap and are not additive.

| Command | Actual result |
| --- | --- |
| `npx.cmd vitest run tests/diagnostic-corrections.test.ts tests/diagnostic-context.test.ts tests/diagnostic-workbench.test.ts tests/integration/diagnostic-resolver.test.ts --maxWorkers=2` | 54 passed, 4 files; 11 new correction cases |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run lint` | Exit 0 after fixture corrections |
| `npm.cmd run build` | Exit 0 |
| `npm.cmd test -- --maxWorkers=2` | 1576 passed, 89 files, 40.73 s |
| `npm.cmd run test:acceptance -- --maxWorkers=2` | 43 passed, 1 file, 8.53 s |
| `npm.cmd run test:security -- --maxWorkers=2` | 73 passed, 7 files, 29.63 s |
| `npm.cmd run test:integration -- --maxWorkers=2` | 250 passed, 15 files, 12.87 s |
| `npm.cmd run test:system -- --maxWorkers=2` | 18 passed, 1 file, 15.15 s |
| `npm.cmd run coverage -- --maxWorkers=2` | 1869 passed, 105 files, 54.96 s; full src V8 coverage: statements 88.63%, branches 86.39%, functions 91.88%, lines 93.12% |
| `npm.cmd run security:repo` | Exit 0 |
| `git diff --check` | Exit 0; only Git's existing LF→CRLF notices |

After the final summary consistency adjustment (a candidate with a FINAL observation
is not grouped as an unknown disappearance), focused tests, typecheck, lint, build,
Node and full coverage were rerun. The last fixture-only lint correction removed a
redundant TypeScript assertion; the final focused/typecheck checks include it.

New tests cover reliable/missing series labels, explicit missing episode title,
unchanged provider item, anonymized privacy, optional context validation, actual
pre-normalization/URL/Identity rejections, local/global duplicate winner replacement,
probe status vs cause, missing probes, actual budget deadline rejection, historical
V1/V2 captures, missing dedupe attribution, truncated captures, matrix/snapshot
counts and inspector consistency, EN/ES and strict V3 schema/privacy. Existing
Workbench/export/security suites cover keyboard/focus, filters, hash CSP, offline
script boundaries and bounded private/anonymized exports. Existing and new resolver
fixtures compare exact ON/OFF output, order, Identity states and outbound requests.

Initial focused runs failed on three old expectations that deduplication/quota
losses must remain unknown after hooks existed. Those were updated to assert the
actual decision. New fixtures initially used incorrect display-label expectations
and assumed the scheduler cap produced budget_exhausted; actual output showed
PROBE_MISSING. Labels were corrected; a separate real-probe fake-clock deadline
fixture demonstrates causal budget exhaustion. Initial lint rejected five synthetic
provider methods with unnecessary async; they now return Promise.resolve. A later
lint run caught an unnecessary type assertion in the added rejection fixture; it
was removed. No rule,
assertion about resolver equivalence, validator, quota or test policy was weakened.
An edit script initially stopped at a non-ASCII match under PowerShell's default
pipe encoding; remaining edits were applied with explicit UTF-8.

### Limits and final state

All evidence in this correction record is automated synthetic Node/process QA.
No new real-browser GUI run, Stremio session, playback, real-provider campaign,
Linux/macOS run, hosted CI or screen-reader certification was performed. Earlier
browser evidence above belongs only to that earlier revision. Aggregate source
counts alone remain insufficient; missing hooks/references, historical reports and
truncated captures can still leave unknown causes. Generic Identity rejection does
not disclose a new specific Identity cause. Provider-internal discovery, comparator
group, pre-quota ranking and post-resolver delivery remain unobserved. New causal
events consume existing event/byte limits and may reach truncation sooner; bounds
were not raised. Strict older readers will reject V3 reports and the new optional
private field; this checkout continues to read historical V1/V2 reports/contexts.

Final branch and HEAD remain `work/us-1501-diagnostics` and
`69c67946a26cf52ab86782ec0080d5c1b2cea5b1`. Twelve tracked files are modified and
one new test file is untracked; index empty. No commit has been made. Resolver
selection, ranking, probes, requests and playback decisions are unchanged; passive
instrumentation reports existing decisions, with synthetic ON/OFF parity verified.


## 2026-10-26 — Final QA and authorized local consolidation

Initial verification: independent nested repository, branch
`work/us-1501-diagnostics`, HEAD `69c67946a26cf52ab86782ec0080d5c1b2cea5b1`.
Exactly the expected twelve tracked modifications and one new synthetic test file
were present, with an empty index. No unrelated changes were found or included.
The complete pending diff and all earlier QA sections were reviewed. Production
changes remain those described above; this final pass changes only this QA record
and the new synthetic test file. It does not modify Identity, scoring, probes,
quotas, networking, playback, providers, dependencies or test selection configuration.

### Test-count reconciliation against the checkpoint

The lifecycle checkpoint's "Full Node suite" entry was **1,815 tests / 103 files**.
Its adjacent coverage result was **1,858 / 104 files**. Package scripts at HEAD and
in the working tree are identical. The apparent fall to 1,576 compared different
commands, not equivalent test selections:

| Selection | Composition and observed count |
| --- | --- |
| Checkpoint `test:all` | Includes integration; excludes acceptance and system: 1,815 / 103 files |
| Earlier correction `npm test` | Excludes integration, acceptance and system: 1,576 / 89 files |
| Integration | 250 / 15 files; excluded from `npm test`, included in `test:all` |
| New corrections file before final QA | 11 tests / 1 file; no old test was removed |

Thus **1,815 − 250 + 11 = 1,576**. This was verified by actually running
`npm.cmd run test:all -- --exclude tests/diagnostic-corrections.test.ts --maxWorkers=2`:
**PASS, exactly 1,815 / 103 files** with current production code and old tests.
This is selection equivalence evidence, not a claim that the historical HEAD was
checked out or rerun. Existing test edits change causal expectations and add failure
injection inside an existing test; they do not delete tests or change their count.

Final QA adds one further reconciliation test, bringing that new file to 12 tests.
Actual final selections are **1,577 + 250 = 1,827** (`npm test` + integration =
`test:all`); **1,827 + 43 = 1,870** for coverage, which also includes acceptance;
**1,870 + 18 = 1,888** distinct tests when system is added. Security's 73 tests are
already inside `npm test`, `test:all` and coverage. Focused tests are also subsets;
they must not be added to those totals. System is deliberately outside V8 coverage.
No test was skipped or removed to reconcile the numbers, and counts alone are not
treated as proof of behavioral coverage.

### Synthetic reconciliation and compatibility evidence

The new complete fixture exercises the unchanged resolver's deduplication/admission,
real observer/recorder and validated V3 reader with a controlled synthetic probe
boundary. It reconciles all six snapshots and unique individual observations with
the matrix: **22 → 22 → 21 → 21 → 13 → 13**. For every transition, the exact set of
missing occurrence IDs equals the set of exclusions at that decision stage. There
are nine explicit exclusions: one duplicate, four causal probe-budget rejections,
three deterministic probe rejections and one direct-media verification requirement
not met. There are zero continuity gaps. The grouped summary has four reasons,
outcome filters show 13 final / 9 rejected / 0 unknown / 22 all, and the inspector
shows the observed state separately from the causal decision in English/Spanish.
OFF and ON return equal results from the same resolver. No private report was read,
imported or persisted; the fixture does not reproduce private source objects,
provider identities, titles or an actual report's event count.

The final fixture also computes the embedded CSS and JS SHA-256 hashes and verifies
both are pinned by the HTML CSP, with connect-src none and no unsafe-inline,
unsafe-eval or external script. The earlier mistyped '?' in a negative survived-stage
assertion was corrected to the actual arrow character, strengthening that assertion.
Existing/new regressions cover V1/V2 historical readers, V3-only event rejection in
older envelopes, strict stage/reason/extra-field validation, optional private series
context, title absence, anonymization, unknown causal evidence, truncation, filters,
keyboard/focus, translations and resolver OFF/ON request/result parity. This is
Node/DOM-harness evidence, not a new manual-browser or playback certification.

### Gates actually executed in this final pass

Windows, Node v22.23.2, Vitest v4.1.12. Logs remain ignored in
`.cache/us1507-final/`; no generated artifact is staged. Counts overlap as explained
above. No production policy, test policy, validator, quota or security check was
weakened to pass a gate.

| Gate / command | Status | Actual evidence |
| --- | --- | --- |
| Focused corrections/context/workbench/export/recorder/resolver: `npx.cmd vitest run tests/diagnostic-corrections.test.ts tests/diagnostic-context.test.ts tests/diagnostic-workbench.test.ts tests/diagnostic-export.test.ts tests/diagnostics.test.ts tests/integration/diagnostic-resolver.test.ts --maxWorkers=2` | PASS | 89 tests / 6 files |
| `npm.cmd test -- --maxWorkers=2` | PASS | 1,577 / 89 files |
| `npm.cmd run test:all -- --maxWorkers=2` | PASS | 1,827 / 104 files |
| Checkpoint-equivalent selection excluding new corrections file | PASS | 1,815 / 103 files |
| `npm.cmd run test:integration -- --maxWorkers=2` | PASS | 250 / 15 files |
| `npm.cmd run test:acceptance -- --maxWorkers=2` | PASS | 43 / 1 file |
| `npm.cmd run test:security -- --maxWorkers=2` | PASS | 73 / 7 files |
| `npm.cmd run test:system -- --maxWorkers=2` | PASS | 18 / 1 file |
| `npm.cmd run typecheck` | PASS | Exit 0 after correcting new fixture narrowing |
| `npm.cmd run lint` | PASS | Exit 0 after correcting new fixture narrowing |
| `npm.cmd run build` | PASS | Exit 0 |
| `npm.cmd run coverage -- --maxWorkers=2` | PASS | 1,870 / 105 files; statements 88.60%, branches 86.39%, functions 91.88%, lines 93.10% |
| Staged-only repository safety: `npx.cmd tsx scripts/check-repository-safety.ts` | PASS | Index blobs only; no --all workspace/private-input scan |
| `git diff --check` and `git diff --cached --check` | PASS | Exit 0 |
| Manual GUI / browser / physical terminal signals | SKIP | No new manual run in this pass |
| Real Stremio / playback / Tribler / live providers | SKIP | Synthetic fixtures only |
| Python / dependency audit / hosted CI / other operating systems | SKIP | Unchanged and outside this local diagnostics consolidation |

The first typecheck/lint runs failed only in the newly added test: TypeScript did
not narrow RecordedEvent through compound filter/map predicates before candidateId
access. Explicitly discriminated flatMap branches fixed the test typing without
casts or weaker checks. The focused run, typecheck, lint, uninstrumented test:all
and full coverage then passed with those corrections and the added CSP assertions.
No blocking FAIL remains. Earlier failed attempts remain described here rather
than being represented as passing executions.

Coverage is the actual full-src V8 result, not an estimate from test counts or a
claim of exhaustive branch coverage. It varies slightly from the earlier 93.12%
line result; production code is unchanged in this final pass. Embedded JS in a
string is exercised by DOM-harness assertions, not comprehensively measured by the
Node TypeScript coverage percentage. Real-browser execution remains a stated gap.
The controlled aggregate probe fixture is complemented by existing actual probe
fixtures for deterministic failures, deadlines, missing observations and unchanged
ON/OFF outbound requests.

### Staged content audit and commit boundary

Only the thirteen paths listed in the earlier modified-file inventory are staged:
eight production TS files, three synthetic TS test files and two Markdown docs.
No configuration, report/export, corpus, provider payload, generated dist/coverage,
log, database, image, private input, environment file or dependency artifact is part
of the commit. Staged file modes are ordinary blobs. Full diff review plus the
repository scanner checked the staged blobs for secrets, non-placeholder credentials,
personal home paths and prohibited artifacts. Test locator strings are reserved
.example/loopback synthetic fixtures and negative validator inputs, not real source
URLs or private routes. Generic private-canary labels are invented test sentinels;
no registered real provider identities, media names or runtime report contents were
copied. The full workspace/private directories were not audited or imported.
No external ChatGPT-only document was required.

The authorized commit subject is
`fix(diagnostics): improve trace causality and episode context`.
Its parent is `69c67946a26cf52ab86782ec0080d5c1b2cea5b1`; the resulting commit ID is
reported from Git after creation rather than embedded self-referentially here.
The index audit and whitespace check are repeated after this record is staged,
before that single local commit. No amend, reset, rebase, push, PR, merge, tag or
publication is part of this operation. US-1507 is consolidated locally; v1.5 is not
declared released. Historical unknown causes and truncated evidence remain unknown,
strict older readers require the newer V3/private-field reader, existing diagnostic
limits can truncate earlier with more events, and post-resolver delivery remains
unobserved. Resolver decisions and effective source selection are unchanged.
