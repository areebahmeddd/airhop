// A wrong neighbour walks the user somewhere they did not point at, and the
// cases that break neighbour maths are exactly the ones nobody tests by hand:
// the poles and the date line. Values below are checked against the published
// geohash grid rather than against our own implementation.

import {
  geohashBounds,
  geohashCenter,
  geohashNeighbours,
} from "../geohash-grid";

describe("geohashBounds", () => {
  it("treats the empty prefix as the whole world", () => {
    expect(geohashBounds("")).toEqual({
      minLat: -90,
      maxLat: 90,
      minLon: -180,
      maxLon: 180,
    });
  });

  it("boxes a known cell", () => {
    // "u" is the north-east quadrant-ish cell covering much of Europe.
    const b = geohashBounds("u");
    expect(b.minLat).toBe(45);
    expect(b.maxLat).toBe(90);
    expect(b.minLon).toBe(0);
    expect(b.maxLon).toBe(45);
  });

  it("narrows as precision grows", () => {
    const wide = geohashBounds("tdr");
    const tight = geohashBounds("tdr1k");
    expect(tight.maxLat - tight.minLat).toBeLessThan(wide.maxLat - wide.minLat);
  });
});

describe("geohashNeighbours", () => {
  it("has none for the whole world", () => {
    expect(geohashNeighbours("")).toEqual([]);
  });

  it("finds the eight cells around an inland one", () => {
    const n = geohashNeighbours("tdr1k");
    expect(n).toHaveLength(8);
    expect(new Set(n.map((x) => x.geohash)).size).toBe(8);
    // A neighbour is a different cell of the same precision.
    expect(n.every((x) => x.geohash.length === 5)).toBe(true);
    expect(n.every((x) => x.geohash !== "tdr1k")).toBe(true);
  });

  it("puts north actually north", () => {
    const n = geohashNeighbours("tdr1k");
    const north = n.find((x) => x.direction === "N")!;
    expect(geohashCenter(north.geohash).lat).toBeGreaterThan(
      geohashCenter("tdr1k").lat,
    );
  });

  it("wraps across the date line instead of inventing a cell", () => {
    // "x" (lat 0..45, lon 135..180) sits against +180, so its eastern column
    // is the cells at lon -180..-135 on the other side. Without the wrap, E
    // re-encodes to "x" itself and is dropped, and NE / SE clamp to "z" / "r".
    const n = geohashNeighbours("x");
    expect(n).toHaveLength(8);
    const at = (d: string) => n.find((x) => x.direction === d)?.geohash;
    expect(at("NE")).toBe("b");
    expect(at("E")).toBe("8");
    expect(at("SE")).toBe("2");
  });

  // Read off the published base32 grid by hand: odd-length cells end in a
  // character from the 8-wide, 4-tall layout, even-length ones in the 4-wide,
  // 8-tall one.
  const byDirection = (gh: string): Record<string, string> =>
    Object.fromEntries(
      geohashNeighbours(gh).map((n) => [n.direction, n.geohash]),
    );

  it("matches the published neighbours of an odd-length cell", () => {
    expect(byDirection("dqcjq")).toEqual({
      N: "dqcjw",
      NE: "dqcjx",
      E: "dqcjr",
      SE: "dqcjp",
      S: "dqcjn",
      SW: "dqcjj",
      W: "dqcjm",
      NW: "dqcjt",
    });
  });

  it("matches the published neighbours of a bridge rendezvous cell", () => {
    // Precision 6, the bridge's cell size, wholly inside its parent.
    expect(byDirection("tdr1v9")).toEqual({
      N: "tdr1vd",
      NE: "tdr1vf",
      E: "tdr1vc",
      SE: "tdr1vb",
      S: "tdr1v8",
      SW: "tdr1v2",
      W: "tdr1v3",
      NW: "tdr1v6",
    });
  });

  it("carries across the parent cell's edge", () => {
    // "tdr1vb" is the bottom-right character of its parent, so its east and
    // south neighbours live under different parents ("tdr1y", "tdr1t").
    const n = byDirection("tdr1vb");
    expect(n.E).toBe("tdr1y0");
    expect(n.S).toBe("tdr1tz");
    expect(n.SE).toBe("tdr1wp");
    expect(n.N).toBe("tdr1vc");
  });

  it("has no northern row at the pole for a fine cell either", () => {
    const n = byDirection("zzzzzz");
    expect(Object.keys(n).sort()).toEqual(["E", "S", "SE", "SW", "W"]);
    // East of the top-right corner of the world is the top-left one.
    expect(n.E).toBe("bpbpbp");
  });

  it("drops the neighbour that would be past the pole", () => {
    // A top-row cell has no cell to its north.
    const n = geohashNeighbours("b");
    expect(n.some((x) => x.direction === "N")).toBe(false);
  });
});
