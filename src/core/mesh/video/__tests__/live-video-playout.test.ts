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

  test("sound leaves 150 ms ahead of its moment, the picture exactly on it", () => {
    const p = new LiveVideoPlayout<{
      ptsMs: number;
      track: "video" | "audio";
    }>();
    p.push({ ptsMs: 0, track: "video" }, 1_000);
    p.push({ ptsMs: 0, track: "audio" }, 1_000);
    expect(p.take(1_199)).toEqual([]);
    expect(p.take(1_200)).toEqual([{ ptsMs: 0, track: "audio" }]);
    expect(p.take(1_349)).toEqual([]);
    expect(p.take(1_350)).toEqual([{ ptsMs: 0, track: "video" }]);
  });

  test("drops sound more than 100 ms late so lag cannot build up, but still shows late video", () => {
    const p = new LiveVideoPlayout<{
      ptsMs: number;
      track: "video" | "audio";
    }>();
    // Due at 350, 650 and 350. A stall keeps the caller away until 500.
    p.push({ ptsMs: 0, track: "audio" }, 0);
    p.push({ ptsMs: 300, track: "audio" }, 0);
    p.push({ ptsMs: 0, track: "video" }, 0);
    expect(p.take(500)).toEqual([
      { ptsMs: 0, track: "video" },
      { ptsMs: 300, track: "audio" },
    ]);
    expect(p.size).toBe(0);
  });

  // A sender's stream as it reaches a 40 ms playout tick: sound every 64 ms
  // and a picture every 40 ms of pts, each arriving `delayFor(pts)` after it
  // was sent. Returns what each track released, by pts, and when.
  function play(
    delayFor: (ptsMs: number, track: "video" | "audio") => number,
    untilMs: number,
  ): { audio: Map<number, number>; video: Map<number, number> } {
    type Unit = { ptsMs: number; track: "video" | "audio" };
    const arrivals: { atMs: number; unit: Unit }[] = [];
    for (let pts = 0; pts < untilMs; pts += 64) {
      const unit: Unit = { ptsMs: pts, track: "audio" };
      arrivals.push({ atMs: pts + delayFor(pts, "audio"), unit });
    }
    for (let pts = 0; pts < untilMs; pts += 40) {
      const unit: Unit = { ptsMs: pts, track: "video" };
      arrivals.push({ atMs: pts + delayFor(pts, "video"), unit });
    }
    arrivals.sort((a, b) => a.atMs - b.atMs);
    const p = new LiveVideoPlayout<Unit>();
    const audio = new Map<number, number>();
    const video = new Map<number, number>();
    let next = 0;
    for (let now = 0; now < untilMs + 3_000; now++) {
      while (next < arrivals.length && arrivals[next].atMs <= now) {
        p.push(arrivals[next].unit, now);
        next++;
      }
      if (now % 40 !== 0) continue;
      for (const u of p.take(now)) {
        (u.track === "audio" ? audio : video).set(u.ptsMs, now);
      }
    }
    return { audio, video };
  }

  test("sound comes back in step with the picture under a steady extra delay", () => {
    // A busy relay adds 450 ms from 2 s on: past the jitter buffer by the
    // full lateness sound may have.
    const { audio, video } = play((pts) => (pts >= 2_000 ? 450 : 0), 8_000);
    // Every frame of sound from half a second after the change on.
    const sent = Array.from({ length: 125 }, (_, i) => i * 64);
    const settled = sent.filter((pts) => pts >= 2_500);
    expect(settled.filter((pts) => !audio.has(pts))).toEqual([]);
    // In step: sound leaves at most its lead ahead of the picture at its pts.
    for (const pts of [3_200, 5_120, 7_680]) {
      const heard = audio.get(pts);
      const shown = video.get(pts);
      expect(heard).toBeDefined();
      expect(shown).toBeDefined();
      expect(shown! - heard!).toBeGreaterThanOrEqual(0);
      expect(shown! - heard!).toBeLessThanOrEqual(150 + 40);
    }
  });

  test("a single late frame of sound is dropped without moving the clock", () => {
    const { audio, video } = play(
      (pts, track) => (track === "audio" && pts === 1_280 ? 700 : 0),
      4_000,
    );
    expect(audio.has(1_280)).toBe(false);
    expect(audio.has(1_344)).toBe(true);
    // The picture keeps the clock it started with: due 350 ms after its pts,
    // shown at the first tick on or after that.
    for (const pts of [1_280, 2_000, 3_960]) {
      expect(video.get(pts)).toBe(Math.ceil((pts + 350) / 40) * 40);
    }
  });

  test("a backlog nobody drains is bounded", () => {
    const p = new LiveVideoPlayout<ReturnType<typeof unit>>();
    for (let i = 0; i < 200; i++) p.push(unit(i * 10), i * 10);
    expect(p.size).toBe(96);
    expect(p.flush()[0].ptsMs).toBe(1_040);
    expect(p.size).toBe(0);
  });
});
