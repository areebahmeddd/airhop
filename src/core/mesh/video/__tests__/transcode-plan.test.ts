// The transcode plan, case for case against bitchat-ios's VideoTranscoder.plan
// (its VideoTranscoderTests, then the same formula worked by hand), and the
// Airhop budget above it.

import {
  MAX_BITCHAT_VIDEO_BYTES,
  MAX_FILE_BYTES,
} from "../../wire/file-packet";
import {
  initialTranscodeBits,
  planTranscode,
  retryTranscodeBits,
  type TranscodeSource,
} from "../transcode-plan";

const BITCHAT_BITS = initialTranscodeBits(MAX_BITCHAT_VIDEO_BYTES);
const AIRHOP_BITS = initialTranscodeBits(MAX_FILE_BYTES);

function source(
  durationMs: number,
  width = 1080,
  height = 1920,
  hasAudio = true,
): TranscodeSource {
  return { durationMs, width, height, hasAudio };
}

describe("planTranscode at bitchat's budget", () => {
  test("the first pass spends 100 KiB less 8%", () => {
    expect(BITCHAT_BITS).toBeCloseTo(753_664, 6);
  });

  test("10 s portrait: sound, a 320 long edge, 15 fps (bitchat-ios)", () => {
    const plan = planTranscode(
      source(10_000),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(plan).toEqual({
      startMs: 0,
      keepMs: 10_000,
      width: 176,
      height: 320,
      fps: 15,
      videoBitrate: 63_366,
      audioBitrate: 12_000,
      keyframeIntervalSeconds: 3,
    });
  });

  test("60 s landscape: silent, a 192 long edge, 6 fps (bitchat-ios)", () => {
    const plan = planTranscode(
      source(60_000, 1920, 1080),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(plan.audioBitrate).toBe(0);
    expect([plan.width, plan.height]).toEqual([192, 112]);
    expect(plan.fps).toBe(6);
    expect(plan.videoBitrate).toBe(12_561);
  });

  test.each([
    [3_000, 176, 320, 24, 239_221, 12_000],
    [15_000, 112, 192, 10, 38_244, 12_000],
    [60_000, 112, 192, 6, 12_561, 0],
  ])(
    "%i ms portrait plans %ix%i at %i fps",
    (durationMs, width, height, fps, videoBitrate, audioBitrate) => {
      const plan = planTranscode(
        source(durationMs),
        BITCHAT_BITS,
        MAX_BITCHAT_VIDEO_BYTES,
      );
      expect(plan).toMatchObject({
        width,
        height,
        fps,
        videoBitrate,
        audioBitrate,
      });
    },
  );

  test("only the first minute of a long source is kept", () => {
    const tenMinutes = planTranscode(
      source(600_000),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(tenMinutes).toEqual(
      planTranscode(source(60_000), BITCHAT_BITS, MAX_BITCHAT_VIDEO_BYTES),
    );
    expect(tenMinutes.keepMs).toBe(60_000);
  });

  test("a short or unknown length plans as bitchat-ios does", () => {
    expect(
      planTranscode(source(200), BITCHAT_BITS, MAX_BITCHAT_VIDEO_BYTES).keepMs,
    ).toBe(500);
    for (const unknown of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        planTranscode(source(unknown), BITCHAT_BITS, MAX_BITCHAT_VIDEO_BYTES)
          .keepMs,
      ).toBe(60_000);
    }
  });

  test("never past bitchat-ios's 320 edge, however short", () => {
    const plan = planTranscode(
      source(500),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(plan.videoBitrate).toBe(600_000);
    expect(Math.max(plan.width, plan.height)).toBe(320);
  });

  test("a silent source spends everything on the picture", () => {
    const plan = planTranscode(
      source(10_000, 1080, 1920, false),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(plan.audioBitrate).toBe(0);
    expect(plan.videoBitrate).toBe(75_366);
  });

  test("sound needs 30 kbps in all", () => {
    // 753,664 bits over 25.1 s is 30,026 bps; over 25.2 s it is 29,907.
    const kept = planTranscode(
      source(25_100),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    const dropped = planTranscode(
      source(25_200),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(kept.audioBitrate).toBe(12_000);
    expect(dropped.audioBitrate).toBe(0);
  });

  test("the shape is kept in 16-pixel blocks, never under 64", () => {
    const square = planTranscode(
      source(10_000, 720, 720),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect([square.width, square.height]).toEqual([320, 320]);
    const fourThree = planTranscode(
      source(10_000, 640, 480),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect([fourThree.width, fourThree.height]).toEqual([320, 240]);
    const sliver = planTranscode(
      source(10_000, 4000, 100),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect([sliver.width, sliver.height]).toEqual([320, 64]);
  });

  test("the bitrate never drops under the floor", () => {
    const plan = planTranscode(
      source(60_000),
      100_000,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(plan.videoBitrate).toBe(6_000);
  });
});

describe("planTranscode with a trimmed range", () => {
  test("spends the budget on the chosen part, from where it starts", () => {
    const plan = planTranscode(
      source(300_000),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
      { startMs: 120_000, endMs: 130_000 },
    );
    expect(plan).toEqual({
      ...planTranscode(source(10_000), BITCHAT_BITS, MAX_BITCHAT_VIDEO_BYTES),
      startMs: 120_000,
    });
  });

  test("a range longer than a minute still keeps one", () => {
    const plan = planTranscode(
      source(300_000),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
      { startMs: 0, endMs: 90_000 },
    );
    expect(plan.keepMs).toBe(60_000);
  });
});

describe("planTranscode for another Airhop phone", () => {
  test("a short clip may use the 480 step", () => {
    const plan = planTranscode(source(15_000), AIRHOP_BITS, MAX_FILE_BYTES);
    expect([plan.width, plan.height]).toEqual([272, 480]);
    expect(plan.fps).toBe(24);
    expect(plan.audioBitrate).toBe(12_000);
  });

  test("a minute stays at 320 with sound", () => {
    const plan = planTranscode(source(60_000), AIRHOP_BITS, MAX_FILE_BYTES);
    expect([plan.width, plan.height]).toEqual([176, 320]);
    expect(plan.fps).toBe(15);
    expect(plan.audioBitrate).toBe(12_000);
  });
});

describe("retryTranscodeBits", () => {
  test("scales by the overshoot, then 10% under", () => {
    expect(retryTranscodeBits(BITCHAT_BITS, 102_400, 128_000)).toBeCloseTo(
      ((BITCHAT_BITS * 102_400) / 128_000) * 0.9,
      6,
    );
  });

  test("the retry's plan is smaller than the first", () => {
    const first = planTranscode(
      source(10_000),
      BITCHAT_BITS,
      MAX_BITCHAT_VIDEO_BYTES,
    );
    const retry = planTranscode(
      source(10_000),
      retryTranscodeBits(BITCHAT_BITS, MAX_BITCHAT_VIDEO_BYTES, 140_000),
      MAX_BITCHAT_VIDEO_BYTES,
    );
    expect(retry.videoBitrate).toBeLessThan(first.videoBitrate);
  });
});
