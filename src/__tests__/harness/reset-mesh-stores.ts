// What every lifecycle suite resets between scenarios.

import { useMeshStateStore } from "@store/mesh-state-store";
import { usePeerStore } from "@store/peer-store";
import { useSettingsStore } from "@store/settings-store";

export function resetMeshStores(): void {
  useMeshStateStore.setState({
    bleBlocker: "starting",
    blePermissionBlocked: false,
    bleAdvertisingUnsupported: false,
    powerSaving: false,
    wifiFastPath: "unknown",
    lanState: "off",
    locationGranted: true,
    nostrConnected: false,
    torActive: false,
    bridgeActive: false,
    bridgePeopleAcross: 0,
    presenceStatus: "online",
  });
  // A start restores a kept Invisible, so Online has to be the saved choice too.
  useSettingsStore.getState().setStayInvisible(false);
  useSettingsStore.getState().setBackgroundMeshEnabled(true);
  usePeerStore.getState().clearAll();
}
