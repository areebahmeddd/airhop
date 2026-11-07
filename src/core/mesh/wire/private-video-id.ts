// Airhop's stable message ID for a private video note or clip, the counterpart
// of bitchat's privateMediaStableID (private-media-id.ts) for the two video
// names bitchat gives no ID.
//
// Same contract: both ends derive it from fields already on the wire, the
// sender keys its bubble by it, and the receiver keys its row by it and answers
// a sealed file with a Noise DELIVERED naming it. bitchat-ios ignores a
// DELIVERED for an ID it does not hold, so a bitchat peer simply never confirms.
//
// Its own domain string, so it can never collide with a bitchat media ID, and
// only Airhop's own UUID-shaped names. bitchat names a clip `clip_<8 hex>`:
// keyed on 32 bits, two distinct bitchat clips could share an ID and the second
// would be dropped as a repeat. A receiver's renamed repeat (`note_x (1).mp4`)
// gets no ID either, since its name is not what the sender hashed.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const DOMAIN = "airhop-private-video-message-v1";
const ID_PREFIX = "media-";
const DIGEST_HEX_LENGTH = 32;

// Exactly what videoNoteName() and videoClipName() in file-packet.ts write.
const VIDEO_NAME_RE =
  /^(?:note|clip)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

const enc = new TextEncoder();

// Sender and recipient are 16-hex peer IDs, lower-cased as bitchat's are, so
// both directions of a chat stay distinct.
export function privateVideoStableID(
  senderPeerID: string,
  recipientPeerID: string,
  fileName: string | undefined,
): string | null {
  if (fileName === undefined || !VIDEO_NAME_RE.test(fileName)) return null;

  const fields = [
    enc.encode(senderPeerID.toLowerCase()),
    enc.encode(recipientPeerID.toLowerCase()),
    enc.encode(fileName),
  ];
  const domain = enc.encode(DOMAIN);
  const input = new Uint8Array(
    domain.length + fields.reduce((n, f) => n + 4 + f.length, 0),
  );
  input.set(domain, 0);
  const view = new DataView(input.buffer);
  let at = domain.length;
  for (const field of fields) {
    view.setUint32(at, field.length, false);
    input.set(field, at + 4);
    at += 4 + field.length;
  }
  return ID_PREFIX + bytesToHex(sha256(input)).slice(0, DIGEST_HEX_LENGTH);
}
