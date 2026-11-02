// The rules a trim range obeys while its handles move: inside the video, at
// least a second long, and never longer than the minute a send keeps. Worklets,
// since the trimmer's gestures apply them on the UI thread every frame.

import {
  MAX_TRANSCODE_SOURCE_MS,
  type TranscodeRange,
} from "@core/mesh/video/transcode-plan";

// Shorter than this is a slip, not a clip, and leaves no room between handles.
export const MIN_TRIM_MS = 1_000;

// Above its callers: the worklet transform turns a declaration into a binding,
// which is not hoisted.
function clamp(value: number, min: number, max: number): number {
  "worklet";
  return Math.min(Math.max(value, min), max);
}

// Where a picked video starts out: all of it, or its first minute.
export function initialTrim(durationMs: number): TranscodeRange {
  return { startMs: 0, endMs: Math.min(durationMs, MAX_TRANSCODE_SOURCE_MS) };
}

// The start handle, held between the minute before the end and a second
// before it.
export function trimStartTo(
  range: TranscodeRange,
  startMs: number,
): TranscodeRange {
  "worklet";
  const min = Math.max(0, range.endMs - MAX_TRANSCODE_SOURCE_MS);
  const max = range.endMs - MIN_TRIM_MS;
  return { startMs: clamp(startMs, min, max), endMs: range.endMs };
}

export function trimEndTo(
  range: TranscodeRange,
  endMs: number,
  durationMs: number,
): TranscodeRange {
  "worklet";
  const min = range.startMs + MIN_TRIM_MS;
  const max = Math.min(durationMs, range.startMs + MAX_TRANSCODE_SOURCE_MS);
  return { startMs: range.startMs, endMs: clamp(endMs, min, max) };
}

// The whole window, dragged along the video at its current length.
export function slideTrim(
  range: TranscodeRange,
  startMs: number,
  durationMs: number,
): TranscodeRange {
  "worklet";
  const length = range.endMs - range.startMs;
  const start = clamp(startMs, 0, durationMs - length);
  return { startMs: start, endMs: start + length };
}
