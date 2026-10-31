// The receive clock: 350 ms behind the first unit, rebased rather than stalled.

import { LiveVideoPlayout } from "../live-video-playout";

const unit = (ptsMs: number, id = ptsMs) => ({ ptsMs, id });

describe("LiveVideoPlayout", () => {
  test("holds the first unit for the jitter buffer, then keeps the sender's pace", () => {
    const p = new LiveVideoPlayout<ReturnType<typeof unit>>();
    p.push(unit(0), 1_000);
    p.push(unit(125), 1_010);
    expect(p.take(1_349)).toEqual([]);
    expect(p.take(1_350).map((u) => u.ptsMs)).toEqual([0]);
    expect(p.take(1_474)).toEqual([]);
    expect(p.take(1_475).map((u) => u.ptsMs)).toEqual([125]);
  });

  test("releases both tracks in presentation order", () => {
    const p = new LiveVideoPlayout<ReturnType<typeof unit>>();
    p.push(unit(0, 1), 0);
    p.push(unit(64, 2), 0);
    p.push(unit(40, 3), 0);
    expect(p.take(10_000).map((u) => u.id)).toEqual([1, 3, 2]);
  });

  test("a unit far behind rebases the clock instead of showing late", () => {
    const p = new LiveVideoPlayout<ReturnType<typeof unit>>();
    p.push(unit(0), 0);
    p.take(350);
    // A dropout: the next unit is 10 s of pts later but arrives 20 s later.
    p.push(unit(10_000), 20_000);
    expect(p.take(20_349)).toEqual([]);
    expect(p.take(20_350).map((u) => u.ptsMs)).toEqual([10_000]);
  });

  test("a unit far ahead rebases too", () => {
    const p = new LiveVideoPlayout<ReturnType<typeof unit>>();
    p.push(unit(0), 0);
    expect(p.take(350)).toHaveLength(1);
    p.push(unit(60_000), 400);
    expect(p.take(749)).toEqual([]);
    expect(p.take(750).map((u) => u.ptsMs)).toEqual([60_000]);
  });

  test("a backlog nobody drains is bounded", () => {
    const p = new LiveVideoPlayout<ReturnType<typeof unit>>();
    for (let i = 0; i < 200; i++) p.push(unit(i * 10), i * 10);
    expect(p.size).toBe(96);
    expect(p.flush()[0].ptsMs).toBe(1_040);
    expect(p.size).toBe(0);
  });
});
