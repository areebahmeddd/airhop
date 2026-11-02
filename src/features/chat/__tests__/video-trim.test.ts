// The trimmer's range rules, as a thumb would push against them.

import {
  initialTrim,
  MIN_TRIM_MS,
  slideTrim,
  trimEndTo,
  trimStartTo,
} from "../video-trim";

const FIVE_MINUTES = 300_000;

describe("initialTrim", () => {
  test("a short clip starts whole", () => {
    expect(initialTrim(12_000)).toEqual({ startMs: 0, endMs: 12_000 });
  });

  test("a long video starts at its first minute", () => {
    expect(initialTrim(FIVE_MINUTES)).toEqual({ startMs: 0, endMs: 60_000 });
  });
});

describe("trimStartTo", () => {
  const range = { startMs: 10_000, endMs: 40_000 };

  test("moves within the range", () => {
    expect(trimStartTo(range, 15_000)).toEqual({
      startMs: 15_000,
      endMs: 40_000,
    });
  });

  test("stops a second short of the end", () => {
    expect(trimStartTo(range, 39_900).startMs).toBe(40_000 - MIN_TRIM_MS);
  });

  test("stops at the video's start", () => {
    expect(trimStartTo(range, -5_000).startMs).toBe(0);
  });

  test("never opens the window past a minute", () => {
    const late = { startMs: 200_000, endMs: 250_000 };
    expect(trimStartTo(late, 100_000).startMs).toBe(190_000);
  });
});

describe("trimEndTo", () => {
  const range = { startMs: 10_000, endMs: 40_000 };

  test("stops a second after the start", () => {
    expect(trimEndTo(range, 10_200, FIVE_MINUTES).endMs).toBe(
      10_000 + MIN_TRIM_MS,
    );
  });

  test("stops at the video's end", () => {
    expect(trimEndTo(range, 50_000, 45_000).endMs).toBe(45_000);
  });

  test("never opens the window past a minute", () => {
    expect(trimEndTo(range, 200_000, FIVE_MINUTES).endMs).toBe(70_000);
  });
});

describe("slideTrim", () => {
  const range = { startMs: 0, endMs: 60_000 };

  test("keeps the length as it moves", () => {
    expect(slideTrim(range, 120_000, FIVE_MINUTES)).toEqual({
      startMs: 120_000,
      endMs: 180_000,
    });
  });

  test("stops at either end of the video", () => {
    expect(slideTrim(range, -1_000, FIVE_MINUTES).startMs).toBe(0);
    expect(slideTrim(range, 290_000, FIVE_MINUTES)).toEqual({
      startMs: 240_000,
      endMs: 300_000,
    });
  });
});
