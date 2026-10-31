// How a query is normalized, and how good a match is once found. Split out of
// chat-search so settings search ranks identically.

import { stripIsolates } from "@i18n";

// NFC first: the same word typed on two keyboards can arrive composed or
// decomposed, and those are different strings to indexOf. Isolates are the bidi
// marks the app wraps user content in; they are never typed.
export function searchKey(text: string): string {
  return stripIsolates(text.normalize("NFC")).toLowerCase();
}

// Below this, a mid-word match is likely a coincidence: "tor" sits inside
// "storage", "id" inside "guide". Prefix and word-boundary matches count at
// any length regardless.
const MIN_MIDWORD_QUERY_LENGTH = 4;

// Anything but a letter, a combining mark, a digit or an underscore ends a word:
// Japanese writes "。", Arabic "،", Hindi "।", none of which is whitespace. A
// mark is inside its word: Devanagari, Bengali, Gurmukhi and Tamil write vowel
// signs, the anusvara and the virama as marks, so "डा" after "भं" is mid-word.
const WORD_BOUNDARY = /[^\p{L}\p{M}\p{N}_]/u;

// Scripts written without spaces between words, where every match is mid-word
// and two characters are a whole word: "预览" (preview) inside "隐藏通知预览".
// Korean is not one of them; it spaces its words.
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

// The character before `index`, whole: a letter outside the Basic Multilingual
// Plane is two UTF-16 units, and its trailing half alone is no letter.
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff;
  return isLowSurrogate && index >= 2
    ? text.slice(index - 2, index)
    : text[index - 1];
}

// matchIndex === 0: prefix match. Match starts right after a word boundary:
// word match. Anything else: mid-word substring match, only past the floor
// above, unless the match is in a script with no spaces to find a word by.
export function scoreMatch(
  text: string,
  matchIndex: number,
  queryLength: number,
): number {
  if (matchIndex === 0) return 3;
  const precedingChar = charBefore(text, matchIndex);
  if (precedingChar !== undefined && WORD_BOUNDARY.test(precedingChar)) {
    return 2;
  }
  if (queryLength >= MIN_MIDWORD_QUERY_LENGTH) return 1;
  const match = text.slice(matchIndex, matchIndex + queryLength);
  return UNSPACED_SCRIPT.test(match) ? 1 : 0;
}
