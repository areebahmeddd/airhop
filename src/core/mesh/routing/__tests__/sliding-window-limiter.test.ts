/**
 * @jest-environment node
 */
import { SlidingWindowLimiter } from "../sliding-window-limiter";

describe("SlidingWindowLimiter", () => {
  test("admits max hits per window, then slides", () => {
    const l = new SlidingWindowLimiter(3, 1000);
    expect([0, 10, 20, 30].map((t) => l.tryAcquire("a", t))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // A refusal is not recorded, so the first hit ages out on time.
    expect(l.tryAcquire("a", 1000)).toBe(true);
    expect(l.tryAcquire("a", 1001)).toBe(false);
    expect(l.tryAcquire("b", 1001)).toBe(true);
  });

  test("allows records nothing", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    expect(l.allows("a", 0)).toBe(true);
    expect(l.allows("a", 0)).toBe(true);
    l.record("a", 0);
    expect(l.allows("a", 1)).toBe(false);
  });

  test("keys whose hits have all aged out are swept", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    for (let i = 0; i < 500; i++) l.tryAcquire(`id-${i}`, i);
    expect(l.size).toBe(500);
    l.tryAcquire("late", 3000);
    expect(l.size).toBe(1);
  });

  test("prune empties keys idle past the window without another check", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    l.tryAcquire("a", 0);
    l.tryAcquire("b", 900);
    l.prune(1500);
    expect(l.size).toBe(1);
    l.prune(3000);
    expect(l.size).toBe(0);
  });

  test("forget and reset clear a budget", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    l.tryAcquire("a", 0);
    l.forget("a");
    expect(l.tryAcquire("a", 1)).toBe(true);
    l.reset();
    expect(l.size).toBe(0);
  });
});
