// The NOISE_ENCRYPTED inner payload, matching bitchat's NoisePayload,
// PrivateMessagePacket and BLENoisePayloadFactory.
import {
  decodeNoisePayload,
  decodePrivateMessagePacket,
  encodeNoisePrivateMessage,
  encodeNoiseReceipt,
  encodePrivateMessagePacket,
  NoisePayloadType,
  PRIVATE_MESSAGE_MAX_CONTENT_BYTES,
} from "../noise-payload";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("noise-payload", () => {
  describe("NoisePayloadType (bitchat values)", () => {
    it("matches bitchat's type bytes", () => {
      expect(NoisePayloadType.PRIVATE_MESSAGE).toBe(0x01);
      expect(NoisePayloadType.READ_RECEIPT).toBe(0x02);
      expect(NoisePayloadType.DELIVERED).toBe(0x03);
    });
  });

  // The byte-for-byte vector is under "the courier envelope plaintext" below,
  // alongside the 255-byte content cap measured through the typed wrapper.
  describe("PrivateMessagePacket TLV", () => {
    it("round-trips messageID and content", () => {
      const enc = encodePrivateMessagePacket("abc123", "hello world")!;
      const dec = decodePrivateMessagePacket(enc)!;
      expect(dec.messageID).toBe("abc123");
      expect(dec.content).toBe("hello world");
    });

    it("round-trips UTF-8 content", () => {
      const enc = encodePrivateMessagePacket("x", "日本語 café")!;
      expect(decodePrivateMessagePacket(enc)!.content).toBe("日本語 café");
    });

    it("returns null for a malformed TLV buffer", () => {
      expect(
        decodePrivateMessagePacket(new Uint8Array([0x00, 5, 1, 2])),
      ).toBeNull();
    });
  });

  describe("NoisePayload framing", () => {
    it("a private message is [0x01] + PrivateMessagePacket", () => {
      const np = encodeNoisePrivateMessage("m", "hey")!;
      expect(np[0]).toBe(NoisePayloadType.PRIVATE_MESSAGE);
      const decoded = decodeNoisePayload(np)!;
      expect(decoded.type).toBe(NoisePayloadType.PRIVATE_MESSAGE);
      expect(decodePrivateMessagePacket(decoded.body)!.content).toBe("hey");
    });

    it("a delivered receipt is [0x03] + utf8(messageID)", () => {
      const r = encodeNoiseReceipt(NoisePayloadType.DELIVERED, "msg-9");
      expect(r[0]).toBe(NoisePayloadType.DELIVERED);
      const decoded = decodeNoisePayload(r)!;
      expect(new TextDecoder().decode(decoded.body)).toBe("msg-9");
    });

    it("a read receipt is [0x02] + utf8(messageID)", () => {
      const r = encodeNoiseReceipt(NoisePayloadType.READ_RECEIPT, "msg-9");
      expect(r[0]).toBe(NoisePayloadType.READ_RECEIPT);
    });

    it("decodeNoisePayload returns null for empty input", () => {
      expect(decodeNoisePayload(new Uint8Array(0))).toBeNull();
    });
  });
});

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
    expect(encodeNoisePrivateMessage("id", "\u00e9".repeat(128))).toBeNull();
    expect(
      encodeNoisePrivateMessage("id", "\u00e9".repeat(127)),
    ).not.toBeNull();
  });

  test("rejects a truncated packet rather than half-reading it", () => {
    const sealed = encodeNoisePrivateMessage("id1", "hi") as Uint8Array;
    const typed = decodeNoisePayload(sealed.slice(0, sealed.length - 1));
    expect(
      decodePrivateMessagePacket((typed as { body: Uint8Array }).body),
    ).toBeNull();
  });
});
