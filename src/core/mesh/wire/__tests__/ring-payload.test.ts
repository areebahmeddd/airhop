/**
 * @jest-environment node
 */
// The ring wire formats. Small on purpose, so the tests are mostly about what
// the decoder refuses: these bytes come from the far end.

import {
  decodeRing,
  decodeRingAck,
  decodeRingRefused,
  encodeRing,
  encodeRingAck,
  encodeRingRefused,
  isRingRefusalReason,
  RingRefusalReason,
} from "../ring-payload";

const ID = "8f3c2a1b-ring";

describe("RING and RING_ACK", () => {
  it("round-trips an id as bare UTF-8", () => {
    expect(decodeRing(encodeRing(ID))).toBe(ID);
    expect(decodeRingAck(encodeRingAck(ID))).toBe(ID);
    expect(encodeRing(ID)).toEqual(new TextEncoder().encode(ID));
  });

  it("refuses an empty, oversized or malformed id", () => {
    expect(decodeRing(new Uint8Array(0))).toBeNull();
    expect(decodeRing(new Uint8Array(65).fill(0x61))).toBeNull();
    expect(decodeRingAck(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe("RING_REFUSED", () => {
  it("leads with the reason byte, then the id", () => {
    const bytes = encodeRingRefused(ID, RingRefusalReason.SNOOZED);
    expect(bytes[0]).toBe(RingRefusalReason.SNOOZED);
    expect(bytes.slice(1)).toEqual(new TextEncoder().encode(ID));
  });

  it("round-trips every reason", () => {
    for (const reason of Object.values(RingRefusalReason)) {
      expect(decodeRingRefused(encodeRingRefused(ID, reason))).toEqual({
        ringID: ID,
        reason,
      });
    }
  });

  it("refuses an unknown reason rather than guessing", () => {
    const bytes = encodeRingRefused(ID, RingRefusalReason.COOLDOWN);
    bytes[0] = 0x7f;
    expect(decodeRingRefused(bytes)).toBeNull();
    expect(isRingRefusalReason(0x7f)).toBe(false);
  });

  it("refuses a reason with no id behind it", () => {
    expect(decodeRingRefused(new Uint8Array([RingRefusalReason.SNOOZED]))).toBe(
      null,
    );
    expect(decodeRingRefused(new Uint8Array(0))).toBeNull();
  });
});
