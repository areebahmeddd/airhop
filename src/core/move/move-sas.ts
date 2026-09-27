// The words both phones show before anything moves, so the person can see the
// two screens belong to one connection.
//
// Derived from the Noise handshake hash, which is identical on both ends of one
// session and differs across any two, so a third phone that read the code and
// connected first shows words the real old phone never shows. It need not be
// secret. Grinding it buys nothing: the old phone pins the new phone's key, so
// no relay between two honest phones exists to grind for.
//
// Rendered through `safetyNumberWords`, never translated, so two phones in
// different languages agree.

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";

const SAS_LABEL = new TextEncoder().encode("airhop-move-sas-v1");

export function moveSas(handshakeHash: Uint8Array): Uint8Array {
  return sha256(concatBytes(SAS_LABEL, handshakeHash));
}
