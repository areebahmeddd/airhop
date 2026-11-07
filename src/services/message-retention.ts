// When disappearing messages are removed from this phone.
//
// The thread, search and the lists already hide an expired message the moment
// it expires (utils/message-expiry), so this decides when the text, and the
// files behind it, actually leave storage, and with them everything the hiding
// does not reach: unread badges, the bell, owed read receipts. So a sweep runs
// at the next row's deadline while the process runs, since a foreground
// service can keep it alive for days without anyone opening it, and at least
// hourly besides, for what no deadline announces (a token claimed after its
// row's deadline). At launch it sweeps at once; on a return to the app, at
// once if a deadline passed meanwhile (a suspended app ran no timer), and
// otherwise no more than hourly.
//
// A sweep removes every copy this phone holds: the row (whose files go through
// file-transfer-service's reference-counted cleanup), its line in the bell,
// its outbox entry once a relay holds a copy, a read receipt still owed for
// it, and the conversation's card in the tray once nothing in it is left
// unread. A card
// with unread messages left stays, since it stands for those too; a ring is
// never ended by a sweep. What a notification already showed is past recalling.
//
// The window is read at each sweep. Shortening it in General sweeps at once
// (sweepMessagesNow), after a confirmation, since what goes cannot come back.

import { useActivityStore } from "@store/activity-store";
import { useChatStore } from "@store/chat-store";
import { awaitingReceiptIds, useOutboxStore } from "@store/outbox-store";
import { useSettingsStore } from "@store/settings-store";
import { selectKeysetRefs, useWalletStore } from "@store/wallet-store";
import {
  messageRetentionWindowMs,
  nextExpiryAtMs,
  type WalletClaims,
} from "@utils/message-expiry";
import { dismissMessageNotificationFor } from "./notification-service";

// The longest between sweeps, and between sweeps a return to the app runs.
const MESSAGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// A timer can fire a moment before the deadline it was set for, which sweeps
// nothing and finds the same deadline still ahead. Without a floor that would
// spin until the clock caught up.
const MIN_SWEEP_DELAY_MS = 1000;

let lastSweepAtMs: number | null = null;
// The earliest deadline the last sweep left ahead, or null for none. A message
// arriving after that sweep cannot expire within the hour that follows it,
// the shortest window being a day, so the hourly rule covers it.
let nextDeadlineMs: number | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

// Drops the read receipts owed for expired messages. The receipts belong to
// the mesh, which this module must not import: it loads the native BLE module
// at import, and Settings imports this. Whoever starts retention passes it.
type ExpiredHandler = (ids: ReadonlySet<string>) => void;
let onExpired: ExpiredHandler | null = null;

// Every token the wallet has taken in. Read whatever the wallet's state: one
// still locked or loading lists none, which keeps every token row, the safe way
// to be wrong.
function walletClaims(): WalletClaims {
  const wallet = useWalletStore.getState();
  return {
    claimed: new Set(wallet.claimedTokens),
    keysets: selectKeysetRefs(wallet),
  };
}

function currentWindowMs(): number {
  return messageRetentionWindowMs(
    useSettingsStore.getState().messageRetentionDays,
  );
}

// Remove what the window has retired.
function sweepExpiredMessages(nowMs: number): void {
  const windowMs = currentWindowMs();
  if (!(windowMs > 0)) return;
  const removed = useChatStore
    .getState()
    .removeExpired(
      nowMs,
      windowMs,
      walletClaims(),
      awaitingReceiptIds(useOutboxStore.getState().pending),
    );
  const ids = new Set(removed.map((m) => m.id));
  // Run even when no row went: the bell keeps entries for messages the
  // 200-message trim took long before they could expire.
  useActivityStore.getState().expire(ids, nowMs - windowMs);
  if (ids.size > 0) {
    useOutboxStore.getState().discard(ids);
    onExpired?.(ids);
  }
  // A card left in the tray would keep the removed text on the lock screen.
  const { unreadCounts } = useChatStore.getState();
  for (const channel of new Set(removed.map((m) => m.channel))) {
    if ((unreadCounts[channel] ?? 0) === 0) {
      void dismissMessageNotificationFor(channel);
    }
  }
}

// Set the timer for the next deadline, or the hourly sweep if that is sooner.
function scheduleNextSweep(nowMs: number): void {
  if (!running) return;
  if (timer !== null) clearTimeout(timer);
  const deadline = nextDeadlineMs ?? nowMs + MESSAGE_SWEEP_INTERVAL_MS;
  const delay = Math.min(
    Math.max(deadline - nowMs, MIN_SWEEP_DELAY_MS),
    MESSAGE_SWEEP_INTERVAL_MS,
  );
  timer = setTimeout(() => {
    timer = null;
    sweepMessagesNow();
  }, delay);
}

// Returns whether a sweep ran, for tests.
export function sweepMessagesIfDue(nowMs: number = Date.now()): boolean {
  // A clock moved backwards counts as due, not as years of waiting. The sweep
  // itself deletes nothing on a clock that went back (see isMessageExpired).
  if (
    lastSweepAtMs !== null &&
    nowMs >= lastSweepAtMs &&
    nowMs - lastSweepAtMs < MESSAGE_SWEEP_INTERVAL_MS &&
    (nextDeadlineMs === null || nowMs < nextDeadlineMs)
  ) {
    return false;
  }
  lastSweepAtMs = nowMs;
  try {
    sweepExpiredMessages(nowMs);
  } catch {
    // A store that failed to write. Retried on the next due sweep, and the
    // thread hides the messages meanwhile.
  }
  try {
    nextDeadlineMs = nextExpiryAtMs(
      useChatStore.getState().messages,
      nowMs,
      currentWindowMs(),
    );
  } catch {
    nextDeadlineMs = null;
  }
  scheduleNextSweep(nowMs);
  return true;
}

// Sweep now, whatever the throttle says: at launch, and for a window that
// just got shorter.
export function sweepMessagesNow(nowMs: number = Date.now()): void {
  lastSweepAtMs = null;
  sweepMessagesIfDue(nowMs);
}

// Sweep now, then at each deadline while the process runs. Started with the
// app and with the boot start; a second call only sweeps.
export function startMessageRetention(expired: ExpiredHandler): void {
  onExpired = expired;
  running = true;
  sweepMessagesNow();
}

/**
 * @public For tests, which must not leave the sweep timer running.
 */
export function stopMessageRetention(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  running = false;
  lastSweepAtMs = null;
  nextDeadlineMs = null;
  onExpired = null;
}
