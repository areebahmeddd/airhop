// A peer ID is the first 8 bytes of SHA-256(Noise static public key), as hex.
//
// The one definition. Gossip sync and DM addressing key on it, and bitchat
// derives it identically, so it never changes (AGENTS.md, Protocol
// Compatibility).

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function peerIDFromNoiseKey(noiseStaticPubKey: Uint8Array): string {
  return bytesToHex(sha256(noiseStaticPubKey)).slice(0, 16);
}
