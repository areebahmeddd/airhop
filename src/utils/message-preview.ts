// Last-message preview text for channel and DM list rows and notifications,
// so an attachment-only message (no caption) never renders as a blank line.
//
// Two shapes of one answer. A list row re-renders on a language change and takes
// the text; the bell persists what it logs and takes the key as well, the same
// contract as `systemKey` on ChatMessage.

import { mayContainToken, pureTokenAmount } from "@core/payments/cashu";
import {
  stripIsolates,
  type CatalogKey,
  type TranslationKey,
  type TranslationVars,
} from "@i18n";
import type { ChatAttachment, ChatMessage } from "@store/chat-store";
import { amountParts } from "./format";
import { translateStored } from "./message-text";

export interface MessagePreview {
  preview: string;
  // Absent when the preview is a person's own words (a caption, a filename),
  // which are never re-translated.
  previewKey?: CatalogKey;
  previewVars?: TranslationVars;
}

// The key for a captionless attachment, or undefined when it has its own words
// (a document's filename is the sender's text, never re-translated).
function attachmentPreviewKey(
  attachment: ChatAttachment,
): TranslationKey | undefined {
  switch (attachment.type) {
    case "voice":
      return "transfer.kind.voice_preview";
    case "image":
      return "transfer.kind.photo_preview";
    case "video":
      return "transfer.kind.video_preview";
    case "document":
      return attachment.name === undefined
        ? "transfer.kind.document_preview"
        : undefined;
  }
}

// A token-only message previews as its amount: the token is bearer money that
// anyone reading a lock screen or the bell could take, so it is never shown.
function ecashPreview(
  text: string,
): { key: TranslationKey; vars: TranslationVars } | null {
  if (!mayContainToken(text)) return null;
  const token = pureTokenAmount(text);
  return token === null
    ? null
    : {
        key: "notif.preview.ecash",
        vars: amountParts(token.amount, token.unit),
      };
}

// Whether the preview is Airhop's words, named by a key, or a person's, taken
// verbatim. Both exports are views of this.
function resolve(message: ChatMessage): {
  key?: CatalogKey;
  vars?: TranslationVars;
  literal: string;
} {
  // A row Airhop wrote already carries its key.
  if (message.systemKey !== undefined) {
    return { key: message.systemKey, vars: message.systemVars, literal: "" };
  }
  const ecash = ecashPreview(message.text);
  if (ecash !== null) return { ...ecash, literal: "" };
  if (message.text) return { literal: message.text };
  if (message.attachment) {
    const key = attachmentPreviewKey(message.attachment);
    return key === undefined
      ? { literal: message.attachment.name ?? "" }
      : { key, literal: "" };
  }
  return { literal: "" };
}

// For a row on screen, isolates included: they keep a right-to-left name from
// reordering the line it sits in.
export function messagePreviewText(message: ChatMessage): string {
  const { key, vars, literal } = resolve(message);
  return key === undefined ? literal : translateStored(key, vars);
}

// For the bell, which persists what it is given. Same contract as `systemRow`,
// down to the plain fallback: display machinery does not belong in storage.
export function messagePreviewEntry(message: ChatMessage): MessagePreview {
  const { key, vars } = resolve(message);
  return {
    preview: stripIsolates(messagePreviewText(message)),
    previewKey: key,
    previewVars: vars,
  };
}
