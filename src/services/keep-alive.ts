// The JS side of the keep-alive task AirhopBLEModule holds while the Android
// background service runs. React Native pauses JS timers once no Activity is
// resumed unless a headless task is active, and the mesh runs on timers, so
// native starts this task with the service and finishes it when the service
// stops. The promise never settles on its own for that reason.

import { AppRegistry, Platform } from "react-native";

// Must match KEEP_ALIVE_TASK in AirhopBLEModule.kt.
const TASK_KEY = "Airhop.KeepAlive";

export function registerKeepAliveTask(): void {
  if (Platform.OS !== "android") return;
  AppRegistry.registerHeadlessTask(
    TASK_KEY,
    () => () => new Promise<void>(() => {}),
  );
}
