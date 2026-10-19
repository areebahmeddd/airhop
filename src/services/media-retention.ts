// When the attachment retention sweep runs.
//
// Once at launch, and again on a return to the app once SWEEP_INTERVAL_MS has
// passed. The launch alone is not enough: on Android the foreground service can
// keep one process alive for weeks, receiving media the whole time, and a
// window of days would then be enforced only as often as the phone restarts.
//
// Wrapped because the cache directory may be unreadable on a device with no
// storage left, and a failed sweep must not stop the app from opening.
//
// The window is read at each sweep rather than subscribed to. Shortening it in
// General sweeps at once (sweepMediaNow): someone choosing a week because the
// phone itself is the risk should not keep a month of media for up to another
// half day. Lengthening it cannot bring anything back, since the files are already
// gone.

import { useSettingsStore } from "@store/settings-store";
import { sweepExpiredAttachments } from "./file-transfer-service";

// Keeps any file within half a day of its deadline, against a shortest window
// of a week. More often would repeat a directory listing on every app switch
// for nothing.
export const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

let lastSweepAtMs: number | null = null;

// Returns whether a sweep ran, for tests.
export function sweepMediaIfDue(nowMs: number = Date.now()): boolean {
  // A clock moved backwards counts as due, not as years of waiting.
  if (
    lastSweepAtMs !== null &&
    nowMs >= lastSweepAtMs &&
    nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS
  ) {
    return false;
  }
  lastSweepAtMs = nowMs;
  try {
    const days = useSettingsStore.getState().mediaRetentionDays;
    sweepExpiredAttachments(nowMs, days * DAY_MS);
  } catch {
    // Unreadable cache directory. Retried on the next due sweep.
  }
  return true;
}

// Sweep now, whatever the throttle says, for a window that just got shorter.
// Restarts the interval, since this is a full sweep like any other.
export function sweepMediaNow(nowMs: number = Date.now()): void {
  lastSweepAtMs = null;
  sweepMediaIfDue(nowMs);
}
