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
import { peerIDFromNoiseKey } from "@core/crypto/peer-id";
import { base64UrlToBytes, bytesToBase64Url } from "@core/encoding/base64";
import { generateChannelKey } from "@core/mesh/rooms/channel-crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useChatStore } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { applyAirhopLink } from "../link-router";

const signingPrivKey = new Uint8Array(32).fill(4);

function signedCard(noisePubKey: Uint8Array): string {
  return encodeQRContent(
    {
      peerID: peerIDFromNoiseKey(noisePubKey),
      noisePubKey,
      signingPubKey: ed25519.getPublicKey(signingPrivKey),
      nickname: "someone",
      nostrPubKey: new Uint8Array(32).fill(5),
    },
    signingPrivKey,
  );
}

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
  const peerID = peerIDFromNoiseKey(noisePubKey);
  const card = signedCard(noisePubKey);
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

test("a signed card is imported with its Nostr key", () => {
  const noisePubKey = new Uint8Array(32).fill(3);
  const peerID = peerIDFromNoiseKey(noisePubKey);
  mockMeshUp = true;
  mockAddVerifiedContact.mockReturnValue("added");

  expect(
    applyAirhopLink({ kind: "card", card: signedCard(noisePubKey) }),
  ).toEqual({ channel: `dm:${peerID}` });
  expect(useContactsStore.getState().getContact(peerID)?.nostrPubkeyHex).toBe(
    bytesToHex(new Uint8Array(32).fill(5)),
  );
});

// A real person's card with someone else's Nostr key passes every mesh key
// check, and once the safety number matched it would route their internet DMs
// to the forger. The signature is what refuses it, before anything is seeded.
test("a card with a substituted Nostr key is refused as invalid", () => {
  const noisePubKey = new Uint8Array(32).fill(3);
  const peerID = peerIDFromNoiseKey(noisePubKey);
  const bytes = base64UrlToBytes(
    signedCard(noisePubKey).slice("airhop:v1/".length),
  );
  bytes.set(new Uint8Array(32).fill(0xee), bytes.length - 64 - 32);
  const forged = "airhop:v1/" + bytesToBase64Url(bytes);
  mockMeshUp = true;
  mockAddVerifiedContact.mockReturnValue("added");

  expect(applyAirhopLink({ kind: "card", card: forged })).toEqual({
    refused: "invalid",
  });
  expect(mockAddVerifiedContact).not.toHaveBeenCalled();
  expect(useContactsStore.getState().getContact(peerID)).toBeUndefined();
});
