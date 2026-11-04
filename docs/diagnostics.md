# Local diagnostics: capture, CLI and offline reports (v1.5 P0)

**2026-11-03: local technical scope closed; feature frozen.** Current evidence is
the [closure QA](qa/v1.5-technical-closure.md) and [technical release notes](releases/v1.5-diagnostic-readiness.md).
The v1.5.1 source candidate is unreleased; publication requires explicit approval.
See [candidate notes](releases/v1.5.1.md); historical QA is not final-candidate QA.

## Structural container admission (technical v8)

`DIRECT_MEDIA_SIGNATURE` records admission by bounded structural evidence, not
verified video tracks, codecs, audiovisual identity or sustained playback. It is
emitted instead of the historical `DIRECT_MEDIA` event only when the new admission
path actually wins. Existing name/MIME admission observations retain v7 semantics.

The exact event fields are `kind`, `stage` (`ADMITTED`), internal `candidate`
(exported as an opaque `candidateId`), `container` (`mp4` or `matroska`), `mime`
(`application/octet-stream`), `response` (206), `range` (true) and `verified` (true).
No sample bytes, arbitrary brands, names, locators, headers or free text are
retained in this event. Reports become v8 only after this event is stored; later
v7 observations cannot downgrade them. Versions 1–7 remain readable and reject
the new event. A v8 document without an actual signature event is invalid. The
private envelope remains v1. Capture defaults, event/byte/candidate/TTL/export
limits and operational logs are unchanged. OFF allocates no new capture detail.

Admission requires the existing probe's identity-encoded, coherent initial 206:
`Content-Range` starts at zero and ends at most at 63, its total is a safe integer
greater than the end, the observed prefix matches that interval, and a present
`Content-Length` matches it. Missing encoding or `identity` is supported; compressed
responses, observed excess bytes and inconsistent lengths do not qualify. The
reader still stops and cancels at its existing limit; this is not a full-body
length or integrity certificate. MIME absent/malformed, other MIME and HTTP 200
gain no new admission path. Normalization, Identity, deterministic security and
probe rejections, HLS requirements and budgets retain precedence.

The pure recognizer uses at most the same 64 bytes. MP4 requires a complete normal
`ftyp`, allowed brands (`isom`, `iso2`, `avc1`, `mp41`, `mp42`), an explicit `mp41`
or `mp42` brand and a coherent following `moov`/`mdat` header. Extended/EOF-sized
boxes, unknown brands and incomplete structures remain unrecognized. Matroska
requires a complete finite EBML header with exactly the seven supported fields:
EBMLVersion/EBMLReadVersion 1, maximum ID length 4, maximum size length 1–8,
DocType exactly `matroska`, DocTypeVersion 1–4 and a compatible DocTypeReadVersion.
Duplicates, unsupported fields/versions and invalid VINTs fail closed. A following
Segment header is required; its size may be a coherent finite value or the EBML
unknown-size marker. WebM is not admitted by this path. Valid files outside this
deliberately small subset can still be rejected.

Only a closed container enum is added to the existing in-memory probe metadata
and cache. HMAC keys, TTL, capacity, scheduler, timeouts, recipients and requests
are unchanged. The existing MP4 duration reader keeps its original triggers and
auxiliary requests; signature recognition never initiates or completes a read.
Timeout/cancellation cannot be rescued by an earlier recognizable prefix.

## Direct video admission evidence (technical v7, retained)

Opt-in diagnostic captures now record a bounded `DIRECT_MEDIA` event at admission
evaluation for direct non-HLS sources that reach the video-name/MIME decision.
This is a technical observation, available in anonymous JSON and private reports;
capture remains OFF by default. No provider text, exception, locator, header value
outside the canonical MIME allowlist, or content identifier enters this event.
Stronger Identity, budget, deterministic probe and HLS decisions keep their existing
precedence and do not manufacture direct-video evidence.

The unchanged decision tree is: reject explicit budget exhaustion or deterministic
probe failures; require the existing HLS verification for HLS candidates; admit a
recognized structured filename or original normalized URL pathname video name;
otherwise admit verified HLS, or require normalized `video/*` and either HTTP 200
or HTTP 206 with both verified transport and valid Range evidence. Presentation
`title`/`name` never supplies that structural video name or positive Identity evidence.

`filename` and `urlName` contain only canonical recognized extensions (`mkv`, `mp4`,
`webm`, `m4v`, `mov`, `avi`, `mpeg`, `mpg`, `ts`, `m2ts`, `mts`, `vob`, `ogv`, `ogm`,
`wmv`, `flv`) or `ABSENT` (filename only), `NO_EXTENSION`, `OTHER`. Recognition uses
the production helpers, including existing pathname decoding. It describes the
source URL supplied to admission, not a reconstructed redirect target. Extensions
from arbitrary query values or display titles are never used.

`mime` retains canonical normalized types from a fixed allowlist: common video
types (`video/mp4`, `video/x-matroska`, `video/webm`, `video/mp2t`, `video/mpeg`,
`video/quicktime`, `video/x-msvideo`), generic binary (`application/octet-stream`,
`application/mp4`), documents (`text/html`, `text/plain`, `application/json`,
`application/xml`, `text/xml`) and audio (`audio/mpeg`, `audio/mp4`). These cover
video recognition and common incompatible responses without retaining arbitrary
server strings. Parameters are not retained. Other normalized `video/*` is
`VIDEO_OTHER`, other valid MIME is `OTHER`. A call-local, diagnostic-only callback
distinguishes a missing root Content-Type (`ABSENT`) from a malformed one
(`MALFORMED`). Neither adds data to the probe cache. A cache hit with no retained
normalized MIME, a network failure, or missing observation yields `UNOBSERVED`,
not a claim that the raw header was absent. No additional request is made.

`transport`, `verified`, `range`, and numeric `response` (100..599; 0 means
unobserved) preserve existing probe observations. `media` is the actual local
admission predicate result, not final selection or video-content verification.
`mediaCause` is `NONE` on admission; otherwise the winning condition is:

| Code | Existing condition |
| --- | --- |
| MIME_ABSENT | No usable normalized MIME (missing, malformed or unavailable); no recognized video name |
| MIME_NOT_VIDEO | Usable MIME does not start with `video/`; no recognized video name |
| HTTP_RESPONSE_NOT_ACCEPTED | Video MIME, but HTTP status is neither 200 nor 206 |
| RANGE_NOT_VERIFIED | Video MIME and HTTP 206, without both required verified and Range flags |
| EVIDENCE_UNDETERMINED | Required probe or status unavailable |

MIME failure takes precedence over HTTP/Range failure exactly as in admission;
the retained status and flags still show concurrent missing conditions. The
schema rejects incompatible stage, codes, result/cause/name/MIME combinations,
extra fields and accessors. V7 is selected only when a `DIRECT_MEDIA` event is
actually stored and never downgraded by later v5/v6 facts. V1–v6 remain readable
and reject this new event. Historical reports explicitly show missing detail;
no evidence is inferred from titles or reconstructed from HTML. The private
envelope stays version 1. All byte/event/candidate/TTL/HTML ceilings are unchanged;
extra events can reach the existing technical limits sooner.

The source inspector and timeline explain transport versus video admission in
EN/ES. Session truncation remains global. Resolution technical incompleteness is
based on that resolution's state, not the global state. A terminal observation
in a CLOSED resolution with no observed continuity gap is labelled accordingly;
private-context byte omission is shown independently. A genuinely TRUNCATED
resolution retains its warning even if an exclusion was observed. No missing
terminal, END, classification or count is synthesized.

There is no existing diagnostic authorization to show literal source URLs, even
in PRIVATE_LOCAL mode. Structural facts are the supported investigation path;
showing full locators needs an independent privacy decision. This change adds
no endpoint, raw-URL viewer, persisted header or operational log field.

P0 comprises US-1501/1502/1503 plus the US-1506 usability/context correction.
US-1505 records the earlier scope; [US-1506 QA](qa/us-1506-diagnostic-usability.md)
records the later contract and verification. Those checkpoint reviews are historical;
the closure QA above supersedes their local technical readiness status;
[US-1504 is deferred following its phase-0 NO-GO](qa/us-1504-playback-feasibility.md)
and is not a P0 closure requirement. All playback correlation remains UNOBSERVED;
the proposed alternative channel has not been implemented. See
[final QA](qa/us-1505-diagnostic-final-qa.md) and [release readiness](releases/v1.5-diagnostic-readiness.md).
Real reports and private input/output must stay outside Git.

Each application owns one OFF controller. Starting capture is an explicit administrative
operation; no environment flag enables capture. There is no automatic disk persistence,
export I/O in the resolver, live dashboard or playback correlation. Starting a new process creates
an empty OFF controller. US-1502 connects each real `StreamResolver.resolve()` invocation
through a minimizing adapter; the original `StreamResolverTrace` interface is never a
recorder input because it can expose source objects. No diagnostic adapter or occurrence
references are allocated while OFF or when capture admission returns no handle.

## Administrative contract

The `/diagnostics` namespace uses the existing first localhost request policy, including
Host, Origin, Referer, Fetch Metadata and independent Bearer authentication. No configured
token disables every diagnostic operation. No diagnostic response enables CORS. Tokens
belong only in the Authorization header, never in query parameters or request bodies.

- `POST /diagnostics/start`: JSON with exactly `ttlMs`, `resolutions`, `retainReport`.
  All fields are mandatory; integers have ranges 1..300000 and 1..10 respectively,
  and retention requires a boolean. A second active start returns 409 without replacement.
- `GET /diagnostics/status`: OFF and report availability, or ON with session ID,
  remaining milliseconds, quota, reserved/active/skipped counts, event count and truncation.
- `POST /diagnostics/stop`: immediately revoke handles and return OFF. Repetition is safe.
- `GET /diagnostics/report`: a validated detached final DTO, JSON only, at most 2 MiB.
  No capture is started and no provider/probe request is made. Active capture returns 409
  (`DIAGNOSTIC_CAPTURE_ACTIVE`); no retained report returns 404 (`DIAGNOSTIC_REPORT_NOT_FOUND`);
  expired retained data returns 410 (`DIAGNOSTIC_REPORT_EXPIRED`). Invalid internal report
  data returns fixed 500 (`DIAGNOSTIC_REPORT_UNAVAILABLE`) without disclosure.
- `POST /diagnostics/private/start`: the same exact three fields and authorization,
  explicitly opting into bounded private context for this session only. The normal
  `/start` does not accept a private flag in body/query and never captures that context.
- `GET /diagnostics/private/report`: the same boundary, method/body/query restrictions
  and lifecycle errors. Returns a private envelope only if context was opted into;
  otherwise 404. The normal report remains anonymous even for a private session.

All six reject query strings. Status, stop and both report operations reject bodies. Both start operations accept only
application/json, with a 1 KiB decompressed parser limit. Invalid or oversized bodies
return fixed 400 JSON without logging input. Other methods, including HEAD, return 405
(OPTIONS remains 403 at the authorization boundary). Unknown paths return 404.
Responses use no-store, with no CORS. Report reads do not renew capture or retention.
Only a boolean expiry tombstone remains after report deletion; it contains no IDs or
report data and is cleared by a new capture. After process restart, no report means 404.
No endpoint serves HTML or accepts a filesystem path, language or export action.

## Lifecycle and bounded data

`beginResolution()` is the capture admission boundary. It receives no media or
query data. It reserves one of the requested N slots synchronously at resolution entry,
before any work, and never waits. Only the first N attempts are eligible: a concurrency
skip consumes its reserved slot and marks the session TRUNCATED. Finishing never refunds
quota. Attempts after N, after stop or while OFF return no handle; production work must
continue normally. Captured work has no influence over resolver/network budgets.

Hard diagnostic maxima are 5 minutes capture, 10 resolution reservations, 4 concurrent
captures, 256 candidate slots per resolution, 2048 events per resolution, 8192 events per
session and 2 MiB total DTO. Byte admission counts UTF-8 JSON event bytes and separators,
with 4096 bytes reserved for the fixed session envelope and 256 for each resolution envelope.
The expanded numeric schema can reach byte admission before the event ceiling; both are
independently enforced. These bounds concern DTO content, not a precise JavaScript heap quota.

The original `STAGE` (closed stage enum and integer count 0..256) and
`CANDIDATE` (local integer slot 0..255 and closed decision enum) events remain supported.
US-1502 adds `SNAPSHOT`, `OBSERVATION`, `PRE_PROBE`, `REJECTION`, `GAP`, `RANKING` and `END`.
Snapshots retain actual array counts (0..2^32-1) separately from bounded observed occurrence
counts (0..256); more than 256 sources truncates diagnostics after the bounded snapshot.
Slots must be bridge-owned
ordinal numbers, never private identifiers or hashes. Stored candidates have random UUIDs;
session and resolution IDs are independently random. No input object is retained. Events
with additional fields, accessors, invalid enums or numbers are rejected and truncate capture.
Identity, probe status, decisions, rejection reasons, gap contexts/reasons and completion
outcomes are closed enums. `UNCLASSIFIED` is distinct from observed `UNKNOWN`.
`UNKNOWN` is an observed effective Identity classification; `UNCLASSIFIED` means no
bridge-owned classification was available at that observation. `UNOBSERVED` means
the hook did not supply the relevant observation. `INSUFFICIENT_EVIDENCE` means a
change was seen but its cause is not established; neither code supplies a missing cause.
Ranking contains position 1..256 and exactly seven finite numbers bounded to [-10000,10000]:
total score and availability, resolution, size, codec, metadata and transport components.
No URL, requested title, registered provider ID/name, query ID, token, header, magnet,
infohash, personal path or arbitrary text is part of the anonymous event schema.
US-1506 explicitly permits a separate opt-in sensitive context vault, described below;
it does not pass titles or names to DiagnosticRecorder. Both boundaries minimize
before storage, not after HTML rendering. There is no hashing of private values.

## US-1506: useful context, private and anonymous views

The first screen answers what was requested, which registered providers participated,
what each returned and what happened to each observed source. Choose one search at a
time; source labels are Source 1, Source 2, etc., scoped to that resolution. Source
transport and supported height come from existing metadata; absent quality is not
invented. Provider provenance comes from each registry invocation and the exact
flattened intake occurrence, never from an upstream `providerId` claim or global
last-run diagnostics. Sources show observed phases, latest observed Identity/probe
state, explicit rejection if any, and final resolver selection/position. Scores and
UUIDs remain available under expandable technical details rather than primary titles.

`PROVIDER_STATE` distinguishes ENABLED, DISABLED, INVOKED, RETURNED_ZERO,
RETURNED_RESULTS, FAILED, TIMED_OUT, CANCELLED and NOT_OBSERVED. An enabled provider
with earlier outstanding work may not be invoked; a provider that returned an empty
array is distinct. Failure versus timeout/cancellation comes from bridge-owned abort
state, never error text. Invocation means `StreamProvider.resolve()` was called,
not that it necessarily made an upstream request: internal provider eligibility and
filters remain outside this boundary. No special provider-specific code was added.

`PROVIDER_COUNTS` records the actual array received, entries handed to the resolver
after the existing 100-entry per-provider intake ceiling, and that difference. Counts
before provider-internal filters are NOT OBSERVED. Candidate stage counts describe
observed occurrences and may be incomplete after truncation. The raw intake limit,
business quotas, scheduler, normalization, dedupe, probes, Identity and scoring are
unchanged. Missing candidates have no attributed cause unless an explicit rejection
or exclusion decision was observed. A deduplicated-stage count decrease alone is not
a captured per-candidate dedupe decision. Historical/demo gaps stay unknown; fresh
resolver hooks can identify the exact discarded occurrence.

An **anonymized report** contains `REQUEST` content kind, provider ordinal aliases,
typed `SOURCE` transport/height/provenance and the existing counts/decisions. Requested
title, episode coordinates and registered provider identity are absent. This is the
default capture/export/report mode and the only data returned by the normal report
endpoint. No private context is read or converted into public label hashes.

A **private local report** is an explicit `--mode private` opt-in. It may additionally
include the requested title when actually available (never an ID fallback), media
kind/episode coordinates, and validated registered provider ID/name. Fresh episode
contexts additionally carry optional `seriesTitle`, read only from the existing
`NormalizedMediaItem.seriesTitle` enrichment. This strictly validated private field
distinguishes the series name from the legacy requested `title`; historical contexts
without it keep their original meaning. The UI labels the series name (or its absence),
season/episode and unavailable episode title explicitly. The generic catalog name
is not asserted to be an episode title. No extra metadata query or provider request
change is made, and no ID, filename or source title is a fallback. Labels are
classified sensitive, limited to 160 title code units and 96 per provider field,
and rejected if they resemble URLs, credentials, opaque tokens, magnets/hashes,
paths or markup. Missing/rejected labels display as unobserved rather than being
reconstructed from private values. Safe bounded source declarations are now separately
permitted under the private opt-in described in [Private source declarations](#private-source-declarations);
raw filenames and complete configurations are not retained. There are at most 64 provider contexts and 32 KiB
private context per resolution, counted inside the same 2 MiB aggregate budget.
Exceeding a technical diagnostic bound truncates the trace; production still proceeds
normally. Private context byte limits freeze only private metadata, as described below.

The controller is the only private vault owner; the adapter has no retained string
buffer or provider/source objects. The vault shares the session's authority, TTL,
optional retention, deletion and restart behavior. Reads never renew it. It is absent
from normal API/report/status/operational logs and cannot be recovered retroactively
for an anonymous capture. Registry failure logging now uses a generic closed error
without its registered provider ID; existing administrative `/providers` remains its
separate owner-authorized inventory, not a source of per-resolution attribution.

Private JSON has `{version:1, privacy:"PRIVATE_LOCAL", report, context}`. `report`
is the validated anonymous technical report; `context` contains only controlled
resolution-ID-linked fields. The private wrapper has its own format version and
is rejected by the ordinary report validator. `anonymizeDiagnosticExport()` rebuilds
only the anonymous report and drops the entire private namespace by construction;
it does not redact rendered text. New context/provider/source events use technical
report version 2. Capturing an `EXCLUSION` decision upgrades the technical report
monotonically to version 3. Legacy v1/v2 reports remain readable/exportable without
rewriting their data. V1 rejects V2-only events; both V1 and V2 reject V3-only
`EXCLUSION` events. No old field was renamed; the private wrapper stays version 1.

Private HTML is prominently marked **PRIVATE LOCAL REPORT — DO NOT SHARE** (translated
in Spanish). Both views use English defaults, the offline en/es selector and the same
underlying counts, decisions and random candidate IDs. No context enters script code,
innerHTML, external assets or requests. Real private or anonymized capture artifacts
must stay outside Git; sharing an anonymized copy remains an explicit owner action.

Final candidates are observed in `StreamResolver.resolve()` before its finally closes
the sequence. Addon capability registration/publication occurs later. Consequently
the UI says **selected for final resolver output**, and explicitly marks addon
publication, Stremio receipt/display and playback NOT OBSERVED. No recorder reopening,
post-resolution authority channel or US-1504 correlation was introduced to fabricate
client-delivery evidence. CLOSED is not complete traceability.

Overflow closes event admission for the affected resolution and marks both resolution and
session TRUNCATED. Session exhaustion prevents further event admission. Finishing closes
the handle; stop/expiration revoke all handles before recorder finalization. Interrupted
resolutions are TRUNCATED. Recorder factory/write/close/snapshot exceptions cannot escape
capture operations; they switch the controller OFF. Finalization failure discards collected
data and, if retention was requested, retains only a fixed TRUNCATED/RECORDER_FAILURE envelope.
Error messages and exception objects are never retained or logged.

Optional retention holds one detached sanitized report for at most 5 minutes after stop or
the logical expiry deadline. Delayed timer delivery does not extend this window. Starting
again discards the old report and invalidates old handles. `report()` is an in-process DTO
boundary for explicit export; callers receive a copy and must not persist it automatically.
Unreferenced timers clean up without keeping the process alive, and every operation also
checks expiry using an injected monotonic clock (production: performance.now).

## Passive integration and evidence gaps

The application supplies an observation factory through `createStreamResolver`. Resolve
reserves capture before provider work, composes a call-local trace with any existing legacy
consumer, and closes the handle synchronously in `finally`. No shared trace is swapped.
There is no additional await or I/O. Legacy trace consumers retain their existing complete
arrays/references; diagnostics alone bounds reference arrays and ranking projections to 256.
No source array is copied by the adapter. The adapter keeps only a bounded weak reference
map, integer slot sets and immediately validated flat numeric DTOs. It clears them on closure
or loss of capture authority. The recorder never receives an original source or hook object.

The six snapshots are provider, normalized, deduplicated, probed, admitted and final.
Every provider occurrence gets a distinct empty reference, including repeated copies of the
same object. Existing resolver reference propagation carries that occurrence through
normalization and probe replacement. The adapter reads only bridge-owned effective Identity
state and existing probe status; it does not normalize, dedupe, classify or probe anything.
Pre-probe decisions and explicit rejection reasons are projected from the resolver hooks.
`EXCLUSION` adds closed, stage-specific causes at actual normalization, URL-policy,
deduplication, admission and final-quota discard branches. Admission causes are
emitted inside the existing boolean decision branches, never inferred from probe
status or compared snapshots. These hooks do not change the predicates or results.
`IDENTITY_REJECTION` records the existing filter decision without asserting a new
specific contradiction or altering the frozen Identity classification rules.
Snapshots report the source count and how many bounded occurrence references are observable.

Disappearance without an explicit rejection/exclusion produces a CONTINUITY gap with
`INSUFFICIENT_EVIDENCE`. Missing references produce `UNOBSERVED`, using the fixed
`candidateId: "UNOBSERVED"` sentinel rather than inventing an ID from a source. A deduplicated
snapshot can show disappearance but cannot establish which dedupe rule caused it.
No candidate is classified from its absence.

The existing ranking callback and immediately following final snapshot share the same
post-quota order. A per-invocation buffer contains only the seven validated numeric fields;
matching counts and the final occurrence reference permit index correlation. Missing,
non-finite, out-of-range or uncorrelated data is omitted with a RANKING/UNOBSERVED gap.
Scores are never recalculated by the adapter, and the effective JSON policy is unchanged.
The effective comparator group is not emitted by the current hook; an IDENTITY_GROUP /
UNOBSERVED gap records that limitation instead of recomputing it from Identity. Observed
Identity states remain available separately. There is no pre-quota ranking snapshot:
quota removals between admitted and final have insufficient cause evidence.

`END` records SUCCEEDED, FAILED or CANCELLED without an exception object. Failure and
cancellation truncate the captured resolution; the original result or exception retains
authority. Diagnostic observer/factory/finalizer failures cannot escape or trigger retries.
Stop/expiry revoke event admission immediately, even if production work continues. Resolver
and recorder event/candidate/byte budgets are independent: diagnostic overflow never slices,
queues, cancels or changes a production result.

`CLOSED` means the accepted event sequence was closed; it never certifies full resolver
traceability. Full bounded traces can still contain evidence gaps. Report display does not
reclassify candidates, recalculate scores, infer disappearance causes or reconstruct a
pre-quota ranking snapshot. Comparator group remains UNOBSERVED.

## CLI workflow and language selection

### Simple workflows

`npm run diagnostic -- demo` runs three synthetic resolutions through a new isolated
controller, the actual resolver and existing report/HTML exporter. The in-memory
providers return only invented `.example` sources, including a real kind-conflict
rejection and a disappearance whose cause stays unknown. Empty, disabled, failed and
timed-out providers are observed through their actual registry paths. URL-policy address lookup is
injected; there is no probe, outbound transport, HTTP server, production bridge,
Tribler, real media or need for BRIDGE_ADMIN_TOKEN. It does not read production
process configuration or load `.env`; it reuses the checked-in ranking defaults.
The synthetic resolver is loaded only for `demo`, keeping advanced commands independent
of that configuration. Each run writes only `report.html` in a fresh random
directory under Git-verified ignored `.cache/diagnostic-demo/`. Real demo artifacts
are never added to Git. Directory ancestors and no-clobber writes use the same safe
export checks. Only generated local HTML is eligible for shell-free browser opening.
Interactive terminals attempt the platform default browser; noninteractive/CI or
unsupported/failed opening prints the local path and instructions instead. Browser
opening failure does not invalidate an already-created synthetic report.
The demo defaults to private mode with invented titles/names, so its context is useful
without real sensitive input. `demo --mode anonymized` exercises the anonymous view.

`npm run diagnostic -- capture --output .cache/my-capture.html` requires an
already-running bridge and a valid existing BRIDGE_ADMIN_TOKEN. Output is mandatory;
this advanced subcommand does not generate its own output filename. Its defaults are 3 resolution
reservations and 300 seconds; optional `--next N` (1..10), `--ttl SECONDS` (1..300)
and the existing strict local `--bridge` option are supported. It explicitly requests
in-memory retention, arms capture, prints instructions, and polls status every
500 ms. Resolve normally through Stremio; this workflow makes only the existing
start/status/stop/report administrative requests. It cannot create stream requests,
providers, probes, playback, retries or media requests.

It finishes when the requested reservations have no remaining active captures,
when the original TTL expires, or when Enter is received in an interactive terminal.
Concurrency skips remain diagnostic omissions, not delayed production work. It
stops a still-active owned session before validating/exporting the final HTML using
the existing safe no-overwrite writer. Expiry does not renew capture or retention.
HTML always opens in English; use its English / Español selector. `capture` does not
automatically launch a browser or print real report contents or output paths.

SIGINT/Ctrl+C or SIGTERM latches interruption even during an administrative request.
Cleanup attempts to stop and export the owned session exactly once, then returns
exit 130. SIGTERM and delivered SIGHUP use the same path. EOF is ignored; repeated
signals are latched during requests/export. Forced termination cannot guarantee export.
Listeners, timers and input flow are restored when the workflow finishes. A failed
export leaves the bridge OFF where confirmed, preserves existing files and does
not create fallback output; the sanitized retained report may be exported explicitly
within its original retention window. No other real data is written.

Session identity is checked on polls, immediately before stop, and against the final
report. A detected replacement is not stopped/exported (`CAPTURE_REPLACED`, exit 4).
The CLI sends `X-Diagnostic-Session` on stop; the authenticated server compares
the ID and stops synchronously, returning 409 on an active replacement. Legacy
manual stop remains unconditional for compatibility. A start with uncertain outcome or failed cleanup prints
a fixed warning; the original bounded server TTL still applies. An unidentified
session is never blindly stopped. Authentication/network failures use fixed errors
and exit 3; safe output/demo failures use exit 5. US-1506 adds the private operations
and versioned model described above; the original operations and network policy stay intact.

Both workflows default to English; add `--lang es` for Spanish instructions/errors.
Unknown languages are rejected. `demo` accepts no bridge/output/capture options;
`capture` always exports HTML and requires no `--retain`/`--format` flag. The advanced
commands below retain their existing syntax, API payloads, retention and output
semantics. See [workflow QA](qa/v1.5-diagnostic-cli-workflows.md) for actual command,
browser, test and preservation results.

For real context in one command, use
`capture --mode private --output .cache/private-report.html`. Capture defaults to
`--mode anonymized`; the explicit private choice enables the private start/report
operations without exposing context through status or ordinary report reads. For
advanced use, add `--mode private` to start, report or export as appropriate. A private
report requires an opted-in start plus retention; it cannot reconstruct earlier
anonymous context. Default report/export from that same private session still
returns the anonymous projection. Neither mode accepts arbitrary mode values.

Run the existing bridge separately. Advanced commands and capture only call its administrative API; they never
imports or starts a second resolver. Set `BRIDGE_ADMIN_TOKEN` in the environment through
your existing local secret mechanism. It is never accepted as a CLI argument or URL value.

```text
npm run diagnostic -- start --next 3 --ttl 60 --retain
npm run diagnostic -- status
npm run diagnostic -- stop
npm run diagnostic -- report
npm run diagnostic -- export --format json --output .cache/report.json
npm run diagnostic -- export --format html --output .cache/report.html --lang es
```

Start arms the next N ordinary resolutions; it does not initiate media resolution or
probes. Trigger normal Stremio stream discovery between start and stop. `--next` is an
integer 1..10 and `--ttl` is seconds, integer 1..300. Retention defaults to false and
requires `--retain` at start. Stop is explicit/idempotent; the CLI never silently stops
capture to export. `report` validates and prints a safe human-readable summary; explicit
JSON/HTML exports contain the full captured DTO. Export while active returns an error.

Global options are `--bridge http://127.0.0.1:7000` and `--lang en|es`. HTTP authorities
are restricted to literal 127.0.0.1 or localhost, optional canonical port 1..65535, root
path only. Credentials, query, fragments, alternate IP spellings, IPv6, HTTPS and remote
hosts are rejected before token use. This matches the bridge's current IPv4 listener
profile. The native HTTP client connects directly to 127.0.0.1 even for localhost, does
no DNS lookup, ignores proxy environment settings and never follows redirects. Requests
have a five-second absolute deadline and a 2 MiB response limit before JSON parsing.

English (`en`) is always the default, independently of OS/browser locale. `--lang es`
selects Spanish human-readable CLI text; `--lang en` selects English. Unknown language
values are rejected. `help` and `--help` work without a token or network request.
Command names, flags, API fields, JSON schema/version, error codes, enums, identifiers
and captured numbers always remain in English/unchanged. Errors are constant safe messages
with English codes; exit codes are 0 success, 2 configuration/arguments, 3 request or
response failure, 4 report lifecycle conflict/unavailability, and 5 export failure.
No error prints supplied paths, URLs, tokens, upstream payloads or raw exceptions.

JSON and HTML consume the same strictly validated anonymous v1–v7 report or explicit
private wrapper. Validation rebuilds closed
primitive events, bounds counts/arrays/numbers, admits only random UUID-shaped IDs and
the fixed UNOBSERVED gap sentinel, and rejects accessors, extra fields and prototypes.
There is no language field or translated diagnostic datum in JSON. HTML always initially
renders English, including when exported with `--lang es`; that flag controls CLI text.
The English / Español selector switches visible labels, explanations, table/filter
headings, limitations, `html.lang`, document title and accessibility labels offline.
It never changes data, technical codes, scores, identifiers or schema. Small typed
dictionaries cover both languages, with required technical-code translations checked by
TypeScript and missing/empty translations checked at runtime and in tests. Other bridge
interfaces and provider output are outside this localization scope.

## Explicit files and offline HTML

Choose an existing local output directory. Prefer an ignored directory such as `.cache`;
keep real reports out of Git and shared artifacts. The CLI does not create directories.
For a fresh checkout, create the directory with your shell before exporting:

```powershell
New-Item -ItemType Directory -Force .cache | Out-Null
```

On Linux, use `mkdir -p .cache`. JSON is compact UTF-8, at most 2 MiB; HTML is one UTF-8
document, at most 4 MiB. Output paths may contain spaces. Existing files are never
overwritten. UNC/device paths, drive-relative paths, alternate data streams, reserved
device names and known symbolic-link/junction ancestors or targets are refused.
Writes use a random exclusive temporary file in the checked parent, mode 0600 where
supported, flush/close, parent identity recheck, and an atomic no-clobber hard link.
Each writer removes only its own temporary file. Concurrent writers cannot overwrite
the winner. Filesystems without hard-link support fail safely; no overwrite fallback
is used. Cleanup is best effort if the filesystem itself refuses unlink. Node's path
checks do not isolate a malicious same-user process racing directory replacement;
Windows ACLs remain inherited, and no OS sandbox claim is made.

In-memory availability still expires after five minutes without persistence. Explicitly
exported files are user-owned copies and remain until the user removes them. Stop and
expiry never write files. The local HTML provides session/closure summary, fixed diagnostic
ceilings and Trace Workbench, with per-search selection and source inspection. Six stage counts, final positions, actual rejection
reasons and unknown-cause gaps remain visible. UUIDs, the candidate score table,
six score components and detailed timeline are secondary expandable information.
Missing observations display UNOBSERVED rather than invented zeros or causes. Filters
do not modify captured counts. Transport observations, HTTP 200/206, Identity markers and
high scores never establish playback success or audiovisual identity.

The HTML uses no external resource, CDN, image, playback link or network API. Hash-pinned
inline script/style and a default-deny CSP disable external resources and connections.
Embedded JSON escapes HTML/script delimiters; dynamic data enters the DOM only with
textContent and safe element APIs. Local JavaScript is required for tables, filters and
language switching; a no-script notice explains this. There is no framework or live SPA.

### Reproducible manual browser smoke

US-1505 executed a real headless Chrome file-URL smoke with Spanish locale and
offline page emulation, including keyboard navigation and a CSP negative control.
That result is separate from the DOM harness; see the QA report for the browser
version, failed attempts, scope and accessibility/layout limitations. To repeat manually:

1. Use the workflow above to explicitly export to an ignored local HTML file. Open it
   directly as a file with network disconnected and browser developer tools open.
2. Confirm initial English even with a Spanish browser/OS locale, visible capture state,
   stage counts, candidate positions/scores, timeline and gap/limitation notices.
3. Switch to Español and back. Check document language/title, all visible labels and
   accessibility labels; IDs, numeric values and bracketed English technical codes must
   remain unchanged. Exercise phase, observed Identity/probe state and candidate filters,
   and activate a candidate button using the keyboard.
4. Verify the Network panel shows no report-initiated requests and the Console shows no
   CSP/script errors. Compare the embedded diagnostic dataset with explicit JSON export.

Automated tests execute the actual embedded script in a small DOM contract harness and
check language switching, filters, CSP hashes, escaping and dataset equality. This is
not a browser layout, accessibility or CSP-enforcement certification. No browser or
large frontend testing dependency is installed solely for this feature.


### Trace Workbench (US-1507)

The central matrix has one stable Source N row per candidate in the selected search,
and six columns: provider intake, normalized, deduplicated, probed, admitted and final.
Read left to right; click a source or any stage button, or Tab to it and press Enter
or Space, to focus the source inspector. The inspector shows provider attribution,
observed transport/height, reached/last stage, explicit rejection, Identity/probe,
final position and the captured score with six components. Expand its technical
section for UUIDs and events. Scores are displayed, never recomputed.

The symbols and their text labels distinguish positive observation (?), explicit
rejection with a captured reason (?), a recorded continuity gap with unknown cause
(?), unavailable observation (?), and incomplete evidence (?). SOURCE establishes
provider intake; only an actual `OBSERVATION` establishes survival at later stages.
`PRE_PROBE CONTINUE` does not certify normalization (URL policy still follows);
`PRE_PROBE REJECT` marks an explicit rejection at NORMALIZED, with an unknown
specific cause if no reason event was captured. Neither
ranking alone nor count differences fill missing candidate-stage observations.
A rejection cell takes precedence over a positive observation at that stage;
missing cells in incomplete captures remain incomplete. Known evidence is preserved.
Subsequent cells without evidence do not claim rejection, deduplication or a cause.

Use outcome filters for final sources, explicit rejections and recorded continuity
gaps, plus provider, phase, observed state and candidate filters. Filters intersect.
The global source/outcome counts and pipeline counts describe the selected search;
only Visible changes with filtering. Changing searches clears source selection and
filters. Language changes preserve selection and do not change captured facts.
Provider counts distinguish zero returned from disabled/not invoked or unavailable;
final survivors count only attributed candidates positively observed in FINAL.
No provider-internal discovery total is inferred.

Graphite surfaces, petroleum green observations and amber evidence gaps use text
and symbols alongside color. Stage/source controls are native keyboard buttons,
with visible focus; the selected row is highlighted and marked aria-selected.
On narrow screens the inspector follows the horizontally scrollable matrix.
The six-stage matrix intentionally retains its columns: scroll sideways or Tab
through stage buttons. A screen-reader certification remains outstanding.

Privacy is unchanged: private context remains explicitly authorized; anonymized
reports omit titles and registered provider identities. Both modes retain existing
safe-data validation, CSP, no-network behavior and export ceilings. This is an
offline presentation change only. See `docs/qa/us-1507-trace-workbench.md` for local
synthetic browser evidence, performance measurements and actual gate outcomes.


## One-console local session

Run `npm run diagnostic` without a subcommand from the configured source checkout.
The npm entry uses `node --import tsx` so capture handlers run in the entry process
without the tsx CLI child-process signal relay.
It reads the normal `.env` (environment values take precedence), requires the existing
independent `BRIDGE_ADMIN_TOKEN`, and follows `BRIDGE_PORT` (default 7000).
It first checks the existing public addon manifest ID/name/stream resource without
sending a token, then uses the native authenticated localhost diagnostic status request, with
strict DTO validation and the `X-Diagnostic-Protocol: owned-session-v1` capability.
Unauthorized, malformed, incompatible and timed-out listeners fail closed. A public manifest is a process identity hint, not a cryptographic proof against a
hostile local process imitating the bridge. The existing same-user/Bearer threat
boundary remains unchanged. Only an
explicit TCP connection refusal permits startup. An older bridge must be restarted
from this checkout to support conditional ownership; tokens are never passed as
arguments, URLs, bodies, output or browser parameters.

If absent, the production app/configuration is loaded lazily and its listener runs
inside the CLI process. There is no second recorder or background bridge process.
The usual localhost, authorization, URL/SSRF and capture budgets apply. On an owned
listener, starts additionally require the foreground CLI's random in-memory owner ID
in a header; other authenticated starts receive 409. This prevents a competing
session from being created on a listener that the CLI must close afterward. It adds
no persistent secret, token argument or separate process, and changes neither the
normal bridge nor a reused bridge. A reused
bridge stays running and the CLI can finish after export. When the CLI starts its own
bridge, quota, capture TTL and Enter end only the capture: the recorder becomes OFF,
one HTML is exported and optionally opened, and the process stays in the foreground
serving normal Stremio requests. No new capture or resolution counter is started.
`next` remains the existing 1..10 reservation quota; `ttlSeconds` limits only capture,
not service uptime. Enter and EOF after capture do not close the bridge.

Ctrl+C after export closes the owned listener without another stop/export. Ctrl+C
during capture first attempts its one safe stop/export, then closes the owned listener.
SIGTERM and delivered SIGHUP follow the same shutdown path. Only requested shutdown
(or an unsafe/uncertain capture failure) closes the owned service, stopping normal
service cleanup and allowing a two-second HTTP draining grace period. Existing
upstream work keeps its usual timeouts. Repeated signals are latched through cleanup.

Optional `config/diagnostic.local.json` is explicitly Git-ignored; do not add real
preferences or reports to Git. For example, capture five reservations and attempt
browser opening (defaults remain anonymized, next 3, 300 seconds and openReport false;
all keys are optional):

```json
{
  "mode": "anonymized",
  "next": 5,
  "ttlSeconds": 300,
  "openReport": true
}
```

Only these keys are accepted, with strict types. Limits remain 1..10 reservations
and 1..300 seconds. UTF-8 JSON with or without the BOM used by PowerShell 5.1 is
accepted, up to 8 KiB. Invalid preferences fail before bridge/capture operations.
Private mode requires `"mode": "private"` here or `npm run diagnostic -- --mode private`.
Explicit `--mode anonymized` overrides local private consent. `--next` and `--ttl`
also override preferences. Advanced subcommands keep their own defaults and do not
read these preferences; an explicit export of private context still requires
`--mode private`.

The default output directory is created with checks on each ancestor. A custom
`outputDir` must already exist, be local, writable, outside version control or Git-ignored,
and contain no linked ancestors. Windows absolute drive paths and spaces are supported;
UNC/device paths, drive-relative paths, ADS, reserved device components and ambiguous
trailing dots/spaces are rejected. Each run selects a random HTML filename and uses
the existing bounded atomic hard-link/no-overwrite exporter. Windows ACLs remain
inherited, and hostile same-user path races remain outside the filesystem guarantee.
Browser opening is optional, shell-free and limited to interactive supported sessions;
a launch failure leaves the saved report usable and prints manual opening instructions.

An active capture or retained report is left untouched. Export an existing report
with the advanced commands and wait for its retention TTL (at most five minutes)
before starting another session on that bridge. Guided start sends
`X-Diagnostic-Preserve-Report: true`; the server atomically refuses to replace a
retained report even if it appeared after preflight. The optional ownership headers
add restrictions only and do not change legacy request bodies or authorization.

Completion means quota reservations consumed with no active diagnostic captures,
TTL expiry, Enter, or a handled signal. EOF is not a finish command. Ctrl+C, SIGTERM
and delivered SIGHUP attempt one stop and one valid HTML export, including when
signals arrive during requests. A successful Ctrl+C save prints its path and exits
130; an export failure preserves its error exit code for eventual shutdown instead.
No private report contents or raw exception text are printed. Existing output is
never overwritten and there is no alternate fallback destination.

If export fails after capture has been confirmed OFF (including report read/validation,
rendering or filesystem failure), an owned bridge stays in the foreground serving
Stremio. The error is printed immediately, without automatically retrying, rearming
the recorder or extending retention. If a valid retained report exists, fix the output
directory permissions/hard-link support and recover explicitly before retention expires
(at most five minutes after closure). For example, from another terminal:

```text
npm run diagnostic -- export --format html --output .cache/recovered.html
```

Preserve the local admin environment; for a non-default service port, pass its
`--bridge http://127.0.0.1:PORT` explicitly to the export subcommand; `--mode private` is
required only for an explicitly private session. A missing, invalid or expired report
may not be recoverable. A successful manual export does not trigger another automatic
report. Ctrl+C then closes the owned bridge; a prior export failure remains its exit
code even if manual recovery succeeded. If shutdown was already requested when the
export failed, the CLI reports that the owned bridge will close and unexported memory
will be discarded. With a reused bridge, errors terminate the CLI while leaving that
service and its bounded retained report untouched. Uncertain capture/cleanup failures
keep the previous fail-closed behavior; they do not claim the recorder is safely OFF.

Windows window-close/X and forced process termination are **not guaranteed saves**.
Windows can terminate a process after delivering SIGHUP with too little time for
asynchronous I/O; npm/terminal signal delivery also depends on the console. Use Ctrl+C
and wait for the printed export path. No persistent capture, shutdown service,
background process or orphan is installed to simulate a guarantee. Automated signal
tests establish handler behavior; they do not certify a physical console-close event.
US-1507 title, causality and matrix corrections and executed gates are recorded in
[US-1507 QA](qa/us-1507-trace-workbench.md). Real playback/client delivery remain unverified.


## US-1507 causal decision contract

V3 `EXCLUSION` is a flat DTO with only `candidateId`, `kind`, `stage`, `reason`.
The in-process opaque occurrence reference is mapped to a random ID; no provider
objects, media labels, URLs, errors or headers cross this boundary. Validators reject
unknown keys, reason values and stage/reason combinations. Existing `REJECTION`
events keep their original identity-specific semantics.

| Stage | Closed EXCLUSION reasons |
| --- | --- |
| NORMALIZED | INVALID_SOURCE, IDENTITY_REJECTION, URL_POLICY_REJECTION |
| DEDUPLICATED | DUPLICATE, MISSING_DEDUP_KEY |
| ADMITTED | IDENTITY_REJECTION, PROBE_MISSING, PROBE_BUDGET_EXHAUSTED, DETERMINISTIC_PROBE_REJECTION, HLS_NOT_VERIFIED, DIRECT_MEDIA_NOT_VERIFIED |
| FINAL | PROVIDER_RESULT_LIMIT |

`DUPLICATE` identifies the actual discarded occurrence at each existing local/global
winner comparison, including replacement of a previous winner. Missing occurrence
attribution remains an evidence gap. `PROBE_BUDGET_EXHAUSTED` is emitted only when
the existing admission predicate rejects a direct source for that explicit probe
status; a candidate never probed under the scheduler cap has `PROBE_MISSING` instead.
An observed `unreachable` source may still survive. A completed deterministic failure,
unverified HLS or opaque direct media may cause admission rejection under their
existing rules. Observations alone never establish these causal decisions.

The summary groups captured exclusions by search, reason and decision stage, and
unknown disappearances by search. Source inspection retains each occurrence's
observed probe/Identity state, decision and causal reason separately. For unattributed
disappearances it shows the last actual observation and preserves
`INSUFFICIENT_EVIDENCE`. Positive matrix cells use individual survival evidence;
rejections mark the decision stage without adding it to the survived-stage list.
Aggregate snapshots remain counts, and incomplete captures keep absent cells uncertain.
Historical reports acquire no new causal events during rendering/export.


## Provider failure categories and the PROBED boundary

Provider participation remains `PROVIDER_STATE`: successful results, empty results,
failed execution, registry timeout, cancellation, disabled and not-observed are
separate outcomes. Technical report **v4** adds a separate flat `PROVIDER_FAILURE`
event containing only a numeric provider slot and a closed category. Existing
PROVIDER_STATE fields and semantics do not change. V1/V2/V3 reports remain readable
and exportable; they reject v4 events. A captured failure event upgrades the report
monotonically to v4 even if later EXCLUSION or SOURCE events follow. Historical
failures without category evidence render as "Failure category not captured", not
as newly classified failures.

| Category | Actual evidence at the existing registry catch boundary |
| --- | --- |
| REGISTRY_DEADLINE | The same bridge-owned deadline state that selects TIMED_OUT; no upstream timeout-message interpretation |
| URL_POLICY_REJECTED | The caught object is an existing bridge-owned ExternalUrlPolicyError |
| CAUSE_UNDETERMINED | FAILED with no reliably distinguishable typed cause, including generic adapter/transport/parse errors |

Cancellation stays CANCELLED and emits no failure event. Zero results stay
RETURNED_ZERO, disabled providers stay DISABLED, abandoned work stays NOT_OBSERVED.
No exception message, name, code, stack, cause, response, URL, ID or provider name
is copied or parsed. Prototype-test failures from hostile thrown objects fall back
to CAUSE_UNDETERMINED. With observation OFF no error classification or new failure
DTO/callback allocation runs. Observer errors cannot change production results.

At this boundary the external HTTP and addon adapters use generic Error values for
HTTP responses, JSON/schema/size guards and many request failures. DNS, redirect,
body-read, upstream adapter/Python/Kodi and internal exceptions are not reliably
distinguishable from each other without changing error propagation. They remain
CAUSE_UNDETERMINED rather than being guessed from text or all called timeouts.
That deeper classification is deliberately deferred; no provider, Python/Kodi or
HTTP transport error semantics were changed.

The note next to **PROBED** explains that this snapshot counts candidates reaching
the boundary, not necessarily HTTP probes executed or verified transports. The
optional breakdown counts only captured PROBED OBSERVATION probe states, including
UNOBSERVED, and is explicitly labelled as states rather than HTTP request counts.
It appears only when that resolution is closed, the latest SNAPSHOT
count equals its observed count, and the number and unique IDs of individual
observations exactly match it. Otherwise the breakdown is unavailable. Aggregate
snapshots themselves are unchanged. No transport split is inferred from earlier
SOURCE records, since they are not transport observations at the PROBED boundary.
Translations, native table labels/focus, offline operation and the hash CSP apply
to both modes. More events consume the same existing capture limits.

See [provider failure QA](qa/v1.5-provider-failure-observability.md) for executed
synthetic gates, exact scope and remaining limits. No new release is implied.

### Deterministic probe rejection evidence (technical report v5)

The existing ADMITTED / DETERMINISTIC_PROBE_REJECTION exclusion may carry
`probeCause`, and only HTTP_CLIENT_ERROR carries integer `httpStatus` (400..499,
excluding 408, 425 and 429). The same pure resolver predicate drives backfill and
admission; admission passes its winning cause to the observer. Diagnostics do not
reinspect sources, errors or response bodies. No new event, request or retry is added.

| Precedence | Observed condition | Detail |
| --- | --- | --- |
| 1 | Probe status route_rejected | ROUTE_REJECTED |
| 2 | ZIP signature already recorded by the probe | ARCHIVE_ZIP |
| 3 | Recorded HTML/XML/JSON document signature | DOCUMENT_REJECTED |
| 4 | Status unreachable plus deterministic HTTP 4xx | HTTP_CLIENT_ERROR + bounded numeric status |
| Fallback | Historical rejection predicate matches but detail is malformed | CAUSE_UNDETERMINED; no status payload |

Identity/runtime rejection and budget exhaustion retain their earlier admission
precedence. HTTP 408/425/429, 5xx, timeout and connection failure alone do not become
deterministic. Missing evidence produces no invented specific cause. For example,
an unrecorded HLS child response cannot be inferred from the root's HTTP 200.
HTTP 403 reports observed access denial, not an external cause or permanent failure.

The candidate inspector and its event timeline show the observed cause in English
or Spanish; HTTP 404 displays "Resource not found". Generic HTTP statuses retain
their validated numeric code. No document body/type string, URL, path, domain,
title, header, credential or arbitrary exception text is added to the event.
These closed facts are safe in anonymous exports; PRIVATE_LOCAL remains separate.

V5 is selected only when a detailed exclusion is recorded and never downgraded.
V1..V4 historical reports remain readable; missing detail renders as not captured,
never reconstructed from later observations. Older versions reject the new fields,
and older readers may reject v5. The private envelope remains version 1.
Both CLOSED and TRUNCATED reports retain recorded detail without synthetic terminal
events. Added bytes consume the unchanged event/DTO/HTML budgets and may cause
earlier truncation; capture still cannot change production admission or probe limits.

### HLS verification failure detail (technical report v6)

HLS_NOT_VERIFIED remains the admission reason. Its optional `hlsPhase`, `hlsCause`
and shared bounded integer `httpStatus` come from probe-owned `hlsFailure`, not from
HTML heuristics or exception messages. V6 is selected only when HLS detail is stored;
v5 deterministic details remain unchanged. V1..V5 remain readable, with absent HLS
detail explicitly shown as phase/cause not captured. Older readers may reject v6.
The private envelope stays version 1 and anonymous exports contain closed facts only.

| Observed phase | Existing operation |
| --- | --- |
| INITIAL_MANIFEST | Initial request/fallback and root manifest reading/validation |
| VARIANT_PLAYLIST | Selected variant request, reading and playlist-reference validation |
| AUDIO_PLAYLIST | Already selected audio rendition request, reading and reference validation |
| MEDIA_RESOURCE | Existing representative video/audio segment checks |
| MAP_RESOURCE / KEY_RESOURCE | Existing required initialization-map/key checks |

Closed causes are HTTP_RESPONSE (with HTTP status 100..599), EMPTY_BODY,
MANIFEST_TOO_LARGE, MANIFEST_LENGTH_MISMATCH, MANIFEST_INVALID,
PLAYLIST_TYPE_MISMATCH, PLAYLIST_DEPTH_LIMIT, NO_MEDIA_REFERENCE,
NO_DISTINCT_MEDIA_REFERENCE, RESOURCE_INVALID, TIMEOUT, ROUTE_REJECTED,
BUDGET_EXHAUSTED and CAUSE_UNDETERMINED. A phase may be absent only for an
undetermined cause. HTTP status is forbidden on non-HTTP causes and belongs to the
operation that failed: a child HTTP 404 is never replaced by root HTTP 200.

The reader's optional failure callback only marks the conditions of existing throws;
it does not change validation, reads, cancellation or exception values. Segment
validation reports its existing coarse byte-check failure, without retaining bytes
or claiming a codec/content identity verdict. Invalid URI/reference parsing, UTF-8
decoding and generic read/connection failures may remain undetermined: the existing
untyped errors do not reliably distinguish them. Their operation phase can still be
known. No external-error message/code dictionary is used to infer a cause.

Known budget exhaustion takes precedence, then typed route/timeout evidence, then
the explicit failure condition at that operation, otherwise CAUSE_UNDETERMINED.
Admission precedence is unchanged: Identity, probe budget and deterministic root
failures can win before HLS_NOT_VERIFIED. For example root HTTP 404 is still a v5
deterministic exclusion; a variant HTTP 404 after a successful root can produce the
v6 HLS detail. The root responseStatus field remains root-only.

Only the bounded HLS failure facts are retained with existing cached probe results.
Cache keys, TTL, scheduling, requests, fallback, selection, validation and cancellation
are unchanged. Extra event bytes consume the same budgets and can advance truncation;
stop/expiry/invalid input still revoke capture, without invented FINAL/END events.
No manifest, segment, filename, URL, headers, credentials or arbitrary error is copied.

In EN/ES, ADMITTED is labelled "Admission evaluation" / "Evaluación de admisión";
the technical code and all counts remain unchanged. The inspector presents PRE_PROBE
Identity separately as preliminary. The effective display excludes PRE_PROBE as a
fallback: UNKNOWN there does not manufacture a later effective state. UNCLASSIFIED
means no effective classification was observed, not that an earlier assessment was
overturned. These are presentation changes only; Identity decisions are unchanged.

### Private source declarations

Opt-in private Trace Workbench captures can show each source's provider-stage name/title
and explicitly declared Identity title/episode coordinates in the source inspector.
These are untrusted declarations from adapted provider output, separate from the requested
title and bridge-owned Identity observations. Original upstream names may already be lost.
Unsafe/overlength values are withheld whole; no descriptions, URLs, filenames or external
identifiers are added. Missing values are not inferred. Failed providers delivering no
candidates have no individual metadata. Existing limits may mark a capture incomplete.
Anonymous reports remain unchanged; historical private reports remain readable.
See [privacy, feasibility and verification](qa/private-source-metadata.md).

Fresh private captures also distinguish closed reasons for missing declared labels:
absent at the observer boundary, empty, non-text, unreadable, overlength or withheld
by privacy policy. Historical reports cannot establish those reasons retrospectively.
Actual private context/report byte denials are marked separately and remain incomplete.
After a marked CONTEXT_LIMIT or REPORT_LIMIT denial, private context is frozen: no
further names, titles or provider metadata are added, and later callbacks cannot
reset the marker. This does not stop the technical recorder. Opaque candidate IDs,
stage observations, exclusions/rejections, final ranking and END continue within
their existing budgets. The session remains TRUNCATED to disclose private omissions;
a resolution can be CLOSED when its technical recording completed without loss.
The existing marker describes omitted private metadata, not lost technical events.

No new summary DTO, sensitive field, retention extension or increased budget is used.
Technical event/byte ceilings, stop, expiry and invalid input still truncate/revoke
the trace; terminal capture is not guaranteed after those independent limits. A
missing FINAL or END is never synthesized. Historical truncated traces stay partial;
new code cannot recover their missing decisions. Complete resolutions retain their
probe-state breakdown even when a sibling or private metadata truncates the session;
missing, duplicate or mismatched boundary observations still suppress that breakdown.

The codes contain no rejected values and do not recover upstream fields that an adapter
already omitted. In particular, source_pack name-only candidates can reach Node without
any title; changing that mapping requires separate adapter work.

New private source declarations optionally attach a sparse `labelReasons` map to
WITHHELD fields: CONTROL, URL_MARKER, LOCATOR_CHARACTER, MARKUP, SENSITIVE_TERM,
OPAQUE_RUN or UNSUPPORTED_CHARACTER, in that precedence order. These report lexical
matches, not proof of dangerous content. OVER_LIMIT is separate; historical missing
reasons remain unknown. Only validated private
inspectors show reasons; anonymous exports and the ordinary CLI remain unchanged.
The synthetic label-policy tests cover these lexical boundaries. Real reports and
private smoke aggregates are excluded from the public source distribution. This
contract does not certify real-provider availability or audiovisual correctness.

#### Text format normalization (2026-11-03)

Fresh captures collapse tabs, CR/LF, vertical tab, form feed, NEL and Unicode
separator runs to one ASCII space and trim edge spaces. Existing internal runs of
ASCII spaces are preserved for historical report compatibility. All lines remain subject
to privacy validation; no first-line selection, truncation or description fallback
is used. Unicode letters, marks, numbers, punctuation and symbols (including square
brackets, quotes, dashes and emoji without format controls) are accepted for private
labels. Spelling and combining marks are preserved. Raw input still has a hard
160 UTF-16-unit ceiling (96 for provider labels), checked before normalization.

Format acceptance never authorizes disclosure. Titles are permitted only in the
existing opt-in PRIVATE_LOCAL context, with the same access, retention and byte
budgets; anonymous JSON/HTML and ordinary logs/CLI gain no titles or new fields.
The whole label is still withheld for URL markers, slash/backslash/equals/at-sign,
angle brackets, sensitive keywords and long opaque ASCII runs. Detection also
checks compatibility Unicode forms and whitespace-obfuscated URL/credential terms.
Other controls, invisible formatting (including bidi/zero-width characters), lone
surrogates, private-use characters and percent-encoded text remain rejected.
Strict imports require the already normalized value; they do not repair payloads.

These conservative heuristics can still reject innocent slash-separated titles,
keyword-bearing narrative titles or long release identifiers. Bare domains and
private facts in ordinary prose are not reliably detected; PRIVATE_LOCAL is not
an anonymization guarantee. Historical WITHHELD values cannot be recovered or
reclassified. The earlier investigation above describes the previous filter;
no new live classification campaign or recovery percentage is claimed.
