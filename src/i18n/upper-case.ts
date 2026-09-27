// Upper case in the reading language, for section headings and badges.
//
// Not `textTransform: "uppercase"`: iOS applies it without a locale and
// Android with the device's, never the app's, so Turkish "Dil" comes out "DIL"
// instead of "DİL". Not `toLocaleUpperCase` either: Hermes does not document
// honouring its locale argument on both platforms. Turkish is the one shipped
// language whose rule differs from the default mapping: dotted i keeps its dot.
//
// Georgian is left as written. Its capitals (Mtavruli) are not a heading style,
// and older Android fonts lack the glyphs. Scripts without case pass through
// `toUpperCase` untouched anyway.

import { LANGUAGES, type LanguageCode } from "./languages";

export function upperCase(text: string, language: LanguageCode): string {
  if (LANGUAGES[language].script === "georgian") return text;
  const dotted = language === "tr" ? text.replace(/i/g, "İ") : text;
  return dotted.toUpperCase();
}
