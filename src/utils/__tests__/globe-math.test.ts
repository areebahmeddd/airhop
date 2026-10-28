// The projection and zoom rules the globe picker shares with bitchat. Ported
// from bitchat-ios's GlobePickerTests where one exists, so a regression there
// is a regression here; the pinned numbers below are bitchat's own.

import { encodeGeohash, geohashBounds } from "../geohash-grid";
import {
  BASE_RADIUS_FRACTION,
  MAX_PRECISION,
  MAX_ZOOM,
  MIN_ZOOM,
  autoPrecision,
  cellCoverageMeters,
  cellSpanLat,
  cellSpanLon,
  fastOutSlowIn,
  makeProjector,
  normalizeLon,
  projectPrepared,
  projectRaw,
  unproject,
  zoomForPrecision,
} from "../globe-math";

const DEG = Math.PI / 180;

function terms(lat: number, lon: number): Float64Array {
  return Float64Array.of(
    Math.sin(lat * DEG),
    Math.cos(lat * DEG),
    Math.sin(lon * DEG),
    Math.cos(lon * DEG),
  );
}

describe("projection", () => {
  it("agrees with the reference projection for prepared points", () => {
    const centers = [
      [0, 0],
      [45.25, 12.5],
      [-72, 179.5],
    ];
    const points = [
      [0, 0],
      [51.5074, -0.1278],
      [-33.8688, 151.2093],
      [89, -179.9],
    ];
    const out = { x: 0, y: 0, cosC: 0 };
    for (const [cLat, cLon] of centers) {
      const p = makeProjector(cLat, cLon);
      for (const [lat, lon] of points) {
        projectPrepared(p, terms(lat, lon), 0, out);
        const want = projectRaw(lat, lon, cLat, cLon);
        expect(out.x).toBeCloseTo(want.x, 9);
        expect(out.y).toBeCloseTo(want.y, 9);
        expect(out.cosC).toBeCloseTo(want.cosC, 9);
      }
    }
  });

  it("puts north up and the far side behind", () => {
    const north = projectRaw(10, 0, 0, 0);
    expect(north.y).toBeLessThan(0);
    expect(projectRaw(0, 180, 0, 0).cosC).toBeLessThan(0);
  });

  it("inverts with unproject, and refuses points off the disc", () => {
    const p = projectRaw(48.2, 16.4, 40, 10);
    const at = unproject(p.x, p.y, 40, 10);
    expect(at?.lat).toBeCloseTo(48.2, 9);
    expect(at?.lon).toBeCloseTo(16.4, 9);
    expect(unproject(0.9, 0.9, 0, 0)).toBeNull();
    expect(unproject(0, 0, 12, 200)).toEqual({ lat: 12, lon: -160 });
  });

  it("stays finite on the limb next to a pole", () => {
    for (const y of [-1, -0.9999999, 1]) {
      const at = unproject(0, y, 89.9999, 0);
      expect(Number.isFinite(at?.lat)).toBe(true);
      expect(Number.isFinite(at?.lon)).toBe(true);
    }
  });

  it("normalises longitude into [-180, 180]", () => {
    expect(normalizeLon(190)).toBe(-170);
    expect(normalizeLon(-190)).toBe(170);
    expect(normalizeLon(540)).toBe(180);
    expect(normalizeLon(-45)).toBe(-45);
  });
});

describe("zoom and precision", () => {
  it("keeps every framed zoom inside the interactive range", () => {
    for (let p = 1; p <= MAX_PRECISION; p++) {
      const zoom = zoomForPrecision(p, 400, 900);
      expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(zoom).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });

  // The buttons frame a precision and the pinch derives one; if they disagree,
  // the first pinch after a button press changes the cell size by itself.
  it("derives the same precision the buttons frame", () => {
    for (let p = 2; p <= MAX_PRECISION; p++) {
      const zoom = zoomForPrecision(p, 400, 900);
      if (zoom <= MIN_ZOOM || zoom >= MAX_ZOOM) continue;
      expect(autoPrecision(400 * zoom, 900)).toBe(p);
    }
  });

  it("matches the geohash grid's own cell sizes", () => {
    for (let p = 1; p <= 8; p++) {
      const b = geohashBounds(encodeGeohash(10, 10, p));
      expect(b.maxLat - b.minLat).toBeCloseTo(cellSpanLat(p), 9);
      expect(b.maxLon - b.minLon).toBeCloseTo(cellSpanLon(p), 9);
    }
  });

  it("tops out at precision 7 by pinching on a phone", () => {
    const screenMin = 390;
    const base = screenMin * BASE_RADIUS_FRACTION;
    expect(autoPrecision(base * MAX_ZOOM, screenMin)).toBe(7);
    expect(autoPrecision(base * MIN_ZOOM, screenMin)).toBe(1);
  });
});

describe("cellCoverageMeters", () => {
  it("quotes bitchat's sizes", () => {
    expect(cellCoverageMeters(1)).toBe(5_000_000);
    expect(cellCoverageMeters(2)).toBe(1_250_000);
    expect(cellCoverageMeters(5)).toBe(4_890);
    expect(cellCoverageMeters(7)).toBe(153);
    expect(cellCoverageMeters(10)).toBe(1.19);
    expect(cellCoverageMeters(12)).toBeCloseTo(1.19 / 16, 12);
  });
});

describe("fastOutSlowIn", () => {
  it("runs from 0 to 1 without stepping back", () => {
    expect(fastOutSlowIn(0)).toBe(0);
    expect(fastOutSlowIn(1)).toBe(1);
    let previous = 0;
    for (let step = 1; step <= 20; step++) {
      const value = fastOutSlowIn(step / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(fastOutSlowIn(0.5)).toBeGreaterThan(0.7);
  });
});
