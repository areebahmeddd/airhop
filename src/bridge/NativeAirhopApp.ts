// The native contract for process-level operations that belong to no radio.
//
// Hand-maintained, not Codegen input. See NativeAirhopBLE.ts for why.
//
// Backed by AirhopAppModule.kt, and Android only for a reason rather than for
// now: iOS gives an app no supported way to relaunch itself, and `exit()` there
// is grounds for rejection, and the native modules there write no log to read.
// Callers optional-chain and fall back to asking, or to a report without one.
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  // Relaunch into a fresh process. Settles just before the current one ends, so
  // nothing after the call runs. Foreground only: from API 29 Android forbids a
  // background activity start.
  //
  //   NO_LAUNCH_INTENT  no launcher activity in this build
  //   RESTART_FAILED    the platform refused the start
  //
  // Both leave the app running, so a caller that cannot restart says so instead.
  restart(): Promise<void>;
  // This process's recent logcat, filtered to Airhop's own tags and the crash
  // reporter, oldest first. Empty on a device that refuses logcat, which is a
  // report with no log section rather than a failure.
  recentLog(): Promise<string>;
}

// `get`, not `getEnforcing`: absent on iOS, and a missing module is an answer
// rather than a crash.
export default TurboModuleRegistry.get<Spec>("AirhopApp");
