// The chat row a public location or room message is filed under.
//
// Its Bluetooth copy and its Nostr copy share a sender-chosen message ID (the
// `mid` tag) so the two collapse into one bubble. Taken on its own, that ID
// lets anyone who read the message send different text under it over a
// faster path and have the genuine one dropped as a duplicate. Binding the
// text into the row means a copy with other words is a row of its own, under
// its own author. The sender cannot be bound: the two copies are signed by
// keys nothing links (peer ID versus a per-cell Nostr key).
//
// Hash the text as received, before any truncation, on both paths. The ID is
// length-prefixed: both halves are sender-chosen, and joined by a separator
// alone, an ID ending in part of the genuine text would reach the same row.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export function sharedRowID(msgId: string, text: string): string {
  const id = utf8ToBytes(msgId);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, id.length, false);
  const digest = sha256(concatBytes(length, id, utf8ToBytes(text)));
  return `ch-${bytesToHex(digest).slice(0, 32)}`;
}
