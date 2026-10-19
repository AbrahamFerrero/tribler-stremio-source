# Safe stream descriptions

Resolved streams retain their compact `name` and opaque localhost playback URL.
An optional `title` provides up to three closed upstream labels, ordered as
generic language, audio language, audio mode, subtitle language. These labels
describe provider claims, not independently verified media tracks. Empty descriptions omit the
property entirely. The installed Stremio addon SDK defines `title` as an optional
stream description; client rendering still requires a Stremio UI check.

Supported languages are English, Spanish, French, German, Italian, Portuguese,
Japanese, Korean, Chinese, Russian, Hindi and Hungarian. Structured `language`
and `audio` accept a single English language name or its ISO 639-1/639-3 code
(en/eng, es/spa, fr/fra, de/deu, it/ita, pt/por, ja/jpn, ko/kor, zh/zho,
ru/rus, hi/hin, hu/hun), ignoring ASCII case and surrounding spaces. Generic
`language` retains its code/name form in lowercase: `language: "en"` becomes
`Language: en`, never `English audio`. It does not identify an audio or subtitle
track and does not override explicit declarations. Bare `audio: "Japanese"`
declares Japanese audio; this remains a provider declaration, not a verified
track property. No media track analysis is performed.

Only the dedicated `audio` field additionally accepts bare `Dual` and `Multi`
as `Dual audio` and `Multi audio`. ASCII case and surrounding spaces are ignored;
one or more ASCII spaces may separate the mode from `audio`. Bare modes are not
accepted in generic `language` or presentation titles. Full `Dual audio` and
`Multi audio` descriptors remain supported in closed presentation titles.

Also only in `audio`, a whole pair of distinct recognized two- or three-letter
codes can use exactly one `/`, `+` or `,` separator, with optional ASCII spaces
around it. The pair is rendered in provider order as one canonical component:

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
rejected whole. `language: "ES/EN"`, title `ES/EN` and title `Audio: ENG+JPN`
remain unsupported. No language is extracted from locators or release names.
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
case conversion. Output uses canonical literals and, for `Language: …`, only an
exact key from the closed language vocabulary. No arbitrary provider substring
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
Resolver normalization preserves these fields, and PlaybackManager retains the
original private source behind its token. Only the resolved mapping in
`createAddon` constructs the public description. Legacy catalog/download
fallback presentation is a separate boundary and is not covered by this policy.
