// Applying a presence choice to the running mesh.
//
// Presence is the one setting that starts and stops radios, so it has to be
// reached from more than one place: the Status picker in Profile, and the "Stop
// mesh" action on the Android background notification. Two copies of "what Away
// means" would drift the moment either changed, and the drift would show up as
// a green dot over a dead mesh.
//
// Deliberately does NOT live in mesh-state-store: that store is imported by
// mesh-service, so putting the mesh calls there would close an import cycle.

import {
  useMeshStateStore,
  type PresenceStatus,
} from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { getMeshService } from "./mesh-service";

// Move the mesh to `next` and record it. Safe to call with the mesh already in
// that state, and safe to call before the mesh exists: the status is recorded
// either way, but a start replaces it with applyStartupPresence's, so only an
// Invisible choice carries into the mesh that start builds.
//
// The three states, and what each actually does to the radios:
//   online     advertise + scan. Findable and reachable.
//   away       everything stops. The only state that takes the mesh down.
//   invisible  scan + relay, but stop advertising. You see others; they don't
//              see you.
export function applyPresence(next: PresenceStatus, nickname: string): void {
  const current = useMeshStateStore.getState().presenceStatus;
  const mesh = getMeshService();

  if (next === "online") {
    // Coming back from Away means the whole mesh was stopped, so it needs a
    // real start; from Invisible only advertising was off.
    if (current === "away") mesh?.start(nickname);
    // Stated unconditionally, not only on the Invisible edge.
    //
    // Discoverability is intent the radio controller holds across a stop:
    // suspend() and stop() clear `running` and leave `discoverable` alone, on
    // purpose, so an outage does not make an Invisible user discoverable when
    // the radio returns. So Online has to undo it itself: Invisible, then Away,
    // then Online would otherwise restart the mesh still holding
    // discoverable=false, scanning and relaying but never advertising, while
    // the profile dot says Online.
    //
    // setDiscoverable is a no-op when the value already matches, so saying it
    // every time costs nothing and removes the ordering dependency entirely.
    mesh?.setDiscoverable(true);
  } else if (next === "away") {
    mesh?.stop();
    // Away stops the whole mesh, so the internet gateway can no longer relay
    // for anyone. Turn it off outright rather than leaving a green toggle that
    // does nothing; the user re-enables it when they come back. (Tor stays as
    // set: it is a privacy preference, and silently disabling it would risk
    // clear-net traffic on return.)
    useSettingsStore.getState().setGatewayEnabled(false);
  } else {
    if (current === "away") mesh?.start(nickname);
    mesh?.setDiscoverable(false);
  }

  // Away is left out: it pauses the mesh for this session only, and the next
  // launch comes back in whichever visibility was chosen last.
  if (next !== "away") {
    useSettingsStore.getState().setStayInvisible(next === "invisible");
  }
  useMeshStateStore.getState().setPresenceStatus(next);
}

// Put a freshly started mesh in the presence that outlives a launch: Invisible
// if it was chosen, Online otherwise. Away never does, since opening Airhop
// means wanting the mesh.
//
// Call it on the same tick as initMeshService. A new radio controller starts
// discoverable, but its first pass reads the device before it reads that, so
// the Invisible choice lands in time and nothing is advertised even once.
export function applyStartupPresence(): void {
  const invisible = useSettingsStore.getState().stayInvisible;
  getMeshService()?.setDiscoverable(!invisible);
  useMeshStateStore
    .getState()
    .setPresenceStatus(invisible ? "invisible" : "online");
}
