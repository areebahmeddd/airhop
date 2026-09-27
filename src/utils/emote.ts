// Action lines (/hug, /slap and the screenshot notice) this app or bitchat
// could have produced, recognised on receipt.
//
// An action renders centered and italic with no sender name, one shade off a
// system row. Matching on "starts and ends with *" would let any peer put any
// words in that styling. So only the exact templates the composer emits
// qualify, the actor must be the wire sender, and the target must be a single
// name. Anything else is a normal bubble under the sender's real name.
//
// The text on the wire is bitchat's fixed English, which it matches by
// substring, so none of it is ever translated. Both sides are NFC-normalised
// before comparing: a nickname stored normalised never equals the decomposed
// spelling another keyboard put in the message.

import type { ChatMessage } from "@store/chat-store";
import { systemRow } from "./message-text";

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

// A geohash sender is stored as `nick#abcd`; an action embeds the bare nick.
function actorName(senderNickname: string): string {
  return senderNickname.replace(/#[0-9a-f]{4}$/, "").normalize("NFC");
}

export function emoteLine(text: string, senderNickname: string): string | null {
  const normalized = text.normalize("NFC");
  if (!normalized.startsWith("* ") || !normalized.endsWith(" *")) return null;
  const inner = normalized.slice(2, -2);
  const actor = actorName(senderNickname);
  for (const { emoji, verb, suffix } of TEMPLATES) {
    const head = `${emoji} ${actor} ${verb} `;
    if (!inner.startsWith(head) || !inner.endsWith(suffix)) continue;
    const target = inner.slice(head.length, inner.length - suffix.length);
    if (isNameToken(target)) return inner;
  }
  return null;
}

// What this node sends when its user takes a screenshot, byte for byte what
// bitchat-ios sends. The local row saying so is keyed separately.
export function screenshotNotice(nickname: string): string {
  return `* ${nickname} took a screenshot *`;
}

// A peer's message as it is stored. A screenshot notice from the sender becomes
// Airhop's own line, keyed, so each reader sees it in their language rather
// than in bitchat's English. Everything else, a sentence that only mentions a
// screenshot included, is the sender's words, verbatim.
//
// `senderNickname` is the name the sender goes by on the wire, which the notice
// must name. `shownName` is the one this phone shows for them, which the row
// names.
export function inboundText(
  text: string,
  senderNickname: string,
  shownName: string = senderNickname,
): Pick<ChatMessage, "text" | "systemKey" | "systemVars" | "isSystem"> {
  const actor = actorName(senderNickname);
  if (actor.length === 0 || text.normalize("NFC") !== screenshotNotice(actor)) {
    return { text };
  }
  return {
    ...systemRow("chat.screenshot.peer_took", { name: shownName }),
    isSystem: true,
  };
}
