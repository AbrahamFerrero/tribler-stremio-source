# Future work

## v1.3 status and deferred decisions

v1.3.0 is the public source release dated 2026-10-20. This file separates current debt from delivered mechanisms. It does not authorize another QA campaign. See [v1.3 notes](docs/releases/v1.3.0.md) for its supported scope.

Delivered mechanisms (retain their documented limits):

- Bounded Identity qualification, resource/runtime observations and bridge-owned public markers; no complete semantic identity guarantee.
- Shared HLS inactivity authority, child replacement/revocation and bounded eviction; the old absolute child-token TTL is superseded, not remaining implementation work.
- Cache-first probe recovery, recipient-scoped headers and token-scoped representation binding.
- Startup-local Python profiles, bounded worker IPC, registry round-robin and known-zero-seed filtering.
- Strict localhost authority/context checks and independent administrative Bearer authentication; Node/Python error/logging boundaries and supported Windows host environment filtering.

Current deferred debt and accepted limits:

- **PR6 open; Identity frozen:** 41 independent-provenance/confidence-composition dimensions plus two dependent ranking dimensions remain unmet (43 across 16 failing STRICT scenarios at the integration checkpoint). BASELINE acceptance of that inventory is not STRICT conformance. Reopening requires a separately approved product decision.
- **R-020 open:** broader response metadata, session/rendition fields, legacy routes, logs and artifacts need separate design/evidence. Bounded residual risk is provisionally accepted for v1.3; existing minimization does not close it.
- **Advanced localhost hardening deferred:** current Origin/native policies do not authenticate local executables or contain same-user attackers. The implemented controls have recorded Desktop validation and their residual risks are accepted for v1.3 localhost-only use. Any stronger design requires separate review and client compatibility evidence.
- **Development dependency risk:** temporary local-integration acceptance of the embedded vulnerable source-map code remains open; retire only after verifying a corrected artifact or a separately reviewed tooling change. See [dependency review](docs/dependency-security-review.md).
- **Publication boundary:** private development history contains private material and must never be merged directly into a public main branch or exposed publicly. The public source repository starts from the approved, audited neutral snapshot with a separate root history and an explicitly reviewed file manifest; it does not inherit that private history.

Additional mutation testing, fuzzing, soak, stress and extensive campaigns are deferred enhancements, not automatic v1.3 blockers. Cache-first probing is delivered; a causal real-world speedup has not been isolated by A/B evidence and is not promised.

## Streaming qualification

- MKV runtime/completeness is not independently measured. Revisit an EBML duration parser only if real recurrence justifies it; multipart filenames alone are insufficient evidence.
- A controlled swarm fixture and performance acceptance thresholds.
- Evaluate the seek-prebuffer latency and stability trade-off with repeatable data.
- Consider separate liveness and readiness endpoints while retaining aggregate provider diagnostics.
- Improve per-entry diagnostics or partial loading for invalid Stremio addon configuration.

## Python/Kodi worker

- Operating-system-level memory and CPU limits.
- An operating-system sandbox for untrusted native extensions; the audit hook is additional defense.
- Additional Kodi APIs required by future extensions.
- An explicit design for persistent services or warm processes.
- Process-tree containment if a trusted module needs to create child processes.
- Host-wide admission/rate limiting beyond existing per-request resolver concurrency and per-resolver worker bounds.
- Recovery of parent-owned temporary profiles after hard host death, without
  sweeping unrelated paths; POSIX abrupt-owner-death containment also needs
  platform-specific evidence. Windows jobs contain assigned workers, but cannot
  execute parent cleanup after the parent has been killed. See
  `docs/stress-concurrency-qa.md`.
- Versioned contracts for metadata profiles whose APIs change.
- Preserve the implemented authoritative `seriesTitle` mapping; define any additional `episodeTitle` contract before adding interfaces that require it.
- An authorized, deterministic fixture or provider for a real-module E2E without contacting uncontrolled sources.

Do not add HTTP-controlled imports, `eval`/`exec`, request-derived commands, or paths outside authorized directories.

## Checkpoint C functional acceptance

**2026-10-17: Checkpoint C research CLOSED with accepted limitations;
functional evidence PARTIAL.** This explicit user-approved v1.3 scope decision
ends active Stremio/Kodi utility research; it is not full functional acceptance
or a PASS against the frozen criteria. Retain both provider families and their
current contracts, limits and defaults.

- Stremio technical utility is demonstrated.
- Kodi Callable historical marginal technical contribution is demonstrated;
  audiovisual identity remains unproven.
- Correct additional SourcePack utility is not demonstrated. Its mandatory
  functional acceptance requirement remains unmet and visibly deferred by approval,
  along with Kodi audiovisual precision. Architecture/contract implementation is
  satisfied separately from these evidence gaps.
- Environmentally invalid resolutions are inconclusive, not negative
  provider-utility evidence. No frozen acceptance criterion is changed.
- Further experiments, commercial queries, connectivity/manifest checks,
  benchmarks and provider evaluations remain outside the closed research scope
  and require separate authorization. Private reports, commercial corpora, actual
  result records and provider inventories stay outside Git; this document records
  only the approved aggregate decision. Identity remains frozen under the deferred
  PR6 decision above.

Aggregate callables, SourcePack discovery,
authoritative aliases/JSON codec, bounded startup source selection, registry
round-robin and known-zero-seed filtering are implemented. Their contracts and
regression references are in the [Python README](python-adapter-host/README.md#checkpoint-c-status-and-regression-evidence).
The old registration-order monopoly is corrected; do not list it as an
unimplemented scheduler. A configured, operational resolver, HTTP 200 or an empty
successful scrape does not establish useful media availability.

- Deferred unmet functional requirement (not an active closure task): an authorized
  real SourcePack-derived HTTP/HTTPS source must
  provide a useful contribution unavailable in the comparison baseline. Trace
  that source through the normal worker, registry aggregate cap, Node admission
  and final listing, then playback smoke. Retain reproducible local setup,
  effective limits and baseline/comparison evidence without publishing private
  profiles, titles, locators or traces. Verify the requested content and useful
  playback; discovery counts, probe verification, an aggregate-callable HLS
  success or a short sample returned for unrelated requests cannot satisfy it.
- Generic HosterResolver remains separate work: resolve hoster/embed intermediates
  to final HTTP/HLS using a bounded disposable worker. Acceptance requires owned
  deterministic fixtures for valid final media, unresolved/invalid results,
  timeout, cancellation and cleanup, followed by authorized real-path evidence.
  Preserve URL/SSRF policy; add no debrid, arbitrary headers, weakened TLS, UI or
  addon-specific branches. SourcePack host dictionaries remain empty today.
- Upstream availability and normal aggregate visibility still require real-path
  evidence after the hygiene fixes. Establish where candidates disappear across
  adapter output, per-resolver limits, registry dedupe/global cap and Node
  qualification/probing/ranking. Do not infer content loss from a missing intake
  snapshot or increase limits to manufacture a pass.
- Slow implementations, including those retaining non-daemon threads, can exceed
  existing worker/request deadlines; external warnings can exhaust bounded stderr.
  Diagnose with effective limits and sanitized outcomes. Any future compatibility
  change needs reproducible evidence and cleanup/output-bound regression checks;
  historical longer private deadlines or local warning suppression are not defaults.
- Prolonged playback, seek, pause/resume and an actual Stremio UI journey remain
  separate uncertified acceptance evidence; a transport smoke alone cannot claim them.

## Resolution latency and provider availability

This research is deferred under the Checkpoint C scope decision above. The
following historical limits and unapproved alternatives are retained for context,
not an active investigation or a proposal to begin another campaign.

**Retain production defaults.** Historical local exploratory studies repeatedly
observed more final HTTPS results and lower listing latency for isolated Stremio
addons with a reduced addon timeout. Kodi responded differently. These private
observations establish neither causality nor a universally better profile, and
do not justify changing timeouts, probe budgets, concurrency, ranking or Identity.

Restrictive smoke profiles are diagnostic bounds. Compare effective `loadConfig`
settings: a supposedly larger experimental profile may lower a local limit, and
a Node timeout does not extend Python request/resolver/worker deadlines. Provider
response latency excludes concurrency-slot wait, while batch time includes it;
qualification and probing add other costs. A timeout without an intake snapshot
is missing evidence, not zero sources. Failed, timed-out, unexamined or exhausted
probes prove neither wrong content nor source loss. Final HTTPS counts and media
verification alone do not establish requested content.

Remote caches, execution order and upstream variability remain confounders. A
fresh bridge clears local state without resetting remote/adapter state or
representing a warm long-running bridge. No combined hybrid comparison applies
both families' separate experimental settings together; isolated observations
cannot predict competition for shared probing/ranking. Before proposing defaults,
obtain repeatable authorized combined comparisons with effective settings,
order/cache controls, intake and per-stage evidence, content checks and explicit
acceptance thresholds. Keep corpora, provider inventories and results private.

Unapproved design alternatives remain:

| Option | Benefit to investigate | Required evidence and design work |
| --- | --- | --- |
| Two independently installed localhost addons/manifests, one per family | Independent response completion could reduce waiting for the slower family. | Distinct addon identities and configuration, resource ownership/cleanup, unchanged security boundaries and client presentation; cross-family dedupe/ranking would no longer share one result set. Validate duplicate handling. |
| One addon with early response and later bounded Kodi work cached for a subsequent query | Earlier initial listing while retaining later contributions. | Background-work ownership, cancellation, duplicate-work suppression, cache keys/expiry, safe merging/revalidation, incomplete first responses, refresh/staleness and ranking behavior. |

Automatic Stremio Desktop refresh or merging of late responses has not been
verified. Neither option may assume it. No implementation is committed.
See [provider evaluation](docs/provider-quality-evaluation.md) for the separate
synthetic funnel and [existing smoke bounds](docs/qa/identity/IDENTITY_LIVE_SMOKE.md)
for diagnostic evidence limits. D2b worker timings are not normal `external_http`
request latency.

## v1.4 candidate decisions pending

v1.4.0 is a local source candidate continuing the published v1.3.0 history.
Final Identity ranking, opt-in F details, validated metadata/seeds and corrected
size/header-latency semantics are implemented; the public transformed tree
still requires candidate QA. Historical US-1403 technical closure and Windows
Quality 4/4 PASS do not certify that tree. Earlier intermittent failures retain
an undetermined environmental cause. See the [QA summary](docs/qa/v1.4-release-qa.md).

Identity STRICT is pending and PR6 remains open; R-020 remains open.
The v1.3 risk decisions recorded above keep their historical scope. In
particular, the changed lockfile and coverage consumer require an explicit
v1.4 tooling-risk decision or a verified correction before publication. No
dependency update or new risk acceptance is made in this preparation. See the
[proposal](docs/dependency-security-review.md#v14-source-candidate-risk-proposal--2026-10-24).
