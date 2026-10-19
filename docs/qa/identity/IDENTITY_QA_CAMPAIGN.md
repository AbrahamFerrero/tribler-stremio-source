# Identity QA campaign

Status at the historical **2026-10-17** checkpoint: **compliance incomplete;
Identity frozen**. All execution results below are dated historical evidence,
not executions performed by a later documentation or publication review.

[IDENTITY_ACCEPTANCE](IDENTITY_ACCEPTANCE.md) is the normative contract;
[IDENTITY_COVERAGE](IDENTITY_COVERAGE.md) is the AC/evidence map;
[IDENTITY_LIVE_SMOKE](IDENTITY_LIVE_SMOKE.md) is the operational guide, including
interactive rejected-source review. This campaign summarizes current decisions,
blockers and evidence limits. Approval, implementation and proof are separate.

## Verified state and metric boundaries

These are the results recorded for the bounded A1/A2 correction on 2026-10-17.
No live smoke or provider campaign was rerun.

| Metric | State at 2026-10-17 | Source / meaning |
| --- | --- | --- |
| Official inventory | 53 main cases, 84 scenarios, 10 guardrails, 94 tests | `tests/identity-qa/`; guardrails are tests outside the 84 scenario reports |
| BASELINE | **94 PASS**, 84 reports, 43 known dimensions, zero unexpected failures/progress | Verified within the general suite; green does not mean contractual conformity |
| STRICT | Expected exit 1; **16 failing / 78 passing tests**, 84 reports, **43 discrepancies** | One complete campaign; includes ten passing guardrails |
| Acceptance coverage | **78 ACs: 20 COVERED, 53 PARTIAL, 5 UNCOVERED**, zero DECISION_REQUIRED | 2026-10-11 reconciled coverage matrix, preserved without whole-AC promotion |

Coverage counts criteria; discrepancies count case/dimension mismatches, often
sharing a cause; failing tests count executions. None is a count of distinct bugs.
The older 49/50/52/54/62/72/118/138-dimension checkpoints are historical, superseded by 43.
The baseline is the exact known-violation inventory; it is not contractual conformity.

The official commands, when executable verification is needed, are:

```powershell
$env:IDENTITY_QA_MODE='BASELINE'
npx.cmd vitest run tests/identity-qa
$env:IDENTITY_QA_MODE='STRICT'
npx.cmd vitest run tests/identity-qa
Remove-Item Env:IDENTITY_QA_MODE
```

`tests/identity-qa/pilot-corpus.ts` holds explicit contractual expectations;
`known-violations.ts` holds manually reviewed exact case/dimension observations.
`harness.ts` compares them and reads real resolver/public events; it must not
infer confidence from labels, legacy evaluation, disappearance or aggregate counts.
Changed observations require review, never automatic baseline regeneration.

The 43 remaining registered dimensions are:

| Cases | Pending dimensions per case |
| --- | --- |
| 05, 34 | 9: identity/public state, disposition, admitted resources, disappearance domain, probe, measured seconds, validated effective year, origins rejected before dedupe |
| 13 | 3: identity/public state, origins rejected before dedupe |
| 01, 04, 12, 27-independent, 35, 35-recall, 40, 45, 45-independent | 2: identity/public state |
| 39, 39-negative | 1: identity state |
| 47, 47-recall | 1: confidence-ranking neutrality |

### Focused Case 20 correction — 2026-10-17

At the 2026-10-17 Case 20 checkpoint, STRICT reproduced
two missing signals: internal and public identity were NOT_OBSERVABLE despite
ADMIT, verified MP4, 6420 measured seconds and compatible effective year 1994.
The validated movie-resource classifier now returns UNKNOWN when the compatible
year lacks the canonical title anchor. Unequal title hashes establish neither
corroboration nor an explicit other-work claim. Admission, rejection, ranking,
provenance guards and fail-open behavior are unchanged; pre-probe confidence for
this resource remains unclassified. No audiovisual truth is inferred.

Case 20 now passes STRICT with internal/public UNKNOWN and ADMIT. Its two exact
known-violation entries were removed after reproduction and verification; the
contract expectations are unchanged. At this checkpoint, 50 registered dimensions
remained, without a new whole-campaign execution or coverage promotion.

Validation: STRICT Case 20 and 15 related resource/runtime scenarios pass;
190 related regression/security tests pass, including the updated historical
Case 20 characterization and redirect/query controls. Typecheck, build and
repository safety passed. A non-isolated lint run failed on temporary inspection
configuration; excluding that inspection material passed lint. The later A1/A2
checkpoint below records a passing normal lint gate. These results do not
represent a complete STRICT campaign. Cases 05/13/34, PR6, R-020 and the freeze
remained unchanged. Case 26 required separate evidence for UNKNOWN after a
blocked redirect, preserving URL-policy exclusion and domain separation.

### Focused Case 26 correction — 2026-10-17

STRICT Case 26 reproduced UNKNOWN at pre-probe but NOT_OBSERVABLE internally
after the redirect was blocked. The unregistered loopback destination
`/media/blocked.S03E04.mp4` is excluded by the exact URL policy before a target
request; no effective identity facts are obtained. The resolver previously
stored sparse final confidence only for admitted sources. It now also retains
qualified sparse UNKNOWN for `route_rejected`, using the existing classifier
and equivalent-resource evidence guards. This is not identity rejection or a
fallback for all excluded sources. Claims, title concerns and original-resource
evidence do not receive a forced UNKNOWN. No networking code or contract changed.

Case 26 now passes STRICT: UNKNOWN internally, URL_POLICY disappearance,
`route_rejected`, zero effective facts, zero identity rejections and no public
source. The blocked destination receives no request. Legitimate `26-recall`
still corroborates and admits. The exact Case 26 known-violation entry was
removed; 49 registered dimensions remain after Case 20, without a whole-campaign
rerun or any correction to other open cases.

Validation: 13 focal STRICT scenarios PASS, including Case 20, legitimate and
contradictory redirects and sparse runtime controls. Related resolver/probe,
URL-policy, outbound transport and security regressions: 178 PASS. Related
identity controls: 181 PASS after updating the old blocked-redirect
characterization from absent confidence to UNKNOWN (the only initial failure).
Typecheck, build, modified-file ESLint, repository safety and whitespace checks
passed. Normal lint still failed on temporary inspection configuration; lint
excluding inspection material passed. The later A1/A2 checkpoint records the
normal gate passing. No global lint rule or production policy was relaxed.
Cases 05/13/34, PR6, R-020 and the freeze remained unchanged.

### Bounded A1/A2 correction — 2026-10-17

This checkpoint restored normal lint after removal of temporary inspection
configuration, without changing ESLint configuration.

The sparse classifier now permits UNKNOWN for declared IDs without established
independence, subject to the existing title, structural and resource guards.
It does not identify request echoes, authenticate static claims or corroborate
IDs. Existing claimed-resource guards still prevent resource corroboration from
bypassing pending ID composition. The existing early-rejection observer now
emits CONTRADICTION for an already-decided EXTERNAL_ID_CONFLICT. Qualification,
admission, probe eligibility, ranking and public absence of rejects are unchanged.
This observation does not implement the PR6 composition exceptions.

STRICT first passed exactly the five affected scenarios: 03 (internal/public
UNKNOWN, ADMIT), and 02/06/13-negative/45-negative (internal CONTRADICTION,
public ABSENT, REJECT before probe). Thirteen focal controls also passed,
including 20/26, legitimate and contradictory episode coordinates and redirects,
and sparse runtime evidence. One complete STRICT campaign then produced
**68 PASS / 16 FAIL** across 84 scenarios; including ten guardrails,
**78 PASS / 16 FAIL**, with **43 failing dimensions**. All six A dimensions
closed; no new case/dimension discrepancy appeared. Remaining: **41 B / 2 D**.

Only the six verified A entries were removed. Thirteen still-failing B
observations were manually reconciled against that campaign:
internal/public UNKNOWN for 01/04/12/13/35-recall/45, and internal CONTRADICTION
for 34's existing rejection. Their contract expectations and pending status are
unchanged. This is observation drift, not 13 additional fixes. No baseline was
generated, no contract changed, and no second complete STRICT campaign ran.

Validation: general/integration suite **1282 PASS**, including BASELINE **94 PASS**
and exactly 43 known dimensions with zero unexpected failures/progress;
acceptance **43 PASS**; system **16 PASS**; security **21 PASS**. Node coverage
passes (87.79% statements, 84.02% branches, 91.47% functions, 92.13% lines).
Typecheck, normal lint, build and repository safety pass; the historical
full npm audit reported zero declared vulnerabilities, without closing the
embedded tooling risk documented in the [dependency review](../../dependency-security-review.md). Concurrent broad runs
hit subprocess timeouts; isolated general, coverage and system reruns pass
without changing timeouts or product policies.
Python's initial concurrent run also hit worker timeouts; its isolated branch
coverage run finishes **OK: 205 tests run, 1 skipped**, with **67%** host coverage.
No Python code or worker timeout changed.

PR6, the freeze and R-020 remain open/blocked as before. No ranking D work,
provider campaign, Checkpoint C reopening or release integration is included.

## Decisions and implemented boundaries

The canonical contract retains the complete 78 criteria and approved D-078–D-100
compositions. Phase 2.5 policy refinement is complete, including human-approved
AC-ID-028/039 and Option A/R-006. No product-policy row remains DECISION_REQUIRED;
missing implementation or evidence does not reopen those decisions.

- Identity confidence, admission and transport are independent. UNKNOWN may
  survive; SUSPICIOUS may survive; determining CONTRADICTION rejects. Historical
  observational MATCH is not production CORROBORATED. Neither playability nor
  CORROBORATED proves audiovisual content truth.
- Independent provenance requires an inspected derivation and resource binding.
  Request echoes, matching strings, repeated providers, title overlap and upstream
  flags cannot authenticate an ID. Independently derived IDs can still be wrong.
  Comparable namespace and semantic subject are required; series and exact-episode
  IDs are not interchangeable. No automatic cross-namespace mapping is inferred.
- D-082 preserves independently qualified origin disputes for equivalent resources,
  without voting or arbitrary metadata fusion. Different locators/request
  requirements remain separate routes. No full grouped adjudication is implemented.
- Only qualified unambiguous movie-year evidence may hard-contradict, subject to
  approved independent-ID composition. Ambiguous/range/multiple years fail open.
  Episode resource/release year alone never rejects; qualified production-year
  disagreement may cap otherwise positive episode confidence at SUSPICIOUS.
- Runtime is negative-only: strict movie difference `> max(600 seconds, 30%)`;
  exact episode `> max(180 seconds, 20%)`, conditional on trusted exact-S/E runtime.
  Verified supported MP4/HLS VOD measurement overrides weak duration text for
  runtime qualification (Case 30); absent measurement retains textual fallback.
  Compatible duration supplies no positive identity. Series-wide duration is unused.
- Current bounded movie/episode file-resource corroboration uses successful
  protected effective-file observations, not provider presentation or echoed IDs.
  Canonical movie title/year or series-title/exact-S/E may corroborate within the
  implemented scope. Non-empty entry/effective query caps a sole resource positive
  at SUSPICIOUS; qualified basename contradictions remain effective. HLS is outside
  this positive file-resource slice. Failed/unsafe/document routes donate no facts.
  Case 11's qualified different-work structured movie title/year is SUSPICIOUS/ADMIT;
  ambiguous, localized, common-title or token-soup text is not a trusted alias.
- Pre-probe observations cover conservative UNKNOWN continuation and decisive
  kind/S-E CONTRADICTION/reason events. CONTINUE is not admission. ID/year/weak-text
  compositions and some negative confidence remain unclassified. Post-probe measured
  rejection is attributable separately. Call-local opaque references carry no raw
  values; trusted source snapshots are not sanitized public traces.
- Healthy siblings retain opportunity within unchanged intake, probe and final
  bounds. Deterministic post-probe rejection allows bounded replacement, at most
  `2 * maxCandidates` attempts under the shared deadline; timeout alone does not.
  Ordinary candidates precede deferred textual-runtime candidates within each
  provider. Finite slots, provider turns and equivalent-copy arrival order can still
  omit healthy sources; no universal recall or monotonic stream-count guarantee.
- v1.3 preserves ranking. R-017/v1.4 confidence ranking, R-018 yield/availability
  research and R-019 route competition remain separate deferred work.

## Open cases, risks and evidence limits

| Item | Current evidence and unresolved boundary |
| --- | --- |
| Case 05: known false rejection | Matching static synthetic ID + wrong original movie resource year rejects before dedupe/probe; zero media starts, nine pending dimensions. Approved independent matching movie-ID/resource-year composition is SUSPICIOUS/ADMIT. No-ID neighbour still rejects correctly; a structured-year conflict is not automatically the resource-year exception. |
| Case 13: equivalent-origin dispute | Conflicting origin disappears before dedupe; three pending dimensions. Needs independent, comparable claims and per-origin eligibility before grouped adjudication. Repetition is not a vote. Standalone conflicting-ID negative still rejects; A1/A2 supplies its CONTRADICTION observation without implementing grouped composition. |
| Case 34: known false rejection | Conflicting ID rejects before resource validation; zero media starts, nine pending dimensions. Approved strong resource title/year counter-anchor could yield SUSPICIOUS/ADMIT. `34-recall` independently validates/corroborates the same resource without the ID; its facts cannot be borrowed into the rejected candidate. |
| PR6 | Postponed: no supported producer proves independent ID derivation, comparable semantic subject and exact resource binding. Minimum reopening contract below; no case reopened in this batch. |
| R-020 | **OPEN**, blocks final privacy implementation design/freeze. Provider-error and resolved-stream presentation hardening and Case 52 checks are bounded successes, not full privacy closure. Legacy catalog/download presentation, arbitrary/transformed sensitive values, other APIs/logs/artifacts, legacy audit filename retention and remaining header/redirect/HLS compatibility boundaries require their own evidence. Current transport policies are documented in [recipient privacy](../../http-recipient-privacy.md) and [HLS token lifecycle](../../hls-token-lifecycle.md); older Referer/Origin drift is not evidence of a current universal no-header policy or anonymity. |
| Multivariant HLS | Historical controlled smoke showed technical accessibility of a non-inspected variant. It did not establish wrong content or prevalence. Probe selection does not establish identity of every player-selectable branch; route competition/design and branch-wide playback proof remain pending. |
| Dedupe/header order | Complementary characterization exposes duplicate resources/probes/public streams for equivalent HTTP header values in a different insertion order. Unfixed, outside the official inventory of 43 dimensions at 2026-10-17. Do not infer full HTTP equivalence or merge arbitrary identity metadata. |
| Exact episode runtime | AC-ID-056 remains UNCOVERED: supported series metadata supplies title/year, not trusted exact-S/E duration. Injected requested runtime proves conditional rules only. |
| Playback/TLS/system | Synthetic media/protected HTTP demonstrates bounded routing, measurements, reasons, tokens and bytes, not audiovisual truth. HTTPS fixture sockets are substituted: no actual TLS-session claim. The spawned-process identity sentinel disables probing and proves no effective-resource/runtime behavior; full Case 34 SYSTEM proof remains absent. No safety bypass is authorized to manufacture it. |
| Real acceptance | Human survivor/reject content adjudication, actual alias truth, provider prevalence/yield, latency distributions and Stremio UI wrapping/readability remain unproven by synthetic fixtures. Historical private live attempts remain historical; no new live result is claimed. Phase 5, Phase 7 real baseline and Phase 9 freeze are not declared complete. |

The 24 complementary transformations are opt-in via
`tests/identity-characterization.config.ts` and
`tests/identity-phase4-composition.characterization.ts`, outside the official
94-test inventory. The preserved 2026-10-16 PR6 characterization recorded: BASELINE expected red,
6 failed / 18 passed; STRICT 16 failed / 8 passed, 95 dimension mismatches across
transformations. Earlier 7/17 and 96-mismatch counts are historical. Duplicate
05/34 and repeated conflicting 13 origins multiply known early-loss effects,
not root causes. No assertion, skip, exception or expectation is changed here.

## PR6 postponed and minimum reopening contract

The attempted provenance infrastructure was withdrawn; its schema-only API had no
production reader. No candidate-ID producer was authenticated and no Case 05/13/34
composition was implemented. A WeakMap, immutable snapshot, value equality or
`independent` flag can protect stored evidence but cannot create missing derivation.

Future capture must serve a concrete consumer before the irreversible loss it
must prevent. Structured `metadata.identity` alone omits presentation, filenames,
original routes, validated observations and per-origin qualification decisions.
Node cannot recover origins already dropped by Python registry dedupe or adapter
allowlists/attribution. Preserve only bounded sanitized facts/closed decisions;
never construct merged arbitrary metadata. Module-global weak keys do not make
payloads call-local: PlaybackManager and traces retain source objects. Qualification
provenance must end with its consumer, outside playback/probe-cache payloads.

Reintroducing provenance requires one concrete supported producer path and an
actual Identity consumer, not another schema-only declaration. Before that work
starts, the producer contract must specify and demonstrate:

1. **Inspectable extraction.** Identify the bridge-controlled extraction boundary
   and candidate record from which namespace/value are read. Discovery may use
   requested IDs; extraction must demonstrate that the candidate assertion comes
   from the bound record rather than copied request fields. Document what the
   available producer evidence can and cannot establish. An upstream flag,
   provider allowlist or static fixture author's knowledge is insufficient.
2. **Exact binding and semantic subject.** Bind the extracted assertion to the
   particular route/request requirements or selected torrent file under existing
   equivalence rules. State the ID namespace and movie, series or exact-episode
   subject independently of enclosing structural kind. Preserve required parent
   identity/coordinates where applicable; missing scope stays indeterminate.
   Do not infer cross-namespace mappings or redirect equivalence.
3. **Protected derivation transfer.** Define how the reviewed boundary conveys
   its result to qualification through normalization and bridge-created copies.
   Provider JSON must not be able to mint verified derivation. Keep proven
   request-derived, unestablished and independently extracted assertions distinct;
   equality and repetition cannot promote any category. This is derivation
   evidence, not a guarantee that the producer's assertion is true.
4. **Qualification context and upstream loss.** Enumerate the sanitized facts or
   closed decisions needed to distinguish eligible origins from determining
   kind/S-E/year/runtime conflicts and unrelated transport failures. Preserve
   origin/resource separation without arbitrary metadata fusion. Identify any
   upstream dedupe or normalization that loses required claims; either capture
   there under an explicit contract or limit the supported scope honestly.
5. **Consumer and lifetime.** Name the exact admission/composition decision that
   consumes the evidence, with call-local isolation and bounded storage. Define
   invalidation for changed binding, another request and copies/cache reuse.
   No raw provenance payload, locator or claim collection belongs in public
   output, logs, persistent artifacts or playback merely to preserve it.
6. **Falsifiable synthetic proof.** Exercise the supported extraction path and
   transfer with generic fixtures: independent record versus request echo,
   request perturbation, unknown/forged derivation, scope and binding mismatch,
   duplicate/reversed origins, concurrent resolves and cache reuse. Include
   independent-but-wrong claims, determining contradictions and healthy UNKNOWN
   recall. Fixtures must prove the runtime contract, not inject an attestation
   that only tests can create. Preserve existing security and probe budgets.

For Case 05 specifically, the first consumer would require a demonstrably
independent, comparable matching movie-ID assertion bound to the candidate,
plus separately qualified resource-year evidence. Only then can the already
approved narrow SUSPICIOUS/ADMIT composition be implemented. Structured-year
conflicts and other determining contradictions must not be silently treated as
the resource-year exception. Cases 13 and 34 additionally require origin
eligibility/grouped adjudication and strong resource counter-anchor composition,
respectively. None is implemented or investigated further in this closure.

## IDENTITY-PRESENTATION closed

Closed **2026-10-16** for its recorded presentation scope. The complete current
grammar, including dedicated audio-field Dual/Multi and two-code pairs, is in
[safe stream descriptions](../../safe-stream-descriptions.md).
Generic `language=en` renders `Language: en`; explicit audio and subtitles retain
their separate meanings (`English subs` is subtitles). Conflicting declarations
are omitted independently by kind. Labels are upstream claims, not measured tracks.
Closed vocabulary, omission order and existing component/output bounds preserve
privacy. Synthetic public HTTP and spawned Node/Python fixtures establish the
recorded scope; human Stremio UI and audiovisual truth remain separate.
No STRICT exception was added or removed for that presentation correction;
all 84 before/after official reports in each mode were recorded identical.

## Evidence index and minimal history

| Milestone | Durable evidence / interpretation |
| --- | --- |
| Phase 0–2 and approved Phase 2.5 | Exact historical commands/results and AC-level limitations remain in [coverage](IDENTITY_COVERAGE.md). Approval does not prove implementation. |
| Synthetic Phase 3 | All 53 main cases represented in `tests/identity-qa/{pilot,extension,intake,resource-runtime,bounds,public-trace}.test.ts`; explicit expectations, exact violations and ten harness guardrails remain intact. |
| Runtime, confidence and rejection foundation | `tests/identity-runtime.test.ts`, `identity-confidence.test.ts`, `identity-admitted-unknown.test.ts`, `identity-qa/resource-runtime.test.ts` and `identity-qa/public-trace.test.ts` distinguish supported measurement, UNKNOWN and real rejection events. |
| Protected file-resource and public propagation | `tests/identity-resource-corroboration.test.ts`, `resource-identity.test.ts`, `public-identity-presentation.test.ts`; bounded validated movie/episode facts and real public output, not ID provenance. |
| Scheduling and pre-probe observability | `tests/identity-probe-scheduling-regression.test.ts` (12 interaction guardrails), `identity-pre-probe-observability.test.ts`; competing-source opportunity and actual normalized-stage decisions. |
| Reject review / live tooling | `tests/rejected-source-review.test.ts`, `qa-identity-conflict-review.test.ts`, `identity-live-smoke.test.ts`; controlled inspection capability and safe diagnostics, not a human content verdict. Procedures in [live smoke](IDENTITY_LIVE_SMOKE.md). |
| Process/public and presentation | `tests/system/bridge-process.test.ts`, `tests/acceptance/dirty-upstream.test.ts`, `tests/public-stream-presentation.test.ts`; respect the probing/TLS/UI limits above. |

At the recorded presentation closeout: focused presentation 56 PASS; general
1247 PASS; acceptance 43 PASS; system 15 PASS; security 21 PASS; coverage 1305 PASS
(branches 84.04%, lines 92.24%); typecheck/lint/build/repository safety PASS.
Python unittest and branch coverage each 205 tests, one skip, PASS; adapter_host
67%. These are historical checkpoint results, not cleanup executions or a current
full-suite claim. The withdrawn PR6 attempt's intermediate counts are not the
final code inventory. The subsequent withdrawal verified that production/test
blobs matched the pre-attempt checkpoint and recorded focused 167 PASS plus
unchanged official 94/52 and 23/71 results. Those earlier counts must not be
added to or substituted for the 2026-10-17 A1/A2 results.

## Manual review gate and private history

Use AC-ID-076–078 and the [operational guide](IDENTITY_LIVE_SMOKE.md#local-rejected-source-review).
Review survivors and risk-selected rejects: new hard-rejection families, boundaries,
evidence disagreements, semantically doubtful rejects and bounded high-volume
samples. Record CONTENT TRUTH separately from RULE VERDICT, with no defaults.
Correct content rejected exactly as specified is ID-SPEC-GAP / RULE_FALSIFIED,
not PASS. Revise the generic AC first, then its negative/recall neighbours and
required evidence, then repeat the original smoke under unchanged protections.

The PR6 reopening contract above consolidates the technical design constraints;
the operational guide retains the rejected-source review procedure. This
document includes no private provider results or execution artifacts. Source
cleanup does not remove inherited Git history: a public source snapshot requires
an independent history and its own publication review. None of these historical
results authorizes publication or closes the remaining evidence gates.
