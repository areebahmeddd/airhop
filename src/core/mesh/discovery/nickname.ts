// Unicode normalization for nicknames, and fitting one into a byte budget.
//
// A nickname arrives over the wire as UTF-8 in ANNOUNCE TLV 0x01, and the same
// visible name has more than one valid encoding: "José" is either U+00E9 or
// U+0065 followed by the combining acute U+0301. The two render identically and
// compare unequal, so without a single canonical form the mesh sees two people.
//
// The failure this prevents is silent. Mentions match on the nickname string,
// so a mention typed on one platform against a name announced by another simply
// does not fire: no error, no notification, no way for either side to tell why.
// The same mismatch splits autocomplete into duplicate entries and lets one peer
// occupy two rows of a participant list.
//
// NFC (composed) is the form chosen here because it is what the web platform,
// Swift's `precomposedStringWithCanonicalMapping` and bitchat all settle on, so
// normalizing here agrees with what the other implementations store.
//
// This is a local canonicalization, not a wire change. The packet still carries
// whatever bytes the sender chose, peer IDs derive from keys rather than names,
// and no signature covers the normalized form. A peer that normalizes
// differently, or not at all, stays fully interoperable.

import { stripInvisibles } from "@utils/strip-invisibles";

// The canonical form of a nickname, for storage and for comparison.
//
// Also drops invisible and bidi control characters, which could reorder the
// text around a name or make two identical-looking names compare unequal, and
// trims surrounding whitespace: a trailing space is invisible in a name and
// would defeat the comparison this exists to make reliable.
export function normalizeNickname(nickname: string): string {
  return stripInvisibles(nickname.normalize("NFC"), {
    singleLine: true,
  }).trim();
}

// The key to compare or de-duplicate a nickname by. Use this rather than
// calling toLowerCase() on a raw string: the whole point is that a raw string
// may be in either encoding.
export function nicknameKey(nickname: string): string {
  return normalizeNickname(nickname).toLowerCase();
}

// Code points that cannot end a name, so the cut lands before them: a mark
// without its base renders on a dotted circle, a joiner splits an emoji. 32
// bytes is about ten Devanagari characters, so the budget is reached most often
// in exactly the scripts that write with marks.
//
// Mirrors DANGLING in `@utils/utf8-budget` (truncateToUtf8Bytes), which cuts a
// string where this cuts bytes. Keep the two in step.
const DANGLING_NICKNAME = /[\p{M}\u200D\uFE0E\uFE0F]/u;

// Fit a nickname into a byte budget, canonicalized first.
//
// Truncation counts UTF-8 bytes and drops whole code points. Slicing the string
// instead would count UTF-16 units, which is the wrong unit twice over: a name
// of 32 emoji is 128 bytes, four times the budget, and a slice can land in the
// middle of a surrogate pair and emit a lone half that decodes to a replacement
// character on the far side.
export function fitNickname(nickname: string, maxBytes: number): Uint8Array {
  const encoder = new TextEncoder();
  const codePoints = [...normalizeNickname(nickname)];
  let bytes = encoder.encode(codePoints.join(""));
  while (bytes.length > maxBytes) {
    codePoints.pop();
    bytes = encoder.encode(codePoints.join(""));
  }
  // Only once it fits, and only if something was dropped: a name already inside
  // the budget is the user's own.
  if (bytes.length < encoder.encode(normalizeNickname(nickname)).length) {
    while (
      codePoints.length > 0 &&
      DANGLING_NICKNAME.test(codePoints[codePoints.length - 1])
    ) {
      codePoints.pop();
    }
    bytes = encoder.encode(codePoints.join(""));
  }
  return bytes;
}
