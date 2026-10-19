# Evaluation corpus schema and synthetic contract fixture

Both generic evaluators accept an explicitly supplied `--corpus <path>` or their
existing flat `--input <path>`. No private corpus is required by tests, CI, build
or normal application startup. Keep real-title corpora and evaluation reports
outside Git. The former private corpus has been archived externally; its blobs
remain reachable in private development history, which must not be published.
The independent public source candidate has a separate root history and does not
inherit those blobs. Publication of that exact snapshot remains pending approval.

The version 1 JSON envelope contains exactly `version`, `id` and `cases`. The ID
must be a safe identifier. Supply 1-100 cases in at most 64 KiB. Each case has a
unique safe `id`, a `mediaClass` (`movie`, `series` or `anime`), a `cohort`
(`mainstream` or `long-tail`) and an `item`. Unknown envelope/case fields and
unsupported versions are rejected. Items use the shared validated evaluator
input format: `type`, `videoId` and optional title, kind, year, external IDs,
series title, season, episode and classifications. The effective content-policy
class must match `mediaClass`. See [evaluation inputs and reports](evaluation-diversity.md).

[`tests/fixtures/evaluation-corpus.synthetic-v1.json`](../tests/fixtures/evaluation-corpus.synthetic-v1.json)
is deterministic, project-authored contract data with ID `synthetic-evaluation-v1`
and version `1`. All titles and identities are invented; IDs use the `synthetic:`
namespace and do not refer to external catalog entries. It has 24 distinct cases,
four in each media-class/cohort combination. Ordinary series cases are episodes.
Each anime cohort contains two movies and two episodes, with movie/series Stremio
types respectively and `classifications: ["anime"]`. Episodes carry explicit
season/episode coordinates. These labels establish test balance, not popularity,
provider availability, automatic database mapping or content-truth evidence.

`tests/standard-evaluation-corpus.test.ts` checks balance, distinct case/media
identities, both structural forms, exact class/cohort/anime-shape segmentation,
the deterministic loader fingerprint and rejection of invalid envelopes, cases
and item identities. Its expected fingerprint is derived only from the synthetic
fixture. F1 regressions additionally verify property-order stability and that
changing validated case data changes the fingerprint.

The loader fingerprints the validated corpus ID, version and cases using canonical
JSON and SHA-256. Report comparisons require matching corpus identity and
fingerprint; they do not compare private baselines to the synthetic fixture.
No evaluator chooses inputs automatically. Use the synthetic file for offline
contract checks; live evaluations require separately authorized inputs and local
provider configuration. No live command is needed to run the contract tests.
