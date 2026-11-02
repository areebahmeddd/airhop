// Limb splitting, horizon closure and clipping, ported from bitchat-ios's
// GlobePickerTests, plus its two regressions against the real coastline: an
// ocean read as land, and a land fill painted over visible ocean.

import {
  clipPolygon,
  clipRectFor,
  clipSegment,
  fillPolygon,
  frontRuns,
  polygonContains,
  projectedFillNeedsInversion,
  ringContains,
  type DiscRing,
} from "../globe-geometry";
import {
  BASE_RADIUS_FRACTION,
  makeProjector,
  project,
  projectPrepared,
} from "../globe-math";
import { prepareRings, worldData, type RingSet } from "../world-data";

function disc(points: [number, number, boolean][]): DiscRing {
  return {
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    front: points.map((p) => p[2]),
    length: points.length,
  };
}

function projectRing(set: RingSet, ring: number, cLat: number, cLon: number) {
  const projector = makeProjector(cLat, cLon);
  const start = set.starts[ring];
  const end = set.starts[ring + 1];
  const pts: DiscRing = { x: [], y: [], front: [], length: end - start };
  const out = { x: 0, y: 0, cosC: 0 };
  let anyFront = false;
  let anyBack = false;
  for (let i = start; i < end; i++) {
    projectPrepared(projector, set.terms, i, out);
    pts.x.push(out.x);
    pts.y.push(out.y);
    pts.front.push(out.cosC > 0.005);
    if (out.cosC >= 0) anyFront = true;
    else anyBack = true;
  }
  return { pts, anyFront, anyBack };
}

// Non-zero winding, the rule a non-inverted land fill is drawn with.
function windingContains(poly: number[], x: number, y: number): boolean {
  let winding = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2];
    const by = poly[((i + 1) % n) * 2 + 1];
    const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && side > 0) winding++;
    else if (ay > y && by <= y && side < 0) winding--;
  }
  return winding !== 0;
}

const SQUARE: [number, number, boolean][] = [
  [-0.5, -0.5, true],
  [0.5, -0.5, true],
  [0.5, 0.5, true],
  [-0.5, 0.5, true],
];

describe("frontRuns", () => {
  it("closes a ring that is wholly in front", () => {
    const runs = frontRuns(disc(SQUARE), true);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength((SQUARE.length + 1) * 2);
    expect(runs[0].slice(0, 2)).toEqual(runs[0].slice(-2));
  });

  it("leaves an open line open", () => {
    const runs = frontRuns(disc(SQUARE), false);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(SQUARE.length * 2);
    expect(runs[0].slice(0, 2)).not.toEqual(runs[0].slice(-2));
  });

  it("splits a ring where it crosses the limb", () => {
    const runs = frontRuns(
      disc([
        [-0.5, 0, true],
        [0, 0, true],
        [0.5, 0, false],
        [0.2, 0.2, true],
      ]),
      false,
    );
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.length).toBeGreaterThanOrEqual(4);
  });

  it("breaks rather than drawing a chord across the antimeridian", () => {
    const runs = frontRuns(
      disc([
        [-0.9, 0, true],
        [-0.8, 0, true],
        [0.8, 0, true],
        [0.9, 0, true],
      ]),
      false,
    );
    expect(runs).toHaveLength(2);
  });
});

describe("clipping", () => {
  it("clamps a segment to the rect, and drops one outside it", () => {
    const rect = { left: 0, top: 0, right: 10, bottom: 10 };
    const out = [0, 0, 0, 0];
    expect(clipSegment(-10, 5, 20, 5, rect, out)).toBe(true);
    expect(out).toEqual([0, 5, 10, 5]);
    expect(clipSegment(-10, -5, 20, -5, rect, out)).toBe(false);
  });

  it("keeps only the visible part of a polygon", () => {
    const rect = { left: 0, top: 0, right: 10, bottom: 10 };
    const clipped = clipPolygon([-5, -5, 15, -5, 15, 15, -5, 15], rect);
    expect(clipped).toHaveLength(8);
    for (let i = 0; i < clipped.length; i += 2) {
      expect(clipped[i]).toBeGreaterThanOrEqual(0);
      expect(clipped[i]).toBeLessThanOrEqual(10);
      expect(clipped[i + 1]).toBeGreaterThanOrEqual(0);
      expect(clipped[i + 1]).toBeLessThanOrEqual(10);
    }
  });

  it("grows the viewport by a screen each way", () => {
    expect(clipRectFor(400, 800)).toEqual({
      left: -400,
      top: -800,
      right: 800,
      bottom: 1600,
    });
  });
});

describe("containment", () => {
  it("tells inside from outside on screen", () => {
    const square = [-10, -10, 10, -10, 10, 10, -10, 10];
    expect(polygonContains(square, 0, 0)).toBe(true);
    expect(polygonContains(square, 20, 0)).toBe(false);
  });

  it("tells inside from outside on the sphere", () => {
    const set = prepareRings([
      { lats: [-10, -10, 10, 10], lons: [-10, 10, 10, -10] },
    ]);
    expect(ringContains(set, 0, 0, 0)).toBe(true);
    expect(ringContains(set, 0, 20, 0)).toBe(false);
  });

  it("follows a ring across the antimeridian", () => {
    const set = prepareRings([
      { lats: [-10, -10, 10, 10], lons: [170, -170, -170, 170] },
    ]);
    expect(ringContains(set, 0, 0, 180)).toBe(true);
    expect(ringContains(set, 0, 0, -175)).toBe(true);
    expect(ringContains(set, 0, 20, 180)).toBe(false);
    expect(ringContains(set, 0, 0, 0)).toBe(false);
  });

  it("does not invert a small ring in plain view", () => {
    const set = prepareRings([
      { lats: [-10, -10, 10, 10], lons: [-10, 10, 10, -10] },
    ]);
    const { pts } = projectRing(set, 0, 0, 0);
    const polygon = fillPolygon(pts, 100, 100, 100);
    expect(
      projectedFillNeedsInversion(polygon, set, 0, 100, 100, 100, 0, 0),
    ).toBe(false);
  });
});

describe("the bundled coastline", () => {
  const { land } = worldData();
  const isLand = (lat: number, lon: number) => {
    for (let i = 0; i < land.count; i++) {
      if (land.holes[i] === 0 && ringContains(land, i, lat, lon)) {
        let inHole = false;
        for (let h = 0; h < land.count; h++) {
          if (land.holes[h] === 1 && ringContains(land, h, lat, lon)) {
            inHole = true;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  };

  // Eurasia wraps the antimeridian at Chukotka; a seam counted as a crossing
  // read open ocean as Eurasia and flipped its fill over two oceans.
  it("classifies oceans and continents", () => {
    for (const [lat, lon] of [
      [0, -150],
      [32.3, -64.8],
      [40, -50],
      [-30, 80],
      [10, -30],
      [60, -85],
      // The Caspian, the one hole in the 110m set.
      [41.5, 50.5],
    ]) {
      expect([lat, lon, isLand(lat, lon)]).toEqual([lat, lon, false]);
    }
    for (const [lat, lon] of [
      [55.75, 37.62],
      [64.7, 177.5],
      [39.9, 116.4],
      [39, -98],
      [-15.8, -47.9],
      [0, 20],
    ]) {
      expect([lat, lon, isLand(lat, lon)]).toEqual([lat, lon, true]);
    }
  });

  // No visible ocean point may sit under a land fill, from any vantage point.
  it("never paints visible ocean as land", () => {
    const width = 402;
    const height = 874;
    const cx = width / 2;
    const cy = height / 2;
    const clip = clipRectFor(width, height);
    const oceans = [
      [32.3, -64.8],
      [40, -50],
      [30, -20],
      [0, -150],
      [-30, 80],
    ];
    const failures: string[] = [];
    for (let cLat = -60; cLat <= 60; cLat += 30) {
      for (let cLon = -180; cLon < 180; cLon += 30) {
        for (const zoom of [1, 3, 8]) {
          const r = BASE_RADIUS_FRACTION * width * zoom;
          for (const [oLat, oLon] of oceans) {
            const p = project(oLat, oLon, cLat, cLon);
            if (p === null || Math.sqrt(p.x * p.x + p.y * p.y) >= 0.98) {
              continue;
            }
            const sx = cx + p.x * r;
            const sy = cy + p.y * r;
            if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
            for (let ring = 0; ring < land.count; ring++) {
              if (land.holes[ring] === 1) continue;
              const { pts, anyFront, anyBack } = projectRing(
                land,
                ring,
                cLat,
                cLon,
              );
              if (!anyFront) continue;
              const polygon = fillPolygon(pts, cx, cy, r);
              const invert =
                anyBack &&
                projectedFillNeedsInversion(
                  polygon,
                  land,
                  ring,
                  cx,
                  cy,
                  r,
                  cLat,
                  cLon,
                );
              const clipped = clipPolygon(polygon, clip);
              if (clipped.length < 6) continue;
              const inDisc = (sx - cx) ** 2 + (sy - cy) ** 2 <= r * r;
              const painted = invert
                ? inDisc !== polygonContains(clipped, sx, sy)
                : windingContains(clipped, sx, sy);
              if (painted) {
                failures.push(`${oLat},${oLon} from ${cLat},${cLon} x${zoom}`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
