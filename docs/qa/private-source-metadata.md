# Private source declarations in Trace Workbench

Date: 2026-11-01 (Asia/Tokyo). Local changes only; no commit or publication.

## Baseline and feasibility

Verified before editing in the requested checkout: branch `work/us-1501-diagnostics`,
HEAD `ad70623a8961070851e99e53d948c733001ad7bb`, clean Git status. Latest commit:
`feat(diagnostics): improve provider failure observability and funnel clarity`.
No SHA was assumed. Applicable agent instructions were read from the ancestor checkout;
no ChatGPT-specific document is required in this checkout.

The existing provider-stage observer sees registry-delivered source occurrences before
shared normalization. References distinguish duplicate objects and remain local to each
resolution. This is sufficient to capture declarations for INVALID_SOURCE, URL policy,
Identity and later exclusions without changing any decisions.

| Boundary | Available descriptive fields and limitations |
| --- | --- |
| Stremio adapter input | Original name, title, description, behaviorHints.filename; adapter uses description then title then name as source.title, name as quality, filename separately. |
| External HTTP adapter | Already returns normalized sources; upstream original fields need not survive. |
| Catalog adapter | Supplies filename; torrent variants can use the generic title Tribler. |
| Registry delivery / provider trace | source.title, optional own name when actually supplied, metadata.identity.title/season/episode. No promise of the upstream original name/title. Intake and provider internal exclusions have already occurred. |
| Shared normalization | title trimmed/capped at 500; name discarded; identity projected through normalizeCandidateIdentity; invalid sources can vanish. Capturing only here would lose early exclusions or repair/truncate suspicious text. |
| Later stages | Existing technical observations carry bridge-owned Identity state/rejection reasons. No new inference is needed or performed. |

Implementation stores only provider-stage declarations. It never fills absent fields
from the requested title, filename, URL, parsed release markers, neighboring candidates,
probe results or later normalized strings. Coordinates are the explicitly declared
metadata.identity coordinates (integers 0..100000); other shapes are not guessed.

## Privacy, scope and compatibility

The optional candidates array exists exclusively in opt-in PRIVATE_LOCAL context.
Each entry uses the recorder's candidate UUID; the private validator requires a SOURCE
event with that UUID in the same resolution and rejects duplicates, extras and accessors.
Anonymous DTOs/events and versioning are unchanged. Historical private contexts without
the optional array remain valid. New private fields require this updated reader; no
claim of forward compatibility with older strict readers is made.

Only name, title and declared identity title are considered, using the existing
safeContextLabel policy (160 UTF-16 code units, whole-value rejection for overlength,
controls, markup, URLs, paths, credential terms and long opaque identifiers).
The observer reads own data descriptors only and retains copied primitives, never raw
sources. It does not scan arbitrary objects or invoke getters for these fields.
No descriptions, externalIds, headers, filenames or locator-derived names are added.
Stremio's adapted title may itself originate in description; it passes the same strict
single-line label policy, and the UI explicitly calls it untrusted adapted output.
Arbitrary description objects/text are never separately exported.

This policy cannot prove that ordinary short natural-language text contains no private
information or short identifier. Allowed labels are private and must remain local.
Unsafe, absent and historically uncaptured values intentionally share a neutral unavailable
message; the report does not invent a reason for omission. Multi-line labels are omitted,
so metadata visibility can be limited. No sanitizer or access policy was weakened.

The inspector separates requested title, provider declarations and existing interpreted
Identity observations. It renders data with textContent, within existing escaped JSON and
hash-pinned CSP. Failed/timeout/cancelled/zero-result providers explicitly have no delivered
individual candidate metadata. Truncated/incomplete capture is not evidence about upstream
sources that were never delivered. No errors are mined for individual source labels.

Existing 256-candidate, 32 KiB context, 2 MiB report, concurrency, TTL and revocation limits
remain in force. Metadata shares accounting with existing context. Exceeding the context
budget marks diagnostics truncated and drops the overflowing update; production continues.
No retention renewal, logging, new filesystem/network capture or generic free-text event.
All fixtures added here are synthetic. Runtime Identity, resolver, dedupe, probes, ranking,
providers, networking and playback implementations are unchanged.

## Verification

Focused metadata/context/workbench/resolver/private HTTP run: 5 files, 61 tests passed.
New adversarial cases cover whole-value rejection (XSS, URLs, credentials, opaque IDs,
paths, controls and million-character text), getter avoidance, arbitrary metadata omission,
pre-normalization invalid sources, explicit Identity rejection, duplicates, concurrent
occurrences of the same object, UUID binding, historic contexts, byte truncation and late
writes. Existing suites cover expiration, restart, access security, anonymous contracts,
HTML escaping/CSP and private HTTP lifecycle. Resolver equivalence now also exercises both
anonymous and private captures with real resolver/probe layers and fixture transport,
comparing outputs, order, Identity states, exact outbound requests and probe quotas.

Gates observed:

- security:repo: PASS.
- typecheck: PASS (initial test-only optional-property typing corrected).
- lint: PASS (initial test-only unnecessary async corrected).
- build: PASS.
- test:all: PASS, 106 files / 1858 tests (before one additional private equivalence case).
- test:acceptance: PASS, 43 tests.
- test:security: PASS, 73 tests.
- test:system: PASS, 18 tests.
- Initial Node coverage: PASS, 107 files / 1901 tests; statements 88.71%, branches 86.53%, functions 91.99%, lines 93.17%.
- Final Node coverage after extending private probe equivalence: PASS, 107 files / 1902 tests; statements 88.71%, branches 86.53%, functions 91.99%, lines 93.17%.
- Python unittest: PASS, 233 tests in 129.585s, one skipped; no Python code changed.
- Python branch coverage / report: BLOCKED; available Python lacks the coverage module (No module named coverage). No dependency was installed.

No live/provider smoke was run or required for this synthetic diagnostics change.

## Final Git state

Branch and HEAD remain the verified baseline. Eight tracked files modified and two
new files untracked: six diagnostics modules, docs/diagnostics.md, the integration
equivalence test, this QA document and tests/diagnostic-source-metadata.test.ts.
No files staged; no commit, push, PR, merge or publication. `git diff --check` passed.
Ignored coverage/build and synthetic gate outputs remain local.

## Follow-up: missing labels investigation (2026-11-01, Asia/Tokyo)

This follow-up preserves the preceding uncommitted implementation. Initial branch,
HEAD and the eight modified/two untracked files matched the earlier recorded state.
The preceding gate counts are historical; this section records the follow-up.
No private smoke report was accessed, copied, searched, exported or made into a fixture.
No live provider request was made. Aggregate smoke observations cannot attribute the
missing labels to any individual boundary or establish a recoverable percentage.

### Evidence along the existing path

1. **Adapters:** `source_pack._candidate` copies `_STREAM_FIELDS`, whose allowlist has
   title but no name or description (and no metadata). It does not map name to title.
   An executed synthetic Python experiment called this existing function with a final
   HTTPS URL: name-only input delivered a candidate without either name or title;
   title-only input delivered a candidate with title. No network operation is involved.
   Thus this adapter can lose an upstream descriptive name before Node sees it. This is
   evidence of a path, not evidence of which adapters/candidates occurred in the smoke.
   In contrast, `p2p_metadata._final_candidate` maps raw.name to title for its supported
   candidates, including direct HTTP; external_scraper_package uses that helper.
   Stremio prefers description, title, then name for source.title; original provenance
   cannot be reconstructed afterward. Catalog direct sources have filename but no title.
   Python normalization projects allowed text fields and does not retain name.
2. **Node external HTTP adapter / registry:** ExternalHttpStreamProvider copies the
   returned streams with its providerId and applies its existing result ceiling. The
   registry applies its existing raw ceiling and supplies occurrence origins. Neither
   selects descriptive labels by transport or final survival. Already omitted/filtered
   upstream candidates and fields are outside the observer's evidence boundary.
3. **Observer:** metadata is captured at provider stage, after SOURCE registration and
   before shared normalization, dedupe, admission, runtime rejection and final quota.
   The same callback handles HTTPS and magnet. Per-invocation references and UUIDs keep
   identical objects/duplicates/concurrent resolutions distinct. Safe titles in synthetic
   pre-normalization and MEASURED_RUNTIME_CONTRADICTION rejections are retained.
4. **safeContextLabel:** absent, non-text, empty, unsafe and overlength values previously
   collapsed to the same empty string. This is the confirmed observability defect.
   Multi-line text, URLs, paths, credential terms, unsupported punctuation and long opaque
   values fail the existing policy; length >160 is rejected before any expensive scan.
   Normalization's later 500-character title is irrelevant to this earlier capture.
   No substring, first-line, filename, URL basename or description fallback is justified.
5. **Recorder/controller:** the event recorder holds numeric-slot-to-UUID associations;
   descriptive fields live only in separate private context. Context updates share the
   32 KiB per-resolution and 2 MiB session budgets. An actual storage denial truncates
   diagnostics; it does not silently remove titles while retaining complete capture.
   A trusted, current CLOSED capture is inconsistent with this specific byte-limit path
   as the cause, but no assertion is made about the unseen smoke file or older tooling.
6. **Export/renderer:** strict projection preserves accepted private fields; anonymous
   projection drops the entire private context. JSON embedding escapes markup and DOM
   rendering uses textContent. Synthetic round trips display the correct candidate's
   safe title even when rejected. No transport/rejection-dependent rendering or association
   defect was reproduced. The generic old missing-value message concealed omission causes.

### Scoped follow-up changes

- Optional candidate.labelStatus: closed per-field codes CAPTURED, ABSENT, EMPTY,
  INVALID_TYPE, UNREADABLE, OVER_LIMIT, WITHHELD. ABSENT means absent as an own field
  at this boundary; it says nothing about upstream provider input. Accessors are not read.
  Parent descriptor failures propagate as unreadable, not invented absent values.
- Optional context.metadataCapture: WITHIN_LIMITS initially; CONTEXT_LIMIT or REPORT_LIMIT
  only when the controller actually denies a private context write for that byte budget.
  The marker replaces an equally long or shorter pre-accounted string, preserving budgets.
  Invalid projection input is not mislabeled as a limit. WITHIN_LIMITS means no such
  context write denial was recorded, not complete capture of every upstream candidate.
  Other truncation causes remain generic/incomplete; they are not assigned invented codes.
- Renderer shows these private reasons with English/Spanish labels; historical entries
  without codes retain the neutral unknown message. Captured safe labels take precedence.
  Metadata overhead consumes the unchanged limits and can cause earlier visible truncation.
- The same strict validator rejects unknown codes, extra keys/accessors and contradictory
  CAPTURED/empty states. No rejected text, detailed match reason, length measurement,
  arbitrary key name or new descriptive field is retained. No generic event additions.
- safeContextLabel and all runtime/provider/network implementations are unchanged.

### Recoverability and stop boundary

No additional descriptive titles are recovered by this patch; existing allowed labels
were already captured. It repairs the ability to explain absence on future captures.
The recoverable fraction of the real smoke is **INSUFFICIENT EVIDENCE**: the old empty
strings cannot distinguish absent fields from privacy omission, and the private report
was intentionally not inspected. HTTPS titles are demonstrably unavailable for name-only
source_pack output; there is no evidence that this represents most HTTPS smoke candidates.

Recovering those upstream names would require a separately reviewed adapter mapping or
provider-contract extension. That work stops here. Alternatives for later review are
preserving an explicitly declared name in the adapter, or defining provenance alongside
an existing declared title. Either needs separate privacy/contract tests and authorization;
this follow-up makes neither change. Extracting a plausible title from URLs, request titles,
filenames or arbitrary descriptions would invent provenance or broaden privacy exposure.

### Follow-up validation

Synthetic focused run: 5 files / 74 tests PASS. Covers absent/empty/wrong-type fields,
accepted labels, unsafe/oversize values, getter avoidance, HTTPS/magnet rendering,
historical reports, unknown/inconsistent codes, early exclusions, duplicate occurrences,
concurrency, actual context/report byte denials, late writes and anonymous projection.
The real resolver/probe fixture now explicitly verifies title preservation on a
MEASURED_RUNTIME_CONTRADICTION. Existing OFF/ON equivalence covers anonymous/private
modes, exact outputs/order/Identity states, request sequences and probe budgets.

- security:repo: PASS.
- typecheck: PASS.
- lint: PASS after replacing a control-character regex flagged by no-control-regex.
- build: PASS.
- test:all: PASS, 106 files / 1871 tests.
- test:integration: PASS, 15 files / 251 tests.
- test:acceptance: PASS, 43 tests.
- test:security: PASS, 73 tests.
- test:system: PASS, 18 tests.
- Final coverage after the lint correction: PASS, 107 files / 1914 tests; statements 88.73%, branches 86.59%, functions 92.01%, lines 93.16%.
- Python full suite and Python coverage: NOT RERUN in this follow-up; no Python files
  changed. Only the synthetic adapter experiment above was executed. The earlier
  Python coverage blocker (module unavailable) remains unaddressed; no install attempted.
- Live smoke/browser UI journey: NOT RUN; DOM harness is not a real browser/CSP emulator.

No additional path or capture surface was introduced. Final branch/HEAD remain the
baseline, with the same eight tracked modified files and two untracked files, unstaged.
No commit, push, PR, merge or publication. No real source data or report is in Git.
