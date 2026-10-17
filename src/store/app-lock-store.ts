// Whether the app lock is engaged right now. Never persisted: being on is a
// setting, being engaged is decided per launch. Decisions: services/app-lock.

import { create } from "zustand";
import { useSettingsStore } from "./settings-store";

export type AppLockPhase =
  // Nothing in the way.
  | "open"
  // Backgrounded with a delay set: covered so nothing shows early, and the
  // delay decides on return whether to ask.
  | "covered"
  // Asks for the phone's own screen lock before anything shows.
  | "locked";

// Both clocks, read together; see awayMs in services/app-lock.
export interface LockClock {
  wallMs: number;
  monoMs: number;
}

interface AppLockState {
  phase: AppLockPhase;
  // Bumped per lock and per return, so a stale answer cannot open a newer lock
  // and each gets one automatic prompt.
  generation: number;
  promptedGeneration: number;
  authenticating: boolean;
  coveredAt: LockClock | null;
}

export const useAppLockStore = create<AppLockState>()(() => ({
  // Locked from the first frame: a lock that engaged only on returning from
  // the background would leave a cold start wide open.
  phase: useSettingsStore.getState().appLockEnabled ? "locked" : "open",
  generation: 1,
  promptedGeneration: 0,
  authenticating: false,
  coveredAt: null,
}));

// Whether a person could be reading the screen, which the lock rules out.
export function selectLockOpen(state: AppLockState): boolean {
  return state.phase === "open";
}

// Modals stand down while the lock asks: each is its own window, which the lock
// screen in the app root cannot cover.
export function selectLockedOut(state: AppLockState): boolean {
  return state.phase === "locked";
}
