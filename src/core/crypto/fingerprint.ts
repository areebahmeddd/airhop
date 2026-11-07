// Safety codes: what two people read to each other to confirm the keys their
// phones hold are the right ones.
//
// Key delivery and verification are separate steps. A QR scan does both at
// once; every other way of learning someone's keys (an airhop:// link, a card
// inside a geohash DM, a mesh session) does only the first. This is the second
// on its own, so the confirming channel can be anything the two people trust:
// a call, a radio, another app. The strength comes from that channel.
//
// Three properties the rest of the feature rests on:
//
//   * It covers BOTH keys. A peer ID is SHA-256 of the Noise key alone, so
//     reading one aloud would not catch the attack that matters: a forged card
//     keeps the victim's real peer ID and Noise key and substitutes the
//     attacker's SIGNING key.
//   * One code per person, from that person's keys alone. A code over both
//     identities lets a man in the middle, who picks the fake key on each side,
//     search for any two keys whose pair hashes collide: a birthday search of
//     about 2^21 keys per side. A per-person code leaves nothing to collide
//     with; the fake must match the one code its victim reads aloud.
//   * It imports nothing. A match sets a flag, a mismatch tells the user to
//     stop. Neither writes a key, so unlike the scan path there is no
//     re-pinning power to gate. The flag attests keys, not words, so a change
//     to how codes are drawn leaves every verified contact verified.

import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Domain separators, so a fingerprint and a code can never stand in for one
// another, nor for any other hash in the app.
const PEER_CONTEXT = "airhop-fingerprint-v1";
const CODE_CONTEXT = "airhop-safety-code-v1";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// One identity's fingerprint: 32 bytes over both of its public keys. Never
// shown on its own; it is the input to the code below.
export function peerFingerprint(
  noisePubKey: Uint8Array,
  signingPubKey: Uint8Array,
): Uint8Array {
  if (noisePubKey.length !== 32 || signingPubKey.length !== 32) {
    throw new Error("fingerprint: both keys must be 32 bytes");
  }
  return sha256(
    concat(encoder.encode(PEER_CONTEXT), noisePubKey, signingPubKey),
  );
}

// Signal's safety-number stretching (NumericFingerprintGenerator): 5,200
// rounds of SHA-512, each over the previous digest and the fingerprint again.
// Every key an attacker tries costs this many hashes, which is what turns the
// 42 bits below into a bound worth stating.
const SAFETY_CODE_ITERATIONS = 5200;

// A code is public (it is read aloud), so caching it holds nothing secret. A
// screen needs two at a time, your own and one contact's; the rest is headroom
// for switching between contacts without stretching again.
const CODE_CACHE_LIMIT = 16;
const codeCache = new Map<string, Uint8Array>();

// The code for one person, the same on every phone that holds their keys.
//
// Six words from 128-entry lists is 42 bits. To pass, an impostor needs a key
// whose code lands on one specific person's six words: about 2^42 keys, each
// costing 5,200 SHA-512 rounds, roughly 2^54 hash operations per targeted
// person, all done before the two people speak. Within reach of a determined,
// funded attacker, and the reason scanning the QR in person, which compares
// the full keys, stays the strong path. Every extra word is another to read
// over a bad line, and a code nobody finishes reading protects nothing.
//
// Slow by design: long enough to stall a frame on a slow phone, so it runs off
// the render path, and the last few codes are cached (CODE_CACHE_LIMIT) so a
// screen reopened does not stretch the same fingerprint again.
export function safetyCode(fingerprint: Uint8Array): Uint8Array {
  if (fingerprint.length !== 32) {
    throw new Error("safetyCode: a fingerprint is 32 bytes");
  }
  const cacheKey = bytesToHex(fingerprint);
  let digest = codeCache.get(cacheKey);
  if (digest === undefined) {
    digest = stretch(fingerprint);
    // Insertion order makes the Map a FIFO: the oldest entry goes first.
    if (codeCache.size >= CODE_CACHE_LIMIT) {
      const oldest = codeCache.keys().next().value;
      if (oldest !== undefined) codeCache.delete(oldest);
    }
    codeCache.set(cacheKey, digest);
  }
  // A copy, so a caller that writes into its result cannot poison the cache.
  return digest.slice();
}

function stretch(fingerprint: Uint8Array): Uint8Array {
  let digest = concat(encoder.encode(CODE_CONTEXT), fingerprint);
  for (let i = 0; i < SAFETY_CODE_ITERATIONS; i++) {
    digest = sha512.create().update(digest).update(fingerprint).digest();
  }
  return digest;
}

export const SAFETY_WORD_COUNT = 6;
export const SAFETY_BITS_PER_WORD = 7;

// Seven-bit indices out of the hash, most significant bit first, so the mapping
// is fixed here rather than by how a runtime slices bytes.
//
// Here rather than beside the word lists because two devices must agree on it
// exactly, while the words themselves are presentation.
export function safetyNumberIndices(digest: Uint8Array): number[] {
  const indices: number[] = [];
  let bitOffset = 0;
  for (let i = 0; i < SAFETY_WORD_COUNT; i++) {
    let value = 0;
    for (let bit = 0; bit < SAFETY_BITS_PER_WORD; bit++) {
      const absolute = bitOffset + bit;
      const byte = digest[absolute >> 3] as number;
      value = (value << 1) | ((byte >> (7 - (absolute & 7))) & 1);
    }
    indices.push(value);
    bitOffset += SAFETY_BITS_PER_WORD;
  }
  return indices;
}
