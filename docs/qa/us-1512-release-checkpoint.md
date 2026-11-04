# US-1512: v1.5.1 release preparation checkpoint

Date: 2026-11-04 (Asia/Tokyo). **Publication recommendation: NO-GO.**
US-1511 implementation is retained; US-1512 is not closed and v1.5.1 is not
published. No commit, staging, push, PR, merge, tag, release or visibility change
was performed during preparation. No private smoke evidence was consulted.

## Candidate and public ancestry

The existing worktree branch is `work/us-1511-direct-media-signatures`; HEAD and
the verified public main/v1.5.0 tag point to
`ff1d4b151e0b0e8eb48cfa5b777c1fbfdf32c3d8`. All candidate changes are uncommitted.
The original 18 modified and 3 untracked files were preserved. No deletions or
functional release fixes were introduced during this review.

Proposed strategy after authorization: one reviewed neutral source commit whose
sole parent is that public base, followed by explicitly named public refs only.
Never merge private development history or publish all refs. Local capture refs,
ignored evidence, caches, dependencies and runtime/profile/configuration data are
excluded. The five existing public ancestor commits were enumerated separately
from other local refs. The proposed tree and complete path/mode/blob/SHA-256
manifest and patch are identified in the local checkpoint evidence; no final
candidate commit SHA exists. Recompute identity after any change.

Public main, the existing release-candidate branch and v1.5.0 tag matched the base
at inspection. Public v1.3.0/v1.4.0/v1.5.0 source releases exist without uploaded
assets; no v1.5.1 tag/release exists. The latest inspected v1.5.0 CI run completed
with Linux `validate` failing at full npm audit and both Windows jobs succeeding.
Those are historical base results, not v1.5.1 results.

## Functional and documentation inventory

US-1511 changes the pure bounded recognizer, probe-owned enum/admission condition,
minimized diagnostic event/observer/readers/HTML/labels and corresponding synthetic
tests. See the [original file/AC inventory](us-1511-direct-media-signatures.md)
and [v8 contract](../diagnostics.md). The signature uses the existing at-most-64-byte
prefix and gains admission only under coherent verified initial 206, octet-stream,
identity encoding and existing security/Identity/HLS precedence. No additional
requests or larger budgets, networking/SSRF/DNS/redirect/TLS/credential changes,
ranking, deduplication, quota, HLS or provider-specific changes were found in the
reviewed production diff. Historical diagnostic readers remain supported.

The additional Python change is separately reviewed: `start-local.ps1` reacquires
the child environment collection after duplicate-case initialization failure,
clears/verifies it, snapshots permitted process variables and fails on conflicting
allowed values. Parent environment remains untouched; local adapter settings keep
their documented precedence. Two raw Windows-block tests supplement existing
launcher tests. The Python README explains the boundary. No Python resolver or
worker functionality was changed.

Release preparation changes root package/lock metadata to 1.5.1, README,
CHANGELOG, current documentation/status links and candidate-specific release/risk
notes. Python's independent package remains 0.1.0 and the Stremio protocol-facing
manifest version remains unchanged. Every dependency resolution remains unchanged.
No replacement research for minimatch, magicast or source-map-js was performed.

## Privacy, history and redistribution audit

The proposed public ancestry contains five commits, 579 reachable objects and
490 unique blobs. Automated high-confidence credential, personal-home-path and
signed-URL checks found no matches in those blobs/commit messages or the inspected
candidate. Historical path checks found no real environment/settings, inspection,
archive, database, private-key or log artifacts. A separate URL inventory covered
119 domains/host forms: synthetic/adversarial fixtures, local/IP-policy examples,
public documentation, package registries/funding and existing public service/media
references. The production diff, new fixtures and documentation were reviewed;
all new media bytes, request data and canaries are synthetic. No private reports,
search/playback results, provider configuration or session statistics were added.
These bounded scans complement review and do not prove universal secret absence.

The owner supplied the binding external section E, revision 2026-10-20, during
review. It permits generic reproducible, provider-neutral code/docs/QA using
synthetic, freely licensed or expressly authorized media with attribution. The
earlier literal-locator blocker is withdrawn under that clarification: existing
public example references are classified using their documented provenance in
[third-party media](../third-party-media.md), not as private session evidence.
Historical magnet references occur in 54 blob versions, not 54 independent
secrets. This does not establish current remote bytes, availability, encode rights
or playback, and does not permit private provider/session locators or identifiers.
No media was fetched and no history rewrite is proposed.

The generic Stremio/Kodi evaluation tools require an explicit `--input` or
`--corpus` argument; identity live smoke requires an external corpus. Reviewed
defaults/fixtures do not bundle or require a private corpus. This checks the
section-E tools boundary without running those provider-facing tools.

LICENSE (PolyForm Noncommercial 1.0.0), NOTICE and existing media attribution are
unchanged. The lock/install license inventory has no undeclared license fields;
it is not an independent legal certification of every upstream package. No new
external assets or third-party dependencies are introduced or redistributed.

## Fresh local QA

Platform: Windows, Node 22.23.2, npm 10.9.8, Python 3.11.9, coverage.py 7.17.1.
All results below are this session's synthetic executions on 2026-11-04 JST;
the original US-1511 results are historical and were not substituted. The final
functional/build/test/config payload was tested after clean lockfile installation.
Later checkpoint prose only records outcomes; final safety/diff/identity checks
cover the completed documentation. Exact path/blob identity and local raw logs are
retained in ignored `.cache/us1512-evidence/`, excluded from distribution.

| Command/check | Result | Evidence / limitation |
| --- | --- | --- |
| `npm ci --ignore-scripts --no-fund` | PASS | 333 packages; no install scripts; installed versions match exact lock |
| `npm test` | PASS | 1,838 tests / 98 files |
| `npm run test:integration` | PASS | 255 tests / 15 files |
| `npm run test:acceptance` | PASS | 43 tests / 1 file |
| `npm run test:system` | PASS | 18 tests / 1 file, without coverage instrumentation |
| `npm run test:security` | PASS | 73 tests / 7 files |
| `npm run typecheck` | PASS | Exit 0 |
| `npm run lint` | PASS | Exit 0 |
| `npm run build` | PASS | Exit 0 |
| `npm run security:repo` | PASS | All publishable working-tree paths, including completed checkpoint documentation |
| `npm run coverage` | PASS | 2,136 tests / 114 files; statements 89.13%, branches 87.35%, functions 92.26%, lines 93.37% |
| `npm audit` | FAIL | Exit 1; 11 moderate development entries, minimatch advisory |
| `npm audit --omit=dev` | PASS | Exit 0; zero findings; not an embedded-bundle audit |
| Python branch coverage/unittest | PASS / SKIPPED | Authorized rerun: 235 tests, one symlink test skipped; exit 0; branch-instrumented total coverage 70% |
| Windows launcher `test_host_environment.py` | PASS | 14 tests outside sandbox, including both new raw environment-block cases |
| Hosted Windows/Linux CI on v1.5.1 | NOT RUN | No candidate commit/push/PR authorization; existing workflow is not execution evidence |
| Linux/Node 20/Python 3.11 hosted matrix | NOT RUN | Local Windows Node 22 execution does not substitute |
| Final-candidate real playback smoke | NOT RUN | Exploratory SMOKE-1512 is closed; no new provider activity authorized |
| Supplied section-E publication review | PASS | Applied owner-supplied revision 2026-10-20 to audited paths/history, generic fixtures/tools, license/NOTICE and source-only strategy; final approval remains separate |
| Hosted CodeQL | NOT RUN | No execution evidence; the supplied section E does not mandate a CodeQL run |

The first sandboxed npm audit and Python-tool installation attempts could not
reach the registry. Authorized network retries succeeded; no audit PASS was
inferred from connectivity failure. Initial full Python coverage ran 235 tests
with one failure and one symlink skip: the duplicate-case launcher test encountered
UnauthorizedAccessException inside the sandbox. All 14 launcher tests passed
unchanged outside that sandbox. The full authorized rerun then completed all
235 tests with exit 0 and the same one symlink skip; coverage reporting exited 0.
The initial sandbox failure remains recorded and is not relabeled as a PASS.

## Risk decisions and mandatory remaining gates

See the [v1.5.1 proposal](../dependency-security-review.md#v151-candidate-proposal--2026-11-04).
The full audit's 11 moderate development entries and the additional high-severity
embedded magicast/source-map-js risk remain open. Proposed temporary acceptances
are separate, conditional, exact-artifact decisions awaiting the owner. No prior
acceptance transfers, no gate is weakened and no audit PASS is claimed. SECURITY.md
also requires a candidate-specific decision on the inherited P1 trusted-local-module
limitation; the worker audit hook is not hostile-code OS isolation.

The named guardrails are an external project document, not a missing repository
file. The owner-supplied section E and complementary rules replace access to it
for this audit. No further search or repository copy is needed. Its requirements
are covered by the publication/history/tools/license review above, the explicit
QA statuses and the pending exact-candidate approval. No private corpus or
development history is imported; old public ancestry is reviewed, not inferred
safe from HEAD alone. Negative audit and Python results remain visible.

The supplied section E does not require an additional playback smoke. Such a
smoke remains NOT RUN and is not inferred PASS from exploratory campaign closure.
If another applicable DoD introduces that requirement, obtain a specific scope
decision/authorization before any real-provider activity.

**NO-GO remains justified** by missing candidate CI, unresolved candidate-specific
dependency/P1 decisions and failed audit gate. The external-document access and
literal public-example interpretation blockers are resolved by the owner's
section-E clarification. A next
authorization may permit only the reviewed commit/push/CI preparation stage;
that would still not be publication GO. After actual CI and all decisions, seek
explicit GO for the exact unchanged candidate and its risk conditions before
public integration/tag/source-only release. No release closure is asserted here.
