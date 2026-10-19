# Dependency security review — 2026-10-17

Status: partial remediation; the bundled source-map-js vulnerability remains open.

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
