# Stream identity acceptance contract

Historical contract checkpoint: **2026-10-03**, with composition reconciliation dated **2026-10-11**. Phases 0–2 characterization is retained; Phase 2.5 refines the product contract. This document is the canonical contract, not a claim that every criterion is implemented or proven. The [campaign](IDENTITY_QA_CAMPAIGN.md) is the operating plan; [coverage](IDENTITY_COVERAGE.md) records dated evidence. Contract decisions do not establish implementation or fresh execution evidence.

Examples below use synthetic titles and `example` domains. “Synthetic Meridian” is a movie; “Synthetic Harbour” is a series. Titles are illustrative labels, not a new alias dictionary.

## Identity state and disposition

Production disposition, identity confidence and transport/media verification are separate concepts.

| Identity state | Identity disposition | Meaning |
| --- | --- | --- |
| CONTRADICTION | REJECT; absent from public results | Applicable conflict in the closed hard-conflict set rejects after the approved composition exceptions below. |
| CORROBORATED | ADMIT | The applicable positive matrix below is satisfied; this is corroboration, not proof of the bytes' content. |
| UNKNOWN | ADMIT / fail-open | Evidence is missing, ambiguous or insufficient. Never promote this state to known-good. |
| SUSPICIOUS | Normally ADMIT, visibly distinct | A qualified title concern, strong-evidence dispute or approved resource-path positive cap remains unresolved; suspicion alone does not hard-reject. |

**Unknown survives. Unknown is not promoted to known-good. Contradiction dies.**

`ADMIT` means identity eligibility, subject to URL safety, media qualification, deduplication, quotas, budgets, ranking and playback registration. `FAIL_OPEN` means uncertainty cannot itself reject a candidate; it does not guarantee final retention. A non-identity domain can exclude an UNKNOWN, SUSPICIOUS or CORROBORATED candidate.

Transport verification is orthogonal: transport verified + identity CORROBORATED, UNKNOWN or SUSPICIOUS are all possible. `Verified` never means correct content identity. The current observational implementation calls its positive category `MATCH`; that historical enum and quoted test names remain unchanged in code. It is not automatically equivalent to the refined CORROBORATED contract: current title-only MATCH cases can be too broad.

At this checkpoint all 78 product-policy rows are settled, including the year policies in AC-ID-028 and AC-ID-039. Passing characterization is not proof of implementation. Coverage requirements are minimum evidence, not claims that the evidence already exists.

## Evidence and provenance

| Provenance | Role and limits |
| --- | --- |
| REQUEST / TRUSTED_METADATA | Establishes the requested identity; runtime for an episode must belong to the exact requested S/E. Request facts echoed by a provider are not independent candidate proof. |
| PROVIDER_PRESENTATION | Display labels, declared titles and textual duration. Echoed/request-derived text cannot corroborate identity; the existing conservative movie textual-duration negative rule remains separately characterized. |
| RESOURCE_IDENTITY | Bounded candidate-local filename or safe original/effective media basename facts. Effective observations require successful validated transport. Parent paths, queries, fragments and tokens do not donate identity. |
| MEASURED_MEDIA | Independently verified bounded MP4/HLS measurement. Runtime supplies negative evidence only, never positive identification. |
| CANDIDATE_EXTERNAL_ID | Independently supplied candidate identity in a supported namespace; compare with trusted request identity. A copied requested ID is not independent corroboration. |

Multiple fields from the same provenance do not automatically become independent corroboration. Several matching provider fields or an echoed title/year/ID are not multiple independent votes. A deliberately stated structural claim inside `metadata.identity` is an explicit contract claim, not authentication of its truth.

## Positive corroboration and title boundaries

A movie may be CORROBORATED only with no hard contradiction and at least one of:

1. A matching independently supplied external ID.
2. A resource-local canonical requested title immediately delimited by a compatible explicit movie year.

An episode may be CORROBORATED only with no hard contradiction and at least one of:

1. Matching independently supplied series/external identity plus exact season and episode.
2. A resource-local canonical requested series title immediately delimited by exact S/E.

Exact S/E alone remains UNKNOWN without reliable series identity. Compatible year or runtime alone, exact/common title text alone, lexical overlap and containment are not corroboration. Applicable hard contradiction takes precedence after the approved composition rules below.

Positive title structure needs a clear boundary. `Canonical.Title.1964...` may provide movie title/year evidence; `Canonical.Series.S02E04...` may provide series/S-E evidence. `Canonical.Title.HLFV.CODEX.1964...` and `Canonical.Title.Contract.1964...` must not gain positive title evidence by deleting unknown tokens. Do not interpret free-form token soup as a clean title statement or build an infinite release-tag cleanup dictionary.

Localized, romanized or alternate presentation without a trusted relation remains UNKNOWN. An independently supplied matching ID may separately satisfy the positive matrix. Unknown uploader/codec/tags/extra tokens and parsing failures remain UNKNOWN, not SUSPICIOUS. SUSPICIOUS requires an explicit/high-confidence candidate-local statement identifying another work, not merely failed canonical parsing.

No external alias resolver is introduced in v1.3. A future title-to-ID lookup returning no result or a different result must not become hard contradiction without a separate decision.

## Approved composition refinements — D-078–D-100

Composition decisions reconciled **2026-10-11**; their normative rules are recorded below. These rules qualify the existing 78 AC rows; they add no IDs, implementation or evidence. D-080/085 require distinct semantic sentinels and recorded decisions, not combinatorial expansion. D-092/095/097/100 supersede the earlier provisional statuses in D-091/094/096/099.

- D-078/079/081: correct discovery IDs, request-derived title/S-E, free-form ID-looking text, non-echo presentation, and result-derived matching title/year do not establish independent corroboration. No regex harvesting of IDs. Explicit independent different-work title may be SUSPICIOUS; absence of a canary does not prove independence.
- D-082: qualify origin claims independently and preserve provenance through dedupe. CORROBORATED + UNKNOWN equivalent copies may retain stronger admissible confidence without merging arbitrary fields. Independently matching and conflicting comparable ID claims about the same resource produce SUSPICIOUS/ADMIT, not majority voting or poisoning rejection. Applicable resource/measured hard contradiction rejects all copies. Different locators/request requirements are distinct routes; R-019 route competition remains separate open design work.
- D-083/084/086/087: preserve structural/taxonomy isolation, ambiguous-year/S-E fail-open and qualified resource S/E precedence. A clear incompatible production year in otherwise positive canonical series-title + exact-S/E resource blocks corroboration: SUSPICIOUS/ADMIT, never year-only episode rejection. Matching independent candidate ID + conflicting movie resource year is SUSPICIOUS/ADMIT (D-084 refers to approved ID-EXT-05/D-077); without that matching ID, qualified unambiguous wrong movie year rejects. SUPPORTED resource S/E wiring does not mean OBSERVED live prevalence.
- D-088/089/090: actual validated effective resources may transition UNKNOWN to CORROBORATED or CONTRADICTION; unsafe/failed routes supply no effective identity and disappear in their true domain. Parent paths and query text supply no identity; fragments are wholly neutral. Any non-empty query caps a **sole resource-path positive anchor** at SUSPICIOUS/ADMIT. A separate independent strong anchor may still corroborate; qualified basename contradictions still reject. No token-versus-selector heuristic/query-key dictionary; a query naming another locator is not an actual redirect.
- D-091/092: compatible supported independently measured runtime overrides contradictory textual duration **for runtime qualification** (Case 30); absent other evidence, UNKNOWN/ADMIT. Gross measured mismatch remains decisive. Keep movie strict `absDiff > max(10 minutes, 30% expected)`; R-016 resolved. No finer metadata source for synthetic +1-second arithmetic. Exact-episode runtime remains conditional on proven exact-S/E provenance; series-wide duration cannot substitute.
- D-093: rejection authority is a closed set, not every negative field. IDs require comparable semantic scope as well as namespace; series and episode IDs are not automatically comparable. Strong positive resource title/year + conflicting comparable independent candidate ID yields SUSPICIOUS/ADMIT; conflicting ID without an equally strong counter-anchor still rejects. Matching independent ID + clean different/localized resource title without trusted alias is SUSPICIOUS/ADMIT; unparsable text remains UNKNOWN in its title dimension. Gross measured-runtime mismatch defeats matching ID. Language/genre/codec/quality/size acquire no reject authority by analogy.
- D-095–D-098: opaque verified media with compatible runtime, measured runtime without trusted target, and exact S/E plus unanchored localized provider presentation remain UNKNOWN/ADMIT. Deterministic transport/policy failure is non-identity disappearance; successful transport cannot clear SUSPICIOUS. Do not reject every `verified === false` source. Healthy siblings retain useful-result opportunity inside raw/probe/quota bounds. Deterministic post-probe rejection permits existing bounded replacement (shared deadline; at most `2 * maxCandidates` attempts); timeout alone does not. Rejects do not consume final useful quota. Prove internal-state-to-public-token propagation through real qualification/routes, not only formatting; v1.3 ranking stays unchanged, R-017/v1.4 and R-018 yield measurement remain separate.
- D-099/100: fake canaries only; forbidden credential headers are dropped before the direct-source contract and bridge-owned secrets never enter it. Necessary signed locators/allowed compatibility headers remain narrowly scoped and ephemeral internally; public title/filename/error, logs, traces and artifacts must not expose sensitive material. Omission/structural minimization is primary, not a growing redaction dictionary. Reject QA retains real playback/network/media protections behind opaque localhost handles. FAM-14 semantics are closed; R-020 remains OPEN and blocks final privacy implementation design/freeze, including the older context-versus-code Referer/Origin drift. No anonymity claim.

## Structural kind contract — R-006 resolved

OPTION A is approved: `metadata.identity.kind` and `metadata.identity.type` are equivalent aliases for explicit structural `movie | series | episode` identity. Anime, animation, OVA, special and provider/site categories are classification/taxonomy, not structural kind. An episode request with candidate structural series is compatible; qualified candidate movie identity may contradict it.

The 2026-10-03 read-only local provenance audit resolved R-006:

- Stremio addon normalization constructs candidates from an allowlist; ordinary upstream type/kind/taxonomy/anime and nested upstream metadata are not promoted into candidate structural identity.
- Built-in Python/Kodi adapters do not automatically promote taxonomy. Callable/SourcePack discard arbitrary metadata; P2P/external-scraper adapters construct diagnostic metadata without identity.
- Source transport type and request-routing type are separate from candidate proof.
- External HTTP, Manual, Local JSON and locally configured custom Python modules can deliberately supply nested identity.
- Removing the type alias would change configured backward compatibility without establishing provenance: kind could be misused identically.

The nested boundary is the explicit identity contract, not independent provenance verification. Shared normalization recognizes only the three exact structural values and canonicalizes the alias to kind; arbitrary category strings remain non-decisive. Current `raw.kind ?? raw.type` precedence is preserved: a non-null kind wins, even if invalid. No taxonomy conversion, alias conflict rule or provider-specific heuristic is added by this decision.

Exact audit anchors: `src/streams/identity-qualification.ts:23`, `normalization.ts:88`, `providers/stremio-addon-stream-provider.ts:112`, `providers/external-http-stream-provider.ts:98` (paths under `src/streams/`); `python-adapter-host/adapter_host/normalization.py:89`, `kodi/protocol.py:58`, `kodi/adapters/callable_stream_resolver.py:20`, `source_pack.py:286`, `p2p_metadata.py:335`, `external_scraper_package.py:197` (last three under the same adapters directory). README's existing nested alias promise remains compatible. No built-in producer synthesizes nested type, but production pass-through paths support it.

## Runtime and approved year policy

Runtime is strong negative evidence only. Compatible runtime does not prove identity; unavailable/unmeasurable runtime is neutral and fail-open for that claim. The accepted local measured-movie threshold is **max(10 minutes, 30% expected)**; reject only when absolute difference is strictly greater. Exact episodes use **max(3 minutes, 20% expected)** with the same strict comparison, only when trusted duration belongs to the exact requested S/E. Typical/series-wide runtime must not substitute.

The supported current series metadata path does not prove exact episode runtime acquisition/propagation. That public protection is conditional/unavailable today; synthetic requested-item injection is not proof of public wiring.

AC-ID-028 and AC-ID-039 define the v1.3 year policy. For an exact episode request, resource/release year is non-decisive by itself, before or after an episode marker. It may describe release, dub, remaster, edition, pack, air date or another non-series-identity context. Year-only disagreement is FAIL_OPEN and must not independently produce CONTRADICTION; year may remain diagnostic context. Exact S/E, qualified structural kind, external-ID and supported exact-episode-runtime contradictions remain active.

Movie year can produce a hard contradiction only when one explicit, unambiguous year is obtained from already qualified identity/resource provenance. Multiple plausible years, an interval/range or otherwise ambiguous numeric-year evidence leave the year dimension UNKNOWN / FAIL_OPEN. Do not select a year heuristically or create a universal year-cleanup rule. Another independent hard contradiction can still reject the candidate. Episode resource/release years remain governed by AC-ID-028.

## Movies

| ID / short name | Given | When | Then / expected production decision | Expected audit | Required evidence | Notes / limitation |
| --- | --- | --- | --- | --- | --- | --- |
| AC-ID-001 Matching independently supplied external ID | Requested movie and candidate independently share a supported external ID. | A safe candidate is qualified. | ADMIT unless a hard contradiction exists. | CORROBORATED without hard contradiction; otherwise CONTRADICTION. | integration | Provider echo is not independent; contradiction overrides corroboration. |
| AC-ID-002 Conflicting external ID | Both sides state different IDs in the same supported namespace. | Candidate is qualified. | REJECT comparable conflicting ID absent equally strong counter-anchor; disputed resource follows D-082/093. | CONTRADICTION or approved SUSPICIOUS | integration | IDs must have comparable semantic scope; strong counter-anchor/same-resource origin dispute follows D-082/093 (SUSPICIOUS/ADMIT). Missing/different-namespace IDs are not conflicts. |
| AC-ID-003 Compatible movie year | Trusted request year and explicit candidate release year agree. | An otherwise eligible movie is resolved. | Retain: ADMIT. | CORROBORATED only with the immediately delimited resource-title/year matrix; otherwise UNKNOWN. | integration | Same year alone does not establish the same movie. |
| AC-ID-004 Incompatible movie year | Trusted requested year conflicts with an unambiguous explicit movie year. | Presentation, filename or resource evidence is qualified. | REJECT unless independent matching ID + resource-year dispute (D-084). | CONTRADICTION or approved SUSPICIOUS | acceptance | D-084/ID-EXT-05: independent matching ID + conflicting resource year is SUSPICIOUS/ADMIT; otherwise reject. Ambiguous years are AC-ID-039. |
| AC-ID-005 Episodic resource for movie | A movie request receives explicit episodic kind or bounded episode coordinates. | Candidate is qualified. | Exclude: REJECT. | CONTRADICTION | system | Prose mentioning an episode is insufficient. |
| AC-ID-006 Compatible measured movie runtime | Trusted movie runtime and verified MP4/HLS duration exist. | Absolute difference is at most max(10 minutes, 30% of expected runtime). | Retain: ADMIT. | UNKNOWN absent other evidence; runtime agreement never corroborates identity. | acceptance | Equality survives. A compatible runtime does not identify the movie. |
| AC-ID-007 Gross measured movie mismatch | The same trusted and measured durations exist. | Difference exceeds max(10 minutes, 30%). | Exclude: REJECT. | CONTRADICTION | acceptance | Apply symmetrically to shorter and longer content, through normal rejection/backfill accounting. |
| AC-ID-008 Missing expected movie runtime | Trusted runtime is absent or unusable. | Media runtime is measured. | No runtime rejection: FAIL_OPEN. | UNKNOWN absent other evidence. | integration | Never derive expected duration from candidate labels, file size or multipart names. |
| AC-ID-009 Unmeasurable movie runtime | Expected runtime exists, but bounded media inspection yields no valid duration. | Otherwise eligible media is resolved. | No measured-runtime rejection: FAIL_OPEN. | UNKNOWN absent other evidence. | acceptance | Invalid/truncated MP4 indexes and incomplete/live HLS can remain unknown. |
| AC-ID-010 Generic movie label | Candidate says “Server 1” or only quality/audio. | Safe playable media is resolved. | Preserve recall: FAIL_OPEN. | UNKNOWN | acceptance | Generic labels supply no positive identity corroboration. |
| AC-ID-011 Opaque movie resource | URL and filename carry no meaningful identity. | Independent media verification establishes eligibility. | Preserve playable candidate: ADMIT. | UNKNOWN | acceptance | An opaque URL with probing disabled or unsuccessful is not automatically eligible. |
| AC-ID-012 Localized movie title | Localized presentation has compatible year and no hard contradiction, without a trusted title relation. | Safe media is qualified. | Preserve recall: ADMIT. | UNKNOWN; independently supplied matching ID can separately corroborate. | acceptance; manual | Do not infer an alias or SUSPICIOUS merely from localized text. Manual truth review remains required. |
| AC-ID-013 Explicit different movie title | An explicit/high-confidence candidate-local title statement identifies a different work. | It is requested as “Synthetic Meridian”. | Normally ADMIT, visibly distinct; title alone cannot silently hard-reject. | SUSPICIOUS; ambiguous tokens/presentation without reliable identification remain UNKNOWN. | acceptance; manual | Phase 2.5 closes title-only disposition; existing tests prove survival, not the refined confidence boundary. |
| AC-ID-014 Different title plus contradiction | Different title also has a conflicting year, ID, kind or measured runtime. | Candidate is qualified. | Exclude: REJECT. | CONTRADICTION | acceptance | Recall controls must not neutralize independent strong evidence. |
| AC-ID-015 Provider textual duration | A movie label includes one valid standalone hh:mm:ss line and trusted expected runtime exists. | Difference exceeds both 30 minutes and 25% of expected runtime. | Compatible supported bridge measurement overrides textual runtime rejection (D-091); otherwise the separate textual rule remains. | CONTRADICTION on rejection; otherwise UNKNOWN absent other evidence. | integration | This weaker rule is subordinate to compatible independent measurement, which alone does not corroborate identity; ambiguous/multiple duration lines do not donate a duration. |
| AC-ID-016 Untrusted runtime claims | Provider supplies duration/probe fields without bridge measurement. | Candidate is normalized and qualified. | Do not treat those fields as measured evidence: FAIL_OPEN for that claim. | UNKNOWN absent other evidence. | acceptance | Independently measured supported evidence may still reject it later. |

## Exact episodes

| ID / short name | Given | When | Then / expected production decision | Expected audit | Required evidence | Notes / limitation |
| --- | --- | --- | --- | --- | --- | --- |
| AC-ID-017 Exact season/episode | Requested S02E03 and candidate's explicit S/E agree. | Candidate is resolved. | Retain: ADMIT. | UNKNOWN without canonical title/ID corroboration. | system | A bare episode marker must not invent a season. |
| AC-ID-018 Wrong season | Both sides explicitly state different seasons. | Episode is qualified. | Exclude: REJECT. | CONTRADICTION | system | A missing candidate season is not a wrong season. |
| AC-ID-019 Wrong episode | Both sides explicitly state different episodes. | Episode is qualified. | Exclude: REJECT. | CONTRADICTION | system | Preserve the exact requested video identity. |
| AC-ID-020 Movie identity for episode | Episode receives explicit movie kind. | Candidate is qualified. | Exclude: REJECT. | CONTRADICTION | integration | Series kind with compatible S/E is not the same conflict. |
| AC-ID-021 Series title variation | Localized, romanized or alternate series text accompanies compatible S/E and no contradiction. | Safe candidate is resolved. | Preserve numeric identity recall: ADMIT. | UNKNOWN without reliable series identity; independent identity plus exact S/E may corroborate. | acceptance; manual | Alternate/romanized presentation does not establish an alias or another work. |
| AC-ID-022 Generic episode label | Episode candidate has only “Server 1” and safe media evidence. | It is resolved. | Do not reject for missing series text: FAIL_OPEN. | UNKNOWN | system | Coordinate contradictions still prevail. |
| AC-ID-023 Compatible exact episode runtime | Trusted runtime belongs to the exact requested S/E, and verified MP4/HLS duration exists. | Difference is at most max(3 minutes, 20% of expected runtime). | Retain: ADMIT. | UNKNOWN absent other evidence. | integration; acceptance | Equality survives. This conditional rule must not use series-wide runtime. Required examples are below. |
| AC-ID-024 Gross exact episode runtime mismatch | The same exact trusted and measured durations exist. | Difference exceeds max(3 minutes, 20%). | Exclude: REJECT. | CONTRADICTION | integration; acceptance | Movie's 10-minute floor must not be reused. Rejection uses existing accounting/backfill. |
| AC-ID-025 Exact episode runtime unavailable | Metadata lacks runtime for the exact requested S/E. | Candidate is resolved, even with measured duration. | No runtime-based episode rejection: FAIL_OPEN. | UNKNOWN absent other evidence. | integration | Typical series duration, air dates and provider duration lines cannot substitute. |
| AC-ID-026 Explicit different series title | An explicit/high-confidence candidate-local title statement identifies another series, with no hard conflict. | An episode is qualified. | Normally ADMIT, visibly distinct; preserve compatible numeric recall. | SUSPICIOUS; ambiguous or untrusted alternate text remains UNKNOWN. | acceptance; manual | Phase 2.5 closes title-only disposition; matching S/E alone is not corroboration. |
| AC-ID-027 Ambiguous episode resource | Bounded parsing cannot establish one unambiguous episode identity. | Candidate is qualified. | Do not reject on that ambiguity alone: FAIL_OPEN. | UNKNOWN or SUSPICIOUS from remaining text. | integration | A separately explicit kind/S/E/ID contradiction remains decisive. |
| AC-ID-028 Episode resource/release year | Exact episode request has a resource/release-year disagreement before or after an episode marker. | Episode is qualified. | Year-only disagreement is non-decisive: FAIL_OPEN; never hard-reject from that year alone. | UNKNOWN for the year dimension; no year-only CONTRADICTION. | system; manual | Human-approved v1.3 policy. Year may describe release/dub/remaster/edition/pack/air date or other context and remain diagnostic. S/E, qualified kind, external-ID and supported exact-episode-runtime contradictions remain active. |
| AC-ID-029 Date after episode marker | Resource contains a date/year after its episode marker. | Requested S/E otherwise agree. | No year-based rejection: FAIL_OPEN. | UNKNOWN/SUSPICIOUS according to other text. | integration | A later date must not become trusted series identity. |

### Runtime boundary examples

All rows require exact trusted episode duration and independently verified media measurement. Without either, AC-ID-025 applies. Seconds are compared; the threshold is exceeded only with a strictly greater difference.

| Expected episode minutes | Survive examples | Reject examples | Tolerance minutes |
| --- | --- | --- | --- |
| 10 | 9, 12, 13 | 14 | 3 |
| 22 | 21, 25; exact boundaries 17.6 and 26.4 | 12, 50 | 4.4 |
| 45 | 44, 50; exact boundaries 36 and 54 | 32, 22 | 9 |
| 60 | 48 through 72 inclusive | 30, 90; just outside the boundaries | 12 |

For intentional movie/episode distinction, 10→14, 22→12, 22→30, 45→32 and 60→45 minutes survive the movie tolerance and contradict the exact-episode tolerance. These examples are tolerance checks, not declarations that such durations establish movie identity.

## Resource and URL evidence

| ID / short name | Given | When | Then / expected production decision | Expected audit | Required evidence | Notes / limitation |
| --- | --- | --- | --- | --- | --- | --- |
| AC-ID-030 Filename evidence | A bounded media filename states a conflicting movie year/kind or episode S/E. | An otherwise matching label is supplied. | REJECT applicable hard conflict; matching independent ID + resource-year dispute follows D-084. | CONTRADICTION or approved SUSPICIOUS | system | Filename evidence must not be masked by echoed request text. Episode year alone is non-decisive under AC-ID-028. |
| AC-ID-031 Original resource basename | Original safe HTTP(S) URL's final media component independently contradicts kind/movie year/S/E. | Presentation filename appears compatible. | REJECT applicable hard conflict; matching independent ID + resource-year dispute follows D-084. | CONTRADICTION or approved SUSPICIOUS | system | Parent path components do not donate identity. |
| AC-ID-032 Validated effective basename | Successful validated transport exposes a qualified incompatible kind, episode S/E or unambiguous movie year in the final media/selected video-playlist basename. | Post-probe qualification applies the approved composition rules. | REJECT applicable hard contradiction; independent matching candidate ID + conflicting qualified movie resource year is SUSPICIOUS/ADMIT under D-084/ID-EXT-05, absent another applicable hard contradiction. | CONTRADICTION on hard rejection; SUSPICIOUS for the approved ID/resource-year dispute. | acceptance | Keep sanitized derived evidence/provenance for negative and positive transitions (D-088), never raw effective names/locators. Failed/unsafe requests do not qualify. Episode year alone is non-decisive under AC-ID-028. |
| AC-ID-033 Generic master playlist | Safe playable resource ends in master.m3u8 or index.m3u8. | No contradictory facts exist. | Preserve: FAIL_OPEN. | UNKNOWN | acceptance | The basename does not corroborate the requested title. Complete VOD runtime can independently contradict. |
| AC-ID-034 Malformed URL | Provider returns an invalid/unsupported direct URL. | Public resolution normalizes it. | Exclude as invalid transport input: REJECT. | No identity CONTRADICTION inferred. | integration | A parser returning “no evidence” does not prove product admission; malformed percent encodings in an otherwise parseable URL are a separate media/safety question. |
| AC-ID-035 Multiple conflicting markers | One media name carries different episode/season markers. | No other independent contradiction exists. | No invented choice between markers: FAIL_OPEN. | UNKNOWN/SUSPICIOUS from remaining text. | integration | Movie-vs-episode evidence may also be ambiguous; this criterion is bounded to that observation, not every other claim. |
| AC-ID-036 Query/fragment/token isolation | Identity-looking text is present only in query, fragment, token or parent directory. | Safe basename identity is qualified. | Ignore query text/fragment for identity; apply D-090 non-empty-query cap to sole pathname positive. | UNKNOWN absent anchors; capped pathname positive SUSPICIOUS, independent anchor may corroborate. | acceptance | D-090: sole resource-path positive + non-empty query is SUSPICIOUS/ADMIT; independent strong anchor may corroborate, fragments are neutral. Do not persist locators. |
| AC-ID-037 Unsafe redirect | A redirect targets private/blocked addresses or exceeds redirect bounds. | Transport validates it. | Refuse unsafe transport: REJECT; manufacture no identity evidence. | No CONTRADICTION from the unsafe destination's name. | acceptance | No safety exception for recall or testing. |
| AC-ID-038 Failed effective response | Safe redirect reaches an episode-looking name but media request fails. | Qualification completes. | Do not manufacture effective resource identity: FAIL_OPEN for identity; media eligibility decides final rejection. | UNKNOWN absent prior evidence. | acceptance | Failure is not proof that returned content belongs to the named episode. |
| AC-ID-039 Ambiguous numeric years | Qualified identity/resource evidence contains multiple plausible years, an interval/range or otherwise ambiguous numeric years. | Movie-year contradiction is considered. | Year dimension is UNKNOWN / FAIL_OPEN; do not choose a year heuristically or hard-reject from ambiguity alone. | No year-only CONTRADICTION; another independent hard contradiction remains decisive. | integration; manual | Human-approved v1.3 policy: only one explicit, unambiguous movie year from already qualified provenance may hard-contradict. No universal year-cleanup heuristic. Episode resource/release years follow AC-ID-028. |

## Recall

| ID / short name | Given | When | Then / expected production decision | Expected audit | Required evidence | Notes / limitation |
| --- | --- | --- | --- | --- | --- | --- |
| AC-ID-040 Romanization/transliteration | Synthetic transliteration accompanies compatible structured evidence. | Safe source is resolved. | Preserve recall: ADMIT. | UNKNOWN without a trusted relation; reliable independent ID can separately corroborate. | acceptance; manual | String mutation proves tolerance, not an authoritative alias relationship or correct content. |
| AC-ID-041 Alternate-title scope | A provider claims an alternate presentation title without independent identification or a trusted relation. | It differs from the requested title. | ADMIT / fail-open without a hard contradiction; do not introduce alias lookup in v1.3. | UNKNOWN; separately explicit/high-confidence identification of another work is SUSPICIOUS. | acceptance; manual | Phase 2.5 closes alternate-title scope; future no-result/different-result lookup is not hard contradiction without a new decision. |
| AC-ID-042 Metadata-poor source | Provider supplies playable media with sparse labels/identity. | No strong contradiction exists. | Preserve eligible sibling: FAIL_OPEN. | UNKNOWN | acceptance | Missing facts cannot earn CORROBORATED. Safety and media requirements still apply. |
| AC-ID-043 HLS recall | Safe HLS playlist and required media dependencies are playable. | Identity is sparse/compatible. | Preserve HLS stream: ADMIT. | UNKNOWN absent corroboration. | acceptance | Live/incomplete HLS may be playable without measurable complete duration. |
| AC-ID-044 MP4 recall | Safe MP4 is playable with compatible or missing duration evidence. | Identity is sparse/compatible. | Preserve stream: ADMIT. | UNKNOWN absent corroboration. | acceptance | Bounded mvhd inspection is not a full content identification check. |
| AC-ID-045 HTTP and HTTPS recall | Same compatible identity is offered over either supported safe protocol. | Sources are resolved. | Both remain eligible: ADMIT. | Determined by identity evidence, not protocol. | acceptance | Ranking may prefer HTTPS; production TLS and HTTP paths need their own evidence. |
| AC-ID-046 No-duration recall | Safe playable source has neither reliable expected nor measured duration. | Identity contains no contradiction. | No duration-driven rejection: FAIL_OPEN. | UNKNOWN absent other corroboration. | acceptance | Wrong same-year content of similar duration or unknown duration can survive. |

## Behavioral invariants and request wiring

These invariants concern logical identity eligibility. They do not promise an identical ranked list under capacity saturation, score ties, changed network results or different probe budgets. Coverage must make those limitations visible rather than generalize a small permutation test.

| ID / short name | Given | When | Then / expected production decision | Expected audit | Required evidence | Notes / limitation |
| --- | --- | --- | --- | --- | --- | --- |
| AC-ID-047 Order invariance | Same independent candidate facts and successful evidence opportunities. | Provider/candidate order changes. | Preserve identity decisions: ADMIT/REJECT/FAIL_OPEN as before. | Same category for equivalent evidence. | acceptance | Probe scheduling, quotas and tie winners can change the returned set; existing bounded properties do not prove universal returned-set invariance. |
| AC-ID-048 Duplicate invariance | Exact duplicate candidate and evidence are inserted. | Resolution repeats. | Preserve intrinsic decisions and distinct eligible sources: ADMIT/REJECT/FAIL_OPEN as before. | Same individual category; raw observation counts may increase. | acceptance | Raw caps and competing duplicate metadata make unrestricted survivor-set claims unsafe. |
| AC-ID-049 Noise monotonicity | Healthy sources have stable facts and bounded opportunity. | Additional generic noise/strongly contradictory candidates are inserted. | Existing logical eligibility cannot worsen; contradictions remain REJECT. | Existing evidence categories unchanged. | acceptance | Starvation at raw/probe caps is not proven away. |
| AC-ID-050 Provider expansion | New normalized provider supplies additional candidates, including origins of a dedupe-equivalent resource. | Qualification distinguishes an applicable resource/measured hard contradiction from independently matching and conflicting comparable origin-ID claims about that same resource. | An applicable resource/measured hard contradiction remains REJECT for all equivalent copies; without such a contradiction, the approved matching/conflicting origin-ID dispute is SUSPICIOUS/ADMIT under D-082. | CONTRADICTION for the resource/measured hard contradiction; SUSPICIOUS for the approved origin-claim dispute. | acceptance | Preserve origin/resource provenance and apply D-084/093 composition before declaring a hard contradiction. Do not merge arbitrary origin fields or vote by majority. Fake IDs do not prove adapter provenance. |
| AC-ID-051 Generic labels cannot identify | Candidate only echoes request text or a generic server label. | Audit/qualification runs. | No manufactured positive identity: FAIL_OPEN. | UNKNOWN | focused/component | The refined positive matrix is required for corroboration; echoed text is not independent. |
| AC-ID-052 Equivalent pre/post evidence | Same valid strong facts arrive in original/filename evidence or validated effective media evidence. | Qualification happens before/after probe. | Equivalent facts have equivalent REJECT decisions. | CONTRADICTION in the appropriate observed stage. | acceptance | Requires provenance checks; pre-probe presentation cannot impersonate measured evidence. |
| AC-ID-053 Bounded contradiction backfill | A probed candidate deterministically contradicts identity/runtime and a healthy sibling is available. | Existing replacement opportunity remains. | REJECT contradictory candidate; ADMIT eligible sibling within existing limits. | CONTRADICTION on rejected observation; none in final survivors. | acceptance | No unlimited probing; cache reuse must preserve measured evidence and rejection accounting. |
| AC-ID-054 Locator privacy | Candidates/probes include sensitive URL tokens, redirect names and source headers. | Diagnostics, audit reports and logs are emitted. | Preserve decisions; ADMIT/REJECT/FAIL_OPEN based on evidence without leaking locators. | Sanitized identity categories only; current legacy report uses MATCH, not public CORROBORATED. | focused/component; system | Public playback URLs use opaque local tokens. Audit counts must not expose upstream URLs, basenames or tokens. |
| AC-ID-055 Trusted movie runtime wiring | Independent trusted movie metadata supplies runtime, even when catalog owns title/year. | Public movie stream route resolves measured media. | Apply movie runtime qualification: ADMIT within tolerance, REJECT gross mismatch. | CONTRADICTION on gross mismatch. | integration | Preserve requested identity and catalog-owned fields; safe metadata redirects do not suppress enrichment. |
| AC-ID-056 Conditional exact episode wiring | Trusted metadata actually supplies duration tied to the exact requested S/E. | Public episode resolution receives that supported metadata. | Propagate expected duration and apply ADMIT/REJECT exact-episode rule. | CONTRADICTION only for supported gross mismatch. | integration; acceptance | Conditional requirement remains unproven/unavailable on the supported series lookup path. Synthetic NormalizedMediaItem injection is not public wiring proof. |
| AC-ID-057 No typical series runtime | Metadata has only series-wide duration or episode air dates. | Exact episode request is enriched. | Keep exact runtime unavailable: FAIL_OPEN for runtime. | UNKNOWN absent other evidence. | integration | Small validated series title/year enrichment remains acceptable; year alone cannot reject an episode. |
| AC-ID-058 Contradictions cannot be masked | Candidate has matching presentation/year/runtime plus independently conflicting kind, S/E, movie year or ID. | All supported evidence is qualified. | Apply closed hard-conflict set and D-082/084/093 composition: applicable hard contradiction REJECT, strong dispute SUSPICIOUS/ADMIT. | CONTRADICTION for applicable hard conflict; SUSPICIOUS for approved strong-evidence disputes. | acceptance | Echo cannot override resource evidence; independent strong counter-anchors follow approved composition exceptions. Episode-year-only is explicitly excluded. |
| AC-ID-059 Exact requested video identity | User requests a specific episode video ID. | Metadata enrichment and provider mapping occur. | Preserve exact ID/S/E and retain compatible source: ADMIT. | UNKNOWN absent independent corroboration. | system | No guessed cross-namespace mapping or replacement by series base ID; missing coordinates must not fabricate an IMDb episode ID. |

## Public Stremio presentation — intended v1.3 contract

These are normative examples of the intended v1.3 resolved-source contract.
The maintained rendering grammar and its implemented scope are documented in
[safe stream descriptions](../../safe-stream-descriptions.md); the historical
consolidation of this contract did not itself implement rendering:

```text
HTTPS✓ · ID? · 720p · 562MB · 3.8s
HTTPS✓ · ID✓ · 1080p · 1.3GB · 2.7s
HTTPS · ID! · 720p · 866MB
Tribler · ID? · 1080p · 4.2GB · 31 seeds
```

HTTP(S) displays the actual protocol, without redundant Direct. The transport ✓ means direct-media probe verified, never correct identity. An admitted unverified source has no transport marker; do not show a transport ? or Unverified. Identity markers are ID✓ = CORROBORATED, ID? = UNKNOWN, ID! = SUSPICIOUS. CONTRADICTION is absent publicly.

The compact summary omits literal Range, Verified, Unverified, codec and duplicate Direct + HTTP(S) wording. Range support, codec metadata/scoring and detailed probe status remain internal. Below 1 GiB, round whole MB; at/above 1 GiB, use one decimal GB (binary byte conversion with these compact labels). No number/unit space: 562MB, 1.3GB. Latency is one decimal seconds: 377ms → 0.4s; 3770ms → 3.8s. Do not allow number/unit separation that wraps awkwardly.

v1.3 classifies, rejects contradictions and exposes confidence while preserving current ranking. Confidence-based ranking/bucketing is v1.4 Source Selection / Fast Path: roughly corroborated, unknown, suspicious, with contradiction absent. The historical contract consolidation implemented neither presentation nor ranking changes; current presentation behavior is described by the maintained grammar linked above. The [campaign](IDENTITY_QA_CAMPAIGN.md#identity-presentation-closed) records the later bounded presentation closeout and its limits.

## QA decision trace and manual falsification

Live/system QA must inspect survivors and representative rejects. Conceptual stable stages are NORMALIZED → PRE_PROBE_IDENTITY → PROBE → POST_PROBE_IDENTITY → FINAL. Existing resolver/audit stages are related implementation observations, not proof of this complete trace contract.

Every observed candidate must eventually be attributable using an opaque trace ID, provider/source family, safe presentation label, evidence categories, per-stage CONTINUE / REJECT / NOT_REACHED, first decisive rule/reason code, final identity state, final disposition and separate transport state. Disappearance must identify its domain: IDENTITY, TRANSPORT, MEDIA_QUALIFICATION, URL_POLICY, DEDUPE, PROBE_BUDGET, PROVIDER_QUOTA or OTHER_BOUNDED_PIPELINE_RULE. Never expose raw upstream URLs, tokens, cookies, sensitive headers, magnets or secrets.

Manual smoke includes real Stremio visual rendering, survivor playback and reason/risk review of representative rejected candidates. Do not play every reject. Select every newly introduced hard-rejection family, threshold/boundary cases, disagreeing evidence, semantically doubtful rejects and small samples of high-volume deterministic rejection reasons. Keep URL/media protections intact.

Record two independent adjudications:

| Dimension | Allowed outcomes |
| --- | --- |
| CONTENT TRUTH | CORRECT_CONTENT / WRONG_CONTENT / INCONCLUSIVE |
| RULE VERDICT | RULE_SUPPORTED / RULE_FALSIFIED / IMPLEMENTATION_BUG / HARNESS_GAP / UPSTREAM_UNKNOWN |

Correct content rejected exactly according to an AC falsifies the rule: RULE_FALSIFIED / ID-SPEC-GAP. Do not patch that example just to make the suite green. ACs remain falsifiable product hypotheses until Phase 9 freeze. Revise the generic AC first, update the negative and recall neighbour, update corpus/properties/system evidence, then rerun the original live smoke.

The preferred future reject-playback mechanism is a local QA harness using opaque localhost playback handles and existing playback internals. No public debug endpoint or security exception is authorized by this consolidation.

## Phase 2.5 added acceptance criteria

These rows extend stable AC-ID-001–059; they do not imply implementation or evidence completion.

| ID / short name | Given | When | Then / expected production decision | Expected audit | Required evidence | Notes / limitation |
| --- | --- | --- | --- | --- | --- | --- |
| AC-ID-060 State/disposition separation | Safe media has corroborated, unknown, suspicious or contradictory identity. | Shared qualification and public output run. | ADMIT the first three subject to other domains; REJECT contradiction. | CORROBORATED / UNKNOWN / SUSPICIOUS / CONTRADICTION remain distinct. | acceptance; system | UNKNOWN is never known-good; transport verified is orthogonal. |
| AC-ID-061 Independent provenance | Matching facts share provider/request-echo origin. | Confidence is assigned. | Do not manufacture corroboration; retain UNKNOWN absent other evidence. | Provenance categories distinguish request, presentation, resource, measurement and candidate ID. | component; acceptance | Multiple fields from one origin are not independent votes. |
| AC-ID-062 Movie positive matrix | No hard conflict; independent matching ID or canonical resource title immediately delimited by compatible movie year. | Confidence is assigned. | CORROBORATED only under that matrix; otherwise UNKNOWN/SUSPICIOUS as supported. | CORROBORATED only with qualifying evidence. | acceptance | Compatible runtime/year/title alone is insufficient. |
| AC-ID-063 Episode positive matrix | No hard conflict; reliable series/external identity + exact S/E, or canonical resource series title immediately delimited by exact S/E. | Confidence is assigned. | CORROBORATED only under that matrix; S/E alone remains UNKNOWN. | CORROBORATED or UNKNOWN according to provenance. | acceptance; system | No guessed series identity or season. |
| AC-ID-064 No lexical-only positive | Only overlap, containment or exact/common title text matches. | Confidence is assigned. | ADMIT if otherwise eligible without promotion. | UNKNOWN absent qualifying independent evidence. | component; acceptance | Matching display text is not identification. |
| AC-ID-065 Clear title boundary | Clean title/year or series/S-E structure competes with unknown intervening tokens. | Resource title evidence is parsed. | Only clearly delimited canonical structure may corroborate; token soup stays UNKNOWN. | No positive or SUSPICIOUS from arbitrary cleanup/parsing failure. | component; acceptance | No infinite release-tag dictionary. |
| AC-ID-066 Suspicious title precision | An explicit/high-confidence candidate-local title identifies another work. | No hard conflict exists. | Normally ADMIT and visibly distinguish it. | SUSPICIOUS; uncertain tags/alternate text remain UNKNOWN. | acceptance; manual | Future hard title rejection needs separate approval. |
| AC-ID-067 Alias/lookup neutrality | Alternate/localized text lacks a trusted relation, or a future lookup yields no/different result. | Identity is assessed. | v1.3 adds no alias resolver; no lookup-only hard rejection without separate decision. | UNKNOWN absent other evidence. | component; acceptance; manual | Independently supplied ID can separately corroborate. |
| AC-ID-068 Structural alias/taxonomy isolation | Explicit nested kind/type is movie, series or episode; other fields carry taxonomy/routing/transport. | Built-in intake and shared qualification run. | Keep both aliases; reject qualified conflicts, allow episode + series; never promote other types. | CONTRADICTION only for qualified structural conflict. | contract; integration | R-006 resolved by Option A; custom claim truth is not authenticated. |
| AC-ID-069 Compact transport marker | Resolved direct source uses HTTP or HTTPS with/without verified probe. | Public summary renders. | Show actual protocol and ✓ only when verified; omit marker otherwise and redundant Direct. | Identity state independent of transport marker. | public acceptance; UI journey | Never print transport ? / Verified / Unverified. |
| AC-ID-070 Public identity confidence | Resolved candidates have final confidence states. | Stremio response is emitted. | Show ID✓ / ID? / ID!; never return contradiction. | Public state agrees with shared qualification. | acceptance; system; UI journey | Current audit-only enum is not public propagation proof. |
| AC-ID-071 Compact numeric formatting | Size crosses 1 GiB; measured latency includes 377ms and 3770ms. | Summary renders. | Rounded MB below threshold, one decimal GB at/above; one decimal seconds, no number/unit space. | Confidence unaffected. | focused; public acceptance; UI journey | Boundary and wrapping neighbours required. |
| AC-ID-072 Summary/internal/ranking separation | Source has Range, codec and detailed probe metadata. | Compact summary and ranking run. | Omit verbose public terms/codec; keep internal facts and current ranking. | Identity confidence does not re-rank in v1.3. | component; acceptance | Confidence ranking belongs to v1.4. |
| AC-ID-073 Complete staged candidate trace | Live/system QA observes surviving and rejected candidates. | Pipeline completes within existing bounds. | Attribute opaque ID, safe label/family/evidence, stages, first decisive reason, final state/disposition and transport. | CONTINUE / REJECT / NOT_REACHED at stable stages. | system; live QA | No complete trace claimed from aggregate stage counts. |
| AC-ID-074 Disappearance decision domain | A candidate is absent at FINAL. | QA reviews the outcome. | Identify identity, transport, media, URL policy, dedupe, budget, quota or other bounded domain. | No invented identity contradiction for another domain. | system; live QA | Dedupe/cap loss is not necessarily identity REJECT. |
| AC-ID-075 Trace and reject-playback privacy | QA needs detailed trace and representative reject playback. | Local QA mechanism records data/handles. | Use sanitized trace and opaque localhost playback handles; preserve safety boundaries. | No locator/secret exposure. | security; system; live QA | No public debug endpoint; future harness not implemented here. |
| AC-ID-076 Human smoke selection | Implementation is available in real Stremio. | Human reviews survivors and risk-selected rejects. | Check visual summary, playback and each new rejection family/boundary/disagreement/doubtful case plus bounded samples. | Content truth recorded independently. | UI journey; manual | Do not play every reject or bypass URL/media protection. |
| AC-ID-077 Falsifiable adjudication | Human truth disagrees with an expected rejection. | Rule and implementation are reviewed separately. | Record both dimensions; correct content rejected per AC is RULE_FALSIFIED / ID-SPEC-GAP. | Separate rule failure, implementation bug, harness gap and upstream uncertainty. | manual | Never patch an example solely for green tests. |
| AC-ID-078 Generic rule revision | A falsified rule needs refinement before Phase 9 freeze. | Revision is approved. | Change generic AC first, negative/recall neighbour, corpus/properties/system, then rerun original live smoke. | Revision evidence remains attributable. | campaign checkpoint; manual | Phase 3 exposes expected failures before production hardening. |

## Explicit limits of this checkpoint

No acceptance criterion promises to identify unrelated content when it has compatible numeric facts, no trustworthy exact episode runtime, an unmeasurable duration, or no independent identity evidence. A runtime mismatch can reject grossly different length; a runtime match cannot prove correct content. Phase 2.5 defines future confidence/presentation/trace/manual requirements; it does not implement heuristics, a corpus, live sampling, a QA harness or a UI journey. Historical Phase 0–2 characterization is retained in coverage. The refined set has 78 settled product-policy criteria; AC-ID-028 and AC-ID-039 are approved. Implementation/evidence gaps remain in coverage; no current product-policy row is DECISION_REQUIRED.
