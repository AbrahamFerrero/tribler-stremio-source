# Contributing and redistribution

This personal, independent multimedia engineering project has a published
v1.3.0 source release under [PolyForm Noncommercial 1.0.0](LICENSE), SPDX
`PolyForm-Noncommercial-1.0.0`. The v1.4.0 candidate is unreleased. Engineering direction and
QA are by Abraham Ferrero, with AI-assisted development. The project is intended
for experimentation and household use and is not officially affiliated with
Stremio or Tribler. It is source-available, not OSI open source.

## Use, changes and redistribution

The license permits use, changes, forks and redistribution for its permitted
purposes without separate prior permission. Read its full terms rather than
assuming that every context qualifies. Give recipients the terms or their
official URL and preserve the [Required Notice](NOTICE). Preserve applicable
third-party licenses, copyright notices and attribution separately.

Commercial licensing of material over which Abraham Ferrero holds the necessary
rights is reserved to him. Uses outside the license grants require separate
authorization from the relevant rights holders. No commercial or other rights in
dependencies, external addons, media, logos or trademarks are offered here. See
[third-party media and redistribution limits](docs/third-party-media.md).

## Contribution provenance

Submit only material you have the right to contribute under the project license.
Identify original work and any reused material, its source, license and notices.
Disclose AI assistance and review its output; assistance alone does not establish
ownership or third-party provenance. Do not include private prompts, credentials,
provider configurations, playback records or commercial evaluation corpora.

Contributors retain their rights. Submission does not by itself assign copyright
or grant blanket permission for commercial relicensing. Any additional rights
needed for a contribution must be agreed explicitly before inclusion; do not
assume that the project license grants those rights to the maintainer.

## Engineering and validation

Preserve the localhost-only architecture and documented security boundaries.
Propose small changes with their relevant validation; see the
[developer commands](README.md#diagnostics-and-validation) and [security policy](SECURITY.md).
Identity STRICT/PR6, R-020 and the documented Kodi/HTTPS limitations remain open.
Do not convert synthetic test results into security, content-identity or anonymity
guarantees, or run live provider/playback campaigns as part of routine checks.

Earlier private snapshots carried MIT notices. This first-public-release license
choice does not rewrite those records or purport to revoke grants for earlier
copies. Third-party work retains its own terms throughout.

For v1.4, production coverage and uninstrumented system tests are separate
mandatory gates. Use only reviewed/trusted configuration, ASTs and source maps
with development tooling, in isolated environments with bounded execution.
Keep coverage threshold auto-update disabled. The historical v1.3 tooling-risk
acceptance does not approve this v1.4 candidate; see the
[dependency review](docs/dependency-security-review.md).
