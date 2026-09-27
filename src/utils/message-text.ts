// The words a message row shows, resolved at the moment it is displayed.
//
// Almost every message in the store is user content: somebody typed it, and it
// is shown exactly as typed. A handful are not. Airhop writes rows of its own
// into the same store, and those are the app's words, so they belong in the
// language the reader has chosen now rather than the one active when the row
// was saved. A store row outlives the moment it was written, so `t()` at write
// time bakes a language into MMKV permanently.
//
// Rule for callers: anything putting a message on a screen, into a notification
// or into a search haystack goes through here. Reading `.text` directly is
// correct only where the bytes themselves are the point, which is the wire:
// `sendDm`, `sendChannelMessage`, the retry and forward paths.

import {
  isPluralKey,
  stripIsolates,
  t,
  tPlural,
  type CatalogKey,
  type TranslationVars,
} from "@i18n";
import type { ActivityEntry } from "@store/activity-store";
import type { ChatMessage } from "@store/chat-store";
import type { WalletTx } from "@store/wallet-store";

// A row's key names either map. A counted row keeps its number as `count`,
// which is where `tPlural` takes it from.
export function translateStored(
  key: CatalogKey,
  vars?: TranslationVars,
): string {
  if (!isPluralKey(key)) return t(key, vars);
  // Passed apart from the rest, or the raw number would override the grouped
  // one `tPlural` renders.
  const { count, ...rest } = vars ?? {};
  return tPlural(key, Number(count ?? 0), rest);
}

export function messageText(message: ChatMessage): string {
  // No key means user content, or a row written before the field existed.
  // Either way `text` is the answer.
  if (message.systemKey === undefined) return message.text;
  return translateStored(message.systemKey, message.systemVars);
}

// The same rule for the bell. An entry sits in the notification center until a
// hundred newer ones push it out, so it has the same freezing problem and takes
// the same treatment.
export function activityPreview(entry: ActivityEntry): string {
  if (entry.previewKey === undefined) return entry.preview;
  return translateStored(entry.previewKey, entry.previewVars);
}

// ---- Writing one of these rows ----
//
// The three fields move together, so they are built together. Spread into the
// row: `...systemRow("chat.geo.card_received", { name })`.
//
// The stored rendering is stripped of the directional isolates `t()` adds.
// Those are display machinery, and `text` is the field the wire reads:
// `forwardMessage` puts it on the air and the action sheet copies it.

export function systemRow(
  key: CatalogKey,
  vars?: TranslationVars,
): Pick<ChatMessage, "text" | "systemKey" | "systemVars"> {
  return {
    text: stripIsolates(translateStored(key, vars)),
    systemKey: key,
    systemVars: vars,
  };
}

// The bell's equivalent, same contract.
export function systemPreview(
  key: CatalogKey,
  vars?: TranslationVars,
): Pick<ActivityEntry, "preview" | "previewKey" | "previewVars"> {
  return {
    preview: stripIsolates(translateStored(key, vars)),
    previewKey: key,
    previewVars: vars,
  };
}

// ---- A wallet transaction's failure ----
//
// The same contract for the reason a wallet row gives. Written beside `error`
// so a row always carries a plain fallback, and so writing one Airhop reason
// over another, or over a mint's text, leaves no stale key behind.

export type TxFailure = Pick<WalletTx, "error" | "errorKey" | "errorVars">;

export function txFailure(key: CatalogKey, vars?: TranslationVars): TxFailure {
  return {
    error: stripIsolates(translateStored(key, vars)),
    errorKey: key,
    errorVars: vars,
  };
}

// A mint's own words, which are never translated.
export function txFailureVerbatim(text: string): TxFailure {
  return { error: text, errorKey: undefined, errorVars: undefined };
}

// Null when the row has no reason. `error` decides that, since the clears that
// settle a row write only `error: undefined`.
export function txErrorText(tx: TxFailure): string | null {
  if (tx.error === undefined || tx.error.length === 0) return null;
  return tx.errorKey === undefined
    ? tx.error
    : translateStored(tx.errorKey, tx.errorVars);
}
