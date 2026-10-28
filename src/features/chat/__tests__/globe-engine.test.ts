// The globe engine's sequencing: the opening flight, the frame clock, when a
// frame republishes the camera, and how touches end. The rules it sequences
// are tested in src/utils/__tests__/globe-camera.test.ts; this pins the loop
// that runs them on the UI thread, driven here by a fake clock.

import { encodeGeohash, geohashCenter } from "@utils/geohash-grid";
import { startTarget } from "@utils/globe-camera";
import type { GestureTouchEvent } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import {
  layout,
  makeEngine,
  makeTouch,
  stepPrecision,
  stop,
  touchesDown,
  touchesMove,
  touchesUp,
  type GlobeEngine,
  type TouchState,
} from "../globe-engine";

// Frames run by hand, so a test sees exactly how many there were and when
// the clock let go.
let queued: ((now: number) => void)[] = [];
let clock = 0;
const realRaf = globalThis.requestAnimationFrame;

beforeEach(() => {
  queued = [];
  clock = 0;
  globalThis.requestAnimationFrame = (cb: (now: number) => void) => {
    queued.push(cb);
    return queued.length;
  };
  jest.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  jest.restoreAllMocks();
});

function shared<T>(value: T): SharedValue<T> & { modify: jest.Mock } {
  return { value, modify: jest.fn() } as unknown as SharedValue<T> & {
    modify: jest.Mock;
  };
}

// Runs frames 16 ms apart until the clock stops or the limit is hit.
function runFrames(limit = 1000): number {
  let frames = 0;
  while (queued.length > 0 && frames < limit) {
    const due = queued;
    queued = [];
    clock += 16;
    for (const cb of due) cb(clock);
    frames++;
  }
  return frames;
}

function touchEvent(
  changed: { id: number; x: number; y: number }[],
  all: { id: number; x: number; y: number }[],
): GestureTouchEvent {
  const data = (t: { id: number; x: number; y: number }) => ({
    ...t,
    absoluteX: t.x,
    absoluteY: t.y,
  });
  return {
    handlerTag: 1,
    numberOfTouches: all.length,
    state: 0,
    eventType: 0,
    allTouches: all.map(data),
    changedTouches: changed.map(data),
    pointerType: 0,
  } as unknown as GestureTouchEvent;
}

function laidOut(geohash: string, still = false) {
  const engine = shared<GlobeEngine>(
    makeEngine(startTarget(geohash, []), still),
  );
  const touch = shared<TouchState>(makeTouch());
  layout(engine, 400, 800);
  return { engine, touch };
}

describe("opening", () => {
  it("flies to the starting cell, then lets the clock go", () => {
    const { engine } = laidOut("u2edk");
    expect(engine.value.tween).not.toBeNull();
    const frames = runFrames();
    expect(frames).toBeGreaterThan(60);
    expect(frames).toBeLessThan(120);
    expect(queued).toHaveLength(0);
    expect(engine.value.camera.selected).toBe("u2edk");
    expect(engine.value.running).toBe(false);
  });

  it("lands at once with reduce motion", () => {
    const { engine } = laidOut("u2edk", true);
    expect(runFrames()).toBe(1);
    expect(engine.value.camera.selected).toBe("u2edk");
  });

  it("flies only once, however often it is laid out", () => {
    const { engine } = laidOut("u2edk");
    runFrames();
    layout(engine, 380, 820);
    expect(engine.value.tween).toBeNull();
    expect(queued).toHaveLength(0);
  });
});

describe("touches", () => {
  it("redraws nothing while a finger rests on the globe", () => {
    const { engine, touch } = laidOut("u2edk", true);
    runFrames();
    touchesDown(
      engine,
      touch,
      touchEvent([{ id: 1, x: 200, y: 400 }], [{ id: 1, x: 200, y: 400 }]),
    );
    engine.modify.mockClear();
    runFrames(30);
    expect(engine.modify).not.toHaveBeenCalled();
    // Still holding on: the clock keeps measuring frames for the governor.
    expect(queued).toHaveLength(1);
  });

  it("turns the globe under a drag and stops when the finger lifts", () => {
    const { engine, touch } = laidOut("u2edk", true);
    runFrames();
    const lon = engine.value.camera.lon;
    const down = [{ id: 1, x: 200, y: 400 }];
    touchesDown(engine, touch, touchEvent(down, down));
    const moved = [{ id: 1, x: 260, y: 400 }];
    touchesMove(engine, touch, touchEvent(moved, moved));
    expect(engine.value.camera.lon).toBeLessThan(lon);
    // The finger rests before lifting, so nothing flings on.
    clock += 200;
    touchesUp(engine, touch, touchEvent(moved, []), false);
    runFrames();
    expect(engine.value.interacting).toBe(false);
    expect(engine.value.fling).toBeNull();
    expect(queued).toHaveLength(0);
  });

  it("spins on after a fast release, then comes to rest", () => {
    const { engine, touch } = laidOut("u2edk", false);
    runFrames();
    let x = 100;
    const at = () => [{ id: 1, x, y: 400 }];
    touchesDown(engine, touch, touchEvent(at(), at()));
    for (let i = 0; i < 5; i++) {
      clock += 16;
      x += 24;
      touchesMove(engine, touch, touchEvent(at(), at()));
    }
    const lon = engine.value.camera.lon;
    touchesUp(engine, touch, touchEvent(at(), []), false);
    expect(engine.value.fling).not.toBeNull();
    expect(runFrames()).toBeGreaterThan(10);
    expect(engine.value.camera.lon).toBeLessThan(lon);
    expect(queued).toHaveLength(0);
  });

  it("zooms in and refines the cell as two fingers spread", () => {
    const { engine, touch } = laidOut("u2", true);
    runFrames();
    const zoom = engine.value.camera.zoom;
    const precision = engine.value.camera.precision;
    const pinch = (spread: number) => [
      { id: 1, x: 200 - spread, y: 400 },
      { id: 2, x: 200 + spread, y: 400 },
    ];
    touchesDown(engine, touch, touchEvent(pinch(20), pinch(20)));
    for (const spread of [40, 80, 160]) {
      touchesMove(engine, touch, touchEvent(pinch(spread), pinch(spread)));
    }
    expect(engine.value.camera.zoom).toBeCloseTo(zoom * 8, 6);
    expect(engine.value.camera.precision).toBeGreaterThan(precision);
    // A pinch never flings, however fast the fingers left.
    touchesUp(engine, touch, touchEvent(pinch(160), []), false);
    expect(engine.value.fling).toBeNull();
  });

  it("focuses where a quick tap lands, keeping the cell size", () => {
    const { engine, touch } = laidOut("u2edk", true);
    runFrames();
    const precision = engine.value.camera.precision;
    const at = [{ id: 1, x: 260, y: 400 }];
    touchesDown(engine, touch, touchEvent(at, at));
    clock += 50;
    touchesUp(engine, touch, touchEvent(at, []), false);
    runFrames();
    const center = geohashCenter("u2edk");
    expect(engine.value.camera.lon).toBeGreaterThan(center.lon);
    expect(engine.value.camera.precision).toBe(precision);
  });

  it("ends the motion when the touch is cancelled", () => {
    const { engine, touch } = laidOut("u2edk", true);
    runFrames();
    const down = [{ id: 1, x: 200, y: 400 }];
    touchesDown(engine, touch, touchEvent(down, down));
    touchesUp(engine, touch, touchEvent(down, []), true);
    runFrames();
    expect(engine.value.interacting).toBe(false);
    expect(queued).toHaveLength(0);
  });
});

describe("closing", () => {
  // A finger can be down as the picker goes, and its cancel never comes.
  it("lets the clock go once stopped, even mid-touch", () => {
    const { engine, touch } = laidOut("u2edk", true);
    runFrames();
    const down = [{ id: 1, x: 200, y: 400 }];
    touchesDown(engine, touch, touchEvent(down, down));
    runFrames(5);
    expect(queued).toHaveLength(1);
    stop(engine);
    runFrames();
    expect(queued).toHaveLength(0);
  });
});

describe("precision buttons", () => {
  it("step the cell size and land on the finer cell", () => {
    const { engine } = laidOut("u2edk");
    runFrames();
    stepPrecision(engine, 1);
    runFrames();
    const c = engine.value.camera;
    expect(c.precision).toBe(6);
    expect(c.selected).toBe(encodeGeohash(c.lat, c.lon, 6));
  });
});
