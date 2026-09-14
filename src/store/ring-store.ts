// Ring: rate limiting and snooze state for the Ring alert
// (NoisePayloadType.RING / RING_ACK, PROTOCOLS.md section 3.3).
//
// Whether a contact may ring at all lives on the contact record
// (contacts-store's allowRing). This store only holds what changes on its
// own clock: cooldowns and snoozes. Enforcement is in mesh-service.ts and
// notification-policy.ts; this file imports neither.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getStorage } from "./mmkv";

// A repeat ring from the same sender inside this window is dropped.
export const RING_COOLDOWN_MS = 5 * 60 * 1000;

// A ring older than this by the time it decrypts is stale.
export const RING_STALENESS_MS = 2 * 60 * 1000;

/**
 * How long the sender's own "Ringing..." state holds, absent an ack.
 * @alias Matches RING_COOLDOWN_MS so both sides agree on what "still
 * ringing" means; knip reads the tag, so it stays a JSDoc block.
 */
export const RING_SENDER_TIMEOUT_MS = RING_COOLDOWN_MS;

// How long the foreground alert keeps pulsing before it gives up.
export const RING_ALERT_DURATION_MS = 45 * 1000;

// Snooze preset offered on the alert itself.
export const RING_SNOOZE_1H_MS = 60 * 60 * 1000;

interface RingState {
  lastSentAtMs: Record<string, number>;
  lastAckedAtMs: Record<string, number>;
  lastReceivedAtMs: Record<string, number>;
  snoozedUntilMs: Record<string, number>;

  recordSent: (peerID: string, nowMs: number) => void;
  recordAcked: (peerID: string, nowMs: number) => void;
  recordReceived: (peerID: string, nowMs: number) => void;
  snooze: (peerID: string, untilMs: number) => void;
  clearSnooze: (peerID: string) => void;
  // For the panic wipe. The "ring-store" MMKV partition is cleared
  // separately (panic-wipe.ts MMKV_STORE_IDS); this only resets live state.
  clearAll: () => void;

  // Whether our ring to this peer is still unacknowledged and within the
  // timeout window.
  isSending: (peerID: string, nowMs: number) => boolean;
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
        // An ack for an earlier ring must not mask a new one as answered.
        const ackedAt = get().lastAckedAtMs[peerID];
        if (ackedAt !== undefined && ackedAt >= sentAt) return false;
        return nowMs - sentAt < RING_SENDER_TIMEOUT_MS;
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
// knowing about notifications or foreground UI, and app.tsx decides what
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
