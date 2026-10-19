# Synthetic stress and worker lifecycle QA

This workload uses project-authored providers and the existing fake Kodi addon.
It never starts Tribler, requests media, resolves external DNS or loads a real
provider configuration. It is independent of playback and Identity criteria.

## Reproduction

Install the locked Node dependencies with `npm ci` and the Python development
tools from `python-adapter-host/requirements-dev.txt`. Use Node 20+ and Python
3.11+. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

```text
npx vitest run tests/stress-concurrency.test.ts tests/stream-resolver.test.ts
cd python-adapter-host
python -m unittest tests.test_stress_lifecycle tests.test_kodi_worker -v
cd ..
npm run qa:soak -- 100
```

The optional soak accepts 100 through 500 resolutions per runtime. Its Node and
Python phases run sequentially. Node admits four requests with three registry
slots. Python admits two requests, each with two resolver slots and three Kodi
resolvers. At most four disposable workers run simultaneously; processes are
reused neither across requests nor across cycles. The ordinary CI subset is
24 Node resolutions and 10 Python resolutions, plus targeted regressions. Existing
`test:all`, coverage and Python discovery already include these tests; no new CI
service or dependency is needed.

For an independent Windows host-death probe:

```text
cd python-adapter-host
python tests/host_failure_probe.py
```

The probe owns an isolated temporary root, holds the exact worker's kernel handle,
kills its synthetic owner and cleans up independently even on assertion failure.
It reports temporary entries before deleting that root. Other platforms report
`INSUFFICIENT EVIDENCE`; this Windows assertion is skipped there.

## Baseline contracts and existing coverage

| Layer | Limit, queue and ownership |
| --- | --- |
| Node registry | Eight logical slots by default, shared across requests; FIFO waiters; no queue length cap. Default timeout 5000 ms, overridable per provider; timeout begins after acquiring a slot. |
| Node resolver | First 100 raw results per provider; at most 50 distinct admitted results per provider after qualification/ranking. No registry-wide final result cap. |
| Python registry | Four resolver tasks **per invocation** by default (configuration range 1–32), FIFO local queue. Concurrent HTTP requests have independent queues/event loops. No host-wide request or worker admission limit. |
| Python results | Default 20 per resolver, 100 total; configuration maxima 100. Existing round-robin aggregation, normalization and deduplication remain unchanged. |
| Timeouts | Default worker 5 s < resolver 6 s < HTTP request 8 s < Node external HTTP provider 10 s. Worker termination grace is 0.2 s by default, followed by kill and wait. |
| Worker | One subprocess per invocation. Parent owns IPC, bounded reads, terminate/kill/wait and temporary profile cleanup. The manager adds no concurrency semaphore. Input 32768 bytes; stdout 256000; stderr 32768; maximum worker results 100. |
| Host | `ThreadingHTTPServer` bound to `127.0.0.1`. Client EOF polling cancels request work; request timeout cancels and awaits cleanup. Arbitrary in-process Python cancellation suppression is not a hard execution boundary. |

Existing `stream-resolver.test.ts` already tests provider failure isolation,
specific timeouts, concurrency and progress after failure. `test_registry.py`
covers Python queue concurrency, result fairness, limits and timeout survivors.
`test_kodi_worker.py` covers real process exit, hard timeout, cancellation, IPC
overflow, environment isolation and filesystem/child-process restrictions.
`test_http_api.py` covers HTTP disconnect cancellation through real workers;
`test_kodi_profile_isolation.py` covers overlapping independent profiles.
`tests/system/bridge-process.test.ts` covers real Node/Python startup, degraded
resolver availability and controlled playback dependencies. Acceptance, security
and coverage gates already run in CI on Linux and Windows (security is also in
the general suite). These scenarios are reused, not copied into new harnesses.

## New assertions and corrections

- FIFO progress across twelve queued Node requests; twenty cancelled waiters
  complete while the original slot is still occupied. Already aborted requests
  never invoke provider code.
- Mixed fast, slow, timed-out, throwing, disabled and 150-candidate providers through
  the real registry and resolver. Request count and candidate intake remain bounded;
  no unhandled rejection or additional active runtime resource survives the run.
- Abandoned Node provider invocations cannot multiply on successive retries. A
  provider is skipped while **any** of its aborted executions remains pending;
  healthy siblings progress and late success/rejection restores eligibility.
  Abort listeners are detached when the caller finishes, not when plugin work ends.
  Synchronous plugin throws are handled at the same boundary as rejected promises.
- Python alternates success, module failure, hard timeout, cancellation and direct
  worker death. Each batch must end with zero active managers, all observed workers
  exited and an empty temporary root. Invocation-local process observations prevent
  a failure injection from killing another request's worker.
- Worker cleanup remains owned through repeated cancellation: terminate/kill/wait,
  active-PID removal, job closure and profile deletion finish before cancellation
  propagates. Both harnesses drain sibling lanes before reporting a lane failure;
  Python cancels peers before leaving its temporary root, while Node awaits peers.
- Recent PID diagnostics retain at most 100 entries per manager, rather than an
  integer for every worker ever completed. A warmed-history regression verifies
  the cap with one real worker, without creating hundreds of concurrent processes.
- Windows assigns each worker to an unnamed, non-inheritable job before writing
  its IPC request. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` stops assigned workers when
  the owning host dies. Known-exited workers are rejected before reopening a PID;
  job assignment failure refuses execution and still reaps the process.
  Jobs add process ownership, not a scheduler, configurable exception
  or filesystem permission. See [Microsoft's job object lifecycle](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The cancellation, retry amplification, PID retention and Windows host-death
regressions fail against the original implementation. Production corrections do
not change Identity, ranking, playback, provider configurations, timeouts, SSRF,
DNS, redirect or header policies. Workers still receive the minimal environment
and no Tribler settings. Existing filesystem and IPC protections remain active.

## Measurement boundaries

Node reports actual active provider invocations, heap/RSS samples and active
resource types before/after. Logical slots are not a hard bound on arbitrary
plugin execution after abort: cooperative cancellation can unwind after a slot
is released. In this workload, the three slots plus at most three outstanding
timeout executions give a derived six-invocation ceiling. This is distinct from
the healthy-provider scheduling bound. Across arbitrary registered providers,
retry protection bounds abandoned invocation count by provider count times the
slot count; it cannot stop CPU loops or resources independently allocated by code
inside the Node process. An unresolved provider stays unavailable until it settles.

Python reports observed process count, traced memory after collection, recent
PID entries and quiescent OS handles (Windows) or descriptors (`/proc` on Linux).
The final three handle samples must reach a plateau or decrease; no absolute
machine-specific memory or handle threshold is used. Unsupported descriptor
platforms report null. Harness-owned process history is discarded at each batch.
Memory samples are observations, not proof of no leaks: Node GC is not forced,
Python tracing excludes child RSS, and instrumentation/runtime caches consume
memory. No independent long-duration plateau or throughput guarantee is claimed.

The harness is INTEGRATION coverage with real Python worker subprocesses, plus a
Windows process-ownership SYSTEM regression. It does not replace the existing
public HTTP system/acceptance gates or constitute a Stremio UI journey.

## Remaining limits

- Python worker concurrency is bounded by caller admission in the harness, not
  globally in the HTTP host. Many independent clients can multiply workers. Global
  host admission needs a separately scoped design and remains unimplemented.
- Hard host death stops assigned Windows workers but bypasses parent-owned Python
  temporary-directory cleanup. A profile may remain after such a crash. Normal
  timeout, cancellation and end-of-run cleanup are asserted. No automatic sweep
  of arbitrary temporary paths is introduced.
- POSIX abrupt-owner-death containment is not established by the Windows probe.
  Normal termination/cancellation remains covered cross-platform. External OS
  supervision may be needed for hard crashes; this needs platform-specific QA.
- Cancellation cannot preempt a Node event-loop-blocking provider, a Python
  coroutine suppressing cancellation, or native code holding execution indefinitely.
  Only disposable worker processes supply a hard execution boundary here.
- The v1.3–v1.5 roadmap was not validated by this campaign; no roadmap
  requirement is represented as verified. The original coverage map draws on
  `FUTURE_WORK.md`, historical private multi-profile evidence and existing CI/tests.
  Maintained profile contracts and evidence limits are in the
  [Python host README](../python-adapter-host/README.md#profile-and-package-validation-criteria).

Keep machine-specific run logs and QA reports in ignored local storage. Commit
only generic source, synthetic fixtures and reproduction documentation.
