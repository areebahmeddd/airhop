// Ring: rate limiting and snooze state for the Ring alert
// (NoisePayloadType.RING / RING_ACK / RING_REFUSED, PROTOCOLS.md section 3.3).
//
// Whether a contact may ring at all lives on the contact record
// (contacts-store's allowRing). This store holds only what changes on its own
// clock: cooldowns, snoozes, and what became of the last ring we sent.
// Enforcement is in mesh-service.ts and notification-policy.ts; this file
// imports neither.

import type { RingRefusalReasonValue } from "@core/mesh/wire/ring-payload";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getStorage } from "./mmkv";

// A repeat ring from the same sender inside this window is refused by the
// receiver, and the sender's button holds for the same window so it never
// offers a tap that would be refused. One number for both sides.
export const RING_COOLDOWN_MS = 5 * 60 * 1000;

// A ring older than this by the time it decrypts is stale.
export const RING_STALENESS_MS = 2 * 60 * 1000;

// How long the receiver's phone rings before giving up: the overlay, the
// Android sound loop and the iOS notification chain all stop here. The
// sender's "Ringing..." holds for the same window, so the button says what
// the other phone is doing.
export const RING_ALERT_DURATION_MS = 45 * 1000;

// Snooze preset offered on the alert itself.
export const RING_SNOOZE_1H_MS = 60 * 60 * 1000;

interface RingState {
  lastSentAtMs: Record<string, number>;
  lastAckedAtMs: Record<string, number>;
  // A refusal ends "Ringing..." early. The cooldown still runs from the send:
  // a refused ring is still a ring we chose to send.
  lastRefusedAtMs: Record<string, number>;
  lastRefusalReason: Record<string, RingRefusalReasonValue>;
  lastReceivedAtMs: Record<string, number>;
  snoozedUntilMs: Record<string, number>;

  recordSent: (peerID: string, nowMs: number) => void;
  recordAcked: (peerID: string, nowMs: number) => void;
  recordRefused: (
    peerID: string,
    reason: RingRefusalReasonValue,
    nowMs: number,
  ) => void;
  recordReceived: (peerID: string, nowMs: number) => void;
  snooze: (peerID: string, untilMs: number) => void;
  clearSnooze: (peerID: string) => void;
  // For the panic wipe. The "ring-store" MMKV partition is cleared
  // separately (panic-wipe.ts MMKV_STORE_IDS); this only resets live state.
  clearAll: () => void;

  // Whether our ring to this peer is unanswered and inside the alert window,
  // so the other phone may still be ringing.
  isSending: (peerID: string, nowMs: number) => boolean;
  // Milliseconds until this peer may be rung again; 0 when they may be now.
  cooldownRemainingMs: (peerID: string, nowMs: number) => number;
  // Why the last ring was refused, if it was and nothing was sent since.
  lastRefusal: (peerID: string) => RingRefusalReasonValue | null;
  isSnoozed: (peerID: string, nowMs: number) => boolean;
  msSinceLastReceived: (peerID: string, nowMs: number) => number | null;
}

const storage = getStorage("ring-store");

const mmkvStorage = {
  getItem: (name: string): string | null => storage.getString(name) ?? null,
  setItem: (name: string, value: string): void => storage.set(name, value),
  removeItem: (name: string): void => {
    storage.remove(name);
  },
};

export const useRingStore = create<RingState>()(
  persist(
    (set, get) => ({
      lastSentAtMs: {},
      lastAckedAtMs: {},
      lastRefusedAtMs: {},
      lastRefusalReason: {},
      lastReceivedAtMs: {},
      snoozedUntilMs: {},

      recordSent(peerID, nowMs) {
        set((s) => ({ lastSentAtMs: { ...s.lastSentAtMs, [peerID]: nowMs } }));
      },
      recordAcked(peerID, nowMs) {
        set((s) => ({
          lastAckedAtMs: { ...s.lastAckedAtMs, [peerID]: nowMs },
        }));
      },
      recordRefused(peerID, reason, nowMs) {
        set((s) => ({
          lastRefusedAtMs: { ...s.lastRefusedAtMs, [peerID]: nowMs },
          lastRefusalReason: { ...s.lastRefusalReason, [peerID]: reason },
        }));
      },
      recordReceived(peerID, nowMs) {
        set((s) => ({
          lastReceivedAtMs: { ...s.lastReceivedAtMs, [peerID]: nowMs },
        }));
      },
      snooze(peerID, untilMs) {
        set((s) => ({
          snoozedUntilMs: { ...s.snoozedUntilMs, [peerID]: untilMs },
        }));
      },
      clearSnooze(peerID) {
        set((s) => {
          const next = { ...s.snoozedUntilMs };
          delete next[peerID];
          return { snoozedUntilMs: next };
        });
      },

      isSending(peerID, nowMs) {
        const sentAt = get().lastSentAtMs[peerID];
        if (sentAt === undefined) return false;
        // A reply to an earlier ring must not mask a new one as answered.
        const ackedAt = get().lastAckedAtMs[peerID];
        if (ackedAt !== undefined && ackedAt >= sentAt) return false;
        const refusedAt = get().lastRefusedAtMs[peerID];
        if (refusedAt !== undefined && refusedAt >= sentAt) return false;
        return nowMs - sentAt < RING_ALERT_DURATION_MS;
      },
      cooldownRemainingMs(peerID, nowMs) {
        const sentAt = get().lastSentAtMs[peerID];
        if (sentAt === undefined) return 0;
        return Math.max(0, sentAt + RING_COOLDOWN_MS - nowMs);
      },
      lastRefusal(peerID) {
        const sentAt = get().lastSentAtMs[peerID];
        const refusedAt = get().lastRefusedAtMs[peerID];
        if (sentAt === undefined || refusedAt === undefined) return null;
        if (refusedAt < sentAt) return null;
        return get().lastRefusalReason[peerID] ?? null;
      },
      isSnoozed(peerID, nowMs) {
        const until = get().snoozedUntilMs[peerID];
        return until !== undefined && nowMs < until;
      },
      msSinceLastReceived(peerID, nowMs) {
        const at = get().lastReceivedAtMs[peerID];
        return at === undefined ? null : nowMs - at;
      },

      clearAll() {
        set({
          lastSentAtMs: {},
          lastAckedAtMs: {},
          lastRefusedAtMs: {},
          lastRefusalReason: {},
          lastReceivedAtMs: {},
          snoozedUntilMs: {},
        });
      },
    }),
    {
      name: "ring-store",
      storage: createJSONStorage(() => mmkvStorage),
    },
  ),
);

// Inbound-ring side channel, same shape as chat-store's
// subscribeInboundMessages: mesh-service raises an accepted ring without
// knowing about notifications or the overlay, and app.tsx decides what
// happens next.
export interface InboundRing {
  peerID: string;
  ringID: string;
  senderName: string;
  receivedAtMs: number;
}
type InboundRingListener = (ring: InboundRing) => void;
const inboundRingListeners = new Set<InboundRingListener>();

export function subscribeInboundRings(fn: InboundRingListener): () => void {
  inboundRingListeners.add(fn);
  return () => {
    inboundRingListeners.delete(fn);
  };
}

export function notifyInboundRing(ring: InboundRing): void {
  for (const fn of inboundRingListeners) fn(ring);
}
