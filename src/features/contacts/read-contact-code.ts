// A scanned contact code read to the card it carries, whichever app showed it.
//
//   airhop:v1/<base64url>   our contact card
//   bitchat://verify?...    a bitchat verification QR, signed and time-boxed
//
// Shared by adding and verifying, so a bitchat user's code is read the same
// way on both. A bitchat code that is recognised and refused says why: through
// a viewfinder an expired one looks exactly like an unreadable one.

import { parseBitchatVerifyQr } from "@core/crypto/bitchat-verify-qr";
import {
  decodeQRContent,
  isContactQR,
  type ContactCard,
} from "@core/crypto/contact-exchange";

export type ContactCodeRefusal = "expired" | "tampered";

export function readContactCode(
  raw: string,
): ContactCard | ContactCodeRefusal | null {
  const text = raw.trim();
  const card = decodeQRContent(text);
  if (card) return card;
  // Ours but unreadable, unsigned or failing its signature: refused out loud,
  // since a forged card is exactly what the signature is there to catch.
  if (isContactQR(text)) return "tampered";
  const bitchat = parseBitchatVerifyQr(raw);
  if (bitchat === null) return null;
  return bitchat.ok ? bitchat.card : bitchat.reason;
}
