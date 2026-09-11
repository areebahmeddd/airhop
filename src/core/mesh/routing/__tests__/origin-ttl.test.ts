/**
 * @jest-environment node
 */
import { originTtl } from "../origin-ttl";

describe("originTtl", () => {
  it("stays inside 5..7 and is not always the maximum", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const ttl = originTtl();
      expect(ttl).toBeGreaterThanOrEqual(5);
      expect(ttl).toBeLessThanOrEqual(7);
      seen.add(ttl);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
