// The globe picker's runtime on the UI thread: the camera, the frame clock
// that drives flights and flings, the detail governor, and the touch handler.
//
// The rules (what a drag does, how far a fling goes, which cell is selected)
// live in src/utils/globe-camera.ts and are tested there; this module only
// sequences them, the way bitchat-ios's GlobeState and GlobeTouchSurface do.
// It all runs in worklets so a busy JS thread (Noise handshakes, a relay
// backlog) cannot stutter the globe under a finger.
//
// The clock is the UI runtime's requestAnimationFrame, run only while
// something moves, and a frame republishes the camera only when a flight or
// fling stepped it: a finger resting on the globe redraws nothing.
//
// State is mutated in place on the UI runtime and published with a bare
// `modify()`, which notifies the renderer without copying the object. A
// callback handed to `modify` would be a worklet of its own, and a worklet
// captures by copy: an outer variable it assigns would never change.

import {
  FLY_IN_MS,
  focusTween,
  globeRadius,
  introTween,
  makeCamera,
  makeFling,
  precisionTween,
  rotateBy,
  setViewport,
  stepFling,
  stepTween,
  zoomBy,
  type Camera,
  type Fling,
  type StartTarget,
  type Tween,
} from "@utils/globe-camera";
import { BASE_RADIUS_FRACTION, unproject } from "@utils/globe-math";
import {
  beginSession,
  DETAIL_FULL,
  detailFrame,
  endSession,
  makeGovernor,
  recordFrame,
  type DetailFrame,
  type Governor,
} from "@utils/globe-motion";
import type { GestureTouchEvent } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";

export interface GlobeEngine {
  camera: Camera;
  tween: Tween | null;
  fling: Fling | null;
  interacting: boolean;
  running: boolean;
  lastTick: number;
  governor: Governor;
  width: number;
  height: number;
  // The opening flight, until the first layout consumes it.
  intro: StartTarget | null;
  // Reduce motion: flights land at once and a release does not spin on.
  still: boolean;
}

export function makeEngine(target: StartTarget, still: boolean): GlobeEngine {
  "worklet";
  return {
    camera: makeCamera(target, !still),
    tween: null,
    fling: null,
    interacting: false,
    running: false,
    lastTick: -1,
    governor: makeGovernor(),
    width: 0,
    height: 0,
    intro: target,
    still,
  };
}

function inMotion(g: GlobeEngine): boolean {
  "worklet";
  return g.interacting || g.tween !== null || g.fling !== null;
}

// What the next frame draws: shed detail while moving, everything at rest.
export function frameDetail(g: GlobeEngine): DetailFrame {
  "worklet";
  return detailFrame(inMotion(g) ? g.governor.detail : DETAIL_FULL);
}

// One display frame. Returns whether another is wanted.
function advance(g: GlobeEngine, now: number): boolean {
  "worklet";
  const previous = g.lastTick;
  g.lastTick = now;
  if (g.tween !== null) {
    if (stepTween(g.camera, g.tween, now)) g.tween = null;
  } else if (g.fling !== null) {
    const dt = previous < 0 ? 0 : now - previous;
    if (!stepFling(g.camera, g.fling, dt)) g.fling = null;
  }
  if (previous >= 0 && inMotion(g)) recordFrame(g.governor, now - previous);
  if (inMotion(g)) return true;
  endSession(g.governor);
  g.running = false;
  g.lastTick = -1;
  return false;
}

// Starts the governor's session and the clock when the globe starts moving,
// and ends the session once both the finger and any animation are done.
function motionChanged(engine: SharedValue<GlobeEngine>): void {
  "worklet";
  const g = engine.value;
  if (!inMotion(g)) {
    endSession(g.governor);
    return;
  }
  beginSession(g.governor);
  if (g.running) return;
  g.running = true;
  g.lastTick = -1;
  const frame = (now: number) => {
    const e = engine.value;
    const stepped = e.tween !== null || e.fling !== null;
    const detail = e.governor.detail;
    const again = advance(e, now);
    // A shed detail level is a redraw too, and so is coming to rest.
    if (stepped || !again || e.governor.detail !== detail) engine.modify();
    if (again) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function start(engine: SharedValue<GlobeEngine>, tween: Tween | null): void {
  "worklet";
  if (tween === null) return;
  const g = engine.value;
  // Reduce motion lands the move on the next frame instead of flying it.
  if (g.still) tween.durationMs = 0;
  g.fling = null;
  g.tween = tween;
  engine.modify();
  motionChanged(engine);
}

export function layout(
  engine: SharedValue<GlobeEngine>,
  width: number,
  height: number,
): void {
  "worklet";
  const g = engine.value;
  const screenMin = Math.min(width, height);
  g.width = width;
  g.height = height;
  const first = setViewport(
    g.camera,
    screenMin * BASE_RADIUS_FRACTION,
    screenMin,
  );
  let intro: Tween | null = null;
  if (first && g.intro !== null) {
    intro = introTween(g.camera, g.intro, g.still ? 0 : FLY_IN_MS);
    g.intro = null;
  }
  engine.modify();
  start(engine, intro);
}

// The picker is going. Ends whatever moves, so the clock stops on its next
// frame even if a finger was down and its cancel never comes.
export function stop(engine: SharedValue<GlobeEngine>): void {
  "worklet";
  const g = engine.value;
  g.interacting = false;
  g.tween = null;
  g.fling = null;
}

// The OS reduce-motion switch, which can change while the picker is open.
export function setStill(
  engine: SharedValue<GlobeEngine>,
  still: boolean,
): void {
  "worklet";
  engine.value.still = still;
  if (still) engine.value.fling = null;
}

// The + and - buttons, and the screen reader's adjustable action.
export function stepPrecision(
  engine: SharedValue<GlobeEngine>,
  delta: number,
): void {
  "worklet";
  const c = engine.value.camera;
  start(engine, precisionTween(c, c.precision + delta));
}

// ---- Touch ----
//
// One handler for every touch rather than stacked recognisers, as both bitchat
// globes do: the centroid of all fingers pans, their spread pinches, in the
// same gesture, and a quick tap focuses at once while a second tap close
// behind it also zooms. Waiting to rule out a double tap would make every
// single tap feel late.

// Movement under this many points is a tap, not a drag.
const TOUCH_SLOP = 8;
const TAP_MAX_MS = 400;
const DOUBLE_TAP_GAP_MS = 350;
// A second tap may land this far from the first and still count as a double.
const DOUBLE_TAP_SLOP = TOUCH_SLOP * 4;
// Release velocity is averaged over the last 100 ms of movement, and is zero
// when the finger rested for 40 ms before lifting.
const VELOCITY_WINDOW_MS = 100;
const RESTED_MS = 40;
const MAX_SAMPLES = 20;

export interface TouchState {
  ids: number[];
  downTime: number;
  downX: number;
  downY: number;
  movedX: number;
  movedY: number;
  dragStarted: boolean;
  multi: boolean;
  lastX: number;
  lastY: number;
  lastSpan: number;
  // [time, x, y] per sample, single-finger moves only.
  samples: number[];
  lastTapTime: number;
  lastTapX: number;
  lastTapY: number;
}

export function makeTouch(): TouchState {
  "worklet";
  return {
    ids: [],
    downTime: 0,
    downX: 0,
    downY: 0,
    movedX: 0,
    movedY: 0,
    dragStarted: false,
    multi: false,
    lastX: 0,
    lastY: 0,
    lastSpan: 0,
    samples: [],
    lastTapTime: -Infinity,
    lastTapX: 0,
    lastTapY: 0,
  };
}

type Point = { id: number; x: number; y: number };

function tracked(t: TouchState, touches: readonly Point[]): Point[] {
  "worklet";
  return touches.filter((p) => t.ids.includes(p.id));
}

function centroid(points: readonly Point[]): { x: number; y: number } {
  "worklet";
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(points.length, 1);
  return { x: x / n, y: y / n };
}

function spread(points: readonly Point[], cx: number, cy: number): number {
  "worklet";
  if (points.length === 0) return 0;
  let total = 0;
  for (const p of points) total += Math.hypot(p.x - cx, p.y - cy);
  return total / points.length;
}

function resetBaseline(t: TouchState, points: readonly Point[]): void {
  "worklet";
  const c = centroid(points);
  t.lastX = c.x;
  t.lastY = c.y;
  t.lastSpan = points.length > 1 ? spread(points, c.x, c.y) : 0;
}

// Returns true on the first finger down, when the hint can go.
export function touchesDown(
  engine: SharedValue<GlobeEngine>,
  touch: SharedValue<TouchState>,
  e: GestureTouchEvent,
): boolean {
  "worklet";
  const now = performance.now();
  const t = touch.value;
  const first = t.ids.length === 0;
  if (first && e.changedTouches.length > 0) {
    const p = e.changedTouches[0];
    t.downTime = now;
    t.downX = p.x;
    t.downY = p.y;
    t.movedX = 0;
    t.movedY = 0;
    t.dragStarted = false;
    t.multi = false;
    t.samples = [now, p.x, p.y];
    // Touching the globe catches a fling or cuts a flight short.
    const g = engine.value;
    g.interacting = true;
    g.tween = null;
    g.fling = null;
    engine.modify();
    motionChanged(engine);
  }
  for (const p of e.changedTouches) {
    if (!t.ids.includes(p.id)) t.ids.push(p.id);
  }
  if (t.ids.length > 1) {
    t.multi = true;
    t.samples = [];
  }
  resetBaseline(t, tracked(t, e.allTouches));
  return first;
}

// Returns the selected cell when a finger has moved it onto a new one, for the
// haptic tick, or null.
export function touchesMove(
  engine: SharedValue<GlobeEngine>,
  touch: SharedValue<TouchState>,
  e: GestureTouchEvent,
): string | null {
  "worklet";
  const t = touch.value;
  const points = tracked(t, e.allTouches);
  if (points.length === 0) return null;
  const camera = engine.value.camera;
  const before = camera.selected;
  const c = centroid(points);
  const dx = c.x - t.lastX;
  const dy = c.y - t.lastY;
  if (dx !== 0 || dy !== 0) {
    t.movedX += dx;
    t.movedY += dy;
    if (!t.dragStarted && Math.hypot(t.movedX, t.movedY) >= TOUCH_SLOP) {
      t.dragStarted = true;
    }
    if (t.dragStarted) rotateBy(camera, dx, dy);
  }
  if (points.length > 1 && t.lastSpan > 0) {
    const span = spread(points, c.x, c.y);
    if (span > 0) {
      zoomBy(camera, span / t.lastSpan);
      t.lastSpan = span;
    }
  }
  engine.modify();
  t.lastX = c.x;
  t.lastY = c.y;
  if (!t.multi && points.length === 1) {
    t.samples.push(performance.now(), points[0].x, points[0].y);
    if (t.samples.length > MAX_SAMPLES * 3) {
      t.samples.splice(0, t.samples.length - MAX_SAMPLES * 3);
    }
  }
  const after = camera.selected;
  return after !== before && after.length > 0 ? after : null;
}

function releaseVelocity(t: TouchState, upTime: number): Fling | null {
  "worklet";
  const n = t.samples.length / 3;
  if (n < 2) return null;
  const lastTime = t.samples[(n - 1) * 3];
  if (upTime - lastTime >= RESTED_MS) return null;
  let first = n - 1;
  while (
    first > 0 &&
    lastTime - t.samples[(first - 1) * 3] <= VELOCITY_WINDOW_MS
  ) {
    first--;
  }
  const dt = (lastTime - t.samples[first * 3]) / 1000;
  if (dt <= 0.005) return null;
  return {
    vx: (t.samples[(n - 1) * 3 + 1] - t.samples[first * 3 + 1]) / dt,
    vy: (t.samples[(n - 1) * 3 + 2] - t.samples[first * 3 + 2]) / dt,
  };
}

export function touchesUp(
  engine: SharedValue<GlobeEngine>,
  touch: SharedValue<TouchState>,
  e: GestureTouchEvent,
  cancelled: boolean,
): void {
  "worklet";
  const now = performance.now();
  const t = touch.value;
  if (!t.multi && t.ids.length === 1 && e.changedTouches.length > 0) {
    const p = e.changedTouches[0];
    t.samples.push(now, p.x, p.y);
  }
  const lifted = e.changedTouches.map((p) => p.id);
  t.ids = t.ids.filter((id) => !lifted.includes(id));
  if (t.ids.length > 0) {
    resetBaseline(t, tracked(t, e.allTouches));
    return;
  }

  const g = engine.value;
  g.interacting = false;
  let next: Tween | null = null;
  if (!cancelled) {
    const isTap =
      !t.multi &&
      !t.dragStarted &&
      now - t.downTime < TAP_MAX_MS &&
      Math.hypot(t.movedX, t.movedY) < TOUCH_SLOP;
    const r = globeRadius(g.camera);
    // A tap off the disc, on space, focuses nothing, as on bitchat.
    const at =
      isTap && r > 0
        ? unproject(
            (t.downX - g.width / 2) / r,
            (t.downY - g.height / 2) / r,
            g.camera.lat,
            g.camera.lon,
          )
        : null;
    if (at !== null) {
      const double =
        now - t.lastTapTime < DOUBLE_TAP_GAP_MS &&
        Math.hypot(t.downX - t.lastTapX, t.downY - t.lastTapY) <
          DOUBLE_TAP_SLOP;
      t.lastTapTime = now;
      t.lastTapX = t.downX;
      t.lastTapY = t.downY;
      next = focusTween(g.camera, at.lat, at.lon, double);
    } else if (t.dragStarted && !t.multi && !g.still) {
      const v = releaseVelocity(t, now);
      g.fling = v === null ? null : makeFling(v.vx, v.vy);
    }
  }
  engine.modify();
  if (next !== null) start(engine, next);
  else motionChanged(engine);
}
