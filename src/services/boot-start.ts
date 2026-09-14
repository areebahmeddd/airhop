// The JS side of AirhopBootReceiver/AirhopBootService: registers the
// "Airhop.BootStartMesh" headless task Android runs with no Activity and no
// UI. Every step below is a check, never a request - unlike
// startMeshWithPermissions in app.tsx, nothing here can prompt.
//
// syncAutoStartOnBoot lives in ./boot-sync instead: this file pulls in
// mesh-service.ts, which loads the native BLE module at import, and callers
// that only need to mirror the setting (panic-wipe.ts, settings screens)
// must not drag that in.

import { loadIdentity } from "@core/crypto/identity";
import { hasBlePermissions } from "@platform/ble-permissions";
import { getMeshService, initMeshService } from "@services/mesh-service";
import { primeTorRoutingOnStartup } from "@services/tor-routing";
import { useSettingsStore } from "@store/settings-store";
import { peerIDToUsername } from "@utils/username";
import { AppRegistry, Platform } from "react-native";

export { syncAutoStartOnBoot } from "./boot-sync";

// Time for the radio controller to start scanning and hand off to
// AirhopForegroundService before this task, and AirhopBootService holding
// the process up for it, resolve and stop.
const MESH_SETTLE_MS = 6_000;

async function bootStartMesh(): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.autoStartOnBoot) return;
  // backgroundMeshEnabled is what makes the radio controller keep
  // AirhopForegroundService up; without it, a stale autoStartOnBoot would
  // wake the JS runtime just for Android to kill it again moments later.
  if (!settings.backgroundMeshEnabled) return;

  const identity = await loadIdentity();
  if (identity === null) return; // no onboarded identity to start as
  if (getMeshService()?.peerID === identity.peerID) return; // already running
  if (!(await hasBlePermissions())) return; // nothing to ask from here

  try {
    primeTorRoutingOnStartup();
  } catch {
    // Tor is a preference, not a prerequisite.
  }
  initMeshService(identity, peerIDToUsername(identity.peerID));
  getMeshService()?.retryRadios();

  await new Promise<void>((resolve) => setTimeout(resolve, MESH_SETTLE_MS));
}

// Must match the taskKey AirhopBootService.getTaskConfig() passes natively.
const TASK_KEY = "Airhop.BootStartMesh";

export function registerBootStartTask(): void {
  if (Platform.OS !== "android") return;
  AppRegistry.registerHeadlessTask(TASK_KEY, () => bootStartMesh);
}
