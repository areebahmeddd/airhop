/**
 * @jest-environment node
 */
// DM payload envelope: the type + id wrapper that carries delivery and read
// receipts inside a Double Ratchet DM.

import {
  DmPayloadType,
  decodeDmPayload,
  encodeDmMessage,
  encodeDmReceipt,
} from "../dm-payload";

describe("message round-trip", () => {
  it("preserves id and text", () => {
    expect(
      decodeDmPayload(encodeDmMessage("peer-123-abc", "hello there")),
    ).toEqual({
      type: DmPayloadType.MESSAGE,
      messageId: "peer-123-abc",
      text: "hello there",
    });
  });

  it("handles empty text and unicode", () => {
    expect(decodeDmPayload(encodeDmMessage("id1", "日本語 🎉"))?.text).toBe(
      "日本語 🎉",
    );
    expect(decodeDmPayload(encodeDmMessage("id2", ""))).toEqual({
      type: DmPayloadType.MESSAGE,
      messageId: "id2",
      text: "",
    });
  });
});

describe("receipt round-trip", () => {
  it.each([DmPayloadType.DELIVERED, DmPayloadType.READ_RECEIPT] as const)(
    "carries receipt type %i with its id and no text",
    (type) => {
      expect(decodeDmPayload(encodeDmReceipt(type, "msg-9"))).toEqual({
        type,
        messageId: "msg-9",
        text: "",
      });
    },
  );
});

describe("a malformed payload is refused", () => {
  it.each([
    ["raw text", new TextEncoder().encode("just plain text")],
    ["an id that overruns the buffer", new Uint8Array([0x01, 200, 0x61, 0x62])],
    ["an empty id", new Uint8Array([0x03, 0])],
    ["too short", new Uint8Array([0x01])],
  ])("%s", (_label, bytes) => {
    expect(decodeDmPayload(bytes)).toBeNull();
  });
});
