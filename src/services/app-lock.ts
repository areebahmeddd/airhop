// The app lock: the phone's own screen lock in front of Airhop. Decisions live
// here, state in store/app-lock-store; ARCHITECTURE.md "App lock" has the why.
//
//   * Never armed without a screen lock, which would leave nothing to ask.
//   * Opens, and turns itself off, if the screen lock is removed: that takes
//     the passcode, so the owner did it.

import { t } from "@i18n";
import {
  confirmDeviceOwner,
  isDeviceAuthInFlight,
} from "@platform/device-auth";
import { useAppLockStore, type LockClock } from "@store/app-lock-store";
import { useSettingsStore } from "@store/settings-store";
import { AppState, Platform } from "react-native";

// Wall time keeps counting while the phone sleeps, which the monotonic clock
// does not on iOS; the monotonic clock cannot be wound back from Settings,
// which wall time can. Away is the larger of the two, and either running
// backwards counts as the delay passed.
function systemClock(): LockClock {
  return { wallMs: Date.now(), monoMs: performance.now() };
}

export function awayMs(from: LockClock, to: LockClock): number {
  const wall = to.wallMs - from.wallMs;
  const mono = to.monoMs - from.monoMs;
  if (wall < 0 || mono < 0) return Number.POSITIVE_INFINITY;
  return Math.max(wall, mono);
}

// Whether a prompt on screen explains the app reading as away. Only Android's
// pauses the activity, which arrives as "background"; iOS's leaves the app
// "inactive". A background on iOS is the user leaving even mid-prompt, and
// leaving during another prompt (the recovery phrase's) must still lock.
function promptPausedApp(): boolean {
  return Platform.OS === "android" && isDeviceAuthInFlight();
}

function engage(): void {
  useAppLockStore.setState((s) => ({
    phase: "locked",
    generation: s.generation + 1,
    authenticating: false,
    coveredAt: null,
  }));
}

function release(): void {
  useAppLockStore.setState({
    phase: "open",
    authenticating: false,
    coveredAt: null,
  });
}

// The app went to the background (not "inactive": Control Center, the app
// switcher and a permission sheet on iOS leave it on screen).
export function noteBackground(clock: LockClock = systemClock()): void {
  const { appLockEnabled, appLockDelaySeconds } = useSettingsStore.getState();
  // A system prompt pausing the activity is not the user leaving.
  if (!appLockEnabled || promptPausedApp()) return;
  if (useAppLockStore.getState().phase !== "open") return;
  // Locked while away rather than on return, so nothing shows in between.
  if (appLockDelaySeconds === 0) {
    engage();
    return;
  }
  useAppLockStore.setState({ phase: "covered", coveredAt: clock });
}

// Back from the background (see watchAppLock for what counts).
export function noteForeground(clock: LockClock = systemClock()): void {
  if (promptPausedApp()) return;
  const { appLockEnabled, appLockDelaySeconds } = useSettingsStore.getState();
  const lock = useAppLockStore.getState();
  if (!appLockEnabled) {
    if (lock.phase !== "open") release();
    return;
  }
  if (lock.phase === "covered") {
    const away =
      lock.coveredAt === null
        ? Number.POSITIVE_INFINITY
        : awayMs(lock.coveredAt, clock);
    if (away >= appLockDelaySeconds * 1000) engage();
    else release();
    return;
  }
  // Still locked from before: coming back is a fresh reason to ask.
  if (lock.phase === "locked" && !lock.authenticating) engage();
}

// Ask for the screen lock, once per lock. A prompt the user dismissed is
// not asked again until they tap Unlock or come back to the app.
export function promptIfDue(): void {
  const lock = useAppLockStore.getState();
  if (lock.phase !== "locked" || lock.promptedGeneration === lock.generation) {
    return;
  }
  useAppLockStore.setState({ promptedGeneration: lock.generation });
  void requestUnlock();
}

export async function requestUnlock(): Promise<void> {
  const lock = useAppLockStore.getState();
  if (lock.phase !== "locked" || lock.authenticating) return;
  const { generation } = lock;
  useAppLockStore.setState({ authenticating: true });
  const result = await confirmDeviceOwner({
    prompt: t("lock.auth_prompt"),
    cancelLabel: t("common.cancel"),
  });
  // Answered for a lock that has since been replaced.
  if (useAppLockStore.getState().generation !== generation) return;
  if (result === "refused") {
    useAppLockStore.setState({ authenticating: false });
    return;
  }
  if (result === "no-lock") disableAppLock();
  release();
}

// Asks once before arming, so nobody turns on a lock they cannot open.
export async function enableAppLock(): Promise<
  "enabled" | "no-lock" | "refused"
> {
  const result = await confirmDeviceOwner({
    prompt: t("settings.security.app_lock_auth_prompt"),
    cancelLabel: t("common.cancel"),
  });
  if (result !== "passed") return result;
  useSettingsStore.getState().setAppLockEnabled(true);
  return "enabled";
}

export function disableAppLock(): void {
  useSettingsStore.getState().setAppLockEnabled(false);
}

// Follows the app in and out of the background, and stands the lock down when
// it is turned off. Returns the unsubscribe.
//
// Only a real trip to the background is a return. The system prompt takes the
// app away too ("inactive" on iOS, a pause read as "background" on Android),
// and counting that would re-arm the lock as a dismissed prompt closed, and ask
// again, forever.
//
// Android can recreate the Activity, and so this subscription, while the
// process and the lock's state live on. So whether the app is away is seeded
// from that state rather than assumed false: a lock left "covered" or "locked"
// in the background still counts the coming return. Already back when it
// subscribes, a "covered" lock is settled at once, since only noteForeground
// leaves it and the lock face offers no Unlock there; a "locked" one already
// shows Unlock.
export function watchAppLock(): () => void {
  const { phase } = useAppLockStore.getState();
  const active = AppState.currentState === "active";
  let away = phase !== "open" && !active;
  if (active && phase === "covered") noteForeground();
  const appState = AppState.addEventListener("change", (next) => {
    if (next === "background") {
      if (promptPausedApp()) return;
      away = true;
      noteBackground();
    } else if (next === "active" && away) {
      away = false;
      noteForeground();
    }
  });
  const settings = useSettingsStore.subscribe((state, prev) => {
    if (prev.appLockEnabled && !state.appLockEnabled) release();
  });
  return () => {
    appState.remove();
    settings();
  };
}
