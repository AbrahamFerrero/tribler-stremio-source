# Local security

## Localhost HTTP authorization

The first inbound middleware requires exactly one canonical local Host and the effective
listener port. The IPv4 profile accepts `127.0.0.1` and `localhost`; `[::1]` is accepted only
on an actual IPv6 loopback listener. Arbitrary authorities, ambiguous headers and proxy-form
targets are rejected before parsing or handlers. Forwarded headers confer no authority.
`PUBLIC_BASE_URL` must use HTTP, one of the IPv4 profile hosts, the configured port and a root path.

`/health`, `/providers`, `/resolve` and the `/downloads` namespace require an independent
64-character hexadecimal `BRIDGE_ADMIN_TOKEN` in one Authorization Bearer header. Provision
32 random bytes with a local secret manager and set the process environment; never reuse the
Tribler key. An absent variable disables administration with 403; a malformed configured value fails
startup. Missing/incorrect authorization returns generic 401 when enabled. Origin, Referer or
any Fetch Metadata header rejects administration even with the secret. Administrative OPTIONS
ends with 403 before SDK CORS. Diagnostics and administrative responses are not cached.

Catalog/meta/stream discovery trusts only the exact `https://web.stremio.com` Origin.
Present Fetch Metadata must describe a complete, coherent reading context; navigation and
document destinations are rejected. `/auto` and `/play` also accept the observed native
pattern: no Origin, Referer or any of the four Fetch Metadata headers. Every `/play` request
is checked independently, including after a 307. No native exception applies to discovery.
`/source` and `/hls` keep their existing opaque bearer capabilities and expiry rules; an
untrusted or null Origin does not substitute for a token. CORS is scoped to each family;
SDK middleware cannot restore wildcard access to discovery. Stream responses use no-store.

Local processes can falsify context headers. Clients or browsers that omit all signals can
be indistinguishable from the native player. This policy does not provide absolute protection
against every browser, authenticate a particular Desktop instance, or isolate hostile local
processes. Administrative authentication cannot protect against a process already possessing
the secret. Legitimate BitTorrent activity can expose the public IP address. Synthetic HTTP
tests do not establish universal Desktop/browser compatibility. The v1.3 release review
records Desktop validation of the implemented localhost controls and explicit acceptance
of the remaining local-header spoofing, native-context ambiguity and secret-possession
risks for localhost-only use. This is bounded risk acceptance, not universal protection
or publication approval. No new Desktop run was performed in this documentation phase.

The Node listener binds to `127.0.0.1`. Manifest access is public after Host checks;
source/HLS capabilities permit wildcard CORS without credentials. Keep tokens private.
Advanced localhost hardening remains deferred. See the exact
[HTTP contracts](docs/http-api-contracts.md#required-localhost-boundary).

## Provider boundary

Providers only produce normalized data. The bridge does not download or execute remote modules, scripts, commands, Python, or code. A service written in another language must run separately and communicate exclusively over HTTP/JSON.

Outbound direct-media URLs are limited to HTTP(S), resolved before connecting, and rejected if any address is local, private, link-local, multicast, or reserved. Each redirect is revalidated. The native connection is pinned to the validated IP to prevent a second DNS resolution. Bridge and Tribler addresses are explicitly blocked.

External HTTP provider identity POSTs and JSON catalog requests using `headersFromEnv` authorize only their original origin (scheme, hostname and effective port). Same-origin redirects may continue after URL validation; cross-origin redirects fail before another request, without stripping credentials and retrying. Catalog construction without a URL policy also enforces this credential redirect boundary through manual native fetch; it does not supply the application's DNS/pinning protections. Anonymous GET redirect behavior is retained. See [provider redirect authority](docs/http-recipient-privacy.md#provider-redirect-authority).

Direct playback uses temporary random tokens at `/source/:token/:filename`; that route does not accept an arbitrary client-supplied proxy URL. Legacy routes, administrative responses and catalog metadata have separate disclosure limits; opaque tokens are not universal metadata secrecy. Valid HLS playlists rewrite child resources to separate opaque local tokens, and each child URL is validated before registration and again by the outbound transport when requested. Conditional Range uses [token-scoped representation binding](docs/http-recipient-privacy.md#representation-binding): arbitrary player validators are not forwarded, and raw upstream entity validators are not exposed as player authority. Bridge-owned Accept, identity encoding and the configured generic User-Agent remain available. On the initial source origin, source Referer is minimized to origin-only, valid source Origin is serialized minimally, and source Accept may be retained. Source User-Agent and exact Referer values require trusted local configuration. Cross-origin recipients receive no source headers unless a local rule supplies their exact permitted values. `Authorization`, cookies, `X-Api-Key`, and proxy/forwarding headers are never authorized by these rules. See [recipient policy](docs/http-recipient-privacy.md).

The supported Windows Python host launcher builds a filtered child environment before process creation, excluding Tribler variables, unrelated secrets, proxies and inherited Python startup variables. Direct Python and embedded service entry points reject either Tribler variable, but cannot undo interpreter inheritance or startup hooks. Other launch mechanisms require caller-controlled clean environments. Worker environment sanitization remains a separate boundary. See [F4 evidence and limits](PRIVACY_AUDIT.md#known-limitations).

This project treats `TRIBLER_API_KEY` as a local secret.

- `.env` files and variants are excluded from Git, except the sanitized `.env.example` template. The public candidate is a source-only snapshot; npm packages, bundles and binaries require a separate distribution review.
- Do not include keys in `TRIBLER_URL`: the application rejects URLs with a username, password, query string, or fragment. Configure the key only through `TRIBLER_API_KEY`.
- The bridge and Tribler URL are validated as loopback. Do not configure `0.0.0.0`, a LAN IP, or a public proxy.
- The key travels only to Tribler in the `X-Api-Key` header; it is not part of Stremio URLs, HTTP responses, or logs.
- Tribler REST, official streaming requests, and endpoint discovery reject redirects, including same-origin redirects. No redirected recipient receives credentials, control bodies, or Range requests. Redirect refusal does not trigger endpoint recovery; recovery remains limited to connection refusal and verified local discovery. A state-changing request may already have reached Tribler before its redirect is refused; refusal does not roll back that operation.
- Do not upload, paste into issues, share in chat, or include the contents of `.env` in screenshots.
- `config/*.local.json` files may contain only variable names in `headersFromEnv`, never keys or tokens. Keep actual values only in `.env`.

If a key is exposed outside your computer, rotate it in Tribler and replace it in `.env` before starting the bridge again.

## Pre-release threat model and gates

| Threat actor and boundary | Current control and evidence | Residual risk | Priority |
| --- | --- | --- | --- |
| Remote provider, DNS or redirect attacker -> Node | HTTP(S)-only URL policy rejects private, reserved, credentialed and mixed-DNS targets; each redirect is revalidated and the socket is pinned. | Public origins can still observe the connection needed to serve media. | P2 |
| Hostile Stremio request or media metadata -> Node | Bounded JSON, token, `Range`, file-index and normalization validation; direct URLs are opaque bridge tokens. | Denial of service within configured local limits remains possible. | P2 |
| Malformed Tribler REST response -> Node | Bounded parsing, local-only endpoint validation and fail-closed playback paths. | Real Tribler-version compatibility remains a local smoke concern. | P2 |
| Local web context / native process -> Node | Strict Host and route-specific context policy; independent administrative Bearer secret; opaque playback capabilities. | Local processes can forge context headers; stolen capabilities remain usable until revoked/expired. | P2 |
| Python HTTP request -> worker configuration | Requests carry media only; static startup configuration selects module, callable and paths; IPC is bounded. | Static request-selection controls do not certify the locally installed module. | covered |
| Compromised local resolver module -> worker/host | Minimal environment excludes Tribler credentials, child processes are denied, and filesystem access is constrained. | The audit hook is not an operating-system sandbox for code the user installs locally. | P1 |
| Local process -> auto-discovery or Tribler | Discovery is Windows-only, loopback/process-owner/authenticated/exactly-one and bounded; no persistence. | A same-user adversary is outside this application's OS isolation model. | P2 |
| Repository or CI supply chain -> release | Repository scan, lockfile, read-only CI, immutable action SHAs and dependency audits. | New advisories require periodic review. | P2 |
| Accidental publication -> repository | Ignore rules, staged/all-file safety scan and pre-commit hook reject common secrets and private artifacts. | The scanner intentionally does not treat arbitrary prose or placeholders as credentials. | P2 |

For a future separately authorized release, the code validation gates are `npm run security:repo`, `npm run test:security`,
typecheck, lint, the full Node/Python and acceptance suites, coverage commands,
build, both npm audits, and no unresolved security P0. CodeQL scanning can be
restored if the repository becomes public or GitHub Code Security is enabled. A release
must also explicitly accept or close the P1 hostile-local-module limitation;
the worker's audit hook is defence in depth, not a claim of hostile-code isolation.

The documentation-only phase runs repository safety and document checks; it does not repeat those code suites or claim new CI results. The [dependency review](docs/dependency-security-review.md) records an unresolved embedded development-tool vulnerability temporarily accepted for local integration. Its acceptance is not publication approval, and zero declared npm advisories would not establish remediation.

Identity corroboration and transport verification are distinct. Neither `Verified`/HTTP checks nor `ID✓` promises audiovisual identity. PR6 remains open and Identity frozen. R-020 remains open for broader response/session/legacy/log/artifact disclosure, with bounded residual risk provisionally accepted for v1.3; recipient-header and HLS protections do not establish anonymity. Direct HTTPS exposes the connecting public IP to the remote server.

Locally configured Python resolver modules are trusted local code. Configure only
reviewed modules under the operator's control; this project does not claim an
operating-system sandbox for untrusted local module code.

# Repository hygiene

Never commit `.env`, Kodi settings/profiles, logs, databases, downloaded archives, inspected
third-party modules, API keys, tokens, cookies or credentials. Local inspection material belongs
under `python-adapter-host/inspection-input/` or `.inspection-work/`; both are ignored in full.
Kodi addons must be installed outside the repository and referenced through local environment
variables. Only sanitized templates such as `.env.example` and `settings.example.json` may be
versioned.

Run `npm run security:repo` before staging the initial commit. This scans every non-ignored file.
The repository also ships `.githooks/pre-commit`; enable it once per clone with:

```powershell
git config core.hooksPath .githooks
```

The hook scans staged blobs, not merely working-tree files, and rejects ignored artifact types,
personal home paths, high-confidence credentials, non-placeholder Tribler keys and unapproved
magnet fixtures. It complements `.gitignore`; it does not replace reviewing `git status`.

The GitHub Actions workflow is configured to run the repository safety scan, type-checking, linting, Node.js and Python
tests, build, and dependency audits on push and pull-request events. Workflow configuration is not evidence of a successful run for this candidate. The workflow has read-only
repository permissions and does not require secrets.
