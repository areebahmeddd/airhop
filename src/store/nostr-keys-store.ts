// Nostr keys and mesh peer IDs that name each other, learned outside a contact.
//
// Two directions, each a claim one side alone can make:
//   claimedBy  npub -> the peer ID that npub's sealed DMs name as their sender.
//              The seal proves the npub wrote it, not that it owns the peer ID.
//   learned    peer ID -> the npub its proven session handed over (0x54), kept
//              only for a peer a DM has passed with, so a relaunch can still
//              reach them over the internet without making them a contact.
//
// A peer whose session names N and whose N names it back is the same person
// (mesh-service vouchNostrKey). Persisted so the halves can arrive launches
// apart. Like the chat history it serves, a panic wipe clears it and a device
// transfer moves it, and a `learned` entry goes when its thread is removed.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getStorage } from "./mmkv";

// Each map is bounded: any npub can drop a DM in the inbox, and every one of
// them would otherwise leave an entry on disk for good. Far above the threads
// one person keeps open with people outside their contacts.
const MAX_ENTRIES = 256;

interface NostrKeysState {
  claimedBy: Record<string, string>;
  learned: Record<string, string>;
  noteClaim: (npub: string, peerID: string) => void;
  learn: (peerID: string, npub: string) => void;
  forgetClaim: (npub: string) => void;
  // Everything held for this peer, on a block or a delete.
  forgetPeer: (peerID: string) => void;
  // Drop what no open thread needs: a claim lives while the `dm:nostr_` thread
  // a fold would move is open, a learned key while the peer's thread is.
  retainThreads: (channels: readonly string[]) => void;
  clearAll: () => void;
}

// Re-set as the newest key, then the oldest dropped past the cap. Insertion
// order is the age: neither key kind is an integer-like string, so object
// order holds.
function withNewest(
  map: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  const next = { ...map };
  delete next[key];
  next[key] = value;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete next[keys[i]];
  return next;
}

function filtered(
  map: Record<string, string>,
  keep: (key: string, value: string) => boolean,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) if (keep(k, v)) next[k] = v;
  return next;
}

// Filtering only ever removes, so equal sizes mean nothing went.
function unchanged(
  s: Pick<NostrKeysState, "claimedBy" | "learned">,
  claimedBy: Record<string, string>,
  learned: Record<string, string>,
): boolean {
  return (
    Object.keys(claimedBy).length === Object.keys(s.claimedBy).length &&
    Object.keys(learned).length === Object.keys(s.learned).length
  );
}

const storage = getStorage("nostr-keys-store");

const mmkvStorage = {
  getItem: (name: string): string | null => storage.getString(name) ?? null,
  setItem: (name: string, value: string): void => storage.set(name, value),
  removeItem: (name: string): void => {
    storage.remove(name);
  },
};

export const useNostrKeysStore = create<NostrKeysState>()(
  persist(
    (set, get) => ({
      claimedBy: {},
      learned: {},

      noteClaim(npub, peerID) {
        if (get().claimedBy[npub] === peerID) return;
        set((s) => ({ claimedBy: withNewest(s.claimedBy, npub, peerID) }));
      },

      learn(peerID, npub) {
        if (get().learned[peerID] === npub) return;
        set((s) => ({ learned: withNewest(s.learned, peerID, npub) }));
      },

      forgetClaim(npub) {
        if (get().claimedBy[npub] === undefined) return;
        set((s) => ({ claimedBy: filtered(s.claimedBy, (k) => k !== npub) }));
      },

      forgetPeer(peerID) {
        const s = get();
        const claimedBy = filtered(s.claimedBy, (_, p) => p !== peerID);
        const learned = filtered(s.learned, (p) => p !== peerID);
        if (unchanged(s, claimedBy, learned)) return;
        set({ claimedBy, learned });
      },

      retainThreads(channels) {
        const open = new Set(channels);
        const s = get();
        const claimedBy = filtered(s.claimedBy, (npub) =>
          open.has(`dm:nostr_${npub}`),
        );
        const learned = filtered(s.learned, (peerID) =>
          open.has(`dm:${peerID}`),
        );
        if (unchanged(s, claimedBy, learned)) return;
        set({ claimedBy, learned });
      },

      clearAll() {
        set({ claimedBy: {}, learned: {} });
      },
    }),
    {
      name: "nostr-keys-store",
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (s) => ({ claimedBy: s.claimedBy, learned: s.learned }),
    },
  ),
);
