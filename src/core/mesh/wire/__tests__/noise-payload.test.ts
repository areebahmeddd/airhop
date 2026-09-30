/**
 * @jest-environment node
 */
// The NOISE_ENCRYPTED inner payload, matching bitchat's NoisePayload,
// PrivateMessagePacket and BLENoisePayloadFactory.
import {
  decodeNoisePayload,
  decodePrivateMessagePacket,
  encodeNoisePrivateMessage,
  encodeNoiseReceipt,
  encodePrivateMessagePacket,
  NoisePayloadType,
} from "../noise-payload";

describe("noise-payload", () => {
  describe("NoisePayloadType (bitchat values)", () => {
    it("matches bitchat's type bytes", () => {
      expect(NoisePayloadType.PRIVATE_MESSAGE).toBe(0x01);
      expect(NoisePayloadType.READ_RECEIPT).toBe(0x02);
      expect(NoisePayloadType.DELIVERED).toBe(0x03);
    });
  });

  // The byte-for-byte vector is in courier-plaintext.test.ts, alongside the
  // 255-byte content cap measured through the typed wrapper.
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
