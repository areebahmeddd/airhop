// Which messages the disappearing-messages setting has retired.
//
// One check, used where a message is shown (the thread, search, the lists) and
// where it is deleted (services/message-retention), so the sweep's timing never
// decides what a reader sees: an expired message is hidden the moment it
// expires and removed at the next sweep.
//
// Timed from when the message reached this phone (ChatMessage.receivedAtMs),
// which is what the setting promises: "keep history on this phone for N days".
// Local only; nothing on the wire changes, and the other phone keeps its copy.
//
// Rows still in flight are kept past the window (see isMessageExpired), and so
// is a Cashu token received in a DM. It is claimed only by hand, from its bubble, so deleting the row deletes the
// recipient's only copy of the money. Such a row stays until the wallet has
// recorded the token as taken in, which only the sweep knows (WalletClaims);
// everywhere else it stays, so nothing is ever hidden that the sweep would keep.
// A token posted to a room was never one person's: everyone there read it, and
// whoever claimed it first holds it, so its row expires like any other.

import {
  findChatTokens,
  mayContainToken,
  type KeysetRef,
} from "@core/payments/cashu";
import type { ChatMessage } from "@store/chat-store";

const DAY_MS = 24 * 60 * 60 * 1000;

type ExpiryFields = Pick<
  ChatMessage,
  | "id"
  | "channel"
  | "receivedAtMs"
  | "timestampMs"
  | "status"
  | "liveVideo"
  | "isMine"
  | "text"
>;

// What the wallet has taken in: the first proof secret of each token it
// claimed (wallet-store's claimedTokens, the same match the chat card reads
// "Claimed" from), and the keysets that expand a V4 token's short ids so its
// secrets can be read at all.
export interface WalletClaims {
  claimed: ReadonlySet<string>;
  keysets: readonly KeysetRef[];
}

// The window for a setting in days; 0 is Off.
export function messageRetentionWindowMs(days: number): number {
  return days * DAY_MS;
}

// `addMessage` stamps every row it stores; a row built outside it has only the
// sender's clock.
function arrivedAtMs(message: ExpiryFields): number {
  return message.receivedAtMs ?? message.timestampMs;
}

// Whether a received DM carries a token the wallet has not taken in. Without
// claims, any token it carries counts. A token whose keyset this wallet cannot
// expand has no readable secret, so it counts too: it may still be claimed once
// the mint's keysets are fetched.
function holdsUnclaimedToken(
  message: ExpiryFields,
  claims: WalletClaims | undefined,
): boolean {
  if (message.isMine || !message.channel.startsWith("dm:")) return false;
  if (!mayContainToken(message.text)) return false;
  return findChatTokens(message.text, claims?.keysets).some((token) => {
    if (claims === undefined || !("info" in token)) return true;
    const first = token.info.token.proofs[0]?.secret;
    return first === undefined || !claims.claimed.has(first);
  });
}

// `awaitingReceipt` is the outbox's own DMs that no relay holds a copy of
// (outbox-store's awaitingReceiptIds). Such a row reads "sent" once it leaves
// the phone, yet the outbox retry is still its only way to arrive, and it ends
// as "delivered" or "failed" within the outbox's week.
function isInFlight(
  message: ExpiryFields,
  awaitingReceipt: ReadonlySet<string> | undefined,
): boolean {
  return (
    message.status === "sending" ||
    message.status === "queued" ||
    message.status === "carried" ||
    (message.isMine && awaitingReceipt?.has(message.id) === true)
  );
}

export function isMessageExpired(
  message: ExpiryFields,
  nowMs: number,
  windowMs: number,
  claims?: WalletClaims,
  awaitingReceipt?: ReadonlySet<string>,
): boolean {
  // Off, or a window nothing could have stored: never a reason to delete.
  if (!(windowMs > 0)) return false;
  // Still in flight: the transport, the outbox or a courier still holds it and
  // reports back to the row, and deleting it would discard the outbox entry
  // with it, so a DM to a peer away longer than the window would vanish
  // without ever reading "failed". A row that reached a final state expires
  // normally. A live stream is still being drawn into its row.
  if (isInFlight(message, awaitingReceipt) || message.liveVideo !== undefined) {
    return false;
  }
  // An arrival in the future is a clock that moved back, not a fresh message.
  // Kept: deleting on a bad clock is the worse failure, as for media.
  if (!(nowMs - arrivedAtMs(message) > windowMs)) return false;
  // Last, since it decodes: only rows otherwise past the window pay for it.
  return !holdsUnclaimedToken(message, claims);
}

// The earliest moment after `nowMs` at which a stored row passes the window,
// or null when none is waiting to. A row already past it and still kept (still
// in flight, an unclaimed token) has no deadline left to wait for.
export function nextExpiryAtMs(
  messages: Record<string, ChatMessage[]>,
  nowMs: number,
  windowMs: number,
): number | null {
  if (!(windowMs > 0)) return null;
  let next: number | null = null;
  for (const list of Object.values(messages)) {
    for (const m of list) {
      // isMessageExpired takes strictly more than the window.
      const at = arrivedAtMs(m) + windowMs + 1;
      if (at > nowMs && (next === null || at < next)) next = at;
    }
  }
  return next;
}

// A thread without its expired messages; the same array when nothing expired,
// so a memo downstream does not recompute for nothing.
export function withoutExpired(
  list: ChatMessage[],
  nowMs: number,
  windowMs: number,
  awaitingReceipt?: ReadonlySet<string>,
): ChatMessage[] {
  if (!(windowMs > 0)) return list;
  const kept = list.filter(
    (m) => !isMessageExpired(m, nowMs, windowMs, undefined, awaitingReceipt),
  );
  return kept.length === list.length ? list : kept;
}

// Every thread without its expired messages, for search and the lists.
export function withoutExpiredInAll(
  messages: Record<string, ChatMessage[]>,
  nowMs: number,
  windowMs: number,
  awaitingReceipt?: ReadonlySet<string>,
): Record<string, ChatMessage[]> {
  if (!(windowMs > 0)) return messages;
  let out: Record<string, ChatMessage[]> | null = null;
  for (const [channel, list] of Object.entries(messages)) {
    const kept = withoutExpired(list, nowMs, windowMs, awaitingReceipt);
    if (kept === list) continue;
    out ??= { ...messages };
    out[channel] = kept;
  }
  return out ?? messages;
}
