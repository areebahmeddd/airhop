// How the picker's view moves and what it selects, ported from bitchat-ios's
// GlobeStateTests and GeohashPickerTargetTests. The selection must be the cell
// under the screen centre, so these pin encodes against fixed views.

import { encodeGeohash, geohashCenter } from "../geohash-grid";
import {
  DOUBLE_TAP_ZOOM,
  FLY_IN_MS,
  applyTween,
  focusTween,
  introTween,
  makeCamera,
  makeFling,
  precisionTween,
  rotateBy,
  setViewport,
  startTarget,
  stepFling,
  stepTween,
  zoomBy,
  type Camera,
} from "../globe-camera";
import { MAX_ZOOM, MIN_ZOOM, autoPrecision } from "../globe-math";

const BASE = 170;
const SCREEN = 390;

function laidOut(lat: number, lon: number, precision: number): Camera {
  const c = makeCamera({ lat, lon, precision }, false);
  setViewport(c, BASE, SCREEN);
  return c;
}

describe("startTarget", () => {
  it("prefers the given geohash", () => {
    const t = startTarget("u2edk", ["u2"]);
    const center = geohashCenter("u2edk");
    expect(t).toEqual({ lat: center.lat, lon: center.lon, precision: 5 });
  });

  it("falls back to the coarsest cell the phone is in", () => {
    const t = startTarget(null, ["u2edk", "u2e", "u2edk7q"]);
    expect(t.precision).toBe(3);
    expect(t.lat).toBe(geohashCenter("u2e").lat);
  });

  it("defaults to a wide view of the world", () => {
    expect(startTarget(null, [])).toEqual({ lat: 20, lon: 0, precision: 2 });
    expect(startTarget("", [])).toEqual({ lat: 20, lon: 0, precision: 2 });
  });
});

describe("selection", () => {
  it("follows the view centre once laid out", () => {
    const c = makeCamera({ lat: 48.2, lon: 16.4, precision: 4 }, false);
    expect(c.selected).toBe("");
    expect(setViewport(c, BASE, SCREEN)).toBe(true);
    expect(c.selected).toBe(encodeGeohash(48.2, 16.4, 4));
    expect(setViewport(c, BASE, SCREEN)).toBe(false);
  });

  it("does nothing before the first layout", () => {
    const c = makeCamera({ lat: 0, lon: 0, precision: 2 }, false);
    rotateBy(c, 100, 100);
    expect(c.lat).toBe(0);
    expect(c.selected).toBe("");
  });
});

describe("gestures", () => {
  it("raises precision on a pinch and clamps a drag near the pole", () => {
    const c = laidOut(0, 0, 1);
    const before = c.precision;
    zoomBy(c, 64);
    expect(c.precision).toBeGreaterThan(before);
    rotateBy(c, 0, 1_000_000);
    expect(c.lat).toBeLessThanOrEqual(89);
    expect(c.selected).toHaveLength(c.precision);
  });

  it("keeps zoom in bounds and pinches no finer than block cells", () => {
    const c = laidOut(0, 0, 2);
    zoomBy(c, 0.0001);
    expect(c.zoom).toBe(MIN_ZOOM);
    zoomBy(c, 1e12);
    expect(c.zoom).toBe(MAX_ZOOM);
    expect(c.precision).toBe(autoPrecision(BASE * MAX_ZOOM, SCREEN));
    expect(c.precision).toBe(7);
  });

  it("moves the land with the finger", () => {
    const c = laidOut(0, 0, 2);
    rotateBy(c, 50, 0);
    expect(c.lon).toBeLessThan(0);
    rotateBy(c, 0, 50);
    expect(c.lat).toBeGreaterThan(0);
  });

  it("never snaps a polar view back to the drag limit", () => {
    const center = geohashCenter("zzzz");
    const c = laidOut(center.lat, center.lon, 4);
    const start = c.lat;
    rotateBy(c, 0, 50);
    expect(c.lat).toBe(start);
    rotateBy(c, 0, -0.01);
    expect(c.lat).toBeLessThan(start);
    expect(c.lat).toBeGreaterThan(89);
    rotateBy(c, 0, -1_000_000);
    expect(c.lat).toBe(-89);
  });

  it("ignores a slow fling and runs a fast one down", () => {
    expect(makeFling(10, -10)).toBeNull();
    const fling = makeFling(800, 0);
    expect(fling).not.toBeNull();
    const c = laidOut(0, 0, 2);
    let frames = 0;
    while (fling !== null && stepFling(c, fling, 16) && frames < 1000) {
      frames++;
    }
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(1000);
    expect(c.lon).toBeLessThan(0);
  });
});

describe("animations", () => {
  // bitchat-ios #1807 review: zzzz's centre is past the drag limit. The flight
  // used to clamp there and select zzzf, while the reduced-motion path kept
  // zzzz.
  it("lands a polar flight on the requested cell", () => {
    const target = startTarget("zzzz", []);
    expect(target.lat).toBeGreaterThan(89);
    const flying = makeCamera(target, true);
    setViewport(flying, BASE, SCREEN);
    const tween = introTween(flying, target, FLY_IN_MS);
    expect(stepTween(flying, tween, 100)).toBe(false);
    expect(stepTween(flying, tween, 100 + FLY_IN_MS)).toBe(true);
    expect(flying.selected).toBe("zzzz");

    const still = makeCamera(target, true);
    setViewport(still, BASE, SCREEN);
    applyTween(still, introTween(still, target, 0), 1);
    expect(still.selected).toBe("zzzz");
    expect(still.lat).toBe(flying.lat);
  });

  it("flies in from a wide, offset view", () => {
    const target = startTarget("u2edk", []);
    const c = makeCamera(target, true);
    expect(c.lat).toBeCloseTo(target.lat * 0.4, 9);
    expect(c.zoom).toBe(MIN_ZOOM);
    setViewport(c, BASE, SCREEN);
    const tween = introTween(c, target, FLY_IN_MS);
    stepTween(c, tween, 0);
    stepTween(c, tween, FLY_IN_MS);
    expect(c.selected).toBe("u2edk");
    expect(c.precision).toBe(5);
  });

  it("zooms in on a double tap and only pans on a single one", () => {
    const c = laidOut(0, 0, 2);
    const zoom = c.zoom;
    const single = focusTween(c, 10, 10, false);
    expect(single.endZoom).toBe(zoom);
    const double = focusTween(c, 10, 10, true);
    expect(double.endZoom).toBeCloseTo(zoom * DOUBLE_TAP_ZOOM, 9);
    applyTween(c, double, 1);
    expect(c.lat).toBeCloseTo(10, 9);
    expect(c.lon).toBeCloseTo(10, 9);
  });

  it("never coarsens the cell on a tap", () => {
    const c = laidOut(0, 0, 7);
    zoomBy(c, 1e12);
    applyTween(c, precisionTween(c, 9)!, 1);
    applyTween(c, focusTween(c, 0.0001, 0.0001, false), 1);
    expect(c.precision).toBe(9);
    applyTween(c, focusTween(c, 0, 0, true), 1);
    expect(c.precision).toBe(9);
  });

  it("refines the cell when a double tap zooms past the next threshold", () => {
    const c = laidOut(0, 0, 2);
    const before = c.precision;
    for (let i = 0; i < 6; i++) applyTween(c, focusTween(c, 0, 0, true), 1);
    expect(c.precision).toBeGreaterThan(before);
    expect(c.precision).toBe(autoPrecision(BASE * c.zoom, SCREEN));
  });

  it("steps precision with the buttons, past what a pinch reaches", () => {
    const c = laidOut(0, 0, 7);
    zoomBy(c, 1e12);
    const finer = precisionTween(c, 8);
    expect(finer).not.toBeNull();
    applyTween(c, finer!, 1);
    expect(c.precision).toBe(8);
    expect(c.selected).toHaveLength(8);
    expect(precisionTween(c, 8)).toBeNull();
    expect(precisionTween(c, 99)?.targetPrecision).toBe(12);
  });

  it("takes the short way round the antimeridian", () => {
    const c = laidOut(0, 170, 2);
    const tween = focusTween(c, 0, -170, false);
    expect(tween.dLon).toBeCloseTo(20, 9);
    applyTween(c, tween, 0.5);
    expect(Math.abs(c.lon)).toBeCloseTo(180, 9);
  });
});
