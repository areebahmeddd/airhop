/**
 * @jest-environment node
 */
// What an airhop:// link joins. A private invite must never land in the public
// room of the same name, where the user would talk in the clear, and a refused
// contact card has to say why.

const mockAddVerifiedContact = jest.fn<string, unknown[]>();
let mockMeshUp = false;
jest.mock("../mesh-service", () => ({
  getMeshService: () =>
    mockMeshUp ? { addVerifiedContact: mockAddVerifiedContact } : null,
}));

import { encodeQRContent } from "@core/crypto/contact-exchange";
import { generateChannelKey } from "@core/mesh/rooms/channel-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useChatStore } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { applyAirhopLink } from "../link-router";

beforeEach(() => {
  useChatStore.getState().clearAll();
  useContactsStore.getState().clearAll();
  mockAddVerifiedContact.mockReset();
  mockMeshUp = false;
});

test("a valid invite joins the private channel", () => {
  const key = generateChannelKey();
  const outcome = applyAirhopLink({
    kind: "channel",
    channel: "#crew",
    key,
    overNostr: false,
  });
  if (!("channel" in outcome)) throw new Error("refused");
  expect(useChatStore.getState().channelKeys[outcome.channel]).toBe(key);
});

test("an invite with a malformed key joins nothing", () => {
  const outcome = applyAirhopLink({
    kind: "channel",
    channel: "#crew",
    key: "not-a-key",
    overNostr: false,
  });
  expect(outcome).toEqual({ refused: "invalid" });
  expect(useChatStore.getState().channels).not.toContain("#crew");
});

test("a link without a key joins the public room", () => {
  expect(
    applyAirhopLink({ kind: "channel", channel: "#crew", overNostr: false }),
  ).toEqual({ channel: "#crew" });
  expect(useChatStore.getState().channels).toContain("#crew");
});

test("a card naming a different key from the one held is refused as a conflict", () => {
  const noisePubKey = new Uint8Array(32).fill(3);
  const peerID = bytesToHex(sha256(noisePubKey)).slice(0, 16);
  const card = encodeQRContent({
    peerID,
    noisePubKey,
    signingPubKey: new Uint8Array(32).fill(4),
    nickname: "someone",
    nostrPubKey: new Uint8Array(32).fill(5),
  });
  mockMeshUp = true;
  mockAddVerifiedContact.mockReturnValue("conflict");

  expect(applyAirhopLink({ kind: "card", card })).toEqual({
    refused: "conflict",
  });
  expect(useContactsStore.getState().getContact(peerID)).toBeUndefined();

  mockAddVerifiedContact.mockReturnValue("unbound");
  expect(applyAirhopLink({ kind: "card", card })).toEqual({
    refused: "invalid",
  });
});
