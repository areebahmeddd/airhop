// Whether a message is an IRC-style action (/hug, /slap) this app or bitchat
// could have produced, and the line to show if so.
//
// An action renders centered and italic with no sender name, one shade off a
// system row. Matching on "starts and ends with *" let any peer put any words
// in that styling. So only the exact templates the composer emits qualify, the
// actor must be the wire sender, and the target must be a single name.
// Anything else is a normal bubble under the sender's real name.

const TEMPLATES = [
  { emoji: "🫂", verb: "hugs", suffix: "" },
  { emoji: "🐟", verb: "slaps", suffix: " around a bit with a large trout" },
] as const;
const NAME_MAX_CHARS = 32;

function isNameToken(s: string): boolean {
  return (
    s === "you" ||
    (s.length > 0 && Array.from(s).length <= NAME_MAX_CHARS && !/\s/.test(s))
  );
}

export function emoteLine(text: string, senderNickname: string): string | null {
  if (!text.startsWith("* ") || !text.endsWith(" *")) return null;
  const inner = text.slice(2, -2);
  // A geohash sender is stored as `nick#abcd`; the action embeds the bare nick.
  const actor = senderNickname.replace(/#[0-9a-f]{4}$/, "");
  for (const { emoji, verb, suffix } of TEMPLATES) {
    const head = `${emoji} ${actor} ${verb} `;
    if (!inner.startsWith(head) || !inner.endsWith(suffix)) continue;
    const target = inner.slice(head.length, inner.length - suffix.length);
    if (isNameToken(target)) return inner;
  }
  return null;
}
