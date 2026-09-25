/**
 * @jest-environment node
 */
// A card handed over in a location DM must prove the person it names sent it,
// in this conversation, or a forwarded copy would pass for them.
import { ed25519 } from "@noble/curves/ed25519.js";
import { geoCardOf, geoCardProven, sealGeoCard } from "../geo-card-proof";

const SENDER_CELL = "aa".repeat(32);
const RECIPIENT_CELL = "bb".repeat(32);
const OTHER_CELL = "cc".repeat(32);

function setup() {
  const priv = ed25519.utils.randomSecretKey();
  const card = new Uint8Array(96).fill(5);
  const body = sealGeoCard(card, SENDER_CELL, RECIPIENT_CELL, priv);
  return { pub: ed25519.getPublicKey(priv), card, body };
}

describe("geo contact card proof", () => {
  it("round-trips the card and verifies under the named key", () => {
    const { pub, card, body } = setup();
    expect(geoCardOf(body)).toEqual(card);
    expect(geoCardProven(body, SENDER_CELL, RECIPIENT_CELL, pub)).toBe(true);
  });

  it("fails from another sender's pseudonym", () => {
    const { pub, body } = setup();
    expect(geoCardProven(body, OTHER_CELL, RECIPIENT_CELL, pub)).toBe(false);
  });

  it("fails toward another recipient", () => {
    const { pub, body } = setup();
    expect(geoCardProven(body, SENDER_CELL, OTHER_CELL, pub)).toBe(false);
  });

  it("fails with a card byte changed", () => {
    const { pub, body } = setup();
    const tampered = body.slice();
    tampered[3] ^= 0xff;
    expect(geoCardProven(tampered, SENDER_CELL, RECIPIENT_CELL, pub)).toBe(
      false,
    );
  });

  it("fails under any other signing key", () => {
    const { body } = setup();
    const other = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    expect(geoCardProven(body, SENDER_CELL, RECIPIENT_CELL, other)).toBe(false);
  });

  it("reads nothing from a body too short to hold a card and a proof", () => {
    const { pub, body } = setup();
    const truncated = body.subarray(0, 64);
    expect(geoCardOf(truncated)).toBeNull();
    expect(geoCardProven(truncated, SENDER_CELL, RECIPIENT_CELL, pub)).toBe(
      false,
    );
  });
});
