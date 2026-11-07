// Safety codes. These properties are what the feature rests on, so they are
// pinned rather than assumed.

import { sha512 } from "@noble/hashes/sha2.js";
import {
  peerFingerprint,
  SAFETY_BITS_PER_WORD,
  SAFETY_WORD_COUNT,
  safetyCode,
  safetyNumberIndices,
} from "../fingerprint";

// A passthrough that counts stretching rounds, so the cache can be shown to
// skip them rather than inferred from timing.
jest.mock("@noble/hashes/sha2.js", () => {
  const actual = jest.requireActual<typeof import("@noble/hashes/sha2.js")>(
    "@noble/hashes/sha2.js",
  );
  return {
    ...actual,
    sha512: Object.assign(
      (message: Uint8Array) => actual.sha512(message),
      actual.sha512,
      { create: jest.fn(() => actual.sha512.create()) },
    ),
  };
});

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const ALICE_NOISE = key(0x11);
const ALICE_SIGN = key(0x22);
const BOB_NOISE = key(0x33);
const BOB_SIGN = key(0x44);

const alice = peerFingerprint(ALICE_NOISE, ALICE_SIGN);
const bob = peerFingerprint(BOB_NOISE, BOB_SIGN);
// Computed once: each code is thousands of hashes on purpose.
const aliceCode = safetyCode(alice);
const bobCode = safetyCode(bob);

describe("peerFingerprint", () => {
  it("is 32 bytes and deterministic", () => {
    expect(alice).toHaveLength(32);
    expect(peerFingerprint(ALICE_NOISE, ALICE_SIGN)).toEqual(alice);
  });

  // Why the fingerprint is not just the peer ID. A peer ID is SHA-256 of the
  // Noise key alone, so a forged card keeping the victim's peer ID and Noise
  // key while substituting the SIGNING key produces an identical peer ID, and
  // comparing that aloud would confirm the forgery.
  it("changes when only the signing key changes", () => {
    const substituted = peerFingerprint(ALICE_NOISE, key(0x99));
    expect(substituted).not.toEqual(alice);
  });

  it("changes when only the Noise key changes", () => {
    expect(peerFingerprint(key(0x99), ALICE_SIGN)).not.toEqual(alice);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => peerFingerprint(new Uint8Array(31), ALICE_SIGN)).toThrow();
    expect(() => peerFingerprint(ALICE_NOISE, new Uint8Array(33))).toThrow();
  });
});

describe("safetyCode", () => {
  // Not a pair hash: nothing about Bob enters Alice's code, which is what
  // leaves a man in the middle no two keys of his own to collide.
  it("depends on one person alone", () => {
    expect(aliceCode).not.toEqual(bobCode);
    const carol = peerFingerprint(key(0x55), key(0x66));
    expect(safetyCode(carol)).not.toEqual(aliceCode);
  });

  // A substituted signing key must change the code, or the comparison confirms
  // nothing.
  it("changes when the signing key is substituted", () => {
    const impostor = peerFingerprint(BOB_NOISE, key(0x99));
    expect(safetyCode(impostor)).not.toEqual(bobCode);
  });

  it("is a SHA-512 digest, not the fingerprint", () => {
    expect(aliceCode).toHaveLength(64);
    expect(aliceCode.slice(0, 32)).not.toEqual(alice);
  });

  it("refuses anything but a 32-byte fingerprint", () => {
    expect(() => safetyCode(new Uint8Array(31))).toThrow();
  });

  // The compare screen asks for your own code every time it opens; stretching
  // it again each time is the stall the cache exists to remove.
  it("stretches each fingerprint once per process", () => {
    const create = sha512.create as jest.Mock;
    const dave = peerFingerprint(key(0x77), key(0x88));
    create.mockClear();
    const first = safetyCode(dave);
    expect(create).toHaveBeenCalledTimes(5200);
    create.mockClear();
    expect(safetyCode(dave)).toEqual(first);
    expect(create).not.toHaveBeenCalled();
  });

  it("hands out a copy, so a caller cannot poison the cache", () => {
    const mine = safetyCode(alice);
    mine.fill(0);
    expect(safetyCode(alice)).toEqual(aliceCode);
  });

  // Evicting keeps memory bounded without changing any answer.
  it("gives the same code after its entry is evicted", () => {
    for (let fill = 0x80; fill < 0xa0; fill++) {
      safetyCode(peerFingerprint(key(fill), key(fill)));
    }
    expect(safetyCode(alice)).toEqual(aliceCode);
  });
});

describe("safetyNumberIndices", () => {
  it("returns the expected count, all in range", () => {
    const indices = safetyNumberIndices(aliceCode);
    expect(indices).toHaveLength(SAFETY_WORD_COUNT);
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(1 << SAFETY_BITS_PER_WORD);
    }
  });

  // Most significant bit first. Two devices that disagree here render different
  // words for the same keys, which reads to their users as an attack.
  it("reads seven bits at a time from the top of the digest", () => {
    // 0b1111111 0000000 1111111 ... : alternating runs across byte boundaries.
    const digest = new Uint8Array(32);
    digest[0] = 0b11111110;
    digest[1] = 0b00000011;
    digest[2] = 0b11111000;
    expect(safetyNumberIndices(digest).slice(0, 3)).toEqual([127, 0, 127]);
  });

  // Pinned from an independent computation: a change to the context string,
  // the round count, the hash or the bit reading moves every word.
  it("gives a pinned answer for fixed keys", () => {
    expect(safetyNumberIndices(aliceCode)).toEqual([70, 26, 39, 11, 17, 8]);
    expect(safetyNumberIndices(bobCode)).toEqual([6, 37, 66, 107, 112, 80]);
  });
});
