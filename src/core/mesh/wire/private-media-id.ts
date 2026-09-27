// bitchat's stable message ID for a private photo or voice note, derived from
// fields already on the wire (bitchat-ios PrivateMediaMessageIdentity, v1).
//
// Both ends compute it independently: the sender keys its bubble by it, and the
// receiver keys its row by it and answers with a Noise DELIVERED carrying it.
// That is the whole receipt contract for private media, and a sealed file
// (Noise payload 0x20) always keeps it. A name outside the two shapes below
// yields null, which bitchat treats as the legacy path: no receipt, no dedup.
//
// Byte for byte, so a change here breaks receipts with every bitchat-ios phone.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const DOMAIN = "bitchat-private-media-message-v1";
const ID_PREFIX = "media-";
const DIGEST_HEX_LENGTH = 32;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Swift's Character.isHexDigit also admits the fullwidth forms.
const BURST_ID_RE = /^[0-9a-fA-F０-９Ａ-Ｆａ-ｆ]{16}$/u;

const enc = new TextEncoder();

// Sender and recipient are 16-hex peer IDs, so both directions of a chat and
// both chats that reuse a name stay distinct.
export function privateMediaStableID(
  senderPeerID: string,
  recipientPeerID: string,
  fileName: string | undefined,
): string | null {
  if (fileName === undefined || fileName.length === 0) return null;
  // bitchat takes the last path component and refuses a name that had more.
  if (fileName.includes("/")) return null;

  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  let burstID = "";
  if (stem.startsWith("img_")) {
    if (extension !== "jpg" && extension !== "jpeg") return null;
  } else if (stem.startsWith("voice_")) {
    if (extension !== "m4a") return null;
    burstID = stem.slice("voice_".length);
  } else {
    return null;
  }
  // The entropy is the last non-empty "_" token, or a live-voice burst ID.
  const tokens = stem.split("_").filter((s) => s.length > 0);
  const entropy = tokens[tokens.length - 1] ?? "";
  if (!UUID_RE.test(entropy) && !BURST_ID_RE.test(burstID)) return null;

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
