# US-1504: playback correlation feasibility — NO-GO

Date: 2026-10-25. This is a phase-0 architecture assessment, not an implementation
or playback acceptance report. US-1504 is **not complete**. No new playback events,
correlation authority, schema, CLI output or HTML behavior were implemented.

## Verified workspace

- Independent checkout: `.worktrees/us-1501-diagnostics` beneath the current workspace.
- Branch: `work/us-1501-diagnostics`.
- HEAD and public `main`: `18267ac0975f50e201c812db02d1c43cbb2d51ce`.
- Only remote: `https://github.com/AbrahamFerrero/tribler-stremio-source.git`.
- Read-only remote verification also resolved annotated `v1.4.0`
  (`be4b9a22c47f2a9231c5cd864c73878d7a0e0013`) to that same public commit.
- Existing US-1501/1502/1503 tracked modifications and untracked implementation files
  remain uncommitted and unstaged. No existing implementation file was edited here.
- The original private checkout was inspected read-only: branch
  `work/v1.4-separate-coverage-system`, HEAD
  `b1bfc9a2af5a67a879e5351ed76d5d516bb6d576`, four tracked modifications and three
  untracked directories. It was not used as an implementation base or modified.
- No commit, push, PR, merge, tag, reset, stash, cleanup or publication occurred.

## Phase 0 findings

| Question | Evidence in the current implementation | Consequence |
| --- | --- | --- |
| A. Final source to capability | `src/addon.ts` awaits `resolver.resolve(item)`, then passes each final source to `playback.register(source)`. `src/streams/resolver.ts` emits the final stage immediately before return, but its `finally` finishes the observation before the caller receives the array. | Production source-to-capability association exists, but a diagnostic handle cannot survive through the current call contract. |
| B. Existing retained data | `src/playback/manager.ts` stores each source with representation/session/child authority under a fresh 24-byte random opaque capability. `prepare()` validates that capability and expiry, selects a backend and renews production idle expiry before backend preparation. | There is no existing diagnostic resolution/candidate identity or diagnostic authority in registration or preparation. The existing source retention belongs to production playback; duplicating it into diagnostics would violate minimization. |
| C. Route attribution | `/source/:token/:filename` can select exactly one registered source. `/hls/:token` selects separately registered child authority. Legacy `/auto` decodes a stream identifier and `/play` uses infohash/file index. | `/source` is the potential integration point. Child HLS and legacy routes have no current diagnostic occurrence association. Joining by filename, locator, hash or timing is inappropriate. |
| D. Secret-free association | The resolver adapter owns a call-local weak map from empty occurrence references to numeric slots. The recorder independently assigns random candidate UUIDs. Neither mapping is exposed to playback. Both mappings are cleared on finish. | Reading a source during playback cannot reconstruct its diagnostic occurrence or UUID. Keeping tokens in another diagnostic map is unnecessary and would add secret retention. An explicit occurrence-scoped handoff would have to be designed. |
| E. Resolver closure | `observeResolution().finish()` emits END, clears references/ranking and calls `capture.finish()`. Controller finish closes the recorder and removes the resolution from `session.active`. Recorder close sets `closed`, changes OPEN to CLOSED where appropriate and clears candidate IDs. | Even while the session remains ON, this resolution has no event admission authority. A later request cannot use its closed handle. |
| F. Later admission | Controller writes require the matching active session and active resolution. Recorder writes reject closed/truncated recorders. Export accepts the exact v1 report envelope and closed resolution event sequences. | Adding a playback enum alone does not create authority. The current model has no independently authorized post-resolution event channel, budget ownership or report representation. |

The relevant closure points are `src/streams/resolver.ts:496-500`,
`src/diagnostics/resolver-observer.ts:96-100`,
`src/diagnostics/controller.ts:121-133,144-151`, and
`src/diagnostics/recorder.ts:26-27,45-49`. The documented meaning of CLOSED in
`docs/diagnostics.md` is that the accepted event sequence was closed.

## Decision and rejected shortcuts

The blocker is the **handoff and post-resolution authority contract**, not an
inability to observe HTTP requests or a claim that secure correlation is impossible.
The current code cannot supply that correlation through an existing live handle.
Implementing it would require new coordinated lifecycle state across resolver adapter,
addon registration, playback registration/preparation, controller and export model.
That is a new tracking/authority mechanism, beyond a playback callback plus a closed
event enum. Phase 0 therefore stops before introducing it, under the request's
architecture stop condition.

Keeping each resolution open until a player makes a request would tie the four capture
slots to player behavior and mark completed resolutions unfinished at session closure.
Reopening the recorder or allowing writes after CLOSED would change the existing
closure contract. Retaining the adapter's source/reference state or reconstructing
association from URL/token/hash/filename would compromise minimization or occurrence
isolation. Renewing production capability expiry cannot grant diagnostic authority:
playback idle lifetime and diagnostic session TTL have different purposes.

This is not an automatic NO-GO merely because `/auto`, `/play` or HLS children lack
coverage. Those limitations could remain UNOBSERVED. The blocker affects the required
subsequent `/source` request itself with the existing diagnostic authority model.

## Smallest design alternative for a revised scope

Keep each resolver record immutable after finish. Introduce a **separate session-owned
playback channel**, with explicit contract review before implementation:

1. Before resolver finish, export only a bounded, random-ID binding for successfully
   observed final occurrences. Carry the binding through the exact resolve result and
   registration operation, never through source-value matching or global current state.
2. Place a revocable diagnostic cell in the existing registered-source entry, without
   copying its token or source into a new diagnostic registry. Do not propagate that
   cell to HLS children. Resolve repeated/concurrent source occurrences explicitly.
3. Authorize at most the first attributable GET or HEAD while the original diagnostic
   session is active. Stop, expiry, truncation and recorder failure must revoke cells
   and in-flight writes; later/new sessions cannot inherit old authority.
4. Give the separate channel an explicit DTO representation and compatible schema
   policy. Count its entries, events and UTF-8 bytes against the existing resolution
   and session ceilings. It must never extend capture TTL or report retention, nor
   append to a CLOSED resolver sequence.
5. Observe only existing preparation, redirect and superficial HTTP facts. A 307, HEAD,
   200/206 or completed HTTP response cannot demonstrate audiovisual playback.

This alternative is a proposal, **not implemented or verified**. It needs dedicated
concurrency, revocation, fault, canary, export and ON/OFF playback equivalence tests
before it can be described as safe or ready. No architectural change was made on the
assumption that this proposal was approved.

## Coverage and security status

All playback correlation remains **UNOBSERVED**: HTTP(S) `/source`, initial HLS
`/source`, Tribler preparation and its redirect, child `/hls`, legacy `/auto` and
`/play`. Existing functional playback remains present; this assessment adds no facts
to reports and does not infer user selection or playback success from missing data.

No runtime, API, networking, capabilities, HLS registration/rewriting, production TTL,
deadline, probes, buffering, Identity, scoring, dedupe, Python or Kodi changes were
made. Existing localhost Host/Origin/Referer/Fetch Metadata/Bearer and export policies
remain intact. PR6, frozen Identity work and R-020 were not reopened. No private
sources, real diagnostic output or secrets were added to Git.

## Commands and actual results for this assessment

Platform: Windows NT 10.0.26200.0, win32 x64; Node v22.23.2, npm 10.9.8,
Vitest 4.1.12. PowerShell uses `npm.cmd`/`npx.cmd`.

The following existing tests were run once, with two workers:

```text
npx.cmd vitest run tests/diagnostics.test.ts tests/integration/diagnostic-resolver.test.ts tests/playback-manager.test.ts tests/hls-lifecycle.test.ts tests/integration/direct-http-playback.test.ts tests/security/diagnostic-http.test.ts tests/security/diagnostic-report-http.test.ts --maxWorkers=2
```

Result: **70 tests passed, 7 files passed**, exit 0, 2.27 seconds. No failed
assertions, reruns or skips were reported. These tests cover existing closure and
revocation, interleaved resolver observations, bounded capabilities/HLS lifecycle,
synthetic direct playback and administrative/report boundaries. They do **not** test
US-1504 correlation and do not establish its acceptance criteria A–N.

No RED/GREEN implementation cycle applies: no runtime change or new behavior test was
written. No existing test was weakened. Logs and pre-change file hashes are kept only
in ignored `.cache/us1504-baseline/`.

| Additional command/check | Actual result |
| --- | --- |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run build` | Exit 0 |
| `npm.cmd run security:repo` | Exit 0; all publishable files checked |
| `git diff --check` | Exit 0 |
| SHA-256 comparison of all 360 pre-existing tracked/untracked, non-ignored files | 360 unchanged; no missing files |
| New non-ignored files since that snapshot | Only this QA document |
| `git diff --cached --stat` | Empty; nothing staged |

`docs/diagnostics.md` was deliberately preserved with the other US-1501/1502/1503
files: its current statement that playback correlation is absent remains accurate.
This QA file is the only deliverable added for the stopped phase-0 assessment.

The initial sandboxed `git ls-remote` could not reach GitHub; the authorized read-only
retry succeeded. Two local attempts to resolve `v1.4.0^{}` failed because this clone
has no local tag reference (the first also encountered PowerShell argument parsing).
Remote `ls-remote` with an explicitly quoted peeled ref verified the tag without
fetching or changing any refs. These were inspection failures, not test failures.

The full test/coverage/acceptance/system/security suites and both npm audits were
not rerun for this stopped phase-0 assessment. Earlier US-1503 results belong to
its own QA report and are not represented as new passes here. No browser smoke,
real provider/media requests, Linux/macOS run or Python/Kodi gate was executed.

## Readiness

US-1501/1502/1503 remain available for review in their existing uncommitted state.
US-1504 is NO-GO under the current reduced integration contract; readiness for any
US-1505 work depending on playback correlation is **blocked**. There is no claim of
release readiness, complete traceability or audiovisual success.
