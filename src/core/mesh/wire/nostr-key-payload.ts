// The NOSTR_KEY payload: NoisePayloadType 0x54.
//
//   [x-only secp256k1 public key: 32 bytes]
//
// Airhop-only, and sent only inside a session whose peer proved
// Capability.doubleRatchet, so bitchat never sees it. The session vouches for
// who sent it (only the holder of the peer ID's Noise key completes one), but
// not for whose key it is: a peer can name any npub for itself. A receiver
// treats it as a forwarding address for that peer, nothing more (PROTOCOLS.md
// section 3.3, "Nostr keys a peer names for itself").
//
// Exactly 32 bytes. Anything longer is refused rather than read as a prefix,
// so a later version has to take a new type instead of being half understood.

const NOSTR_KEY_SIZE = 32;

export function encodeNostrKey(xOnlyPubKey: Uint8Array): Uint8Array {
  if (xOnlyPubKey.length !== NOSTR_KEY_SIZE) {
    throw new Error("nostr-key: an x-only key is 32 bytes");
  }
  return xOnlyPubKey.slice();
}

export function decodeNostrKey(body: Uint8Array): Uint8Array | null {
  return body.length === NOSTR_KEY_SIZE ? body.slice() : null;
}
