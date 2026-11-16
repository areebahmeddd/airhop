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

const SENT_AT = 1_767_225_600_123;

describe("RING", () => {
  it("leads with the send time, big-endian, then the id", () => {
    const bytes = encodeRing(ID, SENT_AT);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0) * 2 ** 32 + view.getUint32(4)).toBe(SENT_AT);
    expect(bytes.slice(8)).toEqual(new TextEncoder().encode(ID));
    expect(decodeRing(bytes)).toEqual({ ringID: ID, sentAtMs: SENT_AT });
  });

  it("reads a body that is a view into a larger buffer", () => {
    const framed = new Uint8Array(3 + encodeRing(ID, SENT_AT).length);
    framed.set(encodeRing(ID, SENT_AT), 3);
    expect(decodeRing(framed.subarray(3))).toEqual({
      ringID: ID,
      sentAtMs: SENT_AT,
    });
  });

  it("refuses a body with no id, an oversized id, or an unsafe time", () => {
    expect(decodeRing(new Uint8Array(0))).toBeNull();
    expect(decodeRing(encodeRing("", SENT_AT))).toBeNull();
    expect(decodeRing(encodeRing("a".repeat(65), SENT_AT))).toBeNull();
    const unsafe = encodeRing(ID, SENT_AT);
    unsafe.fill(0xff, 0, 8);
    expect(decodeRing(unsafe)).toBeNull();
  });
});

describe("RING_ACK", () => {
  it("round-trips an id as bare UTF-8", () => {
    expect(decodeRingAck(encodeRingAck(ID))).toBe(ID);
    expect(encodeRingAck(ID)).toEqual(new TextEncoder().encode(ID));
  });

  it("refuses an empty, oversized or malformed id", () => {
    expect(decodeRingAck(new Uint8Array(0))).toBeNull();
    expect(decodeRingAck(new Uint8Array(65).fill(0x61))).toBeNull();
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
