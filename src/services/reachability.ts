// Tells the internet-facing services when a network came back or changed, so
// they act on the event rather than on their own timers: the relay pool never
// retries a first connect that failed, a dropped relay waits up to a minute,
// and Tor's status feed cannot report a change it slept through.
//
// A nudge, never a gate. Nothing refuses to connect because the OS reports no
// network: the mesh is offline-first and a captive portal reads as connected.

import * as Network from "expo-network";
import { getMeshService } from "./mesh-service";
import { revalidateTorRouting } from "./tor-routing";
import { reconcileIfDue } from "./wallet-service";

// A Wi-Fi to cellular handoff reports several states inside a second; a change
// counts once it has held this long. bitchat's NetworkReachabilityMonitor uses
// the same window.
const SETTLE_MS = 2_500;

interface Reading {
  reachable: boolean;
  // Android reports a network before it has validated internet on it, then
  // again once it has. A relay dialled in between fails and is dropped, so
  // validation is an edge of its own. Connecting is one too, because where the
  // validation probe is blocked the second report never comes.
  validated: boolean;
  type: string;
}

let subscription: { remove: () => void } | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
// The reading waiting out the window. A repeat of it keeps the deadline rather
// than pushing it back, or a stream of identical reports (Android sends one per
// signal-strength change) would hold the change off indefinitely.
let pending: Reading | null = null;
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

function sameReading(a: Reading, b: Reading): boolean {
  return (
    a.reachable === b.reachable &&
    a.validated === b.validated &&
    a.type === b.type
  );
}

// Acts on a network becoming usable, validating, or changing type under a
// usable one. Never on loss.
function commit(next: Reading): void {
  const previous = committed;
  committed = next;
  if (previous === null || !next.reachable) return;
  // The network the relay sockets were opened on is gone, whether it dropped
  // out for a while or was replaced by another.
  const networkReplaced = !previous.reachable || next.type !== previous.type;
  const validated = next.validated && !previous.validated;
  if (!networkReplaced && !validated) return;
  void revalidateTorRouting();
  getMeshService()?.onNetworkChanged(networkReplaced);
  // Throttled inside; a paid Lightning invoice waits on a mint round trip.
  reconcileIfDue();
}

function cancelPending(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  pending = null;
}

function observe(state: Network.NetworkState): void {
  const next = readingOf(state);
  // Back where it started before the window ran out: a flap, not a change.
  if (committed !== null && sameReading(next, committed)) {
    cancelPending();
    return;
  }
  if (pending !== null && sameReading(next, pending)) return;
  cancelPending();
  pending = next;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    pending = null;
    commit(next);
  }, SETTLE_MS);
}

// Idempotent, and null-safe against a stopped mesh, so it is never stopped.
export function startReachabilityWatch(): void {
  if (subscription !== null) return;
  subscription = Network.addNetworkStateListener(observe);
  void Network.getNetworkStateAsync()
    .then((state) => {
      if (committed === null && pending === null) committed = readingOf(state);
    })
    .catch(() => {
      // The first event records the baseline instead.
    });
}
