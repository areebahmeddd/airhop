// Where the globe picker is looking, and every way that changes: drags,
// pinches, taps, flings, the + and - buttons, and the opening flight.
//
// A port of bitchat-ios's GlobeState with its constants, so a gesture moves
// the globe the same distance in both apps. The selection is always the cell
// under the screen centre at the current precision; nothing selects by where
// a finger landed. Plain data and worklets: the camera lives in a shared value
// on the UI thread, and the tests drive the same functions on JS.

import { encodeGeohash, geohashCenter } from "./geohash-grid";
import {
  MAX_PRECISION,
  MAX_ZOOM,
  MIN_ZOOM,
  autoPrecision,
  fastOutSlowIn,
  normalizeLon,
  zoomForPrecision,
} from "./globe-math";

// Animation lengths, in ms, matched to bitchat so the two globes fly alike.
// They are the globe's own physics rather than the app's motion vocabulary in
// theme.ts: a 1.4 s flight is not a sheet or a fade.
export const FLY_IN_MS = 1400;
const FOCUS_MS = 450;
const DOUBLE_TAP_MS = 500;
const PRECISION_STEP_MS = 450;

// A double tap zooms in by this much as well as focusing.
export const DOUBLE_TAP_ZOOM = 1.9;

// Dragging stops just short of the pole so polar cells stay selectable; a
// tighter clamp would encode the wrong cell there. An animation may pass it to
// reach a polar target (see clampedLat).
const MAX_DRAG_LAT = 89;
// Fling speeds in points per second: slower is a finger at rest, faster is a
// glitch in the velocity estimate.
const MIN_FLING = 35;
const MAX_FLING = 1200;
// A dropped frame must not jump the globe: a step is capped at a 30 fps frame,
// and at this share of the radius.
const MAX_FRAME_DELTA_S = 1 / 30;
const MAX_FLING_RADIUS_FRACTION_PER_FRAME = 0.12;
// Exponential decay per second.
const FLING_FRICTION = 4.2;

// The opening flight starts from a wide, offset view of the target.
const INTRO_LAT_FACTOR = 0.4;
const INTRO_LON_OFFSET = 70;

// With nothing to start from: a wide view of the inhabited latitudes.
const DEFAULT_START = { lat: 20, lon: 0, precision: 2 };

export interface Camera {
  lat: number;
  lon: number;
  zoom: number;
  precision: number;
  selected: string;
  // The globe's radius at zoom 1, and the screen's shorter side. Zero until
  // the first layout, and nothing moves before then.
  baseRadius: number;
  screenMin: number;
}

export interface Tween {
  startLat: number;
  startLon: number;
  endLat: number;
  // The short way round, so a flight never circles the globe the long way.
  dLon: number;
  startZoom: number;
  endZoom: number;
  // Zero leaves the precision to follow the zoom.
  targetPrecision: number;
  durationMs: number;
  // -1 until the first frame stamps it.
  startTime: number;
}

export interface Fling {
  vx: number;
  vy: number;
}

export interface StartTarget {
  lat: number;
  lon: number;
  precision: number;
}

// Where the picker opens: the given cell, else the coarsest of the cells the
// phone is standing in, else a wide default. The coarsest rather than the
// finest, as bitchat does: the picker shows a country to choose from, not the
// user's street to whoever is looking at the screen. Callers pass only valid
// geohashes.
export function startTarget(
  initial: string | null,
  nearby: readonly string[],
): StartTarget {
  "worklet";
  let focus = initial ?? "";
  if (focus.length === 0) {
    for (const gh of nearby) {
      if (focus.length === 0 || gh.length < focus.length) focus = gh;
    }
  }
  if (focus.length === 0) return DEFAULT_START;
  const c = geohashCenter(focus);
  return {
    lat: c.lat,
    lon: c.lon,
    precision: Math.min(focus.length, MAX_PRECISION),
  };
}

// Before the first layout. `flyIn` starts from the wide, offset view the
// opening flight leaves from; without it the camera starts on the target.
export function makeCamera(target: StartTarget, flyIn: boolean): Camera {
  "worklet";
  return {
    lat: flyIn ? target.lat * INTRO_LAT_FACTOR : target.lat,
    lon: flyIn ? normalizeLon(target.lon - INTRO_LON_OFFSET) : target.lon,
    zoom: MIN_ZOOM,
    precision: Math.min(Math.max(target.precision, 1), MAX_PRECISION),
    selected: "",
    baseRadius: 0,
    screenMin: 0,
  };
}

export function globeRadius(c: Camera): number {
  "worklet";
  return c.baseRadius * c.zoom;
}

// Within the drag limit, widened up to the pole on `reach`'s side only: a view
// already past the limit (a polar target) may move toward the equator but not
// further out, and never snaps back.
function clampedLat(lat: number, reach: number): number {
  "worklet";
  const lower = Math.max(Math.min(-MAX_DRAG_LAT, reach), -90);
  const upper = Math.min(Math.max(MAX_DRAG_LAT, reach), 90);
  return Math.min(Math.max(lat, lower), upper);
}

function syncSelection(c: Camera): void {
  "worklet";
  if (c.baseRadius <= 0) return;
  c.selected = encodeGeohash(c.lat, c.lon, c.precision);
}

function syncPrecisionFromZoom(c: Camera): void {
  "worklet";
  if (c.baseRadius <= 0) return;
  c.precision = autoPrecision(globeRadius(c), c.screenMin);
}

// Lays the camera out. Returns true on the first layout, when the opening
// flight (or the jump to the target, without one) is due.
export function setViewport(
  c: Camera,
  baseRadius: number,
  screenMin: number,
): boolean {
  "worklet";
  if (baseRadius <= 0 || screenMin <= 0) return false;
  const first = c.baseRadius <= 0;
  c.baseRadius = baseRadius;
  c.screenMin = screenMin;
  syncSelection(c);
  return first;
}

// A drag, in screen points. Dragging right turns the globe so the land under
// the finger follows it, the same in every layout direction: the globe is a
// physical object, not text.
export function rotateBy(c: Camera, dx: number, dy: number): void {
  "worklet";
  const r = globeRadius(c);
  if (r <= 0) return;
  const degPerPoint = 180 / (Math.PI * r);
  c.lon = normalizeLon(c.lon - dx * degPerPoint);
  c.lat = clampedLat(c.lat + dy * degPerPoint, c.lat);
  syncSelection(c);
}

// A pinch. Precision follows the zoom.
export function zoomBy(c: Camera, factor: number): void {
  "worklet";
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return;
  c.zoom = Math.min(Math.max(c.zoom * factor, MIN_ZOOM), MAX_ZOOM);
  syncPrecisionFromZoom(c);
  syncSelection(c);
}

function makeTween(
  c: Camera,
  lat: number,
  lon: number,
  zoom: number | null,
  precision: number,
  durationMs: number,
): Tween {
  "worklet";
  return {
    startLat: c.lat,
    startLon: c.lon,
    endLat: lat,
    dLon: normalizeLon(lon - c.lon),
    startZoom: c.zoom,
    endZoom: Math.min(Math.max(zoom ?? c.zoom, MIN_ZOOM), MAX_ZOOM),
    targetPrecision: precision,
    durationMs,
    startTime: -1,
  };
}

export function applyTween(c: Camera, tween: Tween, t: number): void {
  "worklet";
  // The target is always reachable: a polar cell's centre can lie past the
  // drag limit, and clamping it would land the flight on another cell.
  c.lat = clampedLat(
    tween.startLat + (tween.endLat - tween.startLat) * t,
    tween.endLat,
  );
  c.lon = normalizeLon(tween.startLon + tween.dLon * t);
  // Exponential, so each part of the flight zooms by the same ratio.
  c.zoom = tween.startZoom * (tween.endZoom / tween.startZoom) ** t;
  if (tween.targetPrecision > 0) {
    c.precision = Math.min(Math.max(tween.targetPrecision, 1), MAX_PRECISION);
  } else {
    syncPrecisionFromZoom(c);
  }
  syncSelection(c);
}

// Advances a tween to `now` (ms). Returns true once it has landed.
export function stepTween(c: Camera, tween: Tween, now: number): boolean {
  "worklet";
  if (tween.startTime < 0) tween.startTime = now;
  const progress =
    tween.durationMs <= 0
      ? 1
      : Math.min(Math.max((now - tween.startTime) / tween.durationMs, 0), 1);
  applyTween(c, tween, fastOutSlowIn(progress));
  return progress >= 1;
}

// The flight in, once the viewport is known.
export function introTween(
  c: Camera,
  target: StartTarget,
  durationMs: number,
): Tween {
  "worklet";
  const zoom = zoomForPrecision(target.precision, c.baseRadius, c.screenMin);
  return makeTween(
    c,
    target.lat,
    target.lon,
    zoom,
    target.precision,
    durationMs,
  );
}

// A tap focuses the point under it; a double tap also zooms in. Neither ever
// coarsens the cell. Past precision 7 the size comes from the + button, not
// the zoom; bitchat re-derives it from the zoom here, which snaps a
// building-sized cell back to a block.
export function focusTween(
  c: Camera,
  lat: number,
  lon: number,
  zoomIn: boolean,
): Tween {
  "worklet";
  if (!zoomIn) return makeTween(c, lat, lon, null, c.precision, FOCUS_MS);
  const zoom = Math.min(c.zoom * DOUBLE_TAP_ZOOM, MAX_ZOOM);
  const precision = Math.max(
    autoPrecision(c.baseRadius * zoom, c.screenMin),
    c.precision,
  );
  return makeTween(c, lat, lon, zoom, precision, DOUBLE_TAP_MS);
}

// The + and - buttons: a new precision, zoomed to frame its cell. At maximum
// zoom this is the only way to precision 8 and finer. Null when nothing would
// change.
export function precisionTween(c: Camera, precision: number): Tween | null {
  "worklet";
  const p = Math.min(Math.max(precision, 1), MAX_PRECISION);
  if (p === c.precision || c.baseRadius <= 0) return null;
  const zoom = zoomForPrecision(p, c.baseRadius, c.screenMin);
  return makeTween(c, c.lat, c.lon, zoom, p, PRECISION_STEP_MS);
}

// A release velocity worth carrying on as a spin, or null.
export function makeFling(vx: number, vy: number): Fling | null {
  "worklet";
  let x = Math.min(Math.max(vx, -MAX_FLING), MAX_FLING);
  let y = Math.min(Math.max(vy, -MAX_FLING), MAX_FLING);
  if (Math.abs(x) < MIN_FLING) x = 0;
  if (Math.abs(y) < MIN_FLING) y = 0;
  return x === 0 && y === 0 ? null : { vx: x, vy: y };
}

// One frame of a fling, `dtMs` since the last. Returns false once it has run
// down.
export function stepFling(c: Camera, fling: Fling, dtMs: number): boolean {
  "worklet";
  const dt = Math.min(Math.max(dtMs / 1000, 0), MAX_FRAME_DELTA_S);
  const maxStep = globeRadius(c) * MAX_FLING_RADIUS_FRACTION_PER_FRAME;
  rotateBy(
    c,
    Math.min(Math.max(fling.vx * dt, -maxStep), maxStep),
    Math.min(Math.max(fling.vy * dt, -maxStep), maxStep),
  );
  const decay = Math.exp(-FLING_FRICTION * dt);
  fling.vx *= decay;
  fling.vy *= decay;
  return Math.abs(fling.vx) >= MIN_FLING || Math.abs(fling.vy) >= MIN_FLING;
}
