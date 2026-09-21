// Tells the internet-facing services when a network came back, so they act on
// the event rather than on their own timers: a relay whose first connect
// failed is never retried by the pool, a dropped one climbs a ladder that
// reaches a minute, and Tor's status feed cannot report a change it slept
// through.
//
// A nudge, never a gate. Nothing refuses to connect because the OS reports no
// network: the mesh is offline-first and a captive portal reads as connected.

import * as Network from "expo-network";
import { getMeshService } from "./mesh-service";
import { revalidateTorRouting } from "./tor-routing";

// A Wi-Fi to cellular handoff reports several states inside a second; a change
// counts once it has held this long.
const SETTLE_MS = 2_500;

interface Reading {
  reachable: boolean;
  type: string;
}

let subscription: { remove: () => void } | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
// Null until the first reading, which is recorded and not acted on: the pool
// is being built at that moment.
let committed: Reading | null = null;

function readingOf(state: Network.NetworkState): Reading {
  // Not `isInternetReachable`: on Android that waits for validation, and an
  // unvalidated network is exactly the one worth trying.
  return { reachable: state.isConnected !== false, type: state.type ?? "" };
}

// Acts on a network becoming usable, or changing type under a usable one.
function commit(next: Reading): void {
  const previous = committed;
  committed = next;
  if (previous === null || !next.reachable) return;
  if (previous.reachable && next.type === previous.type) return;
  void revalidateTorRouting();
  getMeshService()?.onNetworkChanged();
}

function observe(state: Network.NetworkState): void {
  const next = readingOf(state);
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    commit(next);
  }, SETTLE_MS);
}

// Idempotent, and null-safe against a stopped mesh, so it is never stopped.
export function startReachabilityWatch(): void {
  if (subscription !== null) return;
  subscription = Network.addNetworkStateListener(observe);
  void Network.getNetworkStateAsync()
    .then((state) => {
      if (committed === null && settleTimer === null)
        committed = readingOf(state);
    })
    .catch(() => {
      // The first event records the baseline instead.
    });
}
