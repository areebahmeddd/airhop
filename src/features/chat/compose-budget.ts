// UTF-8 byte budgets for text the thread sends, and the checks that apply them.
//
// Both limits are wire fields measured in bytes, which `TextInput`'s `maxLength`
// cannot count. See `@utils/utf8-budget` for why the two disagree.

import { MAX_CAPTION_BYTES } from "@core/mesh/wire/file-packet";
import { PRIVATE_MESSAGE_MAX_CONTENT_BYTES } from "@core/mesh/wire/noise-payload";
import { truncateToUtf8Bytes, utf8ByteLength } from "@utils/utf8-budget";

// Applied on every keystroke, the way the DM composer clamps its draft. The
// encoder drops a longer caption without a word rather than cutting it, so the
// photo would arrive bare.
export function clampCaption(text: string): string {
  return truncateToUtf8Bytes(text, MAX_CAPTION_BYTES);
}

// Whether a text message can be forwarded into `targetChannel` whole.
//
// Only a DM has a budget: channel and group text rides the rest of the payload
// with no length field. A forward that does not fit is refused rather than cut,
// because the words are somebody else's and a silent trim changes what they
// said under their name.
export function forwardTextFits(targetChannel: string, text: string): boolean {
  if (!targetChannel.startsWith("dm:")) return true;
  return utf8ByteLength(text) <= PRIVATE_MESSAGE_MAX_CONTENT_BYTES;
}
