# Case 11: bounded SYSTEM evidence

Historical execution checkpoint: **2026-10-17**. The results below belong to
that date; this report does not establish a recent execution.

**PASS** for final identity, admission and public presentation in SYSTEM
**without a media probe**. This does not close Identity globally or establish
SYSTEM evidence with verified media transport.

## Executed path and results

The existing `tests/system/bridge-process.test.ts` harness is reused: HTTP fixture
server, `startBridge`, allowlisted child environment, readiness, bounded capture,
cleanup and the `publicIdentityState` helper. Node runs `src/index.ts` in a separate
process; the existing setup also starts the Python host and the controlled Tribler
dependency. Those two do not produce the candidate for this scenario: the real
External HTTP adapter is used against the synthetic fixture.

The client requests `/stream/movie/:id.json`. The bridge obtains known metadata
(`Synthetic Meridian`, 1994), queries the provider over HTTP, normalizes, applies
Identity and URL policy, deduplicates, admits and builds the public response with
an opaque token. The resolver is not replaced and no state is injected into the
child bridge.

| Scenario | Provider input | HTTP / sources | Observed public state | Exact presentation |
| --- | --- | --- | --- | --- |
| 11 | `metadata.identity = { title: "Synthetic Aurora", year: 1994 }`, presentation `Server 1` | 200 / 1, ADMIT | SUSPICIOUS | `HTTPS · ID!` |
| UNKNOWN | `Server 1`, no structured evidence | 200 / 1, ADMIT | UNKNOWN | `HTTPS · ID?` |
| Forged marker | `name: "ID!"` and `identityState/confidence: "SUSPICIOUS"` in top-level fields and metadata, no structured evidence | 200 / 1, ADMIT | UNKNOWN | `HTTPS · ID?` |

Candidates use an opaque synthetic HTTPS locator without candidate years,
coordinates or IDs. The positive payload contains neither `ID!` nor `SUSPICIOUS`;
an assertion checks this. The forged control checks that provider labels and
declared states do not generate `ID!`. No ID provenance is added. Assertions check
request metadata, the exact response, absence of the private title, an opaque local
public URL, and absence of credentials/private locators in the response and
captured process output.

## Evidence classification

- **SYSTEM:** 1 focused test PASS, three scenarios through a real process and
  public HTTP. The other 15 tests were not selected; no results are attributed to
  them. State is observed through the real public marker, without direct access
  to the child process's internal WeakMap.
- **INTEGRATION:** existing cases 07 and 11 in `tests/identity-qa/intake.test.ts`,
  STRICT mode: **2 PASS**, without discrepancies or known exceptions. Real adapter,
  resolver, MP4 probe and public route in the in-process harness. Both observed
  `VERIFIED`, 6420 seconds and ADMIT; internal/public states were UNKNOWN and
  SUSPICIOUS respectively. That harness allows exact local media URLs; its resolver
  factory is replaced by the already observed instance. This is not SYSTEM.
- **COMPONENT:** no additional component test was run, and an isolated formatter
  test is not used as SYSTEM evidence.

Typecheck, ESLint for the modified file and `git diff --check`: PASS.

To reproduce the path using the repository's versioned configuration:

```powershell
npx.cmd vitest run --config vitest.config.mjs tests/system/bridge-process.test.ts -t 'Case 11 derives'
$env:IDENTITY_QA_MODE='STRICT'
npx.cmd vitest run --config vitest.config.mjs tests/identity-qa/intake.test.ts -t '(07|11): real External'
Remove-Item Env:IDENTITY_QA_MODE
npm.cmd run typecheck
npx.cmd eslint tests/system/bridge-process.test.ts
git diff --check
```

These commands are for future reproduction; the counts above belong to the
historical checkpoint and do not depend on unavailable temporary configurations.

## Contract comparison and remaining gaps

The results agree with D-081 and AC-ID-013/060/066/070: an explicit different work
with a compatible year is SUSPICIOUS/ADMIT, UNKNOWN remains admitted, and the two
states have distinct public markers. `src/streams/presentation.ts` obtains those
markers through `getBridgeIdentityState`; it does not copy the provider's `name`.

**Limit:** `DIRECT_HTTP_PROBE_ENABLED=false`, as in the existing SYSTEM sentinels.
Production URL policy remains active; the child process has no local-media
exception, DNS override, socket replacement or TLS relaxation. `/source` is not
requested; there is no media TLS session or byte/playback check. The full Case 11
contract's `probe: VERIFIED` is demonstrated here only at INTEGRATION level. A
successful probe would not establish audiovisual identity either.

No production defect was detected for these scenarios. The gap was SYSTEM
evidence for structured titles: the previous Stremio SYSTEM matrix checked
survival and removed the marker before comparison; it did not cover this same
input contract. The minimal change made was a test on the existing harness and
this report, **without production changes**.

Closing an additional Case 11 SYSTEM requirement with a verified probe requires
a controlled synthetic-media origin accessible under production policies and
evidence of the path with the probe enabled. No production security exception is
proposed to achieve this. Audiovisual truth and real Stremio rendering require
separate evidence. No AC is promoted, and the official inventory, expectations
and exceptions are unchanged.

PR6 remains blocked; cases 05/13/34 remain open; the freeze remains in effect.
This checkpoint changes neither the contract nor the lack of audiovisual identity
or SYSTEM evidence with a probe.

## Consolidation — 2026-10-17

The historical consolidation check again recorded SYSTEM 1 PASS, INTEGRATION
STRICT 2 PASS, typecheck, ESLint and diff check PASS. Its scope remained limited
to those synthetic scenarios; SYSTEM with a probe and audiovisual truth remained
pending.
