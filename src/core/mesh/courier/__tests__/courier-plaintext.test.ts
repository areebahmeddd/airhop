/**
 * @jest-environment node
 */
// What goes INSIDE a courier envelope.
//
// The envelope's own bytes are checked against `courier-test-vectors.json`, but
// the sealed plaintext is covered only here: the simulated bitchat peer never
// opens a ciphertext. bitchat requires a typed private message inside, so an
// envelope sealed as raw UTF-8 is dropped by every bitchat recipient, and one
// read as raw UTF-8 renders a binary structure as message text.
//
// These are the bytes bitchat's `BLENoisePayloadFactory.privateMessage` writes
// and its `openCourierEnvelope` reads. Pinned as literal hex rather than a
// round trip through our own encoder, because a round trip agrees with itself
// whatever it produces.

import {
  decodeNoisePayload,
  decodePrivateMessagePacket,
  encodeNoisePrivateMessage,
  PRIVATE_MESSAGE_MAX_CONTENT_BYTES,
} from "../../wire/noise-payload";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the courier envelope plaintext", () => {
  test("is a typed private message, byte for byte", () => {
    const sealed = encodeNoisePrivateMessage("id1", "hi");
    expect(sealed).not.toBeNull();

    // The iOS factory takes (content:messageID:) but writes the ID first, and
    // getting that backwards would still round-trip through our own decoder.
    //  01        NoisePayloadType.privateMessage
    //  00 03     TLV messageID, length 3
    //  69 64 31  "id1"
    //  01 02     TLV content, length 2
    //  68 69     "hi"
    expect(hex(sealed as Uint8Array)).toBe("01" + "000369643101026869");
  });

  test("refuses content no bitchat peer could encode either", () => {
    // Both sides cap a private message at 255 BYTES, not characters, and both
    // return nothing rather than truncating. sendViaCourier turns that into a
    // refusal, so the message stays queued instead of being sealed into
    // something the recipient cannot read.
    const tooLong = "x".repeat(PRIVATE_MESSAGE_MAX_CONTENT_BYTES + 1);
    expect(encodeNoisePrivateMessage("id", tooLong)).toBeNull();

    // Measured in UTF-8: 128 two-byte characters is 256 bytes.
    expect(encodeNoisePrivateMessage("id", "é".repeat(128))).toBeNull();
    expect(encodeNoisePrivateMessage("id", "é".repeat(127))).not.toBeNull();
  });

  test("rejects a truncated packet rather than half-reading it", () => {
    const sealed = encodeNoisePrivateMessage("id1", "hi") as Uint8Array;
    const typed = decodeNoisePayload(sealed.slice(0, sealed.length - 1));
    expect(
      decodePrivateMessagePacket((typed as { body: Uint8Array }).body),
    ).toBeNull();
  });
});
