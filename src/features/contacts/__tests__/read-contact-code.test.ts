// A scanned or pasted code read to a card, or a refusal the person is told.
import {
  encodeContactCard,
  encodeQRContent,
} from "@core/crypto/contact-exchange";
import { peerIDFromNoiseKey } from "@core/crypto/peer-id";
import { bytesToBase64Url } from "@core/encoding/base64";
import { ed25519 } from "@noble/curves/ed25519.js";
import { readContactCode } from "../read-contact-code";

const signingPrivKey = new Uint8Array(32).fill(7);
const noisePubKey = new Uint8Array(32).fill(8);
const card = {
  peerID: peerIDFromNoiseKey(noisePubKey),
  noisePubKey,
  signingPubKey: ed25519.getPublicKey(signingPrivKey),
  nickname: "alice",
  nostrPubKey: new Uint8Array(32).fill(9),
};

test("a signed card reads to its keys", () => {
  const read = readContactCode(` ${encodeQRContent(card, signingPrivKey)} `);
  expect(typeof read === "object" && read?.peerID).toBe(card.peerID);
});

// Silence would leave the camera scanning a forged card as if it were a
// smudge; the person is told it was refused.
test("an unsigned card of ours is refused as tampered", () => {
  expect(
    readContactCode(`airhop:v1/${bytesToBase64Url(encodeContactCard(card))}`),
  ).toBe("tampered");
});

test("a code that is not a card is not one", () => {
  expect(readContactCode("https://example.com")).toBeNull();
});
