# US-1511: bounded direct media signatures

US-1512 now has a separate [release preparation checkpoint](us-1512-release-checkpoint.md).
The original results below remain historical. Additional launcher changes and
candidate-specific gates are recorded there; release closure is still pending.

Date: 2026-11-04 (Asia/Tokyo). Scope: local implementation and synthetic QA;
release closure and publication remain US-1512 work. No release authorization.

## Provenance and isolation

Base: public source v1.5.0, commit
`ff1d4b151e0b0e8eb48cfa5b777c1fbfdf32c3d8`. At the original QA checkpoint,
changes were uncommitted; there was no final candidate commit SHA. The candidate
continues the neutral public source history; private development history was not
imported. Results below describe that checkpoint, not a final release artifact.

## Implementation and limits

The pure recognizer uses at most the already inspected 64 bytes. It accepts a
deliberately small MP4/Matroska structural subset, documented in
[diagnostics](../diagnostics.md#structural-container-admission-technical-v8).
It has no transport, recursive parser, dynamic execution or external dependency.
It does not prove a video track, codec support, identity, full-file integrity or
sustained playback. Valid files with larger headers, unknown brands or other
unsupported structures can still be rejected.

Only opaque direct sources with normalized `application/octet-stream`, a verified
206, coherent initial Range/length/identity encoding and the probe-owned enum gain
admission. Existing normalization, Identity, budget, deterministic rejection and
HLS precedence remain authoritative. HTTP 200, missing/malformed MIME, other MIME,
WebM and other containers gain no new path. Provider-supplied probe metadata is
discarded by the unchanged normalization boundary.

Only `containerSignature: mp4 | matroska` is added to existing in-memory probe
metadata. Sample bytes and arbitrary upstream strings are never added. The
initial reader can mark already observed excess bytes without changing reads or
cancellation. Existing MP4 runtime triggers, requests and parser are unchanged.
Network/URL/DNS/recipient/TLS/token code, ranking/dedupe/quotas, HLS, Tribler,
Python/Kodi, package manifest and lockfile are unchanged.

The compact `DIRECT_MEDIA_SIGNATURE` event replaces the incompatible v7 event
only for signature admission. Actual stored events promote reports to v8; dropped
events do not, and later v7 events cannot downgrade v8. Strict DTO validation,
historical v1–v7 reading, private envelope v1, capture defaults and all existing
limits remain in force. English/Spanish HTML identifies structural evidence and
its limitations. Normal Stremio presentation is unchanged.

## Changed files

| File | Purpose |
| --- | --- |
| `src/streams/direct-media-signature.ts` | Pure bounded MP4/EBML recognizer |
| `src/streams/types.ts` | Closed probe-owned container enum |
| `src/streams/direct-media-evidence.ts` | Typed signature admission observation |
| `src/streams/direct-stream-probe.ts` | Derive enum from existing coherent initial 206 bytes; observe excess without another read |
| `src/streams/resolver.ts` | Narrow admission alternative after existing stronger decisions |
| `src/diagnostics/events.ts` | Compact signature event and exact validation |
| `src/diagnostics/controller.ts` | Stored-event-only v8 promotion, no later downgrade |
| `src/diagnostics/report-model.ts` | v1–v8 reading and version/event consistency |
| `src/diagnostics/resolver-observer.ts` | Explicit minimizing projection for signature evidence |
| `src/diagnostics/html-report.ts` | Timeline/source inspector support |
| `src/diagnostics/i18n.ts` | English/Spanish labels and evidence limitations |
| `tests/direct-media-signature.test.ts` | Structure mutations, truncations and admission exclusions |
| `tests/direct-media-trace-fixture.ts` | Reuse existing fixture with synthetic bytes, full request headers and captured logs |
| `tests/diagnostic-direct-media.test.ts` | RED/GREEN, v8 contract, historical readers, limits and canaries |
| `tests/direct-probe-cache-first.test.ts` | Signature cache TTL/header separation and serialization minimization |
| `tests/integration/public-identity-order.test.ts` | Existing public pipeline fixture: new admission and consequent quota/dedupe behavior |
| `docs/diagnostics.md` | v8 contract and conservative format subset |
| This report | Actual QA, AC matrix and residual risks |

## RED/GREEN and comparative evidence

Before production edits, both new MP4/Matroska component cases failed because the
resolver returned zero candidates instead of one. Request/header assertions and
the expected existing cancellation count passed before those failures. After the
implementation, both cases and the retained diagnostic cases passed.

The focused checkpoint passed **140 tests in six files**, covering the recognizer,
probe, cache, MP4 runtime, diagnostics and public Stremio integration.

A local comparison extracted original source from the exact base into an ignored
cache, then ran original and current probes with their matching real
DirectTransport/URL-policy implementations and the same synthetic pinned-request
boundary. All **12 scenarios** matched exactly for request URLs/destinations,
addresses, methods, headers, DNS calls, body pulls, cancellations, aborts and prior
metadata (excluding the intentional new enum): MP4 prefix, Matroska, MP4 tail,
auxiliary timeout, auxiliary caller cancellation, cross-origin redirect, denied
route, invalid Range, encoded response, ZIP, HTTP 200 and HTTP 428. No real media
provider was contacted. This is component evidence, not a live TLS/network smoke.

Local raw evidence is kept outside version control in
`.cache/us1511-evidence/`: `red.log`, `green.log`, `focused.log`,
`compare.ts`, `network-comparison.json`, gate logs and audit JSON. The baseline
source under `.cache/us1511-baseline/` is also excluded from distribution.

## Acceptance criteria

PASS below describes executed synthetic evidence and unchanged reviewed code;
it does not establish universal compatibility or close frozen product debts.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-151-01 | PASS | MP4 RED/GREEN component, probe-owned enum and public Stremio integration |
| AC-151-02 | PASS | Matroska RED/GREEN; finite and unknown-size Segment fixtures |
| AC-151-03 | PASS | Required-header truncations, invalid sizes/brands/VINTs, duplicates and unsupported versions |
| AC-151-04 | PASS | ZIP/HTML/XML/JSON, incompatible MIME, WebM/image/audio exclusions; existing deterministic regressions |
| AC-151-05 | PASS | Invalid Range, errors, cancellation/budget, dangerous names/URL rejection; original/current 428 and auxiliary timeout/cancel comparison |
| AC-151-06 | PASS | Twelve original/current comparisons; unchanged scheduler/budgets/runtime parser and existing probe scheduling tests |
| AC-151-07 | PASS | Existing name/MIME/HLS/Tribler paths covered by general, integration and system suites |
| AC-151-08 | PASS | Identity rejection precedence; public integration retains dedupe and applies the existing 50-result quota after admission |
| AC-151-09 | PASS | v8 projection, EN/ES HTML, historical versions, forged versions/fields/getters, no downgrade and dropped-event limits |
| AC-151-10 | PASS | Cold/warm admission, unchanged TTL, header-separated cache; anonymous/private exports and cache serialization canaries |
| AC-151-11 | PASS | Real resolver/addon/public HTTP Stremio discovery produces an opaque playback capability for the new source |
| AC-151-12 | PASS | Enum-only retention; binary/MIME/header/cookie/name/metadata canaries; reviewed localized diff, no new data transmission or persistence |
| AC-151-13 | PASS | Unchanged network/security/token boundaries; URL rejection precedence and executed security/recipient/redirect integration regressions |
| AC-151-14 | PASS | Original/current DirectTransport recipient comparison plus executed adversarial export/cache/log/header canary and security tests |

## Gates

Platform: Windows, Node 22.23.2, npm 10.9.8. Exact lockfile installation completed
with lifecycle scripts disabled. The first sandboxed installation failed on
registry access; the subsequent authorized installation succeeded. This is an
environmental preparation failure, not a product test PASS or regression.

| Command/check | Result | Executed evidence |
| --- | --- | --- |
| Focused regression | PASS | 140 tests / 6 files |
| Original/current transport comparison | PASS | 12 scenarios |
| `npm test` | PASS | 1,838 tests / 98 files |
| `npm run test:integration` | PASS | 255 tests / 15 files |
| `npm run test:acceptance` | PASS | 43 tests / 1 file |
| `npm run test:system` | PASS | 18 tests / 1 file, without coverage instrumentation |
| `npm run test:security` | PASS | 73 tests / 7 files |
| `npm run typecheck` | PASS | Exit 0 |
| `npm run lint` | PASS | Exit 0 |
| `npm run build` | PASS | Exit 0 |
| `npm run security:repo` | PASS | All publishable files checked |
| `npm run coverage` | PASS | 2,136 tests / 114 files; statements 89.13%, branches 87.35%, functions 92.26%, lines 93.37% |
| `npm audit` | FAIL | 11 moderate development entries, inherited minimatch advisory |
| `npm audit --omit=dev` | PASS | Zero findings |
| Hosted/Linux CI | NOT RUN | No remote execution/publication authorized |
| Standalone Python gates | NOT RUN | No Python-layer changes |

No full-audit PASS or hosted CI success is implied by the other gates.
No separate Python gate is required for this change: the Python layer is
unchanged; the required system suite still exercises its normal process boundary.

## Residual dependency and release boundary

`npm audit` returns FAIL with 11 moderate development dependency entries derived
from minimatch GHSA-g3hv-75wg-m249. `npm audit --omit=dev` returns PASS with zero
findings. The unchanged lockfile and base dependency review establish this as an
inherited finding, not a signature implementation regression. The embedded
magicast/source-map risk remains open and outside that npm audit result; it is
not corrected or independently re-audited here.

The historical v1.5.0 risk acceptances do **not** authorize acceptance for v1.5.1.
No audit suppression, dependency change or new risk acceptance was made. US-1512
must obtain a candidate-specific remediation/decision and assess its actual CI
gates before release closure. PR6, R-020, Identity STRICT, HTTP 428 handling, HLS,
Playback Resilience and Python/Kodi scope remain unchanged.

No commit, push, PR, merge, newly authored tag, release or publication was made.

## Technical decision

**GO to start US-1512 as the separate release review**, with AC-151-01 through
AC-151-14 satisfied by the executed evidence above. This is not release closure
or permission to publish. **Release readiness remains NO-GO** while the failed
full audit and the candidate-specific minimatch/magicast risk decisions remain
unresolved. The functional GO neither waives that gate nor transfers prior risk
acceptance. The package version remains unchanged for the later release step.

## SMOKE-1512 exploratory campaign closure

The owner has ended the manual exploratory campaign. Its coverage is partial;
closing the campaign does not establish complete manual validation of the
acceptance criteria, functional release readiness or publication approval.
No further live searches, probes or playback campaigns are authorized by this
closure. Private reports, configurations, session evidence and playback results
remain local, outside version control; none are incorporated into this note.

The synthetic AC evidence and PASS/FAIL/NOT RUN gate results above remain records
of their original checkpoint. No tests, dependency audits or CI were rerun for
this documentation-only closure, and no additional PASS is asserted.

Release readiness remains **NO-GO**. Outstanding work includes identifying the
exact final candidate and its complete diff; reviewing the additional Python
launcher, test and README changes separately from the original signature scope;
completing applicable Node/Python and security gates and required CI on that
candidate; and resolving the minimatch audit failure and embedded
magicast/source-map risk through candidate-specific review and owner decisions.
The earlier statement that Python was unchanged applies only to the original
US-1511 checkpoint, not to these subsequent launcher changes. Any required final
candidate smoke remains NOT RUN for release closure; this exploratory closure
neither waives that gate nor authorizes another campaign. Candidate preparation
and publication require their respective explicit GO/NO-GO decisions.
