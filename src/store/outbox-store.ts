// Pending outbound DMs awaiting a route to their recipient: the queue behind
// the "queued for delivery" the UI shows. MeshService enqueues every mesh send
// and flushes when the peer becomes reachable again (its ANNOUNCE, a session
// coming up), and a delivery receipt resolves the entry. Persisted, since the
// promise has to survive a restart.
//
// Not the store-and-forward courier (sealed envelopes carried by third
// parties); this covers the recipient coming back to us, without trusting
// intermediates.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getStorage } from "./mmkv";

export interface PendingMessage {
  // Mirrors the ChatMessage id so the UI can reconcile delivery state.
  id: string;
  recipientPeerID: string;
  channel: string;
  text: string;
  createdAtMs: number;
  attempts: number;
  // When the last charged attempt went out. Absent until the first one.
  lastAttemptMs?: number;
}

// Give up after this long. A week-old "hi" is noise, not a message.
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Per recipient, so one unreachable conversation cannot evict another's mail.
// Eviction is invisible to the sender.
export const MAX_PENDING_PER_PEER = 100;

// Real send opportunities before a message is called failed. An attempt is
// charged only when something went out over a route that could have
// acknowledged it: never by the courier branch, which sends nothing, and never
// by a timer.
export const MAX_SEND_ATTEMPTS = 8;

// The least time between two charged attempts on one message. Opportunities
// cluster: a direct peer announces every fifteen to thirty seconds and each
// announce flushes the queue, so charged per announce the eight attempts would
// be gone in minutes. Sends in between still go out; they are not charged.
export const ATTEMPT_MIN_INTERVAL_MS = 2 * 60 * 1000;

interface OutboxState {
  pending: PendingMessage[];

  enqueue: (msg: Omit<PendingMessage, "attempts">) => void;
  // Remove a message once it has actually gone out.
  resolve: (id: string) => void;
  // Everything still owed to a given peer, oldest first.
  forPeer: (peerID: string) => PendingMessage[];
  // Charge one attempt, unless the last charged one was under
  // ATTEMPT_MIN_INTERVAL_MS ago.
  markAttempted: (id: string, nowMs?: number) => void;
  // Drop anything past OUTBOX_TTL_MS or MAX_SEND_ATTEMPTS. Returns what was
  // dropped so the sender's bubble can stop claiming it is still coming.
  evictExpired: (nowMs?: number) => PendingMessage[];
  clearAll: () => void;
}

const storage = getStorage("outbox-store");

const mmkvStorage = {
  getItem: (name: string): string | null => storage.getString(name) ?? null,
  setItem: (name: string, value: string): void => storage.set(name, value),
  removeItem: (name: string): void => {
    storage.remove(name);
  },
};

export const useOutboxStore = create<OutboxState>()(
  persist(
    (set, get) => ({
      pending: [],

      enqueue(msg) {
        set((state) => {
          // Same id already queued: keep the original attempt count.
          if (state.pending.some((p) => p.id === msg.id)) return state;
          const next = [...state.pending, { ...msg, attempts: 0 }];
          // Oldest-first eviction, within this recipient only.
          const mine = next.filter(
            (p) => p.recipientPeerID === msg.recipientPeerID,
          );
          if (mine.length <= MAX_PENDING_PER_PEER) return { pending: next };
          const doomed = new Set(
            mine.slice(0, mine.length - MAX_PENDING_PER_PEER).map((p) => p.id),
          );
          return { pending: next.filter((p) => !doomed.has(p.id)) };
        });
      },

      resolve(id) {
        set((state) => ({ pending: state.pending.filter((p) => p.id !== id) }));
      },

      forPeer(peerID) {
        return get()
          .pending.filter((p) => p.recipientPeerID === peerID)
          .sort((a, b) => a.createdAtMs - b.createdAtMs);
      },

      markAttempted(id, nowMs = Date.now()) {
        set((state) => ({
          pending: state.pending.map((p) => {
            if (p.id !== id) return p;
            if (
              p.lastAttemptMs !== undefined &&
              nowMs - p.lastAttemptMs < ATTEMPT_MIN_INTERVAL_MS
            ) {
              return p;
            }
            return { ...p, attempts: p.attempts + 1, lastAttemptMs: nowMs };
          }),
        }));
      },

      evictExpired(nowMs = Date.now()) {
        const cutoff = nowMs - OUTBOX_TTL_MS;
        const dropped = get().pending.filter(
          (p) => p.createdAtMs < cutoff || p.attempts >= MAX_SEND_ATTEMPTS,
        );
        if (dropped.length === 0) return [];
        const doomed = new Set(dropped.map((p) => p.id));
        set((state) => ({
          pending: state.pending.filter((p) => !doomed.has(p.id)),
        }));
        return dropped;
      },

      clearAll() {
        set({ pending: [] });
      },
    }),
    {
      name: "outbox-store",
      storage: createJSONStorage(() => mmkvStorage),
    },
  ),
);
