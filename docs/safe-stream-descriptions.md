# Safe stream descriptions

Resolved streams retain their compact `name` and opaque localhost playback URL.
An optional `title` provides up to three closed upstream labels, ordered as
audio language, audio mode, subtitle language. These labels
describe provider claims, not independently verified media tracks. Empty descriptions omit the
property entirely. The installed Stremio addon SDK defines `title` as an optional
stream description; client rendering still requires a Stremio UI check.

Supported languages are English, Spanish, French, German, Italian, Portuguese,
Japanese, Korean, Chinese, Russian, Hindi and Hungarian. The closed vocabulary
accepts each English language name and the following ISO 639-1/639-3 aliases
(en/eng, es/spa, fr/fra, de/deu, it/ita, pt/por, ja/jpn, ko/kor, zh/zho,
ru/rus, hi/hin, hu/hun), ignoring ASCII case and surrounding spaces. Generic
`language` is retained internally for scoring but produces no public description,
including no `Language: en` label. It does not identify an audio or subtitle
track and does not override explicit declarations. Bare `audio: "Japanese"`
declares Japanese audio; this remains a provider declaration, not a verified
track property. No media track analysis is performed.

Only the dedicated `audio` field additionally accepts bare `Dual` and `Multi`
as `Dual audio` and `Multi audio`. ASCII case and surrounding spaces are ignored;
one or more ASCII spaces may separate the mode from `audio`. Bare modes are not
accepted in generic `language` or presentation titles. Full `Dual audio` and
`Multi audio` descriptors remain supported in closed presentation titles.

For public descriptions, only `audio` accepts a whole pair of distinct recognized
two- or three-letter codes, using exactly one `/`, `+` or `,` separator with
optional ASCII spaces around it. The pair is rendered in provider order as one
canonical component:

| Input | Public description |
| --- | --- |
| `audio: "Dual"` | `Dual audio` |
| `audio: "MULTI"` | `Multi audio` |
| `audio: "ES/EN"` | `Spanish/English audio` |
| `audio: "ENG+JPN"` | `English/Japanese audio` |
| `audio: "JA, EN"` | `Japanese/English audio` |
| `audio: "ES/EN", title: "English subs"` | `Spanish/English audio · English subtitles` |
| `audio: "ENG+JPN", title: "Dual audio"` | `English/Japanese audio` |

Two-language audio suppresses a redundant `Dual audio` component; it does not
add a mode. A separate `Multi audio` declaration retains its existing meaning.
Lists of names, more than two codes, unknown codes, repeated languages (including
aliases such as `EN/ENG`), mixed/repeated separators and partial matches are
rejected whole. `language: "ES/EN"` produces no public label even though it is
recognized for scoring. Title `ES/EN` and title `Audio: ENG+JPN` remain
unsupported. No language is extracted from locators or release names.
Regional abbreviations such as `VOSE`, `VOSTFR` and `DUAL LATINO` remain omitted.

Presentation text supports complete components such as `Hungarian audio`,
`Audio: Japanese`, `English subtitles`, `English subs`, `Subtitles: English`,
`Subs: English`, `Dual audio` and `Multi audio`, separated by ` · ` or ` | `.
Every title component must match
this closed grammar. Explicit descriptors in `audio` retain their stated kind:
`audio: "English subs"` declares subtitles, never English audio. Conflicting
audio languages across `audio` and `title` are omitted; conflicting subtitle
languages or audio modes are also omitted, independently by kind. Generic
`language` cannot resolve those conflicts. Missing, unsupported or ambiguous
values produce no label; no free text is repaired into a declaration.
An audio pair and a different explicit title claim (including a single language
from that pair) are not equivalent declarations: the audio component is omitted
rather than choosing a field, taking a union or inferring which tracks exist.
Independent subtitle declarations remain eligible.

At most eight title components are examined, with a 500-character input limit.
Labels are added in the order above only while they fit the existing three-label
and 53-character limits; a label that does not fit is omitted whole. Controls,
format/invisible characters, non-ASCII letters and markup are rejected before
case conversion. Output uses canonical literals from the closed language
vocabulary. No arbitrary provider substring
is copied to public JSON.

Free-form release titles, filenames, URLs, queries, headers, provider identity,
arbitrary metadata, bare language words in titles, language lists and unsupported
audio formats are unavailable in descriptions, except for the exact audio-field
code pairs above. Resolution, size, transport, identity, latency and seeds remain
in the existing compact summary. Codecs
remain internal, following the compact presentation contract.

The existing normalizers preserve audio/language for generic HTTP providers and
the Python adapter. The Stremio provider retains `description`, then `title`,
then `name` as normalized presentation text; it does not merge those fields.
Resolver normalization validates language/audio as described below, and
PlaybackManager retains the private source behind its token. Only the resolved mapping in
`createAddon` constructs the public description. Legacy catalog/download
fallback presentation is a separate boundary and is not covered by this policy.

## Scoring recognition and seed counts

The metadata component awards **+2 for recognized structured `language`** and
**+1 for recognized structured `audio`**. Missing, empty, opaque, unknown or
invalid values receive zero points. Recognition uses the vocabulary above:
`language` accepts a whole single alias or a pair of distinct known two- or
three-letter codes separated by `/`, `+` or `,`, with optional ASCII spaces.
`audio` additionally accepts whole `audio: alias` / `alias audio` declarations
and the existing dual/multi modes. Case and surrounding spaces are ignored;
controls, markup, locators, ambiguous lists and arbitrary text are rejected.
Scoring does not infer languages from titles, filenames or URLs.

Provider normalization checks the complete original `language`/`audio` value
before trimming ASCII spaces. Controls, markup and values over the shared
500-character limit are omitted. Whole recognized claims are retained without
truncation, including permitted spaces within pairs or modes. Other safe text
is retained only within the existing field limits (80 for language, 120 for
audio); longer values are omitted rather than turning a truncated prefix into
points or a public label. Safe short subtitle declarations remain supported
without audio points. Other fields keep their existing normalization.

Python normalization also checks the original `language`/`audio` characters
before stripping only exterior ASCII spaces. Unsafe, empty, non-string or
oversized decorative fields are omitted without rejecting an otherwise valid
source. Existing Python field bounds remain 64 characters for language and 128
for audio, with a 500-character original-input ceiling. Safe opaque text and
explicit subtitle declarations are transported whole, never truncated into a
recognized prefix. The P2P conversion uses the same guard before common
normalization. Python has no language vocabulary or scoring authority; Node
still decides recognition. URL, filename, title, seed and worker contracts are
unchanged, including Python's existing zero-seed torrent hygiene exclusion.

Scoring recognition does not authorize a public label: generic `language` is
never published, and public conflicts can suppress an otherwise recognized
audio declaration. Conversely, an explicit subtitle declaration in `audio`
can produce a subtitle label without receiving audio points. These are provider
declarations, not verified audiovisual tracks or evidence for Identity.
Ranking and opt-in F use the same scorer and effective policy; the closed
presentation grammar and existing ranking weights remain unchanged.

Seed counts must be numeric, nonnegative JavaScript safe integers. Fractions,
negative or unsafe numbers, NaN and infinities are unknown; values are never
rounded, truncated or coerced. Validation applies at provider normalization,
scoring and seed tie-breaks, and the public summary shows only valid counts.
Known zero retains its distinct penalty (default -60), while unknown retains
the unknown penalty (default -12). Valid integer scores and the configured
policy and weights are unchanged. Corrected scores can affect representatives
selected by dedupe and results retained after quotas; neither rule nor Identity
precedence changes.

## Optional F ranking description

`STREAM_RANKING_DETAILS=true` adds two-line bridge-calculated position, technical
score and six components to the existing `title` description. It defaults to
false. Closed audio/subtitle labels retain the rules above. This opt-in layout
extends the description length beyond the default 53-character label bound;
it does not copy arbitrary provider strings or add Identity confidence.
Numbers use at most two decimals; independently rounded components and total
can differ by at most 0.035 points. See [configuration and format](../README.md#stream-ranking).
