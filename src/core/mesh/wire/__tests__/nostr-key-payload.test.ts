// NOSTR_KEY (0x54): the whole layout is one fixed-size field, so the tests pin
// the size rule both ways.

import { NoisePayloadType } from "../noise-payload";
import { decodeNostrKey, encodeNostrKey } from "../nostr-key-payload";

describe("NOSTR_KEY payload", () => {
  const key = new Uint8Array(32).map((_, i) => i);

  it("is Airhop's 0x54", () => {
    expect(NoisePayloadType.NOSTR_KEY).toBe(0x54);
  });

  it("round-trips the 32-byte key unchanged", () => {
    const body = encodeNostrKey(key);
    expect(body).toEqual(key);
    expect(decodeNostrKey(body)).toEqual(key);
  });

  it("copies, so a caller's later write cannot change what was sent", () => {
    const body = encodeNostrKey(key);
    body[0] = 0xff;
    expect(key[0]).toBe(0);
  });

  it("refuses to encode anything but 32 bytes", () => {
    expect(() => encodeNostrKey(new Uint8Array(33))).toThrow();
    expect(() => encodeNostrKey(new Uint8Array(0))).toThrow();
  });

  // A longer body is not a key with trailing data: half-reading a future
  // layout is how two versions come to disagree about a peer's inbox.
  it("refuses any other length on decode", () => {
    expect(decodeNostrKey(new Uint8Array(31))).toBeNull();
    expect(decodeNostrKey(new Uint8Array(33))).toBeNull();
    expect(decodeNostrKey(new Uint8Array(0))).toBeNull();
  });
});
