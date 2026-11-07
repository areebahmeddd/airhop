// @-mentions: detecting them in message text, and driving the composer's inline
// suggestion picker.
//
// Mentions are by nickname (the display name), the only stable human-readable
// identifier the mesh exposes. Matching is case-insensitive and token-bounded,
// so "@ana" does not match a message addressed to "@anabelle".
//
// Both sides are normalized before comparison. Announced nicknames are already
// canonical (announce-manager normalizes at decode), but message text is not:
// it is whatever the sender's keyboard produced, and an iOS keyboard and an
// Android one can emit the same accented name in different encodings. Comparing
// raw strings means a cross-platform mention silently never fires.

import { normalizeNickname } from "@core/mesh/discovery/nickname";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The mention being typed at the caret: an "@" that starts a word and runs up
// to it. Returns the partial nickname (without the "@"), or null when the caret
// is not in one, or sits inside a name that carries on past it.
export function activeMentionQuery(
  draft: string,
  caret: number = draft.length,
): string | null {
  if (continuesName(draft.slice(caret))) return null;
  const m = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
  return m ? m[1] : null;
}

// Replace the mention ending at the caret with "@<nickname>", keeping the text
// after it, and say where the caret goes. A space follows only at the end of
// the draft; mid-draft, whatever came next (a space, a comma) stays as it was.
export function applyMention(
  draft: string,
  nickname: string,
  caret: number = draft.length,
): { text: string; caret: number } {
  const head = draft
    .slice(0, caret)
    .replace(/(^|\s)@[^\s@]*$/, (_full, lead: string) => `${lead}@${nickname}`);
  const tail = draft.slice(caret);
  const done = tail.length === 0 ? `${head} ` : head;
  return { text: done + tail, caret: done.length };
}

// Whether the text after the caret is the rest of a name, so the caret sits
// inside one. Hyphens and underscores join words in generated nicknames.
function continuesName(after: string): boolean {
  return /^[\p{L}\p{M}\p{N}_-]/u.test(after);
}

// Whether `text` mentions `nickname` as a whole @token, case-insensitively.
// A mention is the one message that gets past a muted conversation.
//
// It must start a word, so "ali@example.com" is no mention, and it ends at any
// script's punctuation ("。", "،", "।"), so "@ana" never matches "@anabelle".
//
// In a location channel bitchat writes "@name#abcd", the end of that person's
// cell key, since names there repeat. With `ownSuffix`, a different suffix is
// a namesake; with none on either side, the name decides.
export function mentionsNickname(
  text: string,
  nickname: string,
  ownSuffix: string | null = null,
): boolean {
  const target = normalizeNickname(nickname);
  if (target.length === 0) return false;
  const re = new RegExp(
    `(?:^|\\s)@${escapeRegExp(target)}(?:#([0-9a-f]{4}))?(?=$|[^\\p{L}\\p{N}_])`,
    "giu",
  );
  for (const match of text.normalize("NFC").matchAll(re)) {
    const suffix = match[1]?.toLowerCase();
    if (suffix === undefined || ownSuffix === null) return true;
    if (suffix === ownSuffix.toLowerCase()) return true;
  }
  return false;
}
