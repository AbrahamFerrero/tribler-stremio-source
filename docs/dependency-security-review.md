# Dependency security review — 2026-10-17

Current v1.5.1 preparation: see the [candidate-specific proposal](#v151-candidate-proposal--2026-11-04).
All earlier acceptances retain their original artifact scope.

Status: partial remediation; the bundled source-map-js vulnerability remains open.

## v1.5.1 candidate proposal — 2026-11-04

**PROPOSED ONLY: owner acceptance is pending. Release NO-GO.** No earlier v1.5.0,
v1.4 or local-integration acceptance transfers to this artifact. No parser
replacement, dependency upgrade, override, suppression or vendored fix is made.
Replacement research is deferred to possible v1.5.2 work.

The exact manifest/lock pair was clean-installed with `npm ci --ignore-scripts`.
Only the root package/lock version changes to 1.5.1; every dependency resolution,
integrity, override and consumer configuration is unchanged from public v1.5.0.
Lockfile SHA-256: `f81e6b822f0ebdb4007dad012ea8aa364a3737f265a12d1c8b76852bc0547ceb`.
The 333 installed package versions match the lock; 50 platform-specific optional
entries are absent on this platform. Declared licenses across the 383 entries
are MIT, Apache-2.0, BlueOak-1.0.0, ISC, Python-2.0, BSD-2-Clause, BSD-3-Clause,
MPL-2.0 and 0BSD. This inventory is not an independent legal certification.
Installed dependencies are excluded from the proposed source-only distribution.
Project LICENSE and NOTICE remain byte-for-byte unchanged.

| Risk | Fresh candidate exposure and impact | Existing controls | FIX / ACCEPT / DEFER proposal |
| --- | --- | --- | --- |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), moderate | Full npm audit exits 1: 11 development entries through minimatch and ESLint/TypeScript tooling. Attacker-controlled glob patterns can amplify CPU/memory use; the advisory describes optimization level >=2. No production dependency path is reported by the production audit. This does not establish universal development-input safety. | Reviewed repository/configuration inputs; isolated development/CI with existing 20-minute job limits; no exposed development server or untrusted pattern service in this release. Timeouts limit duration, not input safety. | FIX in this release would require separately reviewed compatible changes and fresh gates; none is proposed. Propose temporary ACCEPT only for this exact source-only 1.5.1 artifact, subject to explicit owner decision. DEFER remediation research to possible 1.5.2 without claiming closure. |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), high | Magicast 0.5.5 declares and bundles source-map-js 1.2.1. The installed executable bundle retains indexed-section ordering checks without the patched offset integer/bounds validation and the generated-line loop. Malicious indexed maps can block the event loop. External source-map-js 1.2.2 and npm audit do not fix or enumerate this embedded copy. | The bounded static review finds a development coverage consumer, no bridge request path; autoUpdate remains disabled, recast map options default to null, and reviewed project code does not pass source maps to magicast. Require trusted reviewed configs/ASTs/map options/maps, isolated execution and bounded jobs. This is not proof of universal unreachability. | FIX requires a verified corrected artifact or a separate tooling decision; no replacement investigation is authorized here. Propose separate temporary ACCEPT for this exact source-only 1.5.1 artifact under these controls. DEFER remediation research to possible 1.5.2. |

Fresh audit results on Windows, 2026-11-04 (Asia/Tokyo): full audit FAIL with
11 moderate entries; production audit PASS with zero findings. No additional
declared advisory appeared in that query. The separate embedded high-severity
risk remains open. Initial sandboxed audit requests could not reach the registry;
the results above came from the subsequent successful authorized network query.
Both advisory pages were consulted; no new exploit or substitution campaign ran.

Any proposed acceptance requires the owner's explicit decision for the identified
candidate tree and this lockfile, excludes installed/bundled/binary distribution,
and does not mark the audit PASS. Owner review is required again before the next
release and immediately if dependency/consumer/configuration or distribution scope
changes, untrusted patterns/maps become reachable, a production path is found,
autoUpdate/map composition is enabled, or trust/isolation/time controls fail.
The owner must separately decide the failing audit gate; hosted results must still
be observed and no security CI step is removed, skipped or softened here.

The inherited P1 trusted-local-module/OS-isolation limitation also needs a
candidate-specific close-or-accept decision under SECURITY.md. No hostile-code
sandbox claim is introduced. The public [release checkpoint](qa/us-1512-release-checkpoint.md)
records remaining CI and owner decisions and applies the owner-supplied external
section E. That section does not require a new playback smoke; any separately
required smoke needs specific authorization. No required gate is waived by this proposal.

## Scope and baseline

This is the technical review recorded on **2026-10-17**. Versions, advisory
queries, reachability assessments and gate results below belong to that dated
checkpoint; they are not a fresh upstream query or a claim about the current
installation. The embedded tooling vulnerability remained unresolved.

## Minimal lockfile change

Only these package entries changed, including their registry URLs and integrity hashes:

| Package | Original lock | Updated lock | Classification |
| --- | --- | --- | --- |
| proxy-addr | 2.0.7 | 2.0.8 | Production |
| source-map-js | 1.2.1 | 1.2.2 | Development |

Command: `npm.cmd update proxy-addr source-map-js --package-lock-only --ignore-scripts --no-audit --no-fund`.
The existing semver ranges accept both updates. package.json, Express 4.22.2,
Vitest/coverage-v8 4.1.11, Vite 8.3.0, PostCSS 8.5.28, magicast 0.5.5 and all
other package resolutions remain unchanged. No new overrides or audit exceptions.

Dependency paths (shared resolutions are deduplicated):

- Root -> express@4.22.2 -> proxy-addr@2.0.8.
- Root -> stremio-addon-sdk@1.6.10 -> express@4.22.2 -> proxy-addr@2.0.8.
- Root -> vitest@4.1.11 -> vite@8.3.0 -> postcss@8.5.28 -> source-map-js@1.2.2.
- Root -> @vitest/coverage-v8@4.1.11 -> magicast@0.5.5 -> source-map-js@1.2.2.

The lockfile was the baseline evidence; an existing installation alone was not
evidence of a clean installation of that baseline.

The advisories consulted on 2026-10-17 identified affected ranges
proxy-addr >=1.1.0 <2.0.8 and source-map-js >=1.0.0 <1.2.2:

- https://github.com/advisories/GHSA-jqcg-44mw-7w3h
- https://github.com/advisories/GHSA-68fv-2mgg-jv7q

## Unresolved published bundle

On 2026-10-17, the registry query reported magicast 0.5.5 as the newest published version.
Compatible upgrade candidates 0.5.3, 0.5.4 and 0.5.5 all explicitly declare
inlinedDependencies.source-map-js = 1.2.1. No corrected compatible upgrade
was found. Downgrading or replacing tooling was not introduced.

After a clean npm ci, magicast/package.json still declares this embedded 1.2.1.
Its published dist/builders-CDdrUKLb.js includes source-map-js@1.2.1 regions,
an IndexedSourceMapConsumer that checks section ordering but lacks the fixed
offset integer/bounds validation, and the SourceNode loop over generated lines.
By comparison, external source-map-js@1.2.2 validates offsets, caps section line
offsets and accumulated nested offsets. This is executable bundled code, not
just an old version label or a source-map reference.

Updating the external package or adding an npm override cannot rewrite that
bundle. npm audit reports declared package dependencies and its zero result
does not establish that this embedded copy is fixed.

Residual risk: development/coverage tooling contains code capable of event-loop
denial of service when processing malicious indexed source maps. No production
request path to this development-only bundle was identified. Do not treat this
as proof that all development inputs are safe. Avoid untrusted source maps in
this tooling until a corrected artifact can be verified.

Alternatives: wait for an upstream release that rebuilds/externalizes this copy;
or separately review a coverage-tool replacement or removal. Forks, permanent
patches and vendoring would require explicit justification and review. None was
introduced, and node_modules was not manually edited.

## Reproducibility and impact

Historical validation used an isolated source tree with the updated lockfile
and a fresh installation, without private configuration or inspection material.
`npm ci` installed 333 packages and left the lockfile SHA-256 unchanged.

Environment: Windows, Node 22.23.2, npm 10.9.8, Python 3.12.10.
No cross-platform or complete Node-version matrix was executed; engine ranges
are unchanged. No application, identity, R-020, Kodi or Tribler code was edited.

Express remains 4.22.2 and config still binds the bridge to 127.0.0.1. No trust
proxy configuration was found in src. The proxy-addr fix hardens incoming proxy
IP handling without changing bridge configuration. The outbound URL policy,
DNS/redirect validation, SSRF protection and header handling remain unchanged.
The source-map-js update affects development tools, not production dependencies.

## Validation

All results in this section were recorded on 2026-10-17; none is a new execution.

Initial audit: 2 vulnerabilities (one critical, one high); production audit:
one critical. After the clean installation, npm audit and npm audit --omit=dev
both exited 0 with zero declared vulnerabilities. npm ls confirms the updated
external versions and magicast 0.5.5. npm ci validates manifest/lock agreement;
only the two intended package entries differ from the original lockfile.

All nine requested literal gates passed in the isolated installation:

| Gate | Result |
| --- | --- |
| npm.cmd run lint | PASS |
| npm.cmd run security:repo | PASS |
| npm.cmd run typecheck | PASS |
| npm.cmd run build | PASS |
| npm.cmd run test:security | PASS, 21 tests |
| npm.cmd test | PASS, 791 tests |
| npm.cmd run test:integration | PASS, 40 tests |
| npm.cmd run test:acceptance | PASS, 43 tests |
| npm.cmd run test:system | PASS, 13 tests |

Python unittest and branch-coverage runs each completed 190 tests successfully,
with one skip because Windows symlinks were unavailable; coverage report: 65%.
The skip was reported by the existing test and no exception was introduced.

The additional Node coverage gate initially failed with 885/887 passing:
a 5-second timeout in kodi-source-quality-evaluation and an empty stream result
in system A03. Both suites passed without coverage. This run overlapped Python
validation and the main-directory lint scan; causality was not established.

The historical non-isolated lint and repository-safety runs also failed while
traversing inspection material/nested checkouts (251 lint errors and EISDIR).
Those environment-contamination failures do not invalidate or substitute for
the isolated gates, and no exception was added to suppress them.

After the concurrent tasks ended, the unchanged literal npm.cmd run coverage
passed: 887/887 tests, statements 84.62%, branches 79.75%, functions 89.34%,
lines 88.87%. The initial failure remains recorded above; no tests, timeouts or
security rules were changed. npm.cmd run test:all also passed, 831/831 tests.

## Decisions

The review established partial remediation only. The embedded vulnerability
was not repaired; a zero declared-dependency audit did not close it. No public
risk acceptance or publication authorization is established by this record.

## Temporary risk acceptance for local release integration — 2026-10-17

The dated acceptance was limited to local release integration under the
conditions below. It did not establish complete remediation, authorize public
distribution/main integration, close R-020 or lift the Identity freeze. Public
snapshot tooling remains a separate gate requiring a verified correction or a
decision valid for that specific public artifact.

Accepted dependency: magicast@0.5.5 contains an executable bundled copy of
source-map-js@1.2.1 vulnerable to event-loop DoS through malformed indexed source
maps. The external source-map-js@1.2.2 resolution does not repair this bundle;
a clean npm audit is not evidence that the embedded vulnerability is remediated.

Static evidence reviewed: the installed bundle, its inlinedDependencies metadata,
the missing indexed-offset validation and SourceNode generated-line loop, and
the actual Vitest coverage consumer. Configuration parsing is used for
coverage.thresholds.autoUpdate, which the reviewed coverage command/configuration
did not enable. Recast defaults inputSourceMap and sourceMapName to null; no
project call supplying these options to magicast was identified. Scope is
development/coverage tooling; no exploitable path from bridge requests was
identified. This is a bounded reachability assessment, not proof of universal
unreachability or safe handling of arbitrary development inputs.

Dynamic evidence reviewed on 2026-10-17: a private development checkpoint QA
report and its literal coverage run (930/930 tests), plus isolated synthetic
magicast API checks on that review date. The private report is historical evidence,
not an artifact reproducible from a public commit; the maintained coverage command
and configuration are in [package.json](../package.json) and
[vitest.config.mjs](../vitest.config.mjs). Trusted configuration parsed/generated without a map; a synthetic
indexed map with an excessive section offset was passed through when no output
map was requested, and explicit map composition returned within a two-second
child-process limit. The first round-trip assertion incorrectly required null
instead of the observed undefined map; the corrected absent-map check passed.
These checks neither reproduce the vulnerable SourceNode loop nor establish
complete dynamic path coverage. No third-party bundle was modified.

Conditions: keep autoUpdate disabled, accept only reviewed/trusted configuration,
ASTs, map options and source maps in this tooling, review contributions, and run
development/CI in isolated environments with bounded execution. Existing CI
jobs have a 20-minute timeout; this limits duration but does not validate maps.
No new override, vendored patch or security-gate exception is introduced.
Platform/Node-version coverage and other development workflows remain limited
to the evidence already recorded; no audiovisual compatibility claim is made.

Withdraw/review this acceptance immediately if untrusted maps can reach the
bundle, a bridge-request path is found, autoUpdate/map options or consumers
change, or input-trust/isolation/time limits cannot be maintained. Track the
upstream magicast artifact until a corrected release is available; on dependency
review or update, inspect the published bundle, verify removal/fixing of the
embedded copy and rerun relevant gates before retiring this acceptance. A tooling
replacement/removal requires separate review if upstream remains uncorrected.
The vulnerability remains open throughout this temporary acceptance.

## Conditional acceptance for v1.3 source publication - 2026-10-20

The maintainer approved temporary acceptance of the open magicast@0.5.5
embedded source-map-js@1.2.1 event-loop DoS risk for the v1.3 source-only
snapshot, with the exact lockfile (SHA-256
`c87b2c39f6242277104f15678c2ac70458e8c0276d0acd8349d3b753047670b8`).
The vulnerability remains open; the external 1.2.2 dependency and a clean npm
audit do not fix the embedded copy. The dated local acceptance above remains
historical. This scoped risk acceptance does not authorize remote publication.

Conditions: distribute sources and the lockfile only, excluding installed
packages, bundles and binaries. Keep coverage.thresholds.autoUpdate disabled;
use only reviewed/trusted configuration, ASTs, map options and source maps;
review contributions before running tooling. Run development/CI in isolated
environments with bounded execution. A timeout limits duration, not map safety.
No production request path was identified in the bounded review; this does not
prove universal unreachability.

Withdraw acceptance if untrusted maps become reachable, a production path is
found, autoUpdate or composition changes, trust/isolation/time limits cannot
be maintained, or distribution expands to npm packages, bundled/binary releases
or exposed development services. Reassess dependency, consumer or configuration
changes and any available upstream fix. At the next dependency review, verify
the corrected published bundle or separately review tooling replacement and its
gates before retiring this notice. No dependency correction is claimed here.

## v1.4 source candidate risk acceptance — 2026-10-24

**TEMPORARY CONDITIONAL OWNER ACCEPTANCE — 2026-10-24.** The owner accepted
the open GHSA-68fv-2mgg-jv7q risk of source-map-js@1.2.1 embedded in
magicast@0.5.5 exclusively for the audited v1.4 source candidate and its
reviewed tooling dependencies and consumers. The owner is responsible for
review and withdrawal. The complete v1.3 acceptance above remains historical;
this is a separate decision for v1.4. Preparation and private CI are authorized;
public publication is not authorized.
This is a bounded applicability review, not a new dependency audit or exploit
campaign. Candidate lockfile SHA-256: `130849766cae0016e4c3ba9e32bab19c82f47fe942734aaf09579059c071087d`.

### Artifact exposure and changes

The candidate distributes project sources and a lockfile, excluding installed
packages, bundles and binaries. Installation nevertheless brings development
code into the consumer's environment. magicast remains 0.5.5 with the same
locked integrity as v1.3; the existing review verified executable embedded
source-map-js 1.2.1. External source-map-js remains 1.2.2 with unchanged locked
integrity. Updating that external dependency does not rewrite the bundle.
The [advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) still identifies
indexed-map offsets as an event-loop DoS risk before 1.2.2. No correction of
the embedded copy is established here; npm audit alone cannot establish one.

Relative to public v1.3, the audited source changes Vitest/coverage-v8 from
4.1.11 to 4.1.12, Vite 8.3.0 to 8.3.3, rolldown 1.2.8 to 1.2.14 and associated
platform bindings/types; body-parser changes 1.20.8 to 1.20.9. The local
preparation records the complete per-entry comparison. Those are preexisting
source changes, not new dependency upgrades during preparation. All non-root
lockfile metadata is retained exactly from the audited source.

Coverage moves to `vitest.coverage.config.mjs`, measuring all non-system tests;
system tests remain a separate mandatory uninstrumented gate. Neither base nor
coverage config enables thresholds.autoUpdate or supplies inputSourceMap or
sourceMapName options. The prior bounded review identified coverage threshold
configuration parsing as the magicast consumer, with auto-update disabled.
The reviewed local consumer still imports parseModule for configuration
handling; its installation is supporting evidence, not a new clean-install
attestation of this candidate. No new application import of magicast or
production request path was found in the selected v1.4 changes. This is an
assessment of the inspected boundaries, not proof of universal unreachability.

### Accepted conditions and residual risk

Acceptance is bound to the audited candidate source inventory, the lockfile
hash above and the documented acceptance edits. Distribute source only, with
no node_modules, builds, bundles or binaries. Use only reviewed/trusted
development inputs, configuration, ASTs, source maps and composition options.
Keep autoUpdate disabled, review contributions before tooling execution, and
use isolated, bounded development/CI environments. The three workflow jobs retain 20-minute limits. A timeout
limits duration; it neither validates maps nor prevents synchronous DoS.
Prior local QA applies to the pre-acceptance inventory; code and dependencies
remain identical after these documentary edits. Hosted private CI must validate
the final commit and record its actual results. Untrusted development input could still block a tooling process;
absence of an identified request path does not eliminate that residual risk.

### Concrete alternatives and withdrawal conditions

1. Verify a corrected upstream magicast artifact that rebuilds or externalizes
   the embedded copy, inspect its executable bundle and rerun relevant gates.
   No currently available corrected release is asserted; no registry search
   or dependency installation was performed in this preparation.
2. Separately review replacing/removing the coverage consumer, with equivalent
   production coverage and mandatory test gates. Do not merely suppress audit
   or remove a required gate to claim remediation.
3. If neither correction nor bounded acceptance can be supported, defer
   publication. A reviewed temporary patch/fork would need explicit scope,
   provenance, notices and validation; none is introduced here.

The owner must review this temporary acceptance before publication and whenever
the dependency graph, consumers, configuration, input surfaces or isolation
change. Withdraw it on evidence of unacceptable exposure or a verified fix.
Withdraw/reassess if untrusted maps become reachable, a production path
is found, consumers/dependencies/configuration or map options change, input
trust/isolation/time bounds fail, or distribution expands to packages,
binaries, bundles or exposed development services. Review on the next
dependency change and before publication; retire only with executable-artifact
evidence and relevant successful checks. **The vulnerability remains open.
This acceptance does not establish remediation or authorize public publication.**

## v1.5.0 candidate review — 2026-11-03

Pre-acceptance review checkpoint: **partial remediation; publication blocked;
no v1.5 risk accepted at that checkpoint**. The separate owner decisions below
now apply to this candidate; v1.3/v1.4 decisions retain their original scope.

### B4: declared dependencies

The installed lock resolves Express 4.22.2, body-parser 1.20.9 and qs 6.16.1.
The sole dependency change is qs 6.16.0 -> 6.16.1, the minimal patch for
[GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).
The existing qs override is updated; root package/lock versions become 1.5.0.
No other package version, integrity or resolution changes. npm ci uses that lock.

Reviewed request consumers in Express query middleware, Express extended-query
utilities, body-parser's extended parser and the Stremio SDK call qs.parse.
The bridge does not import qs or call qs.stringify; no route to the vulnerable
stringify comma-array path was identified in these consumers. This bounded call
review is not a proof about arbitrary future code. The patch removes the affected
installed version regardless of that reachability assessment. Localhost/auth and
input bounds mitigate exposure but are not substitutes for patching.

Fresh npm audit: **11 moderate entries**, all development-only propagation of
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Production audit: **0**. These are advisory entries, not 11 independent root bugs.
The advisory range is <11.0.1. Installed minimatch is 3.1.5 at the root
and 10.2.6 under @typescript-eslint/typescript-estree. The legacy 3.x source lacks
the named firstPhasePreProcess path; 10.2.6 contains it behind optimizationLevel >=2.
The reviewed typescript-estree call uses { dot: true }, leaving its default
optimizationLevel 1. ESLint/type tooling consumes local reviewed patterns; runtime
src does not import minimatch. No bridge-request path was identified. These are
bounded reachability/mitigation findings, not advisory dismissal or v1.5 acceptance.

A global override to minimatch 11 would cross major versions and change the API
expected by legacy ESLint consumers (including default callable exports). Updating
the whole lint stack is outside minimal remediation. Options: obtain an upstream
backport/advisory clarification for the locked legacy implementations, separately
review a compatible tooling migration, or explicitly accept the bounded local-only
risk for this exact candidate. No force fix, downgrade, or major override is applied.

### B5: executable embedded dependency

Registry latest magicast is still 0.5.5. The freshly installed artifact declares
inlinedDependencies.source-map-js = 1.2.1 and contains executable source-map-js
1.2.1 regions in dist/builders-CDdrUKLb.js. SHA-256:
`6d589e4c1b4c89141d67698af6750c470184c575553029c80b110e8e091d553c`.
Inspection of IndexedSourceMapConsumer confirms the old offset handling remains;
this is executable embedded code, not merely stale metadata. External
source-map-js 1.2.2 does not replace it.
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
therefore remains present (upstream severity high), even though npm audit does not
report this embedded copy.

Path: root -> @vitest/coverage-v8 -> magicast; installed Vitest coverage code uses
config parsing/generation for thresholds.autoUpdate. Reviewed configs do not enable
autoUpdate or supply inputSourceMap/sourceMapName; src has no magicast import.
No bridge-request reachability was identified. Reviewed local inputs, disabled
auto-update and bounded test processes limit exposure; they do not remove the code.
No exploit campaign is performed or universal safety claimed.

No corrected compatible upstream artifact exists in the registry check. Minimal
remaining choices: await/review a rebuilt magicast artifact with fixed embedded
code; separately authorize a pinned reproducible patch/fork with provenance and
regression review; or explicitly accept the scoped development-only risk for this
exact candidate. No patch/fork or new risk acceptance is inferred here.

The source-only artifact redistributes neither node_modules nor magicast bundles.
Users installing development dependencies still obtain the vulnerable artifact.
All historical v1.3/v1.4 acceptances retain their original scope. Hosted CI remains
NOT RUN and publication remains NO-GO until decisions and authorization exist.

## Conditional owner acceptances for v1.5.0 — 2026-11-03

The owner explicitly authorizes these separate temporary decisions for the v1.5
source-only candidate based on `da9f1ec75ee670b94bbda0827728fe639b0374d4`
(tree `d372456efe50dd3cb45c4b398b5e806cf2f63d05`) plus only these documentary
acceptance edits. They do not automatically transfer a historical acceptance or
approve another dependency graph, artifact or release. The final documentary
commit/tree and fresh exact-SHA QA are recorded locally outside distributed sources.
The owner is responsible for review and withdrawal, before publication and at
the next dependency review. No functionality, dependency resolution, override,
audit suppression or gate is changed.

### magicast: explicit v1.5 renewal after equivalence review

Compared with the separate 2026-10-24 v1.4 acceptance and public parent
`18267ac0975f50e201c812db02d1c43cbb2d51ce`, lock entries (including integrity)
for magicast 0.5.5, Vitest/coverage-v8 4.1.12 and external source-map-js 1.2.2
are identical. Base/coverage configuration and the three CI jobs' 20-minute
limits are unchanged. The installed magicast bundle hash matches the B5 hash
above; its executable embedded source-map-js 1.2.1 remains vulnerable to
GHSA-68fv-2mgg-jv7q. The external 1.2.2 resolution does not repair it.

The reviewed consumer still imports parseModule for Vitest coverage configuration;
its use for threshold updates is gated by thresholds.autoUpdate, which remains
disabled. Neither project configuration nor runtime supplies inputSourceMap or
sourceMapName. No magicast import or request path was identified in bridge src.
Distribution remains source plus lockfile, excluding installed packages, bundles
and binaries. Installation of development dependencies still obtains the vulnerable
code. No material change to the accepted v1.4 exposure was identified in these
boundaries; this is not proof of universal unreachability or safe arbitrary inputs.

The owner therefore temporarily accepts this open risk specifically for v1.5.
Residual risk: malicious development inputs can cause synchronous event-loop DoS.
Only reviewed/trusted configuration, ASTs, source maps and composition options
may be used; review contributions before running tools. Keep autoUpdate disabled
and development/CI isolated with bounded execution. Timeouts limit duration,
not map safety, CPU/memory consumption or synchronous blocking.

Withdraw/reconsider immediately if untrusted maps become reachable, a production
request path appears, consumers/dependencies/configuration or map options change,
trust/isolation/time bounds fail, or distribution expands to installed packages,
bundles, binaries or exposed development services. Replace this acceptance with
a verified upstream correction when available: inspect the published executable
artifact for removal/fixing of the embedded copy and rerun relevant gates. The
prior registry finding above is dated evidence, not a new search for releases.
Separately review any tooling replacement or reproducible patch/fork.
**The vulnerability remains present and open; no correction is claimed.**

### minimatch: explicit temporary v1.5 acceptance

The owner temporarily accepts GHSA-g3hv-75wg-m249 for the locked development-only
minimatch 3.1.5 and 10.2.6 entries. The reviewed 3.x implementation lacks the
advisory's firstPhasePreProcess path. The reviewed typescript-estree consumer
calls 10.x with dot:true and default optimizationLevel 1, below the >=2 condition
for the analyzed amplification path. Runtime src imports neither minimatch nor
magicast; no HTTP bridge-request path was identified. These bounded findings do
not dismiss the advisory or establish universal safety. Malicious development
patterns remain a residual CPU/memory DoS risk. A forced major update has no
demonstrated compatibility and is not applied.

Keep distribution source-only, development inputs/patterns/configuration reviewed
and trusted, and tooling/CI isolated and bounded. Do not introduce optimizationLevel
>=2 in this consumer or other vulnerable configurations. Review/withdraw on changes
to dependencies, consumers, configuration, advisory, input trust, isolation or
exposure, including a bridge-request path or expanded distribution. At dependency
review and before publication, reassess a compatible upstream correction/backport
or separately reviewed migration; replace acceptance with verified correction and
relevant successful gates when available. No override, downgrade, general update
or suppression is authorized by this decision.

### Audit and authorization boundary

The candidate's declared production audit is **PASS, zero vulnerabilities**;
the complete npm audit is **FAIL, 11 moderate development entries** propagating
the minimatch advisory, not 11 independent root bugs. Acceptance does not convert
FAIL to PASS. The embedded magicast vulnerability (upstream high severity) is an
additional open finding outside npm audit. Fresh audits and all applicable local
gates must be measured again on the final SHA; prior QA is not inherited.

Hosted Linux/Windows CI: **NOT RUN**. The unchanged workflow's full npm audit
step will fail while these findings persist; risk acceptance does not suppress
that gate or establish CI PASS. After local exact-SHA validation, the candidate
can be presented for separate authorization of push and hosted CI, with this
expected failure disclosed. **Publication remains NO-GO** until actual hosted
CI results are reviewed, any failing gate receives an explicit resolution or
separate decision, and final publication authorization is received. No push,
PR, merge, tag, release or visibility change is authorized here.
