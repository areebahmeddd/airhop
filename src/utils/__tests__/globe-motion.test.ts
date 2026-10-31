// The detail levels and the governor that picks between them, ported from
// bitchat-ios's GlobePickerTests with its thresholds.

import {
  DETAIL_BALANCED,
  DETAIL_FAST,
  DETAIL_FULL,
  beginSession,
  detailFrame,
  endSession,
  makeGovernor,
  nextDetail,
  recordFrame,
  type Governor,
  type MotionDetail,
} from "../globe-motion";

function record(g: Governor, frames: number, millis: number): MotionDetail[] {
  const seen: MotionDetail[] = [];
  for (let i = 0; i < frames; i++) {
    recordFrame(g, millis);
    seen.push(g.detail);
  }
  return seen;
}

describe("detail frames", () => {
  it("draws everything at full detail", () => {
    const f = detailFrame(DETAIL_FULL);
    expect(f.landPointStride).toBe(1);
    expect(f.showBorders).toBe(true);
    expect(f.showCityLabels).toBe(true);
  });

  it("keeps borders but not labels when balanced", () => {
    const f = detailFrame(DETAIL_BALANCED);
    expect(f.landPointStride).toBe(2);
    expect(f.showBorders).toBe(true);
    expect(f.showCityLabels).toBe(false);
  });

  it("sheds borders and labels when fast", () => {
    const f = detailFrame(DETAIL_FAST);
    expect(f.landPointStride).toBe(2);
    expect(f.showBorders).toBe(false);
    expect(f.showCityLabels).toBe(false);
  });

  it("degrades on slow frames and recovers with hysteresis", () => {
    expect(nextDetail(DETAIL_FULL, 24)).toBe(DETAIL_BALANCED);
    expect(nextDetail(DETAIL_BALANCED, 32)).toBe(DETAIL_FAST);
    expect(nextDetail(DETAIL_FAST, 17)).toBe(DETAIL_BALANCED);
    expect(nextDetail(DETAIL_BALANCED, 17)).toBe(DETAIL_FULL);
    expect(nextDetail(DETAIL_BALANCED, 20)).toBe(DETAIL_BALANCED);
    expect(nextDetail(DETAIL_FULL, NaN)).toBe(DETAIL_FAST);
  });
});

describe("governor", () => {
  // Shedding detail makes frames fast, and stepping back up mid-drag made the
  // grid and labels flash on and off.
  it("never steps detail back up within one motion", () => {
    const g = makeGovernor();
    expect(g.detail).toBe(DETAIL_FULL);
    beginSession(g);
    expect(g.detail).toBe(DETAIL_BALANCED);
    const seen = [
      ...record(g, 8, 33),
      ...record(g, 64, 8),
      ...record(g, 8, 33),
      ...record(g, 64, 8),
    ];
    expect(seen).toContain(DETAIL_FAST);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    }
    endSession(g);
    expect(g.detail).toBe(DETAIL_FULL);
  });

  it("starts higher after smooth sessions until one degrades", () => {
    const g = makeGovernor();
    beginSession(g);
    record(g, 16, 8);
    endSession(g);
    beginSession(g);
    expect(g.detail).toBe(DETAIL_FULL);
    record(g, 8, 26);
    expect(g.detail).toBe(DETAIL_BALANCED);
    endSession(g);
    // Having failed once, smooth sessions stop retrying, so detail does not
    // alternate from one gesture to the next.
    for (let i = 0; i < 3; i++) {
      beginSession(g);
      expect(g.detail).toBe(DETAIL_BALANCED);
      record(g, 16, 8);
      endSession(g);
    }
  });

  it("ignores frames outside a session", () => {
    const g = makeGovernor();
    record(g, 16, 40);
    expect(g.detail).toBe(DETAIL_FULL);
  });
});
