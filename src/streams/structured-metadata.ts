// Closed provider labels shared by scoring and presentation. No inference from locators or titles.
// Values are presentation literals, never provider substrings. Language claims
// describe upstream labels; they do not verify the media's tracks.
const languages: Readonly<Record<string, string>> = {
  en: "English", eng: "English", english: "English",
  es: "Spanish", spa: "Spanish", spanish: "Spanish",
  fr: "French", fra: "French", french: "French",
  de: "German", deu: "German", german: "German",
  it: "Italian", ita: "Italian", italian: "Italian",
  pt: "Portuguese", por: "Portuguese", portuguese: "Portuguese",
  ja: "Japanese", jpn: "Japanese", japanese: "Japanese",
  ko: "Korean", kor: "Korean", korean: "Korean",
  zh: "Chinese", zho: "Chinese", chinese: "Chinese",
  ru: "Russian", rus: "Russian", russian: "Russian",
  hi: "Hindi", hin: "Hindi", hindi: "Hindi",
  hu: "Hungarian", hun: "Hungarian", hungarian: "Hungarian"
};

export function descriptionText(value: string | undefined): string | undefined {
  // Fail closed on oversized fields, markup and controls, including newlines.
  if (!value || value.length > 500 || /[\p{Cc}\p{Cf}<>]/u.test(value)
    || /[^\x20-\x7e·]/u.test(value)) return undefined;
  return value.trim().toLowerCase();
}

export function descriptionLanguage(value: string | undefined): string | undefined {
  return value && Object.hasOwn(languages, value) ? languages[value] : undefined;
}

export function explicitLanguage(value: string, kind: "audio" | "subtitles"): string | undefined {
  const label = kind === "subtitles" ? "(?:subtitles|subs)" : kind;
  const match = new RegExp(`^(?:${label}: ([a-z]+)|([a-z]+) ${label})$`).exec(value);
  return descriptionLanguage(match?.[1] ?? match?.[2]);
}

export function descriptionAudioMode(value: string, allowBare = false): string | undefined {
  const match = /^(dual|multi)(?: +audio)?$/.exec(value);
  if (!match || (!allowBare && value === match[1])) return undefined;
  return match[1] === "dual" ? "Dual audio" : "Multi audio";
}

/** A whole pair of distinct known codes; presentation uses it only for audio. */
export function structuredAudioLanguage(value: string | undefined): string | undefined {
  const single = descriptionLanguage(value);
  if (single || !value) return single;
  const match = /^([a-z]{2,3}) *[/+,] *([a-z]{2,3})$/.exec(value);
  const first = descriptionLanguage(match?.[1]);
  const second = descriptionLanguage(match?.[2]);
  return first && second && first !== second ? `${first}/${second}` : undefined;
}

/** Structured language: one known alias or two distinct known 2/3-letter codes
 * separated by /, + or comma. Structured audio additionally accepts the existing
 * `audio: alias`, `alias audio`, dual[ audio] and multi[ audio] whole labels.
 * Case and surrounding ASCII spaces are ignored; controls/markup fail closed.
 * These are provider declarations, never verification of media tracks.
 */
export function recognizedStreamLanguage(value: string | undefined): boolean {
  return Boolean(structuredAudioLanguage(descriptionText(value)));
}

export function recognizedStreamAudio(value: string | undefined): boolean {
  const text = descriptionText(value);
  return Boolean(text && (structuredAudioLanguage(text)
    || explicitLanguage(text, "audio") || descriptionAudioMode(text, true)));
}
