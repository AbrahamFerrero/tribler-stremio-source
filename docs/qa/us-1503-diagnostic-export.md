# US-1503: local CLI, JSON/HTML export and English/Spanish interface

Review date: 2026-10-25 (Asia/Tokyo). This records local Windows synthetic verification.
It is not a publication decision, browser certification, real playback acceptance or
closure of earlier deferred security/Identity issues.

## Preserved checkout and scope

Branch, HEAD, status, tracked/staged diffs and remotes were inspected before editing.
The independent public-source clone remains `.worktrees/us-1501-diagnostics`, branch
`work/us-1501-diagnostics`, HEAD
`18267ac0975f50e201c812db02d1c43cbb2d51ce`, origin
`AbrahamFerrero/tribler-stremio-source`. All US-1501/1502 changes were still uncommitted;
there was no staged diff. No refs, checkout or branch were changed. No commit, push,
PR, merge, tag or publication was performed. There is no implementation commit SHA.

Before editing, local ignored SHA-256 baselines were recorded for thirteen files:
resolver/factory, addon/app, localhost policy, passive adapter, event schema/recorder,
all three existing diagnostic test files and both earlier QA reports. Final comparison
showed all thirteen byte-for-byte unchanged. Controller and diagnostic HTTP modules
were extended only for report access; earlier capture controls remain present. The
private development checkout/history was not used or modified. Package/lockfile
dependencies are unchanged; package.json adds only the diagnostic script.

## Implemented interface

`GET /diagnostics/report` is the sole new HTTP operation. It reuses the unchanged
localhost/Host/context/Bearer boundary, rejects queries/bodies/other methods, and returns
no-store JSON only. Available reports are strictly validated detached DTOs, at most
2 MiB. It distinguishes active capture (409), absent/non-retained report (404), expired
retained report (410) and invalid internal report (fixed 500), with English error codes.
Read operations do not refresh any timer or retention window. An expiry boolean retains
no report data or identifiers and resets on a new capture. Restart returns to absence.
There is no HTML-serving endpoint, HTTP output path or HTTP-controlled export action.

`npm run diagnostic -- ...` uses the existing source-tool convention. It supports
start (`--next`, TTL seconds, optional explicit `--retain`), status, stop, report summary
and explicit JSON/HTML export. It imports no second resolver and sends one administrative
request per operation. Only environment BRIDGE_ADMIN_TOKEN is accepted. Strict raw URL
validation admits the current IPv4 Host profile; the native HTTP client pins even
localhost to 127.0.0.1 without DNS/proxies or redirects. Responses have a five-second
absolute deadline and 2 MiB limit before JSON parsing. Errors/output do not echo
supplied paths, URLs, secrets, raw response bodies or exceptions.

CLI, JSON and HTML use the existing v1 DTO. The export validator rebuilds closed flat
events, validates UUID-shaped ephemeral IDs, counts, bounds, finite numbers and exact
fields, and rejects prototypes/accessors/extra metadata. It does not derive Identity,
probe results, disappearance causes, comparator group or pre-quota ranking. JSON data
fields, schema/version, enum values and technical codes remain unchanged.

Output is explicit and never overwrites existing files. An existing local parent is
checked for symbolic links/junctions, a random exclusive same-directory file is written,
flushed and closed, the parent identity is rechecked, and a no-clobber hard link publishes
the file. Only this writer's successfully created temporary file is cleaned up. UNC,
device, drive-relative, ADS/reserved names and known symlinks are refused. JSON limit is
2 MiB; HTML limit is 4 MiB. No stop/expiry persistence or directory creation is introduced.
User-owned exports remain until manually removed; server retention is not renewed.

HTML is one local document with embedded minimized data, static CSS and a small static
script. It includes session/closure state, limits, the six stage counts, candidate table,
observed Identity/probe states, final positions, captured score and six components,
phase/state/candidate filters, candidate timeline, and visible gaps/limitations. Missing
values are UNOBSERVED; CLOSED is never presented as complete traceability. HTTP 200/206,
Identity markers or a high score are explicitly not playback/audiovisual identity guarantees.

## English-first bilingual contract

- CLI text defaults to English, with explicit `--lang en|es`; unknown languages fail
  validation. Commands, flags, JSON fields, enum values, error codes and data stay in English.
- HTML always starts with lang=en and the English selector value, even when exported
  with Spanish CLI text or opened in a Spanish locale. It never consults browser/OS locale.
- The English / Español selector changes labels, headings, filter options, descriptions,
  gaps/limitations, title, html.lang and accessibility labels entirely offline. It leaves
  identifiers, numbers, data and bracketed technical codes unchanged.
- Small typed dictionaries require both language entries and every technical string code.
  Runtime checks reject missing, empty and extra translations. No i18n/frontend dependency
  was added. Localization is confined to diagnostics.

Embedded JSON escapes delimiters and script-sensitive characters; the renderer uses
textContent/element APIs, never dynamic innerHTML or eval. A hash-based CSP with default,
connection, image/object, base and form restrictions accompanies the file. There are
no external scripts/styles/images, playback links, network APIs or persistent UI state.
Tables and language/filter interaction require local JavaScript; a no-script notice is
included. The model is static; there is no live dashboard or SPA framework.

## Commands and real results

Platform: Windows NT 10.0.26200.0, win32 x64, PowerShell; Node v22.23.2, npm 10.9.8,
Vitest 4.1.12. `npm.cmd` avoids the local npm.ps1 policy restriction. No dependency install,
deadline change, expectation weakening, browser install or test configuration change was made.

| Actual command | Observed result |
| --- | --- |
| `npx.cmd vitest run tests/diagnostic-cli.test.ts tests/diagnostic-export.test.ts tests/security/diagnostic-report-http.test.ts --maxWorkers=2` | Final exit 0: 27 tests / 3 files |
| Selective regression command below | Exit 0: 180 tests / 10 files, before the added maximum-DTO case |
| `npm.cmd run test:all -- --maxWorkers=2` | Final exit 0: 1706 tests / 96 files; 36.94 s |
| `npm.cmd run coverage -- --maxWorkers=2` | Exit 0: 1749 tests / 97 files; 41.99 s |
| `npm.cmd run test:acceptance` | Exit 0: 43 tests / 1 file; 6.23 s |
| `npm.cmd run test:system` | Exit 0: 18 tests / 1 file, without V8; 13.82 s |
| `npm.cmd run test:security` | Exit 0: 69 tests / 6 files |
| `npm.cmd run typecheck` | Final exit 0 |
| `npm.cmd run lint` | Final exit 0 |
| `npm.cmd run build` | Exit 0 |
| `npm.cmd run security:repo` | Exit 0; all publishable files scanned |
| `npm.cmd audit --json` | Exit 0: zero declared vulnerabilities |
| `npm.cmd audit --omit=dev --json` | Exit 0: zero declared production vulnerabilities |
| `git diff --check` | Exit 0 |

Final V8 coverage: statements 89.36% (5770/6457), branches 86.61% (5467/6312), functions
92.94% (948/1020), lines 93.53% (4705/5030). The embedded browser program is a static
string; execution in the DOM harness is not independent browser-code coverage measurement.
System tests remain separately uninstrumented as required.

Selective regression command:

```powershell
npx.cmd vitest run tests/diagnostic-cli.test.ts tests/diagnostic-export.test.ts tests/security/diagnostic-report-http.test.ts tests/diagnostics.test.ts tests/security/diagnostic-http.test.ts tests/integration/diagnostic-resolver.test.ts tests/stream-resolver.test.ts tests/stream-identity-ranking.test.ts tests/integration/public-identity-order.test.ts tests/security/localhost-boundary.test.ts --maxWorkers=2
```

New tests exercised the real protected local HTTP client and all CLI operations, no
redirect following, canonical destination validation, missing/invalid token, safe errors,
both help subprocesses, explicit retention, no fetch/provider/probe activity, and no
files after invalid responses/failed outputs. Export tests cover Windows paths with spaces,
concurrent no-clobber writes, junction ancestors/targets, reserved/ADS names, unchanged
existing files and temporary cleanup. An actual byte-budget-exhausted controller report
is exported within both format ceilings. API reads verify active/absent/expired states,
detached data, no CORS, exact no-store responses, repeated-read equality and expiry at
the original injected-clock deadline without extension.

HTML tests compare its embedded dataset with JSON, reject private canaries, prototypes,
accessors and HTML/JS injection, verify delimiter escaping and CSP hashes, and execute
the actual embedded script in a small DOM contract harness. The harness begins with a
Spanish document/browser locale, verifies forced English defaults, switches to Spanish
and back, checks every static translated label/accessibility attribute, filters by phase,
Identity/probe state and candidate, and exercises candidate timeline buttons. Data,
IDs, scores, JSON shape and technical codes remain unchanged. Missing/empty/extra
dictionary entries are tested explicitly.

## Initial failures and repetitions

The first new focused run passed 26/26 tests; no pre-implementation RED claim is made.
An initial lint run found two unused discarded-field bindings and an unnecessary assertion
in the report validator. A later lint run found three test-only issues (require-await,
unsafe Array.fill spread, and unsafe event-result destructuring). All were corrected
without weakening rules. A strengthened compile-time translation completeness check
then failed because the GAP label was missing; adding its English/Spanish translations
made typecheck green. This is real compiler RED/GREEN evidence for translation coverage.

The focused suite remained green, then grew to 27/27 with the maximum-DTO export case.
The first broad run passed 1705 tests / 96 files in 37.10 s; the final run includes the
additional case and passes 1706. Coverage, security, acceptance, system and audits also
passed. No failed test assertions or broad regression failures were observed in US-1503.
Ignored `.cache/us1503-*` contains local gate logs, audit JSON and integrity baselines;
none is repository content. Earlier intermittent failures retain their documented
undetermined cause; passing two-worker runs do not establish their resolution.

## Limits and unexecuted verification

No browser layout, actual file-URL CSP enforcement, assistive-technology or keyboard
browser smoke was executed. The DOM harness tests logic rather than a browser engine.
The [diagnostic guide](../diagnostics.md#reproducible-manual-browser-smoke-not-executed-in-automated-qa)
contains a reproducible offline smoke procedure. No large browser dependency was added.
No Linux/macOS run, hosted CI, separate Python suite/coverage, real provider, real
Stremio/Tribler/Kodi playback or performance benchmark was executed. Linux paths/client
code are portable by design, not a claim of observed Linux execution.

File output requires same-filesystem hard-link support. Parent checks refuse known
links but do not contain a hostile same-user directory replacement race. Windows ACLs
remain inherited; temporary cleanup is best effort if the filesystem denies unlink.
These are explicit limits, not a hostile-local-process/OS sandbox claim.

US-1503 provides the local interface and export boundary for later work. There is no
playback correlation, new resolver capture data, provider instrumentation, Python/Kodi
internal capture, telemetry, automatic persistence or remote access. Comparator group
remains UNOBSERVED and ranking remains post-quota. PR6, R-020, Identity STRICT and
embedded dependency limitations retain their prior scope. No new release/risk acceptance
is asserted by this local implementation.
