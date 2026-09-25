// Proof that a contact card handed over in a location DM came from the person
// it describes (Noise payload 0x22, Airhop-only).
//
// Every field of a card is public, so anyone can forward a friend's. The
// sender signs the card together with the two per-cell Nostr keys of this
// conversation, with the durable signing key the card names:
//   Ed25519(signingKey, "airhop-geo-card-v1" || senderCell || recipientCell || card)
// and the body on the wire is the card followed by that 64-byte signature.
// Binding the sender's cell key is what matters: the gift-wrap seal already
// proves who holds it, so no other pseudonym can present the proof. The
// recipient's cell adds domain separation. No timestamp is needed, since a
// replay can only come from the same pseudonym, which is the genuine sender.
import { ed25519 } from "@noble/curves/ed25519.js";
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const CONTEXT = utf8ToBytes("airhop-geo-card-v1");
const PROOF_BYTES = 64;
const CELL_KEY_BYTES = 32;

function signedBytes(
  card: Uint8Array,
  senderCellPubHex: string,
  recipientCellPubHex: string,
): Uint8Array | null {
  let sender: Uint8Array;
  let recipient: Uint8Array;
  try {
    sender = hexToBytes(senderCellPubHex);
    recipient = hexToBytes(recipientCellPubHex);
  } catch {
    return null;
  }
  if (sender.length !== CELL_KEY_BYTES || recipient.length !== CELL_KEY_BYTES) {
    return null;
  }
  return concatBytes(CONTEXT, sender, recipient, card);
}

export function sealGeoCard(
  card: Uint8Array,
  senderCellPubHex: string,
  recipientCellPubHex: string,
  signingPrivKey: Uint8Array,
): Uint8Array {
  const message = signedBytes(card, senderCellPubHex, recipientCellPubHex);
  if (message === null) throw new Error("geo card: bad cell key");
  return concatBytes(card, ed25519.sign(message, signingPrivKey));
}

// The card a sealed body carries, or null when there is none to read.
export function geoCardOf(body: Uint8Array): Uint8Array | null {
  return body.length > PROOF_BYTES
    ? body.subarray(0, body.length - PROOF_BYTES)
    : null;
}

// Whether `body` carries a proof over this conversation by `signingKey`.
export function geoCardProven(
  body: Uint8Array,
  senderCellPubHex: string,
  recipientCellPubHex: string,
  signingKey: Uint8Array,
): boolean {
  const card = geoCardOf(body);
  if (card === null) return false;
  const message = signedBytes(card, senderCellPubHex, recipientCellPubHex);
  if (message === null) return false;
  try {
    return ed25519.verify(
      body.subarray(body.length - PROOF_BYTES),
      message,
      signingKey,
    );
  } catch {
    return false;
  }
}
