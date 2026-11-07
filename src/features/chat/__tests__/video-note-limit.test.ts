// A video note that stops on its own is sent only when it stopped at a limit;
// an interruption short of both is a discard, not a "Time's up".

import { MAX_FILE_BYTES, MAX_VIDEO_SECONDS } from "@core/mesh/wire/file-packet";
import { PROGRESS_INTERVAL_S, videoNoteAtLimit } from "../video-note-limit";

const FULL_MS = MAX_VIDEO_SECONDS * 1000;
const INTERVAL_MS = PROGRESS_INTERVAL_S * 1000;

describe("videoNoteAtLimit", () => {
  test("the ring closing on time is the limit", () => {
    expect(
      videoNoteAtLimit(FULL_MS, { durationS: 14.9, sizeBytes: 600_000 }),
    ).toBe(true);
  });

  test("within one progress interval of the time limit still counts", () => {
    expect(videoNoteAtLimit(FULL_MS - INTERVAL_MS, null)).toBe(true);
  });

  test("a call taking the camera halfway is not the limit", () => {
    expect(
      videoNoteAtLimit(FULL_MS / 2, { durationS: 7.4, sizeBytes: 300_000 }),
    ).toBe(false);
  });

  test("no progress report at all, short of the time, is not the limit", () => {
    expect(videoNoteAtLimit(2_000, null)).toBe(false);
  });

  test("a file stopped at the size ceiling is the limit", () => {
    // About 100 KiB a second, so the last report trails the stop by ~10 KiB.
    const rate = 100 * 1024;
    const durationS = MAX_FILE_BYTES / rate - PROGRESS_INTERVAL_S / 2;
    expect(
      videoNoteAtLimit(durationS * 1000, {
        durationS,
        sizeBytes: Math.round(durationS * rate),
      }),
    ).toBe(true);
  });

  test("a large file still a few reports short of the ceiling is not", () => {
    const rate = 100 * 1024;
    const durationS = MAX_FILE_BYTES / rate - 5 * PROGRESS_INTERVAL_S;
    expect(
      videoNoteAtLimit(durationS * 1000, {
        durationS,
        sizeBytes: Math.round(durationS * rate),
      }),
    ).toBe(false);
  });

  test("a zero-length report does not divide by zero into a limit", () => {
    expect(videoNoteAtLimit(500, { durationS: 0, sizeBytes: 0 })).toBe(false);
  });
});
