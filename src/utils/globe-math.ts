// Orthographic projection and the zoom rules of the globe picker.
//
// The numbers here are bitchat's, so the same view at the same zoom on the
// same screen picks the same cell in both apps; changing one breaks that
// parity rather than tuning a feel. Every function is a worklet: the globe
// projects on the UI thread, and tests and the picker's setup call the same
// code on JS. A worklet captures what it calls when it is defined, so each
// helper sits above its callers, here and in the other globe modules.
//
// Disc coordinates are in units of the globe's radius, screen y down, with the
// view centre at (0, 0). `cosC` is the cosine of a point's angular distance
// from the view centre, negative on the far side of the sphere.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 120_000;
export const MAX_PRECISION = 12;

// The globe's radius at zoom 1, as a share of the screen's shorter side.
export const BASE_RADIUS_FRACTION = 0.44;

// Zoom picks the finest precision whose cell is still this share of the
// shorter side tall. At MAX_ZOOM that is precision 7: anything finer is only
// reachable by the + button.
const AUTO_PRECISION_CELL_FRACTION = 0.22;

// The + and - buttons frame the new cell at a third of the shorter side, which
// is inside the band AUTO_PRECISION_CELL_FRACTION keeps, so a pinch straight
// after a button press does not change the precision under the user.
const FRAMED_CELL_FRACTION = 1 / 3;

const DEG = Math.PI / 180;

export interface Projection {
  x: number;
  y: number;
  cosC: number;
}

// Into [-180, 180]. JavaScript's % keeps the dividend's sign, as Swift's
// truncatingRemainder does, so this matches bitchat's at every input.
export function normalizeLon(lon: number): number {
  "worklet";
  let x = lon % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

// The view centre's sines and cosines, computed once per frame so projecting
// a prepared point is multiplications only.
export interface Projector {
  sinLat: number;
  cosLat: number;
  sinLon: number;
  cosLon: number;
}

export function makeProjector(centerLat: number, centerLon: number): Projector {
  "worklet";
  return {
    sinLat: Math.sin(centerLat * DEG),
    cosLat: Math.cos(centerLat * DEG),
    sinLon: Math.sin(centerLon * DEG),
    cosLon: Math.cos(centerLon * DEG),
  };
}

// Projects point `i` of `terms`, which holds sinLat, cosLat, sinLon, cosLon
// per point (see world-data.ts), into `out`. Writes rather than returns so a
// frame of eight thousand points allocates nothing.
export function projectPrepared(
  p: Projector,
  terms: Float64Array,
  i: number,
  out: Projection,
): void {
  "worklet";
  const o = i * 4;
  const sinLat = terms[o];
  const cosLat = terms[o + 1];
  const sinLon = terms[o + 2];
  const cosLon = terms[o + 3];
  // sin and cos of (lon - centerLon), by the difference identities.
  const sinDLon = sinLon * p.cosLon - cosLon * p.sinLon;
  const cosDLon = cosLon * p.cosLon + sinLon * p.sinLon;
  out.x = cosLat * sinDLon;
  out.y = -(p.cosLat * sinLat - p.sinLat * cosLat * cosDLon);
  out.cosC = p.sinLat * sinLat + p.cosLat * cosLat * cosDLon;
}

// The reference projection the prepared one must agree with.
export function projectRaw(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
): Projection {
  "worklet";
  const phi = lat * DEG;
  const phi0 = centerLat * DEG;
  const dLambda = normalizeLon(lon - centerLon) * DEG;
  return {
    x: Math.cos(phi) * Math.sin(dLambda),
    y: -(
      Math.cos(phi0) * Math.sin(phi) -
      Math.sin(phi0) * Math.cos(phi) * Math.cos(dLambda)
    ),
    cosC:
      Math.sin(phi0) * Math.sin(phi) +
      Math.cos(phi0) * Math.cos(phi) * Math.cos(dLambda),
  };
}

// Null when the point is behind the limb.
export function project(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
): Projection | null {
  "worklet";
  const p = projectRaw(lat, lon, centerLat, centerLon);
  return p.cosC >= 0 ? p : null;
}

// Disc coordinates back to a position, or null outside the disc.
export function unproject(
  x: number,
  y: number,
  centerLat: number,
  centerLon: number,
): { lat: number; lon: number } | null {
  "worklet";
  const rho = Math.sqrt(x * x + y * y);
  if (rho > 1) return null;
  if (rho < 1e-9) return { lat: centerLat, lon: normalizeLon(centerLon) };
  const c = Math.asin(Math.min(1, Math.max(-1, rho)));
  const phi0 = centerLat * DEG;
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);
  // Clamped: rounding near the limb can push the sine past 1, and the NaN
  // asin returns would poison the camera for good.
  const sinLat = cosC * Math.sin(phi0) + (-y * sinC * Math.cos(phi0)) / rho;
  const lat = Math.asin(Math.min(1, Math.max(-1, sinLat))) / DEG;
  const lonOffset =
    Math.atan2(
      x * sinC,
      rho * Math.cos(phi0) * cosC - -y * Math.sin(phi0) * sinC,
    ) / DEG;
  return { lat, lon: normalizeLon(centerLon + lonOffset) };
}

// A geohash interleaves bits starting with longitude, so an odd precision has
// one more longitude bit than latitude bits.
export function cellSpanLat(precision: number): number {
  "worklet";
  return 180 / 2 ** Math.floor((5 * precision) / 2);
}

/**
 * @public `globe-math.test.ts` checks both spans against the geohash grid;
 * zoom only needs the latitude one, as bitchat's does.
 */
export function cellSpanLon(precision: number): number {
  "worklet";
  return 360 / 2 ** Math.ceil((5 * precision) / 2);
}

export function autoPrecision(globeRadius: number, screenMin: number): number {
  "worklet";
  const target = screenMin * AUTO_PRECISION_CELL_FRACTION;
  let best = 1;
  for (let p = 1; p <= MAX_PRECISION; p++) {
    if (cellSpanLat(p) * DEG * globeRadius >= target) best = p;
    else break;
  }
  return best;
}

// The zoom (over the zoom-1 radius) that frames a cell of this precision.
export function zoomForPrecision(
  precision: number,
  baseRadius: number,
  screenMin: number,
): number {
  "worklet";
  const targetRadius =
    (screenMin * FRAMED_CELL_FRACTION) / (cellSpanLat(precision) * DEG);
  return Math.min(Math.max(targetRadius / baseRadius, MIN_ZOOM), MAX_ZOOM);
}

// How far a cell of this precision reaches at its widest, in metres, for the
// readout. bitchat's table (common geohash dimension tables), so both apps
// quote the same size for the same cell.
export function cellCoverageMeters(precision: number): number {
  "worklet";
  switch (precision) {
    case 2:
      return 1_250_000;
    case 3:
      return 156_000;
    case 4:
      return 39_100;
    case 5:
      return 4_890;
    case 6:
      return 1_220;
    case 7:
      return 153;
    case 8:
      return 38.2;
    case 9:
      return 4.77;
    case 10:
      return 1.19;
    default:
      if (precision <= 1) return 5_000_000;
      // Past 10 each character divides the cell by four or eight; a quarter
      // per step is the conservative reading.
      return 1.19 * 0.25 ** (precision - 10);
  }
}

function cubicBezier(
  t: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  "worklet";
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const sample = (s: number, a1: number, a2: number): number => {
    const inv = 1 - s;
    return 3 * inv * inv * s * a1 + 3 * inv * s * s * a2 + s * s * s;
  };
  // x(s) = t by bisection; x is monotonic for these control points.
  let lo = 0;
  let hi = 1;
  let s = t;
  for (let i = 0; i < 24; i++) {
    const x = sample(s, x1, x2);
    if (Math.abs(x - t) < 1e-6) break;
    if (x < t) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sample(s, y1, y2);
}

// Material's standard curve, cubic-bezier(0.4, 0, 0.2, 1), which both bitchat
// globes animate with.
export function fastOutSlowIn(t: number): number {
  "worklet";
  return cubicBezier(t, 0.4, 0, 0.2, 1);
}
