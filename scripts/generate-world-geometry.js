#!/usr/bin/env node
// Regenerates src/data/world-geometry.ts from assets/data/world/.
//
// The globe picker draws the world from Natural Earth (public domain): 110m
// land polygons, admin-0 boundary lines and 50m populated places. The three
// GeoJSON files are byte-identical to the ones bitchat-ios and bitchat-android
// bundle, so both apps draw the same coastlines and the same city dots. They
// are vendored in this repo and never fetched: the globe has to draw offline.
//
// Coordinates are packed rather than shipped as JSON. Land and borders carry
// two decimals in the source, so hundredths of a degree fit an Int16 exactly
// (longitude tops out at 18000); cities carry three, so they go in an Int32 as
// thousandths. Both are lossless, which the format test in
// src/data/__tests__/world-geometry.test.ts checks against these files. All
// integers are little-endian, written through DataView so the bytes do not
// depend on the machine running this script.
//
// Run after updating a file in assets/data/world/:
//   node scripts/generate-world-geometry.js

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "assets", "data", "world");
const OUT = path.join(__dirname, "..", "src", "data", "world-geometry.ts");

// The high bit of a ring's point count marks an interior ring (a hole). One
// ring in the 110m set is one, the Caspian Sea inside Eurasia, and the globe
// fills it as water.
const HOLE_FLAG = 0x8000;
// Base64 is split into lines this long so a regenerated file diffs by region.
const CHUNK = 100;

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(SRC, name), "utf8"));
}

function fail(message) {
  console.error(`generate-world-geometry: ${message}`);
  process.exit(1);
}

// Fixed-point, refusing any value the packing cannot hold exactly: a finer
// source would otherwise be rounded here without anyone noticing.
function fixed(value, scale, max) {
  const scaled = Math.round(value * scale);
  if (Math.abs(scaled - value * scale) > 1e-6) {
    fail(`${value} has more precision than 1/${scale} of a degree`);
  }
  if (Math.abs(scaled) > max) fail(`${value} is out of range`);
  return scaled;
}

// GeoJSON positions are [lon, lat]; the packed form is lat first, matching
// the globe's (lat, lon) argument order everywhere else.
function packRings(rings, holes) {
  const counts = new DataView(new ArrayBuffer(rings.length * 2));
  const total = rings.reduce((n, ring) => n + ring.length, 0);
  const points = new DataView(new ArrayBuffer(total * 4));
  let offset = 0;
  rings.forEach((ring, i) => {
    if (ring.length >= HOLE_FLAG) fail("a ring has too many points to pack");
    counts.setUint16(i * 2, ring.length | (holes[i] ? HOLE_FLAG : 0), true);
    for (const [lon, lat] of ring) {
      points.setInt16(offset, fixed(lat, 100, 9000), true);
      points.setInt16(offset + 2, fixed(lon, 100, 18000), true);
      offset += 4;
    }
  });
  return { counts, points, total };
}

const land = readJson("land.geojson");
const landRings = [];
const landHoles = [];
for (const geometry of land.geometries) {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : fail(`unexpected land geometry ${geometry.type}`);
  for (const polygon of polygons) {
    polygon.forEach((ring, i) => {
      if (ring.length < 3) return;
      landRings.push(ring);
      landHoles.push(i > 0);
    });
  }
}

const borders = readJson("borders.geojson");
const borderLines = [];
for (const geometry of borders.geometries) {
  const lines =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : fail(`unexpected border geometry ${geometry.type}`);
  for (const line of lines) if (line.length >= 2) borderLines.push(line);
}

const cities = readJson("cities.geojson").cities;
const cityPoints = new DataView(new ArrayBuffer(cities.length * 8));
const cityFlags = new Uint8Array(cities.length);
cities.forEach((city, i) => {
  if (!Number.isInteger(city.r) || city.r < 0 || city.r > 15) {
    fail(`city ${city.n} has rank ${city.r}`);
  }
  cityPoints.setInt32(i * 8, fixed(city.lat, 1000, 90000), true);
  cityPoints.setInt32(i * 8 + 4, fixed(city.lon, 1000, 180000), true);
  cityFlags[i] =
    city.r | (city.cap === 1 ? 0x10 : 0) | (city.mega === 1 ? 0x20 : 0);
});

const landPacked = packRings(landRings, landHoles);
const borderPacked = packRings(
  borderLines,
  borderLines.map(() => false),
);

// Laid out as Prettier lays it out at this depth, so formatting the repository
// leaves a freshly generated file untouched.
function base64(view, depth) {
  const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const text = bytes.toString("base64");
  const inner = "  ".repeat(depth + 1);
  const lines = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    lines.push(`${inner}"${text.slice(i, i + CHUNK)}",`);
  }
  return `[\n${lines.join("\n")}\n${"  ".repeat(depth)}].join("")`;
}

// JSON.stringify, not a bare "${...}": the names come from upstream data and
// land inside a bundled source file, so they are escaped rather than trusted.
const names = cities.map((c) => `  ${JSON.stringify(c.n)},`).join("\n");

fs.writeFileSync(
  OUT,
  `// Natural Earth geometry for the globe picker (public domain).
//
// Generated from assets/data/world/ by scripts/generate-world-geometry.js. Do
// not edit: regenerate. The packing is described there; world-data.ts in
// src/utils decodes it.

export interface PackedRings {
  // Points per ring, Uint16 little-endian. The high bit marks a hole.
  counts: string;
  // Hundredths of a degree, Int16 little-endian, latitude then longitude.
  points: string;
}

export const LAND: PackedRings = {
  counts: ${base64(landPacked.counts, 1)},
  points: ${base64(landPacked.points, 1)},
};

export const BORDERS: PackedRings = {
  counts: ${base64(borderPacked.counts, 1)},
  points: ${base64(borderPacked.points, 1)},
};

// Thousandths of a degree, Int32 little-endian, latitude then longitude.
export const CITY_POINTS = ${base64(cityPoints, 0)};

// One byte per city: Natural Earth's label rank in the low four bits (0 is the
// most prominent), then a capital bit (0x10) and a megacity bit (0x20).
export const CITY_FLAGS = ${base64(new DataView(cityFlags.buffer), 0)};

// Natural Earth's names, verbatim: place names are proper nouns and are never
// translated (see .github/skills/i18n.md).
export const CITY_NAMES: readonly string[] = [
${names}
];
`,
);

console.log(
  `Wrote src/data/world-geometry.ts: ${landRings.length} land rings ` +
    `(${landPacked.total} points), ${borderLines.length} border lines ` +
    `(${borderPacked.total} points), ${cities.length} cities`,
);
