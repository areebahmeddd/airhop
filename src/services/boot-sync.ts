// Split from boot-start.ts: that file imports mesh-service.ts, which loads
// the native BLE TurboModule (getEnforcing) at module scope. panic-wipe.ts
// and the settings screens only need to mirror one native preference and
// must not drag that chain in - panic-wipe's own test has no native bridge.

import NativeAirhopApp from "@bridge/NativeAirhopApp";

// Writes the flag AirhopBootReceiver reads. No-op on iOS: there is no boot
// receiver to sync with, and AirhopApp rejects the call there.
export function syncAutoStartOnBoot(enabled: boolean): void {
  void NativeAirhopApp?.setAutoStartOnBoot(enabled).catch(() => {
    // Best effort; the next toggle or launch resyncs it.
  });
}
