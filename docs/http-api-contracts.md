# HTTP API contracts

The inventory originated in private development checkpoints. Maintained endpoint contracts are mapped to the source files and regression cases in this document; HTTP/HLS privacy and lifetime evidence is indexed in [HTTP transport privacy](http-recipient-privacy.md#implementation-and-evidence-map) and [HLS token lifecycle](hls-token-lifecycle.md). Historical checkpoint results retain their original scope and are not new executions.
This records the current API; it introduces no routes, status normalization or new security exceptions.
Both services are local tools. Node binds a configured loopback address; Python binds `127.0.0.1`.
Neither service is intended for remote exposure; CORS does not authenticate a local process.

## Compatibility rules

Consumers should read the documented envelope and required fields, tolerate additional fields,
and treat diagnostic counts, timing values, provider order and token values as variable.
Exact JSON key order, framework-generated HTML errors, reason phrases, ETags on JSON,
and diagnostic error class names are not portable schemas. The tests pin selected current
error classes for regression diagnosis, not a promise to preserve every internal class name.
Changing endpoint meaning or established success/error statuses requires explicit compatibility review.

Node JSON responses use `application/json; charset=utf-8`; `X-Powered-By` is disabled.
The localhost authorization boundary precedes CORS, parsing and all handlers (see below).
For authorized requests, body parsing precedes routing:
JSON bodies are limited to 32 KiB. Malformed or oversized JSON currently returns **400**,
not 413, through the common error handler. Non-JSON bodies are not parsed as JSON;
`POST /resolve` then fails required-field validation with 400. Node has no general 405
envelope: unsupported route/method combinations normally fall through to 404.
The boundary terminates OPTIONS before the SDK; preflight is not a business operation.

### Required localhost boundary

Every request requires one Host matching the effective listener port: `127.0.0.1` or
`localhost` (case insensitive). A missing port is accepted only on port 80. IPv6 `[::1]`
requires an actual IPv6 loopback listener. Malformed or duplicate Host returns generic 400;
an authority outside this profile returns generic 403, without CORS or handler effects.
Absolute/proxy request targets and ambiguous path separators are rejected. Forwarded headers
do not affect authorization or generated URLs. Startup rejects PUBLIC_BASE_URL outside the
direct HTTP/root-path/configured-port profile.

| Family | Required authorization and CORS |
| --- | --- |
| Manifest | Public after Host validation; ACAO `*`, no credentials |
| Catalog, meta, stream (including extra paths) | Exact Origin `https://web.stremio.com`; ACAO matches that origin. No native discovery exception. Present Fetch Metadata must be complete and coherent; no navigation, documents or user activation. A present Referer must have that same origin. |
| Auto, play | Same Origin policy, or native GET/HEAD with no Origin, Referer or Fetch Metadata. Hashes, IDs and previous source visits do not authorize a new request. |
| Source, HLS | Existing valid opaque capability for the requested source/resource; ACAO `*`, no credentials. Null/foreign Origin may use a valid capability but cannot acquire one through discovery. |
| Health, providers, resolve, downloads and descendants | One `Authorization: Bearer <BRIDGE_ADMIN_TOKEN>` header, with no Origin, Referer or Fetch Metadata. Secret is independently provisioned as 32 random bytes encoded in 64 hex characters. No administrative CORS. |

Administrative routes return generic 403 if no secret is configured, and generic 401 with
`WWW-Authenticate: Bearer` for missing/incorrect credentials when enabled. Browser context or
administrative OPTIONS returns 403 even with correct credentials. These responses and all
administrative responses use `Cache-Control: no-store`; no credentials appear in URLs or
public responses. Malformed configured secrets fail startup. Existing operator clients must
add Bearer authorization to both reads and writes, including HEAD and pin/unpin.

Non-administrative preflights terminate with 204 only for admitted families/contexts and
GET/HEAD with Range, If-Range or Content-Type requested headers. They perform no preparation
or token renewal. Discovery CORS cannot be widened by SDK response headers. Responses vary
on Origin, Referer and Fetch Metadata; stream responses are no-store so capabilities are not
reused through shared caches. Playback sets `Referrer-Policy: no-referrer` and exposes only
Content-Length, Content-Range, Accept-Ranges and local ETag/Last-Modified validators.

The route envelopes below describe requests that have passed this boundary. Denied requests
end before parsing, provider/Tribler calls, playback preparation or mutations. Local processes
can forge these headers; the native branch is compatibility policy rather than cryptographic
authentication. See [security limits](../SECURITY.md).

## v1.4 stream array order

Stream discovery serializes final resolver order: bridge-owned CORROBORATED,
then UNKNOWN and unclassified together, then SUSPICIOUS. Within each group,
the existing technical JSON policy applies, followed by descending seeds,
ascending size and stable input ties. Provider trust declarations do not supply
authoritative classification; supported contradictions remain excluded upstream.

`STREAM_MAX_RESULTS_PER_PROVIDER` caps final distinct results independently per
provider after deduplication, admission, classification and ranking. It defaults
to 50 when absent and accepts integers 1 through 100; invalid values (including
an empty value) fail configuration explicitly. The raw safety cap remains 100
per provider. Changing the final cap affects only the retained ranked subset,
not scoring, probes or earlier admission stages; there is no global cap of 50.
At or below that cap the admitted source set is preserved; above it the selected
subset can change. Normalization, deduplication, probing, timeouts and budgets
retain their contracts. HTTP(S), HLS and Tribler have no absolute transport
priority. Array order is distinct from JSON object key order, which remains
outside the portable schema contract.

Public streams retain opaque localhost playback capabilities and compact
presentation. With ranking details disabled (the default), no numeric score is added.
`STREAM_RANKING_DETAILS=true` adds the bridge-calculated F score/components
through the existing `title` field. Neither mode adds a new identity label, raw
source locator, request header or internal ranking trace. Synthetic regressions are in
`tests/stream-identity-ranking.test.ts` and
`tests/integration/public-identity-order.test.ts`. This does not close R-020 or
certify audiovisual identity; see the [v1.4 QA report](qa/v1.4-release-qa.md).

## Node routes

`GET` routes also support bodyless `HEAD`. Playback has explicit HEAD handlers;
the other routes inherit Express/SDK HEAD behavior. Dynamic health/metrics can change
between calls; HEAD is not a snapshot or a guarantee of identical JSON Content-Length.

| Endpoint / method | Request | Success response | Important other outcomes |
| --- | --- | --- | --- |
| `/health` GET, HEAD | None | 200 `{ok:true, bridge:"ready", tribler:"reachable", downloads:number, providers:object, httpPrivacy:object, triblerStreaming:object}` | 503 degraded or unavailable (below) |
| `/providers` GET, HEAD | None | 200 `{providers: ProviderDiagnostic[]}` | Diagnostics reflect completed invocations, not a live availability probe |
| `/downloads` GET, HEAD | None | 200 `{downloads: DownloadDiagnostic[]}` | Tribler/service errors use common mapping |
| `/resolve` POST | JSON `{source:string, fileIndex?:number}` | 200 `ResolvedStream` | 400 missing/invalid input; service mapping below |
| `/downloads/:infohash/select` POST | JSON `{fileIndex:number}` | 200 `ResolvedStream` | 400 missing/invalid index or absent file; 422 unsafe file |
| `/downloads/:infohash` DELETE | Optional `?removeData=true` | 204, no body | 409 active stream; service mapping below |
| `/downloads/:infohash/pin` POST | No body required | 200 `{bridge: ManagedDownload}` | 404 unmanaged; 409 external ownership |
| `/downloads/:infohash/pin` DELETE | No body required | 200 `{bridge: ManagedDownload}` | 404 unmanaged; 409 external or not pinned |
| `/manifest.json` GET, HEAD | None | 200 Stremio manifest | Resources `catalog`, `meta`, `stream`; types `movie`, `series` |
| `/catalog/:type/:id.json` GET, HEAD | Optional `/:extra.json` with Stremio encoded `skip`/`search` | 200 `{metas:[]}` or catalog metas | Catalog failures return empty results |
| `/meta/:type/:id.json` GET, HEAD | Stremio type and media ID | 200 `{meta:object|null}` | Unknown owned item or handled metadata failure: null |
| `/stream/:type/:id.json` GET, HEAD | Stremio type and exact video ID | 200 `{streams:[], cacheMaxAge:0}` or stream entries | Handled resolution failure: empty array; SDK unsupported resource/type may fall through to 404 |
| `/source/:token/:filename` GET, HEAD | Opaque in-memory source token; optional Range / contained If-Range | Direct media 200/206; torrent preparation 307 to local `/play` | 400 unknown/invalid/expired token; 502 direct failure before headers; valid unsatisfiable Range 416 |
| `/hls/:token` GET, HEAD | Opaque resource token; optional Range / contained If-Range | Rewritten playlist or media dependency, 200/206 | Unknown/expired token 400; proxy exceptions use common mapping, usually 400; valid unsatisfiable Range 416 |
| `/play/:infohash/:fileIndex/:filename` GET, HEAD | Hex hash, nonnegative integer index; optional single byte Range | Media 200/206, relevant media headers | HEAD invalid path/metadata 400, missing file 404, invalid range 416; GET upstream status passthrough, proxy failure 502, abort/timeout before headers 504 |
| `/auto/:token/:filename` GET, HEAD (legacy) | Encoded media ID; optional `file`, `fileIndex`, `source=tribler` | Direct media or 307 local `/play` redirect | Direct/selection failure 502; cancelled operation may attempt 499 before headers |

`source` on Node `/resolve` is a torrent source (supported magnet, hash or torrent URL),
**not** the Python media-item request and not a generic direct-media discovery endpoint.
Optional `fileIndex` selects a particular torrent file. Current handlers apply JavaScript
`Number(...)` coercion to supplied indexes and ignore unknown JSON fields. Consumers should
send integer JSON numbers; coercion edge cases are incidental behavior, not a new strict validator.
Only the literal query value `removeData=true` requests data deletion.

`ResolvedStream` is `{infohash:string, file:TriblerFile, url:string}`. `TriblerFile` includes
`index`, `name`, `size`, `included`, `progress` and optional `priority`. The URL points to local
`/play`, whose hash/filename are intentionally visible. This administrative response is not opaque.

`ManagedDownload` includes `infohash`, `createdAt`, `lastAccess`, `ownership`, `servedBytes`,
`activeStreams`, and optional `retention`, `selectedFileIndex`, `selectedFileName`.
Ownership is `EXTERNAL` or `BRIDGE_OWNED`; retention is `EPHEMERAL`, `RETAINED` or `PINNED`.
Pinning requires bridge ownership; unpinning renews retained lifetime. Active playback prevents deletion.

Download diagnostics project only `infohash`, `name`, `status`, `progress`, `speed_down`,
`speed_up`, `num_peers`, `num_seeds`, optional `time_added`, `size`, and managed `bridge` data.
Names containing HTTP URLs or magnets are replaced with `[redacted]`. Arbitrary upstream fields
are omitted. Missing upstream fields may be absent; diagnostics are not a new Tribler schema validator.

Provider diagnostics require `id`, `name`, `enabled`, `status`; status is `never-run`, `disabled`,
`ok` or `error`. Optional fields include `type`, `supports`, `streamCapabilities`, `latencyMs`,
`lastError`, `identityRejections`. Failure text is bridge-owned, not the provider exception.
Health returns 503 with `{ok:false, bridge:"degraded", tribler:"reachable", ...}` when an enabled
provider has failed. An unreachable Tribler produces `{ok:false, bridge:"unavailable",
tribler:"unreachable", providers, httpPrivacy, error:"Tribler health check failed"}` without downloads.
Python health, by comparison, reports host liveness/configuration even after resolver failures.

Common Node errors are `{error:"Request failed", type:string}` with no exception message or stack.
Current mapping: missing managed download 404; active/retention conflict 409; no seeds,
no video or unsafe file 422; metadata timeout 504; Tribler error carries its status except
upstream 401 maps to 502; other exceptions map to 400. Route-specific proxy errors use
their fixed `{error:string}` messages. Once headers/bytes are sent, a failed response can
end or disconnect; a JSON error/status replacement is not guaranteed.

## Playback headers and privacy

Successful media responses carry applicable Content-Type, Content-Length, Accept-Ranges and
Content-Range. Partial media is 206; unsatisfiable supported single ranges are 416 with
`Content-Range: bytes */total`. Multi-range multipart output is not supported. Direct transport
validates framing and range semantics; it need not reproduce arbitrary upstream behavior.
Tribler GET is a proxy; HEAD derives metadata from the file listing, so their failure semantics differ.

Resolved Stremio streams contain a local opaque `/source` URL, `name`, optional safe `title`, and
`behaviorHints.notWebReady:false`; they expose neither remote source URL nor raw source headers.
`/stream` responses advertise `Cache-Control: no-store`. This response-cache policy is separate
from the internal playback-token lifetime. Source tokens are random 24-byte
base64url values stored in memory. A source token and its retained HLS descendants share an
inactivity deadline, renewed by admitted GET/HEAD access on any retained token using
`HTTP_STREAM_TOKEN_TTL_SECONDS` (default one hour), even if the subsequent upstream request fails.
Playlist rewriting, response completion and representation observations do not renew it. At the
deadline, including equality, the entire tree loses authority and cannot be revived. Child removal,
eviction or restart also invalidate affected tokens; an evicted token is indistinguishable from an
unknown token. Incomplete token paths fall through to 404. See the canonical [HLS token lifecycle](hls-token-lifecycle.md)
for replacement, capacity pressure, revocation and separate legacy `/auto/` trees.

Rewritten HLS GET has `Cache-Control: no-store` and a rewritten byte length. HEAD does not
advertise original upstream playlist length/validators or guarantee a rewritten GET length.
HLS child URLs use local resource tokens. See [validator containment](http-recipient-privacy.md#representation-binding)
for bridge-owned validators and If-Range handling, and [recipient headers](http-recipient-privacy.md)
for exact local authorization rules, redirects, DNS and SSRF restrictions.

Opaque URLs are bearer capabilities, not anonymous access control. This guarantee does not apply
to legacy `/auto` (reversible media-ID encoding and filename/query data), `/play`, administrative
downloads/resolve responses or raw catalog metadata. Python returns normalized source URLs/magnets
to its configured bridge caller by design. None of those surfaces promises universal metadata secrecy.
HLS text minimization covers the documented cases in [HLS text privacy](http-recipient-privacy.md#hls-playlist-text-privacy);
**R-020 remains open**. Universal HLS metadata sanitization is explicitly not claimed.

## Python adapter host

| Endpoint / method | Request | Response / status |
| --- | --- | --- |
| `/health` GET | None | 200 `{ok:true, service:"tribler-stremio-python-adapter", activeResolvers:number, maxConcurrentResolvers:number, resolverTimeoutSeconds:number, requestTimeoutSeconds:number}` |
| `/resolvers` GET | None | 200 `{resolvers:[{id,name,enabled,status,latencyMs?,resultCount?,lastError?}]}` |
| `/resolve` POST | JSON media item below | 200 `{streams: StreamSource[]}` including successful empty results |

Python reads the path independently of query parameters. GET on unknown paths (including
`/resolve`) and POST outside `/resolve` return 404 `{error:"not found"}`. PUT/PATCH/DELETE
return 405 `{error:"method not allowed"}`. HEAD and OPTIONS are unsupported by BaseHTTPRequestHandler:
501 with framework HTML (HEAD has no body). There is no GET/HEAD equivalence contract here.

Media items require `id`, `title`, and `kind` or legacy `type` (`movie|series|episode`);
`kind` takes precedence. Only episode titles may be empty. Optional fields are `year`, `season`,
`episode`, `externalIds`, `classifications`, `stremio`, `metadata`, `seriesTitle`.
Unknown top-level fields are rejected. Integers exclude booleans; structured fields have bounded
sizes/depths enforced by `adapter_host/models.py`. Requests never choose resolver imports,
callables, commands, addon paths, settings or worker configuration.

Stream entries are normalized provider results: `providerId`, supported `type`, the corresponding
`url`/`magnet`/`infoHash` locator, and optional `fileIndex`, presentation/quality/audio/language fields,
`sizeBytes`, `seeds`, `metadata`. These are producer data, not public player URLs. Result counts are
bounded per resolver and globally, deduplicated and validated; do not assume registration order.

All handler JSON responses, including errors, have UTF-8 JSON Content-Type, exact Content-Length,
`Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.
POST requires `application/json` (parameters accepted) or returns 415. Fixed-length and chunked
bodies accept at most 32768 bytes; oversized input returns 413. Malformed JSON, invalid UTF-8,
invalid framing or media validation errors return 400. Errors have `{error:string}`; validation
messages are bounded to 200 characters, not intended as machine-readable error codes.
Missing Content-Length requires chunked encoding.

Global request deadline returns 504 `request timeout`. When all participating enabled locally
configured Kodi profiles fail, the request returns 503 `configured resolvers unavailable`.
A healthy configured profile, including a successful empty result, can preserve 200 despite a
failed sibling. Optional resolver failure is isolated. Unexpected host errors return 500
`internal server error`. Worker exception details, traceback, local paths and environment must
not reach public errors. Client disconnect cancels work and cleans up workers; no response
after disconnect is guaranteed. The supported Windows launcher excludes Tribler URL/API variables
from the host environment before process creation, and worker sanitization is a separate boundary.
Direct Python and embedded service entry points reject either Tribler variable, including empty
values, but cannot undo interpreter inheritance or startup hooks. Other launchers must supply a
clean environment; see [F4 evidence and limits](../PRIVACY_AUDIT.md#known-limitations).

## Executable inventory and coverage reuse

| Contract area | Existing evidence reused | New focused evidence |
| --- | --- | --- |
| Readiness/providers and degradation | `tests/system/bridge-process.test.ts` A01, A10, A12, A13, AC8; `tests/integration/bridge.test.ts` diagnostics | `tests/integration/http-contract.test.ts`: envelopes, HEAD, headers, unavailable error privacy |
| Download resolve/delete/pin/restart/active protection | System AC7; `tests/download-service.test.ts` | HTTP selection envelope, missing pin, invalid selection, download field projection |
| Manifest/catalog/meta/streams | `tests/integration/bridge.test.ts`, `stremio-movie-metadata.test.ts`, `standard-stremio-addon-fixture.test.ts`; system A03, PR23 | Explicit envelopes, unknown meta, opaque playback URL, HEAD |
| Source media GET/HEAD/Range, abort | `tests/integration/direct-http-playback.test.ts` AC5; `bridge.test.ts` | Missing/invalid/unknown/expired source tokens |
| Tribler GET/HEAD/200/206/416, auth | `tests/integration/tribler-redirect-containment.test.ts`; system AC6 | Public HEAD suffix, bounded and invalid/multipart Range cases |
| HLS resources, byte ranges, validators | `tests/integration/hls-text-privacy.test.ts`, `validator-playback.test.ts`, `bridge.test.ts`; `tests/hls-playlist.test.ts` | Unknown/malformed HLS tokens; TTL reuse in `tests/playback-manager.test.ts` |
| Legacy automatic playback | `tests/integration/bridge.test.ts` legacy direct-failure and explicit Tribler cases | No new behavior or duplicated suite |
| Node malformed/oversized input and methods | Existing service/source validators | Explicit 400 parser mapping, required fields, unsupported methods 404 |
| Python API, worker isolation/failure | `python-adapter-host/tests/test_http_api.py`, `test_http_availability.py`, process-manager/isolation tests | Four tests added to existing HTTP fixture: methods/headers; malformed/oversized input; exact/chunked bounds; required/optional fields |
| Secret/header/redirect/SSRF containment | `tests/security`, provider/Tribler redirect integration, public presentation and recipient/validator tests | Sentinel upstream error/field omission checks; all new fixtures synthetic |

The new Node suite substitutes external boundaries and exercises real routing: CONTRACT.
Python HTTP cases run the real loopback server, with existing controlled local resolver/worker
fixtures: INTEGRATION (real-worker cases span multiple layers). The existing spawned Node/Python
suite is SYSTEM. No live provider, commercial-title query or external media request is added.

Run focused checks with `npx vitest run tests/integration/http-contract.test.ts` and, from
`python-adapter-host`, `python -m unittest discover -s tests -p test_http_api.py -v`.
The reuse table identifies the broader suites needed at the final checkpoint. Counts are execution
results, not compatibility guarantees. Real-environment smoke and a real Stremio UI journey are
outside this synthetic HTTP contract campaign. No OpenAPI generation or production changes are required.
