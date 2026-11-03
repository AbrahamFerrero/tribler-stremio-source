# US-1505 — v1.5 P0 final working-tree QA

Historical checkpoint. The [2026-11-03 closure QA](v1.5-technical-closure.md)
supersedes current readiness, candidate inventory and gate results; the evidence
below retains its original revision/platform scope and is not a fresh v7 PASS.

Date: 2026-10-25. **Local Windows P0 QA passed within the evidence below;
publication readiness: NOT READY.** These results concern an uncommitted working
tree, not an implementation commit, release artifact or hosted CI run.

## Scope and provenance

Branch `work/us-1501-diagnostics`, HEAD/public base
`18267ac0975f50e201c812db02d1c43cbb2d51ce`, independent checkout
`.worktrees/us-1501-diagnostics`. The only remote is
`https://github.com/AbrahamFerrero/tribler-stremio-source.git`.
Read-only `git ls-remote origin refs/heads/main refs/tags/v1.4.0 'refs/tags/v1.4.0^{}'`
verified main and the peeled annotated release tag against that base. There are
three public commits and no imported private ancestry. Branches, remote refs and
reflogs remain unchanged. Nothing is staged or committed; no push, PR, merge, tag,
publication, cleanup, stash or reset was performed.

US-1501/1502/1503 implement P0: bounded OFF-by-default capture, existing resolver
observations, final ranking, administrative CLI and offline JSON/HTML export.
**US-1504 is deferred by the scope decision for US-1505, not a P0 prerequisite.**
Its [phase-0 NO-GO](us-1504-playback-feasibility.md) is preserved; no alternative
handoff/channel was implemented. Every playback correlation remains UNOBSERVED.
This supersedes the dependency assumption in the historical US-1504 readiness
paragraph, without altering that assessment or claiming correlation was delivered.

The production source files were not changed during US-1505. A new synthetic
`tests/integration/diagnostic-e2e.test.ts` connects the native administrative CLI,
real application resolver, final report validation and both export formats. It
checks ON/OFF listing shape without comparing random token values, no outbound
transport calls, private canaries in outputs/log calls, default English/Spanish
summaries, English-first HTML and a fresh application's OFF/404 state. Current
README/security/diagnostic/future-work guidance and v1.5 QA/readiness documents
were updated. Earlier QA/release records remain historical and unedited.

The final source inventory has **365 non-ignored files**, with **9 tracked
modifications and 29 new files** versus the public base. Pre-QA SHA-256 comparison
covered 361 existing files: only README, SECURITY, FUTURE_WORK and
docs/diagnostics changed during US-1505; the other 357 files, including every
production source, lockfile and US-1501/1502/1503/1504 QA record, remain unchanged.
The original private checkout was rechecked at closure and still has the same
private branch/HEAD, four tracked modifications and three untracked directories.

## Functional evidence

| P0 property | Executed evidence |
| --- | --- |
| OFF/restart, start/status/stop/report | Controller tests, protected HTTP tests, native CLI tests and new application E2E |
| Expiry, retention, stale handles | Injected-clock tests include exact deadlines, delayed timer delivery, repeated reads, stop/restart and 404/409/410 |
| Reservation/concurrency/overflow | Tests enforce N=10, four active captures, 256 candidates, 2048 resolution / 8192 session events and independent 2 MiB byte admission; production continues |
| Actual resolver capture | Real resolve/provider/probe fixtures; interleaved observations; adapter/factory/recorder faults; cancelled/in-flight calls |
| Decisions and gaps | Observed Identity and rejection enums; missing causes remain INSUFFICIENT_EVIDENCE or UNOBSERVED; no new Identity evaluation campaign |
| Final ranking | Existing post-quota positions, total and six components, validated finite bounds; missing comparator group/pre-quota evidence remains UNOBSERVED |
| ON/OFF equivalence | Source contents/order, existing decisions, production provider/probe call counts and public capability shapes; no literal random-token comparison |
| CLI and export | Real loopback HTTP, stable English commands/codes/schema, en/es messages, unknown-language rejection, explicit retention/output, no overwrite or automatic export |
| Complete/truncated/expired reports | Existing report/export suites, byte-exhausted real DTO, E2E CLOSED report, API 410 and no retention renewal |
| Privacy/security | Canary, accessor/prototype/extra-field rejection; unsafe destination/path/junction checks; boundary, redirect/size limits; actual CSP browser negative control |
| Existing playback | Full synthetic integration/HLS/validator/Tribler/system fixtures retained; no new playback diagnostic claim |

UNKNOWN is an observed effective Identity state; UNCLASSIFIED means no bridge-owned
classification was available at that observation. UNOBSERVED means unavailable
observation; INSUFFICIENT_EVIDENCE does not establish a cause. CLOSED means the
accepted sequence was closed, not full traceability. HTTP 200/206, redirects,
technical scores and Identity markers cannot certify audiovisual identity/playback.
Provider neutrality and the frozen Identity/PR6/R-020 boundaries remain intact.

## Environment and gates

Windows NT 10.0.26200.0, win32 x64; Node v22.23.2, npm 10.9.8,
Vitest 4.1.12; Python 3.11.9; coverage.py 7.17.0. Installed dependencies were used;
there was no clean `npm ci` attestation or package/lockfile upgrade.

Commands below ran from this checkout. `--maxWorkers=2` limits worker contention;
no production/test timeout or coverage threshold was relaxed.

| Command | Actual result |
| --- | --- |
| `npx.cmd vitest run tests/diagnostics.test.ts tests/integration/diagnostic-resolver.test.ts tests/diagnostic-cli.test.ts tests/diagnostic-export.test.ts tests/security/diagnostic-http.test.ts tests/security/diagnostic-report-http.test.ts --maxWorkers=2` | 71 tests / 6 files passed; 2.18 s |
| `npx.cmd vitest run tests/integration/diagnostic-e2e.test.ts --maxWorkers=2` | Initial fixture-context failure, then 1/1 passed; see failures below |
| `npm.cmd run test:integration -- --maxWorkers=2` | Initial 244 / 13 files passed; repeated after E2E addition: 245 / 14 files passed |
| `npm.cmd run test:security -- --maxWorkers=2` | 69 / 6 files passed; 22.72 s |
| `npm.cmd run test:all -- --maxWorkers=2` | Initial 1706 / 96 files passed; repeated after E2E addition: 1707 / 97 files passed |
| `npm.cmd run coverage -- --maxWorkers=2` | Initial 1749 / 97 files passed; repeated with E2E: 1750 / 98 files passed |
| `npm.cmd run test:acceptance -- --maxWorkers=2` | 43 / 1 file passed; 5.23 s |
| `npm.cmd run test:system -- --maxWorkers=2` | 18 / 1 file passed; 12.87 s; script explicitly disables V8 |
| `npm.cmd run typecheck` | Exit 0 initially and after new E2E test |
| `npm.cmd run lint` | Exit 0 initially; new helper caused one error, corrected and rerun exit 0 |
| `npm.cmd run build` | Exit 0; production source unchanged afterward |
| `npm.cmd run security:repo` | Exit 0 initially and after documentation completion; all publishable files checked |
| `npm.cmd audit --json` | Exit 0; zero declared vulnerabilities |
| `npm.cmd audit --omit=dev --json` | Exit 0; zero declared vulnerabilities |
| `git diff --check` | Exit 0; repeated at closure |

Final Node production coverage: statements 89.36% (5770/6457), branches 86.61%
(5467/6312), functions 92.94% (948/1020), lines 93.53% (4705/5030). The last test-only
lint correction changed error typing in a helper's invalid-JSON rejection path;
lint and the E2E were rerun after it. Runtime code did not change. Full suite and
coverage results above preceded that helper correction; they were not rerun merely
to relabel the same runtime evidence as a new pass.

Full suite counts overlap and must not be summed as independent tests. No failing
Node regression assertion was observed beyond the new E2E fixture described below.
Earlier timing failures retain their undetermined cause; successful capped runs do
not establish that those old intermittencies are fixed.

Python is part of the checked-in release CI contract, so it was executed despite
unchanged Python sources. `python -m coverage --version` initially reported the
module absent. `python -m pip install --target .cache/us1505/python-tools -r
python-adapter-host/requirements-dev.txt` installed coverage locally in ignored QA
storage, without changing global Python or dependency declarations. With that
directory in PYTHONPATH and an explicit ignored COVERAGE_FILE, from
`python-adapter-host`:

```text
python -m coverage run --branch -m unittest discover -s tests -v
python -m coverage report --include=adapter_host/*
```

Tests: exit 0, **233 tests in 117.584 s, one skip** (`symlinks unavailable:
OSError`). The report initially failed; the same collected database subsequently
reported exit 0 with **70% combined statement/branch coverage**, 2495 statements,
660 missed, 852 branches and 127 partial branches. This is measured coverage, not
an invented threshold or full platform coverage. No real provider/service campaign
was run. WSL is present but reports no installed Linux distribution; Linux/macOS
and hosted Node 20/Python 3.11 CI remain NOT EXECUTED locally. No CI was triggered.

## Real browser smoke

**PASS within this headless browser scope**, distinct from the DOM harness.
Chrome 155.0.8059.85 on Windows opened two synthetic exports under `file://`:
one CLOSED and one TRUNCATED report, each with two candidates and ten timeline
events. A fresh disposable profile and `--headless=new --lang=es` were used, with
CDP locale `es-ES` and offline network emulation enabled before navigation.

Both reports initially rendered in English. Switching en→es→en updated document
language/title, every static translated label and accessibility label, filters,
gaps and limitation notices. IDs, scores (including 7.25), technical codes and the
embedded JSON dataset remained unchanged. Final/verified filtering produced the
expected single row. Real Tab events moved phase→state→candidate→candidate button;
Enter activated the button and focused the timeline heading. No product JavaScript
exceptions, console errors, pre-test CSP violations or external requests were
observed. JSON and HTML embedded datasets were deeply equal. Appending an unsigned
inline script as a negative control generated a script-src violation and did not
execute, demonstrating actual CSP enforcement. This expected negative-control
console violation is separate from the clean product run.

This was a real browser engine, but not a visual design review, screen-reader audit,
OS-wide disconnected-network test or certification across browser versions. Only
the page network was emulated offline; browser background features were disabled
where possible. No browser dependency was installed. Repeat the manual procedure in
[diagnostics](../diagnostics.md#reproducible-manual-browser-smoke); local execution
scripts/results are ignored QA artifacts, not distributable reports.

## Performance experiment

Command: `node --expose-gc --import tsx .cache/us1505/performance.mjs`.
The local QA script reconstructed public HEAD source/configuration into ignored
storage using `git show`, without changing refs. It compared that actual base
resolver to the current resolver OFF and ON using the same deterministic registry,
32 distinct synthetic HTTPS candidates and media item. No probe/outbound transport
was instantiated; the URL policy used an injected deterministic address callback.
Every result was deeply equal, with one provider call and 32 policy callbacks per
resolution in all modes. Measurements ran after the initial Node/Python suites.

There were 100 warmups per variant, then five rounds of 100 samples per variant
(500 measured each), rotating mode order. Timing covers `resolve()` including
observer finish; explicit capture start/stop/report reads were outside that timed
interval. Forced GC between mode batches and before export samples aids inspection
but differs from normal service execution. After-resolve heap sampling misses
transient allocation peaks. Shared modules/process, JIT warmup, OS scheduling and
the in-memory workload limit causal/general performance conclusions.

| Mode | p50 ms | p95 ms | min–max ms | mean ms |
| --- | ---: | ---: | ---: | ---: |
| Public base | 1.0530 | 1.9959 | 0.9741–2.5177 | 1.2188 |
| Current OFF | 0.9647 | 1.7762 | 0.8890–2.5139 | 1.0955 |
| Current ON | 3.1018 | 5.2887 | 2.7916–6.4687 | 3.3757 |

OFF p50 was 8.39% below base in this run; this is not evidence of an optimization or
universal zero overhead. ON p50 was 194.57% above base, approximately +2.05 ms here.
Batch mean ranges were base 1.1433–1.3707 ms, OFF 1.0416–1.1790 ms and ON
3.2262–3.6186 ms. No performance acceptance threshold was specified or asserted.
No functional change, extra request or reproducible production timeout was observed.

Sampled heap maxima were 31,477,304 bytes (base), 31,639,304 (OFF), and 31,616,664
(ON); whole-process high-water RSS was 137,024 KiB. Post-GC retained batch deltas
ranged 70,280–186,400 bytes OFF and 34,392–190,800 ON (including one retained
sanitized report); this finite experiment cannot establish absence of a leak.

A real byte-budget-exhausted TRUNCATED report held 7482 events, with JSON
2,092,377 bytes and HTML 2,117,829 bytes. Ten fresh export samples measured:

| Operation | p50 ms | p95 ms | min–max ms |
| --- | ---: | ---: | ---: |
| Validate + JSON serialization | 112.2870 | 119.6255 | 110.4394–119.6255 |
| Validate + HTML rendering | 109.2163 | 142.6941 | 107.6295–142.6941 |
| Explicit safe writes of both files | 13.2961 | 33.7568 | 12.4690–33.7568 |

Export generation transient heap deltas were 22,916,384–23,280,416 bytes. The 2 MiB
DTO ceiling is not a 2 MiB process heap bound. Export work stays outside resolve;
browser rendering of a maximum-size report was not benchmarked. A separate
12-resolution overlap observed four active captures, ten reservations and six
concurrency skips; all twelve production resolutions returned 32 sources. An
injected-clock expiry during delayed provider work left the finalized report
unchanged while production still returned all 32 sources.

## Failures, corrections and unexecuted checks

- The new E2E initially received 403 because Node fetch supplied partial Fetch
  Metadata to the discovery boundary. Its fixture now uses native `node:http` with
  the documented Stremio Origin and no implicit Fetch Metadata. The native
  administrative client was already correct. The boundary was not relaxed. This
  is fixture RED/GREEN, not a repaired production bug.
- Final lint found one prefer-promise-reject-errors violation in the new E2E
  invalid-JSON helper. An instanceof guard now guarantees Error rejection; lint and
  the focused E2E passed after correction. No lint rule or assertion was weakened.
- Restricted Edge/Chrome attempts lost the browser debugging connection (exit 13
  / socket close 1006). The authorized installed-Chrome run worked. Its first
  Enter simulation omitted the character event and failed the focus assertion;
  sending the full CDP keyboard sequence passed. No product HTML change was made.
- The first performance setup omitted the base ranking JSON configuration and
  failed before measuring. Copying public `config` alongside `src` fixed the
  fixture. Reported measurements come only from the successful run.
- Python coverage report initially encountered SQLite schema/read-only errors.
  A retry read the data but tried combining a similarly named text log, warning
  SQLITE_NOTADB. Copying the collected database to a dedicated ignored
  `coverage-data/.coverage` directory and pointing COVERAGE_FILE there produced a
  clean exit-0 report, without rerunning or changing tests/data. Initial errors
  remain recorded; no Python coverage pass is inferred merely from test success.
- Two diagnostic `rg` calls initially used unexpanded Windows wildcard paths;
  corrected directory plus `-g` searches succeeded. No product effect.
- No fresh dependency install, Linux/macOS execution, hosted CI, real media/provider
  test, OS security sandbox validation, visual/screen-reader review or maximum-size
  browser interaction benchmark was performed. Old intermittent test causes remain
  undetermined. PR6, R-020, Identity STRICT and the embedded tooling issue stay open.

## Closure and publication boundary

The [publication audit](v1.5-publication-readiness.md) inventories tree/history,
dependencies, fixtures, licenses and remaining review obligations. A passing
repository scanner and zero npm advisories do not replace it. Current tree QA (A)
is distinguished from candidate preparation (B), exact-candidate SHA QA/CI (C), and
publication GO (D). **C and D are not complete.** No candidate commit exists, and
the package version remains the base 1.4.0 pending explicit candidate preparation.
The work is ready for local P0 review; publication is NOT READY. US-1504 is not the
reason: exact-SHA validation, Linux/CI evidence and the scoped dependency-risk /
publication review remain outstanding.
