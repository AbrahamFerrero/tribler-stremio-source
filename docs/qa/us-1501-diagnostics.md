# US-1501 local implementation evidence

Review date: 2026-10-25 (Asia/Tokyo). This is local synthetic evidence, not a release,
publication decision, hosted CI result or real playback certification.

## Git isolation

Read-only inspection confirmed the original checkout on
`work/v1.4-separate-coverage-system`, HEAD
`b1bfc9a2af5a67a879e5351ed76d5d516bb6d576`, remote
`AbrahamFerrero/tribler-stremio`. It had four unstaged modified files (CHANGELOG,
v1.4 QA, v1.4 release notes and Python host environment tests), no staged diff,
and three untracked audit/candidate directories. Branch, HEAD, status, both diffs,
remotes and registered worktrees were inspected. The original status and diff statistics
were checked again after implementation and remained unchanged.

`git ls-remote` verified public `AbrahamFerrero/tribler-stremio-source` main at
`18267ac0975f50e201c812db02d1c43cbb2d51ce`; annotated v1.4.0 tag
`be4b9a22c47f2a9231c5cd864c73878d7a0e0013` peels to that same commit.
A fresh independent `--single-branch --branch main --no-tags` clone was created
inside `.worktrees/us-1501-diagnostics`, then local branch
`work/us-1501-diagnostics` was created. Its common Git directory is its own `.git`,
and its only remote points to the public source repository. No private ancestry was
copied or merged. No cleanup, reset, stash, overwrite, commit, push, PR, merge, tag or
publication was performed. HEAD remains the verified public base; implementation is
an uncommitted local diff, so there is no implementation commit SHA.

## Change and design

Three new modules implement the controller, sanitized recorder and HTTP controls;
`app.ts` mounts the router after the existing localhost policy and before the general
JSON parser. The sole request-policy change adds the diagnostic namespace to the
existing administrative branch. Two synthetic test files cover lifecycle, bounds,
privacy, failure containment and authorization. Current API/security documentation
is updated and [the design](../diagnostics.md) records the future integration contract.
Historical release documents are unchanged. Resolver, Identity, scoring, dedupe,
probes, production quotas, networking, playback, Python/Kodi, configuration, logger,
package metadata and lockfile remain unchanged.

OFF is initial; only one capture can be active. Reservations occur synchronously at
entry, concurrency overflow consumes a reservation without waiting, and completed
captures never refund quota. All requested diagnostic bounds are fixed maxima.
Stop/expiry revoke handles before finalization. Optional reports expire after at most
five minutes and are discarded on a new session. Events contain closed enums and
bounded integers; stored IDs are random, with no private hashes or source references.
Failure of the recorder switches capture OFF; finalization failure retains at most
a fixed truncated envelope. There is no export I/O or production event wiring.

## Commands and results

Platform: Windows NT 10.0.26200.0, win32 x64, PowerShell; Node v22.23.2,
npm 10.9.8, Vitest 4.1.12 from the unchanged lockfile. `npm.cmd` is used because
the local PowerShell policy rejects the npm.ps1 shim; execution policy was not changed.
`npm.cmd ci --ignore-scripts --no-audit --no-fund` installed 333 packages successfully.

| Actual command | Observed result |
| --- | --- |
| `npx.cmd vitest run tests/diagnostics.test.ts tests/security/diagnostic-http.test.ts` | Final: 28 tests / 2 files passed |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run build` | Exit 0 |
| `npm.cmd run security:repo` | Exit 0; all publishable files scanned |
| `npm.cmd run test:security` | Exit 0; 64 tests / 5 files passed |
| `npm.cmd run test:all` | Initial failure: 1658 passed, 2 failed / 92 files |
| `npx.cmd vitest run tests/provider-quality-evaluation.test.ts tests/qa-identity-conflict-review.test.ts --maxWorkers=1` | Exit 0; both failed files passed, 21 tests |
| `npm.cmd run test:all -- --maxWorkers=2` | Final exit 0; 1663 tests / 92 files passed |
| `npm.cmd run coverage -- --maxWorkers=2` | Final exit 0; 1706 tests / 93 files passed |
| `npm.cmd run test:acceptance` | Exit 0; 43 tests / 1 file passed |
| `npm.cmd run test:system` | Exit 0; 18 tests / 1 file passed without V8 |
| `npm.cmd audit --json` | Exit 0; zero declared vulnerabilities |
| `npm.cmd audit --omit=dev --json` | Exit 0; zero declared production vulnerabilities |
| `git diff --check` | Exit 0 |

Final V8 coverage: statements 89.19% (5261/5898), branches 86.12% (5046/5859),
functions 92.72% (867/935), lines 93.21% (4356/4673). System tests were run separately
without V8 as required. The final broad suite took 35.97 s and coverage took 43.45 s.

The first diagnostic execution had 22 passing and 3 failing tests. Those three failures
were test harness errors: passing an empty configured token instead of an absent token,
and applying a string assertion to an absent report in two fault-injection cases.
After fixing the fixtures/assertions all 25 passed. Additional hostile-input cases and
start validation hardening subsequently brought the final focused suite to 28 passing
tests. This was not a pre-implementation RED run; no TDD claim is made.

The initial broad regression failed in two existing, unchanged tests:
`provider-quality-evaluation` exceeded its 5000 ms CLI test timeout, and
`qa-identity-conflict-review` observed one external-provider call instead of two in its
synthetic deadline scenario. Both passed with one worker; the full suite passed with
two workers. Test expectations, deadlines and repository test configuration were not
changed. The cause of the initial failures is undetermined; these reruns do not prove
absence of intermittency. Earlier broad/coverage runs also passed before the last
start-validation hardening; their counts were 1662 and 1705 respectively.

Synthetic canaries cover URLs, titles, query IDs, tokens, magnets, infohashes and paths;
accessors/proxies and arbitrary fields are rejected before retention. App-level malformed
body/query tests check responses and all logger calls, and administrative controls make
no fetch calls. Maximal candidate-event workloads verify resolution/session counts and
serialized report size. Byte admission is conservative; the current closed schema plus
8192-event cap reaches its event ceiling before the 2 MiB ceiling.

## Limits and US-1502 readiness

No Linux/macOS run, hosted CI, separate Python suite/coverage, real provider, Stremio,
Tribler, Kodi or playback smoke was executed. Known Identity STRICT and dependency
limitations retain their existing scope; passing baseline tests or npm audit does not
close those items. No public release gate is declared satisfied.

The minimal core is ready for US-1502 to add a reviewed minimizing adapter and prove
unchanged resolver results/request counts under real event wiring. `beginResolution`,
`DiagnosticCapture` and detached `report()` are the available interfaces. HTTP currently
offers only start/status/stop; no report export exists. CLOSED denotes a closed accepted
event sequence, never full traceability; overflow or interrupted work is TRUNCATED.
