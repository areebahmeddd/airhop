// Backing store for the foreground Ring overlay (ring-alert-sheet.tsx).
// Same shape as alert-store: transient, not persisted. app.tsx's
// subscribeInboundRings wiring calls `show` only when the app is active;
// a backgrounded ring goes through raiseRingNotification instead.

import { create } from "zustand";

export interface IncomingRing {
  peerID: string;
  ringID: string;
  senderName: string;
  receivedAtMs: number;
}

interface IncomingRingState {
  current: IncomingRing | null;
  show: (ring: IncomingRing) => void;
  clear: () => void;
}

export const useIncomingRingStore = create<IncomingRingState>((set) => ({
  current: null,
  show(ring) {
    set({ current: ring });
  },
  clear() {
    set({ current: null });
  },
}));
