// Whether a video note that stopped on its own stopped at its limit, which
// sends it (the ring closed), or because something took the camera, which
// discards it. Reading every undecided stop as the limit would send a half
// note with a "Time's up" toast.

import { MAX_FILE_BYTES, MAX_VIDEO_SECONDS } from "@core/mesh/wire/file-packet";

// How often the recorder reports progress. Fine enough for a smooth ring.
export const PROGRESS_INTERVAL_S = 0.1;

export interface RecordingProgress {
  durationS: number;
  sizeBytes: number;
}

// The recorder ends itself at whichever of MAX_VIDEO_SECONDS and
// MAX_FILE_BYTES comes first. `elapsedMs` is wall time from before the
// recorder started, so it can only overstate the clip and needs no slack
// beyond the one interval a report can trail by. The size is the last
// progress report, which trails the stop by up to one interval of growth, so
// it is allowed that much short.
export function videoNoteAtLimit(
  elapsedMs: number,
  lastProgress: RecordingProgress | null,
): boolean {
  if (elapsedMs >= (MAX_VIDEO_SECONDS - PROGRESS_INTERVAL_S) * 1000) {
    return true;
  }
  if (lastProgress === null || lastProgress.durationS <= 0) return false;
  const bytesPerInterval =
    (lastProgress.sizeBytes / lastProgress.durationS) * PROGRESS_INTERVAL_S;
  return lastProgress.sizeBytes >= MAX_FILE_BYTES - bytesPerInterval;
}
