# HTTP transport privacy

This is the canonical transport privacy policy for direct playback, provider redirects, representation validators and HLS playlist text. These controls are independent; passing one never grants authority under another. Token lifetime is defined separately in [HLS token lifecycle](hls-token-lifecycle.md); endpoint behavior is in [HTTP API contracts](http-api-contracts.md).

| Boundary | Required authority or treatment |
| --- | --- |
| URL, DNS and connection | Validate each destination and pin the native connection; local allowances remain exact. |
| Direct source headers | Minimize at the entry origin; exact trusted local rules may authorize selected recipient values. |
| Conditional byte continuation | Require an active token, exact effective URL, selector digest and strong validator. |
| Provider identity bodies and configured catalog headers | Same-origin redirects only; source-header exceptions do not apply. |
| Tribler credentials and control/stream requests | Refuse every redirect, including same-origin; see [Local security](../SECURITY.md). |
| HLS public text | Rewrite recognized resource URLs; remove ordinary comments and optional segment titles, retaining the documented metadata limits. |

## Direct HTTP recipient policy

The bridge applies one source-header policy in DirectTransport for direct playback, probes, redirect hops and HLS resources. URL/DNS validation and pinned connections remain independent requirements. A safe URL is not authorization to disclose headers to its host.

An origin is scheme, hostname and effective port. Sibling subdomains, different ports, CDNs and scheme changes are distinct origins. The original entry origin follows HLS tokens without being replaced by a redirect, variant, audio rendition, key, map or segment origin. Provider normalization discards attempts to supply that context or authorization rules.

### Defaults

- Referer and Origin are absent when not explicitly supplied. No unrelated Referer or `Origin: null` is invented.
- On the entry origin, a valid HTTP(S) source Referer becomes `origin/`, removing path, query and fragment. Values with userinfo or malformed syntax are omitted.
- Source Origin must represent only an HTTP(S) origin; it is serialized without a trailing slash. Paths, query, fragments, userinfo and opaque origins are refused.
- Source Accept is permitted on the entry origin. Source User-Agent is omitted unless authorized locally. The existing stable generic `Mozilla/5.0` remains the default; existing local default/custom modes remain available.
- An unauthorized recipient receives bridge defaults with no source compatibility headers. Conditional Range uses the independent [representation binding policy](#representation-binding).
- Once a redirect chain or enclosing playlist uses HTTPS, its HTTP descendants cannot receive source overrides. There is no downgrade exception in this implementation.
- Cookies, Authorization, Proxy-Authorization, API-key and forwarding headers cannot be authorized. Signed resource URLs remain intact internally; query signatures are not copied to unrelated child URLs.

`HTTP_PRIVACY_SEND_REFERER=false` and diagnostics `referer: false` describe the default. Diagnostics additionally identify the source-header exception policy and automatic downgrade prohibition; they do not expose rules, header values or recipient lists.

### Local compatibility exceptions

`HTTP_SOURCE_HEADER_RULES` is optional startup JSON in the local environment. It is read only by the application configuration loader, never from requests or provider results. For example, this synthetic rule authorizes exactly one source/recipient pair:

```json
[
  {
    "sourceOrigin": "https://source.example",
    "recipientOrigin": "https://cdn.example",
    "headers": { "Referer": "https://site.example/" }
  }
]
```

Each rule replaces the source-header set for that pair: only its listed names and values are authorized. An entry-origin rule may separately authorize an exact source-specific User-Agent or a necessary exact Referer. No wildcard, sibling-domain expansion or provider-driven authorization exists. Rules are copied and frozen at transport startup, limited to 32 distinct pairs, and reject unknown fields, duplicate pairs, forbidden headers, malformed origins and HTTPS-to-HTTP pairs. Invalid configuration fails with a closed error without reflecting its values.

Keep actual exceptions outside version control. Choose origin-only Referer first. An exact path/query Referer requires local authorization and evidence that the minimum value cannot serve the resource; userinfo and fragments remain prohibited even in local rules. Authorize only required headers, and only the actual recipient origin. Restart the application after changing rules; probe caches and transport authorization belong to that application lifetime.

Minimized requests may proceed to otherwise safe unapproved origins. A refusal remains an ordinary closed upstream failure; the bridge does not escalate headers automatically. Existing bounded Range retry behavior can repeat a minimized probe request, but cannot grant new header authority. Exact-header playback may fail until the user supplies a narrow rule. This is a compatibility loss, not proof that a provider is unsafe or the media has a different identity.

### Recipient evidence limits

Synthetic tests exercise exact received headers at protected local sockets and public source/HLS routes, with the existing exact fixture URL allowances. Synthetic public-address tests substitute the pinned-request boundary to characterize HTTPS and scheme changes; they do not establish TLS socket or live-provider results. Public presentation and logs are checked against fixture values, not a universal secret detector.

R-020 remains open for other upstream response metadata, retained playlist metadata and unrecognized locators, broader telemetry, actual TLS/system evidence and authorized real-provider compatibility. [Representation binding](#representation-binding) prevents arbitrary client If-Range forwarding and raw upstream validator exposure. [HLS text minimization](#hls-playlist-text-privacy) removes only the documented fields. These bounded policies do not establish whole-request confidentiality or sanitize arbitrary playlist text.

## Representation binding

Player `If-Range` values never pass directly to an upstream recipient. A source or HLS resource token can retain one private observation: the exact effective URL, a digest of the actual request selector headers, a strong upstream ETag, and a random opaque player ETag. Equality of URLs or lengths alone cannot authorize continuation. `/auto` has no such token state and restarts conditional requests with full responses.

### Lifetime and bounds

Each observation belongs to its own PlaybackManager token; bindings are not shared between tokens. A source and its retained HLS descendants share an inactivity authority, renewed by admitted GET/HEAD access using `HTTP_STREAM_TOKEN_TTL_SECONDS` (default one hour), rather than fixed HLS expiry from registration. Expiration, whole-tree eviction, child removal and cleanup clear affected observations. Observation or response completion cannot renew or revive authority. Source capacity remains separately configurable (default 1,000); the global HLS cap remains 4,096. See [HLS token lifecycle](hls-token-lifecycle.md) for renewal, replacement, eviction, legacy `/auto/` trees and revocation details. Bindings add no persistence, routes, configuration or media storage.

Each observation bounds its URL to 8,192 characters and strong upstream ETag to 512 characters. The selector digest is 64 hexadecimal characters; the quoted player ETag contains 24 random bytes encoded as base64url (34 characters including quotes). Private fields do not appear in generic JSON serialization. Signed URLs remain private and unchanged in transport.

A monotonically increasing request generation prevents older responses from replacing newer observations. A conditional request rechecks that the entry and its observation remain active before issuing upstream headers and before accepting a partial response. HEAD can confirm an existing observation but cannot create authority or retain it after observing a change. A late response can stream ordinary bytes without establishing a new validator.

### Recipient and representation requirements

Only the issued opaque ETag for this exact token can select an observation. The upstream Range and stored strong ETag are emitted together only at the exact bound effective URL with the same selector digest. Redirect entry points and new destinations do not inherit that authority. Once HTTPS has been used in a chain or enclosing playlist, HTTP cannot establish or receive a binding. PR14 recipient rules and URL/DNS validation remain independent requirements.

The digest includes actual headers after recipient authorization, excluding Range and If-Range; the effective URL includes host, scheme, port, path and query. Only bounded ASCII strong ETags are supported. Weak ETags, HTTP dates, missing, oversized or unsupported validators do not authorize conditional byte continuation. Vary must be absent or bounded and limited to headers covered by this comparison: Accept, Accept-Encoding, User-Agent, Referer, Origin and Host. Unknown Vary selectors and `Vary: *` cannot establish an observation.

A strong ETag is an upstream HTTP assertion of byte identity, not an independent content hash or proof against an origin that lies consistently. A matching response must still provide valid range framing. These rules do not authenticate recipients through SSRF validation.

### Response behavior

- Supported single ranges, including suffix and open-ended ranges, retain correct 206 behavior when the binding is comparable and the upstream confirms the same strong ETag.
- Unknown, replayed, changed or expired validator authority results in a full request, or a closed refusal if a partial response cannot be safely interpreted. A conditional 200 remains a complete 200; it is never sliced into a fabricated continuation.
- Every accepted 206 must describe a safe span within the requested range with consistent declared length. A correctly described bounded prefix is permitted. Framed media streams with actual byte-count checks; unframed partials are completely checked within the existing 32 MiB bound, and larger unframed partials are refused.
- Valid upstream 416 responses retain their unsatisfied-range semantics with an empty response and a validated `bytes */N`. Invalid or contradictory partial metadata is refused.
- Multipart or malformed ranges restart with complete responses. HEAD requests do not issue ranges.
- The existing bounded HLS segment fallback remains available for unconditional ranges when the upstream returns a complete identity-encoded segment. Conditional requests never use that fallback. Encoded bodies cannot be sliced as if they were original media bytes.

Raw upstream ETag, Last-Modified and Content-Disposition are omitted from public media responses. Eligible original media may expose only its token-scoped opaque ETag. Transformed HLS playlists have no upstream entity validators and use `Cache-Control: no-store`. Their HEAD responses omit upstream length, range and seek metadata; GET declares the actual rewritten byte length. Playlist syntax and resource token registration remain unchanged.

### Validator compatibility and evidence limits

Supported unchanged resume needs no additional upstream requests or media buffering. Full restart can transfer more bytes than a range; weak/date-only validators and unknown Vary intentionally lose conditional resume authority. Multipart requests restart, and unframed partials above 32 MiB are refused. Ordinary framed video and safe complete responses continue streaming.

Synthetic regressions use public bridge routes, the real pinned transport and controlled local fixture sockets. They cover cross-token replay, redirect rebinding, source selector changes, expiry, concurrent observations, body framing, range variants and transformed HLS metadata. They do not establish live-provider compatibility or independent cryptographic media authenticity.

R-020 remains open for other response metadata, retained non-resource playlist text, broader telemetry, actual TLS/system observation and explicitly authorized real-provider compatibility; the bounded [HLS text policy](#hls-playlist-text-privacy) does not close it. Identity QA, ranking, scheduling, Tribler and Python behavior are outside this change.

### Historical PR15 synthetic checkpoint

The following records the historical PR15 checkpoint, not a fresh execution or current suite counts. Current token lifetime follows [HLS token lifecycle](hls-token-lifecycle.md).

The starting PR14 revision was a private development checkpoint, absent from the independent public snapshot. The first 14 persistent regressions failed against that revision before production edits. The final 35 validator regressions pass through real protected fixture sockets. Two independently reproduced failures during implementation covered expiration between framed headers and bytes, and compressed ignored-Range HLS slicing. A separate pinned-boundary test covers HTTPS downgrade containment; it is not a TLS socket claim.

The exact PR14/PR15 supported-resume comparison returned the same `cde` bytes, 206 status and length 3 in two upstream requests. Before: the entry and final recipients both received If-Range, and the player received the raw ETag. After: only the bound final recipient receives the raw ETag, and the player receives an opaque ETag. Changed direct and HLS media return complete 200 bodies; validated unsatisfied ranges return empty 416 bodies. Unsafe direct partials are refused with 502. Unsupported encoded HLS fallback retains the existing route's 400 classification and emits no partial media.

Checkpoint validation: general 1,035 PASS; acceptance 43 PASS; system 13 PASS; security 21 PASS; coverage 1,091 PASS (90.13% lines, 82.14% branches); all 12 scheduling guardrails PASS. Identity QA BASELINE: 94 PASS, exactly 54 known dimensions, zero progress dimensions. STRICT intentionally remains RED with those same 54 dimensions in 24 failing scenarios. PR6 remains blocked. Typecheck, build and repository safety pass. Standard lint encounters the existing permission error in ignored `.inspection-work`; the established `eslint . --ignore-pattern '.inspection-work/**'` invocation passes without configuration changes.

## Provider redirect authority

The configured recipient is authorized to receive the original request. URL/DNS safety does not authorize another origin to receive identity bodies or configured catalog headers. An origin consists of scheme, hostname and effective port; sibling domains, different ports and HTTP/HTTPS transitions are distinct origins.

`ExternalHttpStreamProvider` identity POSTs and `JsonCatalogProvider` requests with any `headersFromEnv` entries use the shared redirect helper's internal same-origin authority. This applies to catalog lists and item lookups, including direct library construction and injected standards-compliant fetch implementations. Redirect responses are handled manually and their bodies are cancelled. The next recipient is authorized before URL resolution or a new request. Rejection reports a generic error without Location, query, credentials or response body values. There is no public exception configuration or stripping-and-retry behavior.

Allowed same-origin provider redirects retain the original POST method and identity body for 301/302/303/307/308, including 303; this preserves the existing provider protocol rather than adopting browser POST-to-GET rewriting. Catalog requests retain their configured headers. Existing URL validation, DNS checks, pinned native connections, private-address restrictions and three-redirect limit remain in force when a URL policy is supplied. Same-origin authority does not expand an exact loopback URL allowlist.

Authenticated catalog library construction without a URL policy retains native fetch transport and its twenty-redirect allowance, using the shared manual redirect gate. It does not gain DNS validation or IP pinning. Production `createApp` supplies a URL policy. Injected fetch implementations are trusted local code and must honor `redirect: "manual"`; an implementation that deliberately follows redirects or sends data independently is outside this transport contract.

Anonymous catalog GETs, Internet Archive requests, Stremio addon manifest/stream GETs and movie metadata GETs retain their existing redirect behavior. Signed same-origin query URLs remain internal and arrive unchanged. This policy does not establish privacy for unrelated anonymous GET query values.

Previously supported cross-origin identity POSTs and configured-header catalog redirects now fail, including redirects that eventually return to the initial origin. Operators must configure the intended recipient directly. Refused providers remain errors; the normal registry can still return independently healthy sibling results. Identity qualification, normalization, ranking, caching, budgets, concurrency and playback policies are unchanged. Python host environment isolation (F4) is a separate boundary: the supported Windows launcher filters the child environment before process creation; direct Python and embedded entry points reject Tribler variables after interpreter startup and cannot undo inheritance or startup hooks. Independently launched interpreters need caller-controlled environments. See [the privacy audit](../PRIVACY_AUDIT.md#known-limitations) for evidence and limits. Wider response/privacy limitations (R-020) remain open.

## HLS playlist text privacy

Public source and nested HLS GET responses omit ordinary comment lines and empty the optional EXTINF segment title. The duration text before the first comma is retained exactly. URI-looking strings, signed locators and encoded text inside these two fields are discarded as whole fields, without secret dictionaries or decoding heuristics.

[RFC 8216 section 4.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.1) defines comments separately from tags; [section 4.3.2.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.1) defines the optional segment title. To retain the existing parser's compatibility, any case-insensitive `#EXT` prefix is preserved as a tag, including unknown tags. Ordinary comments cannot change the pending segment/variant association, supply resource attributes or consume resource registrations. EXTINF titles are not attribute lists.

This applies at the existing playlist rewrite boundary. It introduces no routes, configuration, network authority, headers, probe limits or token lifetime changes. Playlists retain media/discontinuity sequences, timestamps, duration spelling, byte ranges, key methods and IVs, map attributes, variant/audio group associations and live/VOD control tags. Recognized resource references continue through URL validation and opaque PlaybackManager registration. [Recipient restrictions](#direct-http-recipient-policy) and [representation binding](#representation-binding), including no-store transformed playlists and HEAD metadata restrictions, remain applicable.

### Metadata boundaries

| Field | Treatment and compatibility boundary |
| --- | --- |
| Ordinary comments | Omitted; all their text is nonfunctional under RFC 8216. |
| EXTINF title | Emptied, retaining the comma and exact duration prefix. Player segment display text changes intentionally. |
| SESSION-DATA VALUE, DATA-ID, LANGUAGE | Preserved. Application-defined session data can drive client behavior; optional presence does not prove removal harmless. |
| SESSION-DATA URI | Existing opaque resource rewrite retained; the fetched JSON is not sanitized. |
| MEDIA NAME, LANGUAGE, ASSOC-LANGUAGE, CHARACTERISTICS | Preserved. NAME is required and rendition names must be distinct within a group; language/accessibility fields participate in rendition selection. No anonymous renaming scheme is introduced. |
| MEDIA GROUP-ID, DEFAULT, AUTOSELECT, FORCED, CHANNELS, INSTREAM-ID | Preserved functional selection/control information. |
| DATERANGE ID, CLASS, dates, durations, SCTE-35, extensible attributes | Preserved. Timed events, ads and interstitials can depend on these fields. Arbitrary X attributes can also disclose information. |
| DEFINE NAME, VALUE, IMPORT, QUERYPARAM | Preserved functional variable declarations. The existing bridge does not expand HLS variables. |
| Unknown/vendor `#EXT` tags | Preserved with existing URI handling; their semantics have not been established safe to remove. |

The [HLS second-edition draft](https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis-22) specifies variable substitution, content steering and interstitial dependencies. It is a draft, not a claim of implementation support. URI extraction here is still the existing generic quoted `URI=` matcher, not a complete tag-specific HLS parser. It may match suffixes such as SERVER-URI or X-ASSET-URI and textual URI-like content in other tags, while missing URL-bearing attributes such as X-ASSET-LIST and JSON-internal locators. Variable URI lines are resolved literally rather than expanded; player query-derived variables cannot rely on the original upstream query after opaque rewriting. These are pre-existing compatibility/privacy boundaries requiring independent design and evidence.

### HLS text evidence limits

Synthetic tests compare exact public source, nested audio/video and live-reload text, normalizing only random local handles. They verify signed-query requirements, opaque resource retrieval, key/map/segment bytes, Range, HEAD, content length, sequence and duration preservation and bounded request counts. Parser regressions cover CRLF comments between EXTINF and its segment, comments containing malformed/private URI text, URI-looking optional titles and preserved unknown/variable/interstitial metadata. Existing protected transport, probe and playback suites cover recipient restrictions, required dependencies, URL/DNS/redirect checks and representation binding.

Transport byte checks do not establish audiovisual decoding, encryption/decryption correctness, a Stremio UI journey or real-provider compatibility. Synthetic fixture log checks are not a universal secret detector. R-020 remains open for retained playlist metadata, fetched metadata bodies, unrecognized resource locators, response surfaces, broader telemetry and actual TLS/system and authorized real-environment evidence. This bounded reduction does not establish comprehensive HLS privacy or close R-020.

## Implementation and evidence map

The references below identify the maintained implementation and reproducible regression cases in this source snapshot. Historical private checkpoint results above retain their original scope and are not new test runs.

| Policy | Implementation | Existing evidence |
| --- | --- | --- |
| Recipient headers, rules, downgrade prohibition | [http-privacy.ts](../src/network/http-privacy.ts), [outbound-transport.ts](../src/network/outbound-transport.ts), [normalization.ts](../src/streams/normalization.ts), [config.ts](../src/config.ts) | [recipient-header-policy.test.ts](../tests/recipient-header-policy.test.ts), [outbound-transport.test.ts](../tests/outbound-transport.test.ts) |
| Representation authority and response framing | [representation.ts](../src/playback/representation.ts), [automatic-stream.ts](../src/automatic-stream.ts), [outbound-transport.ts](../src/network/outbound-transport.ts) | [validator-playback.test.ts](../tests/integration/validator-playback.test.ts) |
| Provider redirect authority | [url-policy.ts](../src/network/url-policy.ts), [external-http-stream-provider.ts](../src/streams/providers/external-http-stream-provider.ts), [json-provider.ts](../src/catalog/json-provider.ts) | [provider-redirect-containment.test.ts](../tests/integration/provider-redirect-containment.test.ts) |
| Playlist text and resource registration | [hls-playlist.ts](../src/hls-playlist.ts), [app.ts](../src/app.ts) | [hls-playlist.test.ts](../tests/hls-playlist.test.ts), [hls-text-privacy.test.ts](../tests/integration/hls-text-privacy.test.ts) |
| Shared inactivity authority and isolated bindings | [manager.ts](../src/playback/manager.ts), [config.ts](../src/config.ts) | [hls-lifecycle.test.ts](../tests/hls-lifecycle.test.ts), [validator-playback.test.ts](../tests/integration/validator-playback.test.ts); canonical [lifecycle contract](hls-token-lifecycle.md) |
| F4 launcher and service-entry limits | [start-local.ps1](../python-adapter-host/start-local.ps1), [config.py](../python-adapter-host/adapter_host/config.py), [app.py](../python-adapter-host/adapter_host/app.py), [__main__.py](../python-adapter-host/adapter_host/__main__.py) | [test_host_environment.py](../python-adapter-host/tests/test_host_environment.py); [audit limits](../PRIVACY_AUDIT.md#known-limitations) |

## Release header hardening retained in the local candidate

DirectTransport validates URL/DNS and recomputes source-header authorization before every pinned request. URL safety does not authorize disclosure. The entry origin (scheme, host and effective port) remains fixed through redirects and HLS variants, audio, segments, keys and maps.

On the entry origin, source Accept is allowed, a valid HTTP(S) Referer is reduced to its origin plus slash, and Origin must be a minimal HTTP(S) origin. Source User-Agent requires local authorization. Other recipients receive bridge defaults unless a local rule authorizes exact values. Range, If-Range, encoding, signed locators and playback-token lifetimes retain release/v1.3 behavior.

Optional `HTTP_SOURCE_HEADER_RULES` is trusted startup JSON, never provider/request input:

```json
[{"sourceOrigin":"https://source.example","recipientOrigin":"https://cdn.example","headers":{"Referer":"https://site.example/","User-Agent":"Compatible/1"}}]
```

A rule replaces the source-header set for that pair; only listed names and values are authorized. Entry-origin rules can authorize a necessary exact Referer or User-Agent. Keep real rules outside version control. Prefer origin-only Referer and authorize a path/query only with evidence that it is necessary. Restart after changes.

Startup validation rejects malformed JSON, empty input, unknown fields, duplicate origin pairs, more than 32 rules, invalid origins/values, forbidden headers and HTTPS-to-HTTP rules. Rules are copied and frozen. Cookies, credentials and forwarding headers cannot be authorized. Once a request chain or enclosing playlist uses HTTPS, HTTP descendants receive no source overrides. Redirects and 403 responses never expand permissions or trigger compatibility retries. Existing URL policy, SSRF/DNS checks and redirect limits remain independent.

Diagnostics identify the policy without disclosing rules or header values; `referer: false` describes the default, not an absolute absence guarantee.

Synthetic evidence uses the existing DirtyUpstream harness and pinned-request boundary. It covers redirects, local compatibility, signed HLS resources, bytes, header canaries and public diagnostics. It does not establish actual TLS behavior, audiovisual decoding or real Stremio/provider compatibility. Those require authorized real-environment playback, seek and pause/resume checks. Broader response/playlist metadata privacy is outside this patch. R-020 remains open and the freeze remains in force; PR6 and cases 05/13/34 are unchanged.
