// The globe's world geometry, unpacked from src/data/world-geometry.ts into
// the flat arrays the renderer projects every frame.
//
// Each point keeps its sines and cosines (four per point, in `terms`), which
// takes nearly all trigonometry out of an animated frame. Positions stay in
// degrees too, for the point-in-ring test the land fill needs. Decoded once,
// on the first picker open, and kept: about 300 KiB, small next to what a
// frame would otherwise recompute.

import { base64ToBytes } from "@core/encoding/base64";
import {
  BORDERS,
  CITY_FLAGS,
  CITY_NAMES,
  CITY_POINTS,
  LAND,
  type PackedRings,
} from "@data/world-geometry";

const HOLE_FLAG = 0x8000;
const DEG = Math.PI / 180;

export interface RingSet {
  count: number;
  // Ring `i` is points starts[i] up to starts[i + 1].
  starts: Uint32Array;
  // 1 for an interior ring (a lake inside a landmass).
  holes: Uint8Array;
  lats: Float64Array;
  lons: Float64Array;
  terms: Float64Array;
}

export interface CitySet {
  count: number;
  lats: Float64Array;
  lons: Float64Array;
  terms: Float64Array;
  // Natural Earth's label rank, 0 the most prominent.
  ranks: Uint8Array;
  capital: Uint8Array;
  megacity: Uint8Array;
  names: readonly string[];
}

export interface WorldData {
  land: RingSet;
  borders: RingSet;
  cities: CitySet;
}

function writeTerms(terms: Float64Array, i: number, lat: number, lon: number) {
  terms[i * 4] = Math.sin(lat * DEG);
  terms[i * 4 + 1] = Math.cos(lat * DEG);
  terms[i * 4 + 2] = Math.sin(lon * DEG);
  terms[i * 4 + 3] = Math.cos(lon * DEG);
}

// Rings given as positions in degrees. The decoder and the geometry tests
// build their sets through this one path.
export function prepareRings(
  rings: readonly { lats: readonly number[]; lons: readonly number[] }[],
  holes: readonly boolean[] = [],
): RingSet {
  const total = rings.reduce((n, r) => n + r.lats.length, 0);
  const set: RingSet = {
    count: rings.length,
    starts: new Uint32Array(rings.length + 1),
    holes: new Uint8Array(rings.length),
    lats: new Float64Array(total),
    lons: new Float64Array(total),
    terms: new Float64Array(total * 4),
  };
  let at = 0;
  rings.forEach((ring, r) => {
    set.starts[r] = at;
    set.holes[r] = holes[r] === true ? 1 : 0;
    for (let k = 0; k < ring.lats.length; k++, at++) {
      set.lats[at] = ring.lats[k];
      set.lons[at] = ring.lons[k];
      writeTerms(set.terms, at, ring.lats[k], ring.lons[k]);
    }
  });
  set.starts[rings.length] = at;
  return set;
}

function view(base64: string): DataView {
  const bytes = base64ToBytes(base64);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function unpackRings(packed: PackedRings): RingSet {
  const counts = view(packed.counts);
  const points = view(packed.points);
  const rings: { lats: number[]; lons: number[] }[] = [];
  const holes: boolean[] = [];
  let offset = 0;
  for (let i = 0; i < counts.byteLength; i += 2) {
    const word = counts.getUint16(i, true);
    const lats: number[] = [];
    const lons: number[] = [];
    for (let k = 0; k < (word & ~HOLE_FLAG); k++, offset += 4) {
      lats.push(points.getInt16(offset, true) / 100);
      lons.push(points.getInt16(offset + 2, true) / 100);
    }
    rings.push({ lats, lons });
    holes.push((word & HOLE_FLAG) !== 0);
  }
  return prepareRings(rings, holes);
}

function unpackCities(): CitySet {
  const points = view(CITY_POINTS);
  const flags = base64ToBytes(CITY_FLAGS);
  const count = flags.length;
  const set: CitySet = {
    count,
    lats: new Float64Array(count),
    lons: new Float64Array(count),
    terms: new Float64Array(count * 4),
    ranks: new Uint8Array(count),
    capital: new Uint8Array(count),
    megacity: new Uint8Array(count),
    names: CITY_NAMES,
  };
  for (let i = 0; i < count; i++) {
    set.lats[i] = points.getInt32(i * 8, true) / 1000;
    set.lons[i] = points.getInt32(i * 8 + 4, true) / 1000;
    writeTerms(set.terms, i, set.lats[i], set.lons[i]);
    set.ranks[i] = flags[i] & 0x0f;
    set.capital[i] = (flags[i] & 0x10) !== 0 ? 1 : 0;
    set.megacity[i] = (flags[i] & 0x20) !== 0 ? 1 : 0;
  }
  return set;
}

let cached: WorldData | null = null;

export function worldData(): WorldData {
  cached ??= {
    land: unpackRings(LAND),
    borders: unpackRings(BORDERS),
    cities: unpackCities(),
  };
  return cached;
}
