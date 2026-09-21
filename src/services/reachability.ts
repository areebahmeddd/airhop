// Tells the internet-facing services when a network came back, so they act on
// the event rather than on their own timers: the relay pool never retries a
// first connect that failed, a dropped relay waits up to a minute, and Tor's
// status feed cannot report a change it slept through.
//
// A nudge, never a gate. Nothing refuses to connect because the OS reports no
// network: the mesh is offline-first and a captive portal reads as connected.

import * as Network from "expo-network";
import { getMeshService } from "./mesh-service";
import { revalidateTorRouting } from "./tor-routing";
import { reconcileIfDue } from "./wallet-service";

// A Wi-Fi to cellular handoff reports several states inside a second; a change
// counts once it has held this long.
const SETTLE_MS = 2_500;

interface Reading {
  reachable: boolean;
  // Android reports a network before it has validated internet on it, then
  // again once it has. A relay dialled in between fails and is dropped, so
  // the validation is an edge of its own.
  validated: boolean;
  type: string;
}

let subscription: { remove: () => void } | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
// Null until the first reading, which is recorded and not acted on: the pool
// is being built at that moment.
let committed: Reading | null = null;

function readingOf(state: Network.NetworkState): Reading {
  return {
    reachable: state.isConnected !== false,
    validated: state.isInternetReachable === true,
    type: state.type ?? "",
  };
}

// Acts on a network becoming usable, validating, or changing type under a
// usable one. Never on loss.
function commit(next: Reading): void {
  const previous = committed;
  committed = next;
  if (previous === null || !next.reachable) return;
  const cameBack = !previous.reachable;
  const validated = next.validated && !previous.validated;
  const moved = next.type !== previous.type;
  if (!cameBack && !validated && !moved) return;
  void revalidateTorRouting();
  getMeshService()?.onNetworkChanged();
  // Throttled inside; a paid Lightning invoice waits on a mint round trip.
  reconcileIfDue();
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
