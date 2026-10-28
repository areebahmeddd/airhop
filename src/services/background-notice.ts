// What the app shows of the mesh outside itself: the home screen widget on both
// platforms, and on Android the background notice (the ongoing notification the
// foreground service shows while the mesh runs). All of it reads one snapshot,
// pushed from here, so none of it can disagree with the rest or with the Mesh tab.
//
// Module level, like the notification pipeline: the mesh outlives the UI.
// Counted by the store's reachability rule, since a peer who left without a
// LEAVE lingers in the map, and recounted on a timer because expiry changes the
// count without a store change.
//
// Kept free of the BLE module and mesh-service, which load native code at
// import: panic-wipe stops this, and must stay loadable without a native host.

import NativeAirhopApp from "@bridge/NativeAirhopApp";
import { useMeshStateStore } from "@store/mesh-state-store";
import { countReachablePeers, usePeerStore } from "@store/peer-store";
import { AppState, Platform } from "react-native";

// Android drops notification updates posted faster than this, possibly the
// last of a burst, so a busy room pushes only its settled count.
const COALESCE_MS = 1_000;

// A peer whose 60 s window lapses leaves the notice within this.
const RECOUNT_MS = 15_000;

// An unchanged reading goes again this often, so its time stays current. The
// widget shows that time to the minute and retires a reading 15 minutes old,
// which is how it tells a counting mesh from a process that was killed.
const REFRESH_MS = 60_000;

// iOS charges every widget reload against a daily budget of a few dozen, except
// while the app is in front, and once it is spent no reload lands until the next
// day. So with the app behind, a reading goes at most this often, under the
// 15-minute cutoff so a mesh the OS keeps waking still reads as live. The mesh
// pausing or Bluetooth going off is never held back: either changes what the
// widget says, and both are rare.
const IOS_AWAY_GAP_MS = 10 * 60_000;

interface Snapshot {
  count: number;
  meshOn: boolean;
  bluetoothOff: boolean;
  atMs: number;
}

let stops: (() => void)[] | null = null;

// Idempotent, so every path that brings a mesh up may call it.
export function startBackgroundNotice(): void {
  if (stops !== null) return;

  let shown: Snapshot | null = null;
  const push = (force: boolean): void => {
    const atMs = Date.now();
    const count = countReachablePeers(usePeerStore.getState().peers, atMs);
    const mesh = useMeshStateStore.getState();
    // Away is the one presence that takes the mesh down.
    const meshOn = mesh.presenceStatus !== "away";
    // Switched off, the mesh stays on and hears nobody, which "nobody in range"
    // would misreport as an empty room. A refused permission is left out: it is
    // answered on the screen that asked, and revoking one in Settings restarts
    // the process.
    const bluetoothOff = mesh.bleBlocker === "adapter-off";
    // A negative age is the clock set back. The widget treats that reading as
    // from the future and hides it, so it is replaced now rather than once the
    // clock has caught up.
    const age = shown === null ? -1 : atMs - shown.atMs;
    const youngerThan = (ms: number): boolean => age >= 0 && age < ms;
    const stateChanged =
      shown === null ||
      shown.meshOn !== meshOn ||
      shown.bluetoothOff !== bluetoothOff;
    if (!force && !stateChanged) {
      if (shown?.count === count && youngerThan(REFRESH_MS)) return;
      if (
        Platform.OS === "ios" &&
        AppState.currentState !== "active" &&
        youngerThan(IOS_AWAY_GAP_MS)
      ) {
        return;
      }
    }
    const next = { count, meshOn, bluetoothOff, atMs };
    shown = next;
    NativeAirhopApp?.setMeshSnapshot(count, meshOn, bluetoothOff, atMs).catch(
      () => {
        // Retried on the next change or recount.
        if (shown === next) shown = null;
      },
    );
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  const settle = (): void => {
    pending ??= setTimeout(() => {
      pending = null;
      push(false);
    }, COALESCE_MS);
  };
  const stopPeers = usePeerStore.subscribe(settle);
  const stopMesh = useMeshStateStore.subscribe((state, prev) => {
    if (
      state.presenceStatus !== prev.presenceStatus ||
      state.bleBlocker !== prev.bleBlocker
    ) {
      settle();
    }
  });
  const recount = setInterval(() => push(false), RECOUNT_MS);
  // Repeated on every trip to the background, changed or not: on Android so
  // native can post a notice that went up before notifications were allowed, as
  // on a first launch, and on iOS so the widget holds the reading the app left
  // with.
  const appState = AppState.addEventListener("change", (next) => {
    if (next === "background") push(true);
  });

  stops = [
    stopPeers,
    stopMesh,
    () => clearInterval(recount),
    () => {
      if (pending !== null) clearTimeout(pending);
      pending = null;
    },
    () => appState.remove(),
  ];
  push(false);
}

// For the panic wipe, before anything is cleared: a recount after the clear
// would put a reading back for the identity being destroyed. The next mesh
// starts this again.
export function stopBackgroundNotice(): void {
  const current = stops;
  stops = null;
  current?.forEach((stop) => stop());
}

// The widget back to "Open Airhop" and the notice's count to zero. Queued on
// the same native module as every push, so it lands after the last one.
export function clearBackgroundNotice(): Promise<void> {
  return NativeAirhopApp?.clearMeshSnapshot() ?? Promise.resolve();
}

// Message alerts post on other channels, so quieting this leaves them alone.
export function openBackgroundNoticeSettings(): Promise<boolean> {
  return (
    NativeAirhopApp?.openBackgroundNoticeSettings().catch(() => false) ??
    Promise.resolve(false)
  );
}
