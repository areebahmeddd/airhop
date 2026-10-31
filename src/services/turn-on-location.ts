// The "Turn on" behind every place that asks for location: the Mesh tab's
// "Location off" banner, the one inside a location channel, and the Mesh
// bridge's Grant row. One function, so they cannot drift.
//
// Without location the location channels still run, over Bluetooth only, so
// this is an upgrade rather than a repair, and it acts like the camera and
// photo flows do: ask while the OS will still ask, and once it will not (any
// refusal on iOS, "Don't allow" twice on Android), say so and offer Settings,
// since a request then is a silent no-op. The resume re-reads the grant when
// the user comes back from Settings, which clears both banners.
//
// Not in location-service: acting on a grant reaches into the mesh service,
// which already depends on location-service through the channel code.

import { t } from "@i18n";
import { showBlockedAlert } from "@platform/permissions";
import { useMeshStateStore } from "@store/mesh-state-store";
import {
  locationPermissionState,
  requestLocationPermission,
} from "./location-service";
import { getMeshService } from "./mesh-service";

// Resolves true when location is granted by the end of it.
export async function turnOnLocation(): Promise<boolean> {
  const current = await locationPermissionState();
  if (!current.granted && !current.canAskAgain) {
    showBlockedAlert({
      label: t("permission.location.label"),
      purpose: t("permission.location.purpose"),
    });
    return false;
  }
  // Declining the prompt just shown is an answer, not a dead end, so it gets
  // no alert of its own. The banner stays, and the next tap explains Settings.
  const granted = current.granted || (await requestLocationPermission());
  useMeshStateStore.getState().setLocationGranted(granted);
  if (!granted) return false;
  // Act on the grant, as the Permissions screen does: re-resolve the cells so
  // the channels reach the internet now rather than on the next resume. On
  // Android 11 and below the mesh's own permission IS location, so the radios
  // may be waiting on this grant too; elsewhere retryRadios finds nothing to do.
  getMeshService()?.refreshGeoChannels();
  getMeshService()?.retryRadios();
  return true;
}
