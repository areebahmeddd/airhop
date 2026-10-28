// Length budgets for text the thread sends, and the checks that apply them.
//
// A DM and a caption are wire fields measured in UTF-8 bytes, which
// `TextInput`'s `maxLength` cannot count; see `@utils/utf8-budget`. A public
// room's limit is the spam filter's: bitchat hides any public message over its
// per-minute character budget, so a longer one is never seen.

import { MAX_CAPTION_BYTES } from "@core/mesh/wire/file-packet";
import { PRIVATE_MESSAGE_MAX_CONTENT_BYTES } from "@core/mesh/wire/noise-payload";
import { CHARACTER_BUCKET } from "@core/spam/spam-filter-config";
import { truncateToUtf8Bytes, utf8ByteLength } from "@utils/utf8-budget";

// Applied on every keystroke, the way the DM composer clamps its draft. The
// encoder drops a longer caption without a word rather than cutting it, so the
// photo would arrive bare.
export function clampCaption(text: string): string {
  return truncateToUtf8Bytes(text, MAX_CAPTION_BYTES);
}

// Characters, counted as code points the way bitchat counts them.
export const PUBLIC_MESSAGE_MAX_CHARS = CHARACTER_BUCKET.capacity;

export function clampPublicText(text: string): string {
  const chars = Array.from(text);
  return chars.length <= PUBLIC_MESSAGE_MAX_CHARS
    ? text
    : chars.slice(0, PUBLIC_MESSAGE_MAX_CHARS).join("");
}

export function publicCharsLeft(text: string): number {
  return PUBLIC_MESSAGE_MAX_CHARS - Array.from(text).length;
}

// A group or a private channel is sealed to its members, so only a public room
// is held to the spam filter's limit.
export function isPublicRoom(channel: string, sealed: boolean): boolean {
  return !sealed && !channel.startsWith("dm:") && !channel.startsWith("group:");
}

// Whether a text message can be forwarded into `targetChannel` whole. A
// forward that does not fit is refused rather than cut, because the words are
// somebody else's and a silent trim changes what they said under their name.
export function forwardTextFits(
  targetChannel: string,
  text: string,
  sealed: boolean,
): boolean {
  if (targetChannel.startsWith("dm:")) {
    return utf8ByteLength(text) <= PRIVATE_MESSAGE_MAX_CONTENT_BYTES;
  }
  return !isPublicRoom(targetChannel, sealed) || publicCharsLeft(text) >= 0;
}
