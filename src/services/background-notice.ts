// The peer count on Android's background notice, the ongoing notification the
// foreground service shows while the mesh runs.
//
// Module level, like the notification pipeline: the mesh outlives the UI.
// Counted by the store's reachability rule, since a peer who left without a
// LEAVE lingers in the map, and recounted on a timer because expiry changes the
// count without a store change.

import AirhopBLE from "@bridge/NativeAirhopBLE";
import { countReachablePeers, usePeerStore } from "@store/peer-store";
import { AppState, Platform } from "react-native";

// Android drops notification updates posted faster than this, possibly the
// last of a burst, so a busy room pushes only its settled count.
const COALESCE_MS = 1_000;

// A peer whose 60 s window lapses leaves the notice within this.
const RECOUNT_MS = 15_000;

let started = false;

// Idempotent, so every path that brings a mesh up may call it.
export function startBackgroundNotice(): void {
  if (Platform.OS !== "android" || started) return;
  started = true;

  let shown = -1;
  const push = (): void => {
    const count = countReachablePeers(
      usePeerStore.getState().peers,
      Date.now(),
    );
    if (count === shown) return;
    shown = count;
    AirhopBLE.setBackgroundPeerCount(count).catch(() => {
      // Retried on the next change or recount.
      shown = -1;
    });
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  usePeerStore.subscribe(() => {
    pending ??= setTimeout(() => {
      pending = null;
      push();
    }, COALESCE_MS);
  });
  setInterval(push, RECOUNT_MS);
  // Repeated on every trip to the background, changed or not, so native can
  // post a notice that went up before notifications were allowed, as on a
  // first launch.
  AppState.addEventListener("change", (next) => {
    if (next === "background" && shown >= 0) {
      AirhopBLE.setBackgroundPeerCount(shown).catch(() => {});
    }
  });
  push();
}

// Message alerts post on other channels, so quieting this leaves them alone.
export function openBackgroundNoticeSettings(): Promise<boolean> {
  return AirhopBLE.openBackgroundNoticeSettings().catch(() => false);
}
