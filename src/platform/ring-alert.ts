// The phone's own ring: a ringtone and vibration loop, for the Ring alert.
//
// Android only. The foreground service holds the process up, so
// AirhopAppModule can loop the default ringtone the way the telecom stack
// does for a call. iOS has no such path outside CallKit, which is for calls;
// there a ring is the notification chain in notification-service.ts, and
// this module answers false so the caller falls back to haptics. Ringer mode
// and Do Not Disturb are honoured natively, and a loop that could not start
// for either reason also answers false.

import NativeAirhopApp from "@bridge/NativeAirhopApp";
import { Platform } from "react-native";

// Whether anything audible or tactile started.
export async function startRingAlert(durationMs: number): Promise<boolean> {
  if (Platform.OS !== "android" || NativeAirhopApp === null) return false;
  try {
    return await NativeAirhopApp.startRingAlert(durationMs);
  } catch {
    return false;
  }
}

// Safe when nothing is ringing, and on iOS, where there is nothing to stop.
export async function stopRingAlert(): Promise<void> {
  if (Platform.OS !== "android" || NativeAirhopApp === null) return;
  try {
    await NativeAirhopApp.stopRingAlert();
  } catch {
    // Nothing was ringing, or the module is gone with the process.
  }
}
