# Privacy audit model

This document records security boundaries and the evidence required to make privacy claims. It does not claim anonymous, untraceable or universally safe operation.

## Evidence levels

- `CODE_ENFORCED`: deterministic local tests exercise the boundary.
- `LOCAL_RUNTIME_OBSERVED`: a local process observation confirms the defined condition.
- `EXTERNAL_E2E_OBSERVED`: an authorised observer outside the device records the defined network event.
- `NOT_TESTED` and `KNOWN_LIMITATION`: no positive claim.

A local `/health` response or a configured hop count is not external network evidence.

## Current code-enforced boundaries

| Property | Evidence | Status |
|---|---|---|
| Bridge routes BitTorrent playback through local Tribler REST | Node tests | `CODE_ENFORCED` |
| Tribler REST and official streaming never follow redirects, including same-origin redirects | Real loopback REST/public playback receiver tests; no redirected connections | `LOCAL_RUNTIME_OBSERVED` |
| Python workers do not receive inherited Tribler credentials | worker environment sanitisation tests; separate launcher mitigation and F4 limits below | `CODE_ENFORCED` |
| Bridge and control listeners bind to loopback in the supported configuration; binding does not authorize callers or routes | configuration tests; route authorization is a separate boundary | `CODE_ENFORCED` |
| Direct HTTP(S) blocks private destinations and revalidates redirects | URL policy and transport tests | `CODE_ENFORCED` |
| Direct HTTP(S) omits cookies, authorisation and forwarding headers; source Referer/Origin follow the explicit recipient policy below | transport tests; local source-header exceptions are separately scoped | `CODE_ENFORCED` |
| A request cannot select a Python module or callable | request validation tests | `CODE_ENFORCED` |
| Ambiguous episode file selection fails closed | adapter and stream tests | `CODE_ENFORCED` |

## Known limitations

Tribler redirect containment uses native fetch refusal, matching endpoint discovery. Local synthetic receivers cover GET, PUT, PATCH, DELETE and public playback with 301/302/303/307/308, no redirected request or connection, no recovery on rejection, secret-bearing Location/body refusal, concurrent control requests and cancellation. Healthy IPv4/IPv6 loopback REST and playback remain covered. This does not establish actual Tribler-version compatibility or swarm anonymity. State-changing requests reach the configured endpoint before a redirect is refused; no rollback is implied.

External HTTP identity POSTs and JSON catalog requests with configured headers refuse cross-origin redirects before contacting the next recipient. Same-origin redirects remain subject to existing URL/DNS validation and limits. Catalog credential containment also applies to direct library construction without a URL policy; that construction retains native transport and does not establish DNS validation or IP pinning. See [provider redirect authority](docs/http-recipient-privacy.md#provider-redirect-authority). Local synthetic receiving sockets cover PR17 F2/F3 with 301/302/303/307/308, including custom credential headers and zero unauthorized connections after refusal.

PR17 F4 is addressed for the supported Windows host launcher: an explicit child environment is constructed before process creation, excluding Tribler variables, unrelated secrets, proxies and inherited Python startup variables. Synthetic real-child tests observe absence before application code and exercise the real host health/resolve endpoints. Worker sanitization remains separate and unchanged. Direct Python and embedded service entry points fail closed on presence of either Tribler variable, without undoing interpreter inheritance or startup hooks. Independently launched interpreters require caller-controlled process environments for the stronger guarantee. DNS behavior is unchanged; R-020 remains open and PR6 remains blocked.

Direct source headers now use a shared [recipient policy](docs/http-recipient-privacy.md) for probe, redirects and HLS playback. `sendReferer: false` describes the default, not an assertion that explicit source Referer is never sent. Recipient origins include scheme, host and effective port; URL/DNS safety does not authorize header disclosure. Local exact rules cannot authorize HTTPS-to-HTTP propagation or forbidden credential headers. Necessary signed URLs remain internal.

R-020 remains open. [Token-scoped representation binding](docs/http-recipient-privacy.md#representation-binding) contains If-Range and minimizes public entity validators. [HLS text minimization](docs/http-recipient-privacy.md#hls-playlist-text-privacy) removes ordinary comments and optional EXTINF titles. Retained playlist metadata, fetched metadata bodies, unrecognized locators, other response metadata and live-provider compatibility remain outside these bounded policies.

A direct HTTP(S) origin necessarily sees the client connection metadata required to serve a resource. DNS resolution by the system resolver is outside the bridge's anonymity guarantees. Tribler swarm, tracker, DHT, PEX and webseed behaviour require separate external observation; none should be inferred from configuration or code tests alone.

An external experiment requires content owned or explicitly authorised for the test, isolated profiles, a controlled observer and a pre-defined record of peer/tracker evidence. Store raw observations only in ignored inspection directories. Do not include magnets, hashes, public addresses, provider responses or runtime logs in the repository.

The Python audit hook is defence in depth. A hostile native extension requires an operating-system sandbox, which is future work.
