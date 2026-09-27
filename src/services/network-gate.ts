// The two facts every clear-net side channel is gated on, read from the stores.
//
// Two predicates rather than one verdict, because the sites compose them
// differently. The OS geocoder refuses a Tor claim on both platforms, since it
// runs in a system process no app proxy reaches. The update check refuses it on
// iOS only, where nothing but the Nostr socket is proxied; on Android the
// download rides Tor. Both refuse with the internet off.
//
// Stores only, no native module, so the panic wipe and the stores that import
// this stay loadable without a native host.

import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";

// The user switched the internet half off ("Bluetooth only").
export function internetOff(): boolean {
  return !useSettingsStore.getState().internetEnabled;
}

// The user asked for Tor, or it is carrying traffic. Either counts: a request
// that slips out while Tor is still starting is the leak the user opted out of.
export function torClaimed(): boolean {
  return (
    useSettingsStore.getState().torEnabled ||
    useMeshStateStore.getState().torActive
  );
}
