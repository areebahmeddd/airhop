// The live video erasure code, case for case against bitchat's
// ReedSolomonErasureTests.

import { Prng } from "../../../../__tests__/simulation/harness/prng";
import {
  coefficient,
  encodeParity,
  gfInverse,
  gfMultiply,
  reconstruct,
} from "../reed-solomon";

describe("GF(256)", () => {
  test("every element times its inverse is one", () => {
    for (let v = 1; v < 256; v++) expect(gfMultiply(v, gfInverse(v))).toBe(1);
  });

  test("the field polynomial is 0x11D", () => {
    // x^7 * x = x^8 = x^4 + x^3 + x^2 + 1.
    expect(gfMultiply(0x80, 0x02)).toBe(0x1d);
    expect(gfMultiply(0, 0x53)).toBe(0);
    expect(coefficient(1, 0, 0)).toBe(1);
  });
});

describe("Reed-Solomon erasure", () => {
  test("any k of k + r symbols rebuild the block", () => {
    const random = new Prng(1234);
    for (const k of [1, 2, 5, 12, 32]) {
      for (const r of [1, 2, 4, 16]) {
        const sources = Array.from({ length: k }, () => random.bytes(64));
        const parity = encodeParity(sources, r);
        expect(parity).toHaveLength(r);
        for (let trial = 0; trial < 20; trial++) {
          const lostCount = random.int(0, Math.min(k, r));
          const lost = new Set(
            random.shuffle([...Array(k).keys()]).slice(0, lostCount),
          );
          const kept = new Map(
            random
              .shuffle([...Array(r).keys()])
              .slice(0, lostCount)
              .map((row) => [row, parity[row]] as const),
          );
          const slots = sources.map((s, i) => (lost.has(i) ? null : s));
          expect(reconstruct(slots, kept)).toEqual(sources);
        }
      }
    }
  });

  test("too few symbols, or lengths that disagree, cannot rebuild", () => {
    const sources = [0, 1, 2, 3].map((i) =>
      Uint8Array.from({ length: 8 }, (_, j) => i * 8 + j),
    );
    const parity = encodeParity(sources, 1);
    expect(
      reconstruct(
        [null, sources[1], null, sources[3]],
        new Map([[0, parity[0]]]),
      ),
    ).toBeNull();
    const pair = [1, 2].map((v) => new Uint8Array(8).fill(v));
    const short = encodeParity(pair, 1)[0].slice(0, 7);
    expect(reconstruct([null, pair[1]], new Map([[0, short]]))).toBeNull();
  });

  test("one source's parity is a copy of it", () => {
    const source = Uint8Array.from([1, 2, 3, 4]);
    const [parity] = encodeParity([source], 1);
    expect(parity).toEqual(source);
    expect(reconstruct([null], new Map([[0, parity]]))).toEqual([source]);
  });
});
