// Mirrors the boot-start preference down to native. Its own module rather than
// part of boot-start.ts, which imports mesh-service.ts and so loads the native
// BLE TurboModule (getEnforcing) at module scope: panic-wipe.ts and the settings
// screens must not drag that chain in, and panic-wipe's own test has no native
// bridge.

import NativeAirhopApp from "@bridge/NativeAirhopApp";

// Writes the flag AirhopBootReceiver reads. No-op on iOS: there is no boot
// receiver to sync with, and AirhopApp rejects the call there.
export function syncAutoStartOnBoot(enabled: boolean): void {
  void NativeAirhopApp?.setAutoStartOnBoot(enabled).catch(() => {
    // Best effort; the next toggle or launch resyncs it.
  });
}

// The effective value: auto-start with background running off would boot the
// app to do nothing. The user's own choice is kept for when it is back on.
export function syncBootStart(settings: {
  autoStartOnBoot: boolean;
  backgroundMeshEnabled: boolean;
}): void {
  syncAutoStartOnBoot(
    settings.autoStartOnBoot && settings.backgroundMeshEnabled,
  );
}
