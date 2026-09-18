// The native contract for process-level operations that belong to no radio.
//
// Hand-maintained, not Codegen input. See NativeAirhopBLE.ts for why.
//
// Backed by AirhopAppModule.kt (Android) and AirhopAppModule.swift (iOS).
// restart and setAutoStartOnBoot reject immediately on iOS: no supported
// relaunch path, no boot receiver. recentLog runs on both.
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  // Relaunch into a fresh process. Settles just before the current one ends, so
  // nothing after the call runs. Foreground only: from API 29 Android forbids a
  // background activity start.
  //
  //   NO_LAUNCH_INTENT  no launcher activity in this build (Android)
  //   RESTART_FAILED    the platform refused the start (Android)
  //   UNSUPPORTED       iOS has no supported way to relaunch itself
  //
  // Always leaves the app running, so a caller that cannot restart says so
  // instead.
  restart(): Promise<void>;
  // This process's recent log, filtered to Airhop's own modules: logcat on
  // Android (plus the crash reporter tag), the unified log store on iOS.
  // Oldest first. Empty on a device that refuses it: a report with no log
  // section, not a failure.
  recentLog(): Promise<string>;
  // The native flag AirhopBootReceiver reads with no JS runtime up. Rejects on
  // iOS: no boot receiver to sync with.
  setAutoStartOnBoot(enabled: boolean): Promise<void>;
}

// `get`, not `getEnforcing`: a missing module is an answer, not a crash.
export default TurboModuleRegistry.get<Spec>("AirhopApp");
