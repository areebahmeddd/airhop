// The plaintext of a Double Ratchet message (NoisePayloadType.RATCHET_MESSAGE).
//
// Receipts need two things in the encrypted payload that raw text cannot carry:
// a type discriminator, and the message id a receipt refers to. Type values
// mirror bitchat's NoisePayloadType, though this format is Airhop-to-Airhop
// only. Its bitchat-compatible counterpart is the PrivateMessagePacket in
// noise-payload.ts.
//
// Layout:
//   [0]              type    u8
//   [1]              idLen   u8   (bytes of the message id, 0 to 255)
//   [2 .. 2+idLen]   id      UTF-8 message id
//   type 0x01 only:
//   [2+idLen]        extLen  u8, bytes of the TLVs after it
//   [ .. +extLen]    TLVs    0x52 sent at (u64 BE ms), required, and the
//                            disappearing timer (dm-timer.ts) when one is on
//   [ .. ]           text    UTF-8 text
//
// The packet around it is unsigned, so the time it shows travels in here,
// under the ratchet, where no relay can restamp it.

import {
  completeDmTimer,
  encodeDmTimer,
  readDmTimerTlv,
  type DmTimer,
} from "./dm-timer";

export const DmPayloadType = {
  MESSAGE: 0x01,
  READ_RECEIPT: 0x02,
  DELIVERED: 0x03,
} as const;

export type DmPayloadTypeValue =
  (typeof DmPayloadType)[keyof typeof DmPayloadType];

export const TLV_SENT_AT = 0x52;

export interface DmPayload {
  type: DmPayloadTypeValue;
  // Message id this payload is about: the message's own id (MESSAGE) or the id
  // being acknowledged (receipts). Never empty.
  messageId: string;
  // Present for MESSAGE; empty for receipts.
  text: string;
  // When a MESSAGE was sent, by the sender's clock.
  sentAtMs?: number;
  // How long a MESSAGE stays, and on a timer change when it was set.
  timer?: DmTimer;
}

function u64(value: number): number[] {
  const out: number[] = [];
  for (let shift = 7; shift >= 0; shift--) {
    out.push(Math.floor(value / 2 ** (shift * 8)) % 256);
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeDmMessage(
  messageId: string,
  text: string,
  sentAtMs: number,
  timer?: DmTimer,
): Uint8Array {
  const ext = [
    TLV_SENT_AT,
    8,
    ...u64(sentAtMs),
    ...(timer === undefined ? [] : encodeDmTimer(timer)),
  ];
  return encodeEnvelope(DmPayloadType.MESSAGE, messageId, text, ext);
}

export function encodeDmReceipt(
  type: typeof DmPayloadType.DELIVERED | typeof DmPayloadType.READ_RECEIPT,
  messageId: string,
): Uint8Array {
  return encodeEnvelope(type, messageId, "");
}

function encodeEnvelope(
  type: DmPayloadTypeValue,
  messageId: string,
  text: string,
  ext?: number[],
): Uint8Array {
  // Ids are short (a local id string); clamp defensively to one length byte.
  const idBytes = encoder.encode(messageId).slice(0, 255);
  const textBytes = encoder.encode(text);
  const extBytes = ext === undefined ? [] : [ext.length, ...ext];
  const out = new Uint8Array(
    2 + idBytes.length + extBytes.length + textBytes.length,
  );
  out[0] = type;
  out[1] = idBytes.length;
  out.set(idBytes, 2);
  out.set(extBytes, 2 + idBytes.length);
  out.set(textBytes, 2 + idBytes.length + extBytes.length);
  return out;
}

// Decode a decrypted DM payload. Null for anything that is not a well-formed
// envelope: an unknown type, an id that is empty or overruns the buffer.
export function decodeDmPayload(bytes: Uint8Array): DmPayload | null {
  if (bytes.length < 2) return null;
  const type = bytes[0];
  const idLen = bytes[1];
  if (
    type !== DmPayloadType.MESSAGE &&
    type !== DmPayloadType.READ_RECEIPT &&
    type !== DmPayloadType.DELIVERED
  ) {
    return null;
  }
  if (idLen === 0 || 2 + idLen > bytes.length) return null;
  const messageId = decoder.decode(bytes.slice(2, 2 + idLen));
  if (type !== DmPayloadType.MESSAGE) return { type, messageId, text: "" };
  let off = 2 + idLen;
  if (off >= bytes.length) return null;
  const extEnd = off + 1 + bytes[off];
  if (extEnd > bytes.length) return null;
  off += 1;
  const timer: Partial<DmTimer> = {};
  let sentAtMs: number | undefined;
  while (off < extEnd) {
    const len = off + 2 <= extEnd ? bytes[off + 1] : -1;
    if (len < 0 || off + 2 + len > extEnd) return null;
    const value = bytes.slice(off + 2, off + 2 + len);
    if (bytes[off] === TLV_SENT_AT && len === 8) {
      const view = new DataView(value.buffer);
      sentAtMs = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
    } else if (!readDmTimerTlv(bytes[off], value, timer)) {
      return null;
    }
    off += 2 + len;
  }
  const complete = completeDmTimer(timer);
  if (complete === null || sentAtMs === undefined) return null;
  const text = decoder.decode(bytes.slice(extEnd));
  return complete === undefined
    ? { type, messageId, text, sentAtMs }
    : { type, messageId, text, sentAtMs, timer: complete };
}
