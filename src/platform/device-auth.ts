// Asks the OS to confirm the owner: Face ID, Touch ID, fingerprint or passcode.
//
// A gate on an action, not on a key: the identity must stay readable after
// first unlock so iOS can relaunch into the mesh on a Bluetooth event.

import * as LocalAuthentication from "expo-local-authentication";

export type DeviceAuthResult =
  | "passed"
  // Dismissed, or locked out.
  | "refused"
  // No screen lock, so no owner to ask. The caller decides.
  | "no-lock";

// Prompts on screen. On Android one can pause the activity, which reads as
// backgrounding; the app lock checks this so a prompt is not taken for leaving.
let promptsInFlight = 0;

export function isDeviceAuthInFlight(): boolean {
  return promptsInFlight > 0;
}

export async function confirmDeviceOwner(params: {
  prompt: string;
  cancelLabel: string;
}): Promise<DeviceAuthResult> {
  let level: LocalAuthentication.SecurityLevel;
  try {
    level = await LocalAuthentication.getEnrolledLevelAsync();
  } catch {
    return "refused";
  }
  if (level === LocalAuthentication.SecurityLevel.NONE) return "no-lock";
  promptsInFlight += 1;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: params.prompt,
      cancelLabel: params.cancelLabel,
      // The passcode proves the owner as well as a face does.
      disableDeviceFallback: false,
    });
    if (result.success) return "passed";
    return result.error === "not_enrolled" ||
      result.error === "passcode_not_set"
      ? "no-lock"
      : "refused";
  } catch {
    return "refused";
  } finally {
    promptsInFlight -= 1;
  }
}
