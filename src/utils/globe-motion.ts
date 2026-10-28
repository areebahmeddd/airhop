// How much of the globe a moving frame draws, chosen from measured frame time.
//
// A port of bitchat-ios's GlobeMotionDetail and GlobeMotionGovernor, with its
// thresholds. Detail drops while the globe moves on a slow phone and comes
// back once it rests. The selected cell, its neighbours and the city dots are
// never shed: they are cheap next to the land, and making them vanish under a
// finger reads as a rendering bug.
//
// The governor is plain data mutated by worklets, so it can live in a shared
// value on the UI thread.

export const DETAIL_FAST = 0;
export const DETAIL_BALANCED = 1;
export const DETAIL_FULL = 2;
export type MotionDetail =
  typeof DETAIL_FAST | typeof DETAIL_BALANCED | typeof DETAIL_FULL;

export interface DetailFrame {
  graticuleStepDegrees: number;
  // Every nth point of a large land ring.
  landPointStride: number;
  showBorders: boolean;
  showCityLabels: boolean;
}

export function detailFrame(detail: MotionDetail): DetailFrame {
  "worklet";
  if (detail === DETAIL_FULL) {
    return {
      graticuleStepDegrees: 4,
      landPointStride: 1,
      showBorders: true,
      showCityLabels: true,
    };
  }
  if (detail === DETAIL_BALANCED) {
    return {
      graticuleStepDegrees: 8,
      landPointStride: 2,
      showBorders: true,
      showCityLabels: false,
    };
  }
  return {
    graticuleStepDegrees: 10,
    landPointStride: 2,
    showBorders: false,
    showCityLabels: false,
  };
}

// The level a measured frame cadence calls for. The bands overlap, but
// hysteresis alone cannot stop oscillation (shedding detail is what makes
// frames fast again), so the governor only applies downgrades mid-motion.
export function nextDetail(
  detail: MotionDetail,
  averageFrameMillis: number,
): MotionDetail {
  "worklet";
  if (!Number.isFinite(averageFrameMillis)) return DETAIL_FAST;
  if (detail === DETAIL_FULL) {
    if (averageFrameMillis > 34) return DETAIL_FAST;
    if (averageFrameMillis > 22) return DETAIL_BALANCED;
    return DETAIL_FULL;
  }
  if (detail === DETAIL_BALANCED) {
    if (averageFrameMillis > 29) return DETAIL_FAST;
    if (averageFrameMillis < 18.5) return DETAIL_FULL;
    return DETAIL_BALANCED;
  }
  return averageFrameMillis < 22 ? DETAIL_BALANCED : DETAIL_FAST;
}

const FRAME_SAMPLE_COUNT = 8;
const SMOOTH_FRAME_MILLIS = 18.5;
// One stalled frame (a GC, a layout) must not condemn a whole session.
const MAX_SAMPLED_FRAME_MILLIS = 50;

// A motion session runs from touch-down through any fling or animation until
// the globe rests. Within one, detail only steps down: letting it step back up
// made the grid and labels flash under the finger. Between sessions, a smooth
// one lets the next start a level higher, until any session has had to shed.
export interface Governor {
  detail: MotionDetail;
  active: boolean;
  startDetail: MotionDetail;
  ceilingFound: boolean;
  sessionDegraded: boolean;
  windowMillis: number;
  windowCount: number;
  sessionMillis: number;
  sessionCount: number;
}

export function makeGovernor(): Governor {
  "worklet";
  return {
    detail: DETAIL_FULL,
    active: false,
    startDetail: DETAIL_BALANCED,
    ceilingFound: false,
    sessionDegraded: false,
    windowMillis: 0,
    windowCount: 0,
    sessionMillis: 0,
    sessionCount: 0,
  };
}

export function beginSession(g: Governor): void {
  "worklet";
  if (g.active) return;
  g.active = true;
  g.sessionDegraded = false;
  g.windowMillis = 0;
  g.windowCount = 0;
  g.sessionMillis = 0;
  g.sessionCount = 0;
  g.detail = g.startDetail;
}

export function recordFrame(g: Governor, millis: number): void {
  "worklet";
  if (!g.active) return;
  const frame = Math.min(Math.max(millis, 1), MAX_SAMPLED_FRAME_MILLIS);
  g.windowMillis += frame;
  g.windowCount += 1;
  g.sessionMillis += frame;
  g.sessionCount += 1;
  if (g.windowCount < FRAME_SAMPLE_COUNT) return;
  const wanted = nextDetail(g.detail, g.windowMillis / g.windowCount);
  if (wanted < g.detail) {
    g.detail = wanted;
    g.sessionDegraded = true;
  }
  g.windowMillis = 0;
  g.windowCount = 0;
}

// Back to full detail at rest, remembering where the next session starts.
export function endSession(g: Governor): void {
  "worklet";
  if (!g.active) return;
  g.active = false;
  if (g.sessionDegraded) {
    g.ceilingFound = true;
    g.startDetail = g.detail;
  } else if (
    !g.ceilingFound &&
    g.sessionCount >= FRAME_SAMPLE_COUNT &&
    g.sessionMillis / g.sessionCount < SMOOTH_FRAME_MILLIS
  ) {
    g.startDetail = g.detail === DETAIL_FAST ? DETAIL_BALANCED : DETAIL_FULL;
  }
  g.detail = DETAIL_FULL;
}
