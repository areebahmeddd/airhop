// Geo-relay directory access.
//
// Airhop ships the relay directory as a vendored, build-time list (src/data/
// relays.ts, generated from assets/data/nostr_relays.csv by
// scripts/generate-relays.js) and does NOT fetch it at runtime. That keeps
// first launch network-free, never tells a third party who is asking for relays
// (a deanonymisation vector, especially under Tor), and works offline, which is
// exactly when this app matters most.
//
// It is bitchat's reviewed directory (relays/online_relays_gps.csv), the file
// both bitchat clients route by: the same file, canonicalized the same way, is
// what puts every client in a cell on the same relays. A weekly CI sync
// (.github/workflows/sync-relays.yml) proposes upstream changes as a pull
// request, since the directory ships inside the bundle.

import { GEO_RELAYS } from "@data/relays";
import type { RelayEntry } from "./geo-relay";

// The vendored geo-relay directory. Never empty.
export function loadGeoRelays(): RelayEntry[] {
  return GEO_RELAYS as RelayEntry[];
}
