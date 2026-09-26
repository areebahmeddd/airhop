/**
 * @jest-environment node
 */
// `coinLock`: whether a coin handed to us is ours to spend. A coin locked
// (NUT-11) to another key is worth nothing to this wallet however genuine its
// signature, so it must never be stored as balance; one locked to our key is
// spendable only by a swap that signs it.
//
// Secrets are built with cashu-ts, and the verdict comes from its own NUT-11
// logic, so the cases that a pubkey comparison gets wrong (a NUT-28 blinded
// lock) are decided exactly as the signing path decides them.

import {
  createP2PKsecret,
  createSecret,
  deriveP2BKBlindedPubkeys,
  type Proof,
} from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { coinLock } from "../cashu";

const OUR_KEY = bytesToHex(new Uint8Array(32).fill(3));
const OUR_PUB = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(3), true),
);
const THEIR_PUB = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
);

const PAST = String(Math.floor(Date.now() / 1000) - 3600);
const FUTURE = String(Math.floor(Date.now() / 1000) + 3600);

function coin(secret: string, extra: Partial<Proof> = {}): Proof {
  return {
    id: "00ad268c4d1f5826",
    amount: 8,
    secret,
    C: "02" + "11".repeat(32),
    ...extra,
  } as unknown as Proof;
}

describe("coinLock", () => {
  it("reads a plain secret as a bearer coin", () => {
    expect(coinLock(coin("a".repeat(64)), OUR_KEY)).toBe("none");
    // JSON that is not NUT-10 is a plain secret to the mint too.
    expect(coinLock(coin("12345"), OUR_KEY)).toBe("none");
  });

  it("knows a coin locked to our key", () => {
    expect(coinLock(coin(createP2PKsecret(OUR_PUB)), OUR_KEY)).toBe("ours");
  });

  it("refuses a coin locked to someone else's key", () => {
    expect(coinLock(coin(createP2PKsecret(THEIR_PUB)), OUR_KEY)).toBe("other");
  });

  it("calls any locked coin someone else's when we hold no key", () => {
    expect(coinLock(coin(createP2PKsecret(OUR_PUB)))).toBe("other");
  });

  it("reads an expired lock with no refund keys as a bearer coin", () => {
    // NUT-11: after the locktime, with no refund path, anyone may spend it.
    const secret = createP2PKsecret(THEIR_PUB, [["locktime", PAST]]);
    expect(coinLock(coin(secret), OUR_KEY)).toBe("none");
  });

  it("knows an expired lock whose refund key is ours", () => {
    const secret = createP2PKsecret(THEIR_PUB, [
      ["locktime", PAST],
      ["refund", OUR_PUB],
    ]);
    expect(coinLock(coin(secret), OUR_KEY)).toBe("ours");
  });

  it("does not let a refund key of ours unlock a lock still running", () => {
    const secret = createP2PKsecret(THEIR_PUB, [
      ["locktime", FUTURE],
      ["refund", OUR_PUB],
    ]);
    expect(coinLock(coin(secret), OUR_KEY)).toBe("other");
  });

  it("knows a NUT-28 blinded lock to our key, which no key comparison finds", () => {
    const { blinded, Ehex } = deriveP2BKBlindedPubkeys([OUR_PUB]);
    const lock = coin(createP2PKsecret(blinded[0]!), { p2pk_e: Ehex });
    expect(coinLock(lock, OUR_KEY)).toBe("ours");
    const theirs = deriveP2BKBlindedPubkeys([THEIR_PUB]);
    expect(
      coinLock(
        coin(createP2PKsecret(theirs.blinded[0]!), { p2pk_e: theirs.Ehex }),
        OUR_KEY,
      ),
    ).toBe("other");
  });

  it("refuses conditions this wallet cannot meet", () => {
    // HTLC needs a preimage; SIG_ALL signs a whole transaction.
    expect(coinLock(coin(createSecret("HTLC", "ab".repeat(32))), OUR_KEY)).toBe(
      "other",
    );
    const sigAll = createP2PKsecret(OUR_PUB, [["sigflag", "SIG_ALL"]]);
    expect(coinLock(coin(sigAll), OUR_KEY)).toBe("other");
  });
});
