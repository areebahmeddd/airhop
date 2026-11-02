// Pins the packed world geometry to its source: decoding
// src/data/world-geometry.ts must give back exactly what
// assets/data/world/ holds. Fails when the generator's format changes without
// the decoder, or when a source file is updated without regenerating.

import { worldData } from "@utils/world-data";

// Declared rather than pulled in via @types/node, as settings-index.test.ts
// does: the app ships with no Node type dependency.
declare const __dirname: string;
declare function require(id: string): unknown;

const fs = require("fs") as {
  readFileSync(path: string, encoding: string): string;
};
const path = require("path") as { join(...parts: string[]): string };

interface Geometry {
  type: string;
  coordinates: unknown;
}

function source<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../../assets/data/world", name),
      "utf8",
    ),
  ) as T;
}

function ringsOf(
  geometries: Geometry[],
  polygon: boolean,
): { ring: number[][]; hole: boolean }[] {
  const out: { ring: number[][]; hole: boolean }[] = [];
  for (const g of geometries) {
    if (polygon) {
      const polygons =
        g.type === "Polygon"
          ? [g.coordinates as number[][][]]
          : (g.coordinates as number[][][][]);
      for (const p of polygons) {
        p.forEach((ring, i) => out.push({ ring, hole: i > 0 }));
      }
    } else {
      const lines =
        g.type === "LineString"
          ? [g.coordinates as number[][]]
          : (g.coordinates as number[][][]);
      for (const ring of lines) out.push({ ring, hole: false });
    }
  }
  return out;
}

describe("world geometry", () => {
  const world = worldData();

  it.each([
    ["land.geojson", "land", true],
    ["borders.geojson", "borders", false],
  ] as const)("round-trips %s exactly", (file, key, polygon) => {
    const want = ringsOf(
      source<{ geometries: Geometry[] }>(file).geometries,
      polygon,
    );
    const set = world[key];
    expect(set.count).toBe(want.length);
    want.forEach(({ ring, hole }, r) => {
      expect(set.holes[r]).toBe(hole ? 1 : 0);
      const start = set.starts[r];
      expect(set.starts[r + 1] - start).toBe(ring.length);
      ring.forEach(([lon, lat], k) => {
        expect(set.lats[start + k]).toBe(lat);
        expect(set.lons[start + k]).toBe(lon);
      });
    });
  });

  it("round-trips the cities exactly", () => {
    const want = source<{
      cities: {
        n: string;
        r: number;
        cap: number;
        mega: number;
        lat: number;
        lon: number;
      }[];
    }>("cities.geojson").cities;
    const { cities } = world;
    expect(cities.count).toBe(want.length);
    want.forEach((c, i) => {
      expect(cities.names[i]).toBe(c.n);
      expect(cities.ranks[i]).toBe(c.r);
      expect(cities.capital[i]).toBe(c.cap);
      expect(cities.megacity[i]).toBe(c.mega);
      expect(cities.lats[i]).toBe(c.lat);
      expect(cities.lons[i]).toBe(c.lon);
    });
  });

  it("has the shape bitchat ships", () => {
    expect(world.land.count).toBe(128);
    expect(world.land.lats).toHaveLength(5143);
    expect(world.borders.count).toBe(333);
    expect(world.borders.lats).toHaveLength(3108);
    expect(world.cities.count).toBe(1251);
    expect(Array.from(world.land.holes).filter(Boolean)).toHaveLength(1);
  });

  it("prepares the projection terms from the positions", () => {
    const { land } = world;
    const i = 1000;
    expect(land.terms[i * 4]).toBeCloseTo(
      Math.sin((land.lats[i] * Math.PI) / 180),
      12,
    );
    expect(land.terms[i * 4 + 3]).toBeCloseTo(
      Math.cos((land.lons[i] * Math.PI) / 180),
      12,
    );
  });
});
