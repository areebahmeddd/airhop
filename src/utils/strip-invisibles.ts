// Remove the characters that change how text reads without being seen.
//
// A peer chooses its nickname and the names of the files it sends, and every
// placeholder in a translated sentence holds text Airhop did not write. Inside
// any of them, a bidi override can reverse what follows ("invoice" + RLO +
// "fdp.exe" reads as "invoiceexe.pdf"), an isolate can close the one `t()`
// wraps a value in, and a zero-width character can make two names that look
// identical compare unequal.
//
// Removed: C0 and C1 controls, bidi embeddings and overrides (U+202A-202E) and
// isolates (U+2066-2069), zero-width space (U+200B), the word joiner and
// invisible operators (U+2060-2064), the BOM (U+FEFF), and tag characters
// (U+E0000-E007F).
//
// Kept: ZWNJ (U+200C), which Persian spelling needs, and ZWJ (U+200D), which
// joins emoji sequences; LRM and RLM (U+200E, U+200F), marks that only settle
// the direction of neutral characters beside them; and tab and line breaks,
// which are visible, unless the text is a name.
//
// Pure and dependency-free, so core, i18n and services can all use it.

const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

const LINE_BREAKS = /[\t\n\r\u2028\u2029]+/g;

export function stripInvisibles(
  text: string,
  // A name is one line: a break in one could fake a second line under it.
  options: { singleLine?: boolean } = {},
): string {
  const stripped = text.replace(INVISIBLE, "");
  return options.singleLine === true
    ? stripped.replace(LINE_BREAKS, " ")
    : stripped;
}
