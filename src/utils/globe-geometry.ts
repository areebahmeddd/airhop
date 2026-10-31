// Turning projected rings into drawable screen geometry: splitting them at the
// limb, closing a fill along the horizon, and clipping to the viewport.
//
// A port of bitchat-ios's GlobeGeometry, kept step for step so the two globes
// fill the same shapes. Worklets, for the renderer on the UI thread.
//
// Points travel as flat arrays rather than point objects: a frame walks some
// eight thousand of them, and an object each is garbage on every frame. A
// projected ring is `DiscRing` (disc units, see globe-math.ts); everything
// after the limb split is interleaved [x0, y0, x1, y1, ...].

import { normalizeLon, unproject } from "./globe-math";
import type { RingSet } from "./world-data";

export interface DiscRing {
  x: number[];
  y: number[];
  front: boolean[];
  // Points in use; the arrays may be longer, reused from a larger ring.
  length: number;
}

// Geometry far outside the view costs precision in the rasterizer at high
// zoom, so everything is clipped to the viewport grown by a screen each way.
export interface ClipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function clipRectFor(width: number, height: number): ClipRect {
  "worklet";
  return { left: -width, top: -height, right: width * 2, bottom: height * 2 };
}

// Where the segment from `behind` to `front` leaves the unit disc, by
// bisection. Both ends of a projected segment lie inside the disc, so this
// settles on the second argument; bitchat's runs are built on exactly that,
// so it stays as written rather than being simplified to the endpoint.
function pushLimbPoint(
  run: number[],
  pts: DiscRing,
  behind: number,
  front: number,
): void {
  "worklet";
  const bx = pts.x[behind];
  const by = pts.y[behind];
  const dx = pts.x[front] - bx;
  const dy = pts.y[front] - by;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const t = (lo + hi) / 2;
    const x = bx + dx * t;
    const y = by + dy * t;
    if (x * x + y * y < 1) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  run.push(bx + dx * t, by + dy * t);
}

// A jump longer than this between consecutive front points is a ring crossing
// the antimeridian, not an edge: drawing it would put a chord through the view.
const WRAP_JUMP_SQUARED = 1.2;

// Splits a projected ring into its front-facing runs, each padded at the limb
// so a fill can close along the horizon. `closed` is false for open polylines
// (borders), which must not join their last point to their first.
export function frontRuns(pts: DiscRing, closed = true): number[][] {
  "worklet";
  const n = pts.length;
  if (n === 0) return [];
  const runs: number[][] = [];
  let run: number[] = [];
  let prev = closed ? n - 1 : -1;
  for (let i = 0; i < n; i++) {
    if (pts.front[i]) {
      if (run.length === 0 && prev >= 0 && !pts.front[prev]) {
        pushLimbPoint(run, pts, prev, i);
      }
      if (run.length > 0) {
        const dx = pts.x[i] - run[run.length - 2];
        const dy = pts.y[i] - run[run.length - 1];
        if (dx * dx + dy * dy > WRAP_JUMP_SQUARED) {
          runs.push(run);
          run = [];
        }
      }
      run.push(pts.x[i], pts.y[i]);
    } else if (run.length > 0 && prev >= 0) {
      pushLimbPoint(run, pts, prev, i);
      runs.push(run);
      run = [];
    }
    prev = i;
  }
  if (run.length > 0) {
    const frontEnds = pts.front[0] && pts.front[n - 1];
    if (closed && runs.length > 0 && frontEnds) {
      runs[0] = run.concat(runs[0]);
    } else {
      // A ring wholly in front has no limb crossing to end its run, so it is
      // closed here. Cell outlines leave out their repeated last corner and
      // rely on this.
      if (closed && runs.length === 0 && frontEnds) run.push(run[0], run[1]);
      runs.push(run);
    }
  }
  return runs;
}

// The fill outline of a projected ring, in screen units: back points are
// pulled onto the limb and consecutive limb points joined by an arc, so the
// shape approximates the ring's visible part without chords across the disc.
export function fillPolygon(
  pts: DiscRing,
  cx: number,
  cy: number,
  r: number,
): number[] {
  "worklet";
  const out: number[] = [];
  let prevAngle = NaN;
  let firstAngle = NaN;
  const addArc = (from: number, to: number) => {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.min(Math.max(Math.trunc(Math.abs(d) / 0.04), 1), 64);
    for (let s = 1; s < steps; s++) {
      const a = from + (d * s) / steps;
      out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  for (let i = 0; i < pts.length; i++) {
    const x = pts.x[i];
    const y = pts.y[i];
    if (pts.front[i]) {
      out.push(cx + x * r, cy + y * r);
      prevAngle = NaN;
    } else {
      const len = Math.sqrt(x * x + y * y);
      const lx = len > 1e-6 ? x / len : 0;
      const ly = len > 1e-6 ? y / len : -1;
      const angle = Math.atan2(ly, lx);
      if (!Number.isNaN(prevAngle)) addArc(prevAngle, angle);
      if (Number.isNaN(firstAngle)) firstAngle = angle;
      out.push(cx + lx * r, cy + ly * r);
      prevAngle = angle;
    }
  }
  // The ring ends and starts on the limb: close that arc too.
  if (
    pts.length > 0 &&
    !pts.front[0] &&
    !Number.isNaN(prevAngle) &&
    !Number.isNaN(firstAngle)
  ) {
    addArc(prevAngle, firstAngle);
  }
  return out;
}

// Sutherland-Hodgman, one rect edge at a time.
export function clipPolygon(poly: number[], rect: ClipRect): number[] {
  "worklet";
  // Edge 0 left, 1 right, 2 top, 3 bottom.
  const inside = (edge: number, x: number, y: number): boolean => {
    if (edge === 0) return x >= rect.left;
    if (edge === 1) return x <= rect.right;
    if (edge === 2) return y >= rect.top;
    return y <= rect.bottom;
  };
  const crossing = (
    edge: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    out: number[],
  ) => {
    if (edge < 2) {
      const ex = edge === 0 ? rect.left : rect.right;
      out.push(ex, ay + ((ex - ax) / (bx - ax)) * (by - ay));
    } else {
      const ey = edge === 2 ? rect.top : rect.bottom;
      out.push(ax + ((ey - ay) / (by - ay)) * (bx - ax), ey);
    }
  };
  let input = poly;
  for (let edge = 0; edge < 4; edge++) {
    const n = input.length / 2;
    if (n === 0) return input;
    const result: number[] = [];
    let sx = input[(n - 1) * 2];
    let sy = input[(n - 1) * 2 + 1];
    for (let i = 0; i < n; i++) {
      const ex = input[i * 2];
      const ey = input[i * 2 + 1];
      const eIn = inside(edge, ex, ey);
      if (eIn) {
        if (!inside(edge, sx, sy)) crossing(edge, sx, sy, ex, ey, result);
        result.push(ex, ey);
      } else if (inside(edge, sx, sy)) {
        crossing(edge, sx, sy, ex, ey, result);
      }
      sx = ex;
      sy = ey;
    }
    input = result;
  }
  return input;
}

// Liang-Barsky. Writes the clipped ends to `out` as [x0, y0, x1, y1] and
// returns false when nothing of the segment is inside.
export function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: ClipRect,
  out: number[],
): boolean {
  "worklet";
  const dx = bx - ax;
  const dy = by - ay;
  let u1 = 0;
  let u2 = 1;
  const test = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const ratio = q / p;
    if (p < 0) {
      if (ratio > u2) return false;
      if (ratio > u1) u1 = ratio;
    } else {
      if (ratio < u1) return false;
      if (ratio < u2) u2 = ratio;
    }
    return true;
  };
  if (
    !test(-dx, ax - rect.left) ||
    !test(dx, rect.right - ax) ||
    !test(-dy, ay - rect.top) ||
    !test(dy, rect.bottom - ay)
  ) {
    return false;
  }
  out[0] = ax + u1 * dx;
  out[1] = ay + u1 * dy;
  out[2] = ax + u2 * dx;
  out[3] = ay + u2 * dy;
  return true;
}

// Even-odd point in polygon, screen space.
export function polygonContains(
  polygon: number[],
  x: number,
  y: number,
): boolean {
  "worklet";
  const n = polygon.length / 2;
  if (n < 3) return false;
  let inside = false;
  let px = polygon[(n - 1) * 2];
  let py = polygon[(n - 1) * 2 + 1];
  for (let i = 0; i < n; i++) {
    const qx = polygon[i * 2];
    const qy = polygon[i * 2 + 1];
    if (qy > y !== py > y) {
      const ix = ((px - qx) * (y - qy)) / (py - qy) + qx;
      if (x < ix) inside = !inside;
    }
    px = qx;
    py = qy;
  }
  return inside;
}

// Point in ring on the sphere: counts the ring's edges that cross the probe's
// meridian north of it. Each edge is followed the short way round, so a ring
// that wraps the antimeridian (Eurasia, at Chukotka) has no false crossing at
// the 180 degree seam; comparing raw longitudes there reads whole oceans as
// inside Eurasia.
export function ringContains(
  rings: RingSet,
  ring: number,
  lat: number,
  lon: number,
): boolean {
  "worklet";
  const start = rings.starts[ring];
  const count = rings.starts[ring + 1] - start;
  if (count < 3) return false;
  let inside = false;
  let prev = start + count - 1;
  for (let i = start; i < start + count; i++) {
    const startLat = rings.lats[prev];
    const endLat = rings.lats[i];
    const a = normalizeLon(rings.lons[prev] - lon);
    // Unbounded on purpose: the end changes sign against the start only when
    // the edge crosses the probe's meridian, never at the seam.
    const b = a + normalizeLon(rings.lons[i] - rings.lons[prev]);
    if (a > 0 !== b > 0) {
      const t = a / (a - b);
      if (startLat + (endLat - startLat) * t > lat) inside = !inside;
    }
    prev = i;
  }
  return inside;
}

// Probes in disc units, the centre and a ring around it.
const INVERSION_PROBES = [
  0, 0, -0.5, 0, 0.5, 0, 0, -0.5, 0, 0.5, -0.35, -0.35, 0.35, -0.35, -0.35,
  0.35, 0.35, 0.35,
];

// The horizon closure can land on the wrong side for a very large ring, which
// would fill the whole disc. One probe at the centre is ambiguous for such a
// ring, so several visible points vote: each is tested against the original
// ring on the sphere and against the projected fill, and the fill is inverted
// only when inverting is clearly the better match.
export function projectedFillNeedsInversion(
  polygon: number[],
  rings: RingSet,
  ring: number,
  cx: number,
  cy: number,
  r: number,
  centerLat: number,
  centerLon: number,
): boolean {
  "worklet";
  let normalErrors = 0;
  let invertedErrors = 0;
  for (let i = 0; i < INVERSION_PROBES.length; i += 2) {
    const nx = INVERSION_PROBES[i];
    const ny = INVERSION_PROBES[i + 1];
    const at = unproject(nx, ny, centerLat, centerLon);
    if (at === null) continue;
    const onSphere = ringContains(rings, ring, at.lat, at.lon);
    const onScreen = polygonContains(polygon, cx + nx * r, cy + ny * r);
    if (onScreen !== onSphere) normalErrors++;
    if (!onScreen !== onSphere) invertedErrors++;
  }
  return invertedErrors < normalErrors;
}
