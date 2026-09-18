// Backing store for the Ring overlay: the phone rings while `current` is set.
//
// Transient, not persisted, like alert-store. app.tsx's subscribeInboundRings
// wiring calls `show` for every ring not arriving in the thread already on
// screen, whether or not the app is in front; out of the foreground the
// system tray is told as well (raiseRingNotification). ring-alert-sheet.tsx
// renders it and owns the ringing.
//
// One ring sounds at a time and the rest wait, the way a second call waits
// behind the first. Each keeps the window it arrived with: a ring that waited
// past RING_ALERT_DURATION_MS is dropped rather than rung late, since its bell
// row and tray card are already the record of it.

import { create } from "zustand";
import { RING_ALERT_DURATION_MS } from "./ring-store";

export interface IncomingRing {
  peerID: string;
  ringID: string;
  senderName: string;
  receivedAtMs: number;
}

interface IncomingRingState {
  current: IncomingRing | null;
  queue: IncomingRing[];
  show: (ring: IncomingRing) => void;
  // The current ring is over: ring the next one still inside its window, or
  // fall silent.
  dismiss: () => void;
  // This person's ring was answered (their thread opened, their card
  // tapped), wherever it sits.
  removeFor: (peerID: string) => void;
  // For the panic wipe.
  clearAll: () => void;
}

function stillRinging(ring: IncomingRing, nowMs: number): boolean {
  return nowMs - ring.receivedAtMs < RING_ALERT_DURATION_MS;
}

function advance(
  queue: IncomingRing[],
): Pick<IncomingRingState, "current" | "queue"> {
  const nowMs = Date.now();
  const live = queue.filter((r) => stillRinging(r, nowMs));
  return { current: live[0] ?? null, queue: live.slice(1) };
}

export const useIncomingRingStore = create<IncomingRingState>((set) => ({
  current: null,
  queue: [],
  show(ring) {
    set((s) => {
      if (s.current === null) return { current: ring, queue: [] };
      // One ring per person: the receiver's cooldown makes a second inside
      // one window near impossible, and if one arrives it stands in for the
      // earlier one rather than ringing twice.
      if (s.current.peerID === ring.peerID) return { current: ring };
      return {
        queue: [...s.queue.filter((r) => r.peerID !== ring.peerID), ring],
      };
    });
  },
  dismiss() {
    set((s) => advance(s.queue));
  },
  removeFor(peerID) {
    set((s) => {
      const queue = s.queue.filter((r) => r.peerID !== peerID);
      if (s.current?.peerID === peerID) return advance(queue);
      return queue.length === s.queue.length ? s : { queue };
    });
  },
  clearAll() {
    set({ current: null, queue: [] });
  },
}));
