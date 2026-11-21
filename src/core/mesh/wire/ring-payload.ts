// The Ring payloads: NoisePayloadType RING, RING_ACK and RING_REFUSED.
//
//   RING          0x51  [sentAt: u64 BE ms] ++ utf8(ringID)
//   RING_ACK      0x52  utf8(ringID)
//   RING_REFUSED  0x53  [reason: u8] ++ utf8(ringID)
//
// Airhop-only; bitchat drops a payload type it does not know. A ring carries an
// id and the time it was sent, sealed with it: the packet around it is
// unsigned, so its timestamp is anyone's to rewrite, and a relay holding a ring
// back could otherwise restamp it fresh. Whether it may sound is the receiver's
// decision (mesh-service.onRing). The two replies keep the sender from
// guessing: an ack says a person saw it, a refusal says why the phone stayed
// quiet. A stale ring gets no reply at all, so a replay cannot probe whether
// its sender is still permitted. None of the three is ever couriered.

export const RingRefusalReason = {
  // No grant, or the master switch is off. One value for both: which applies
  // is the receiver's business, and the sender's next step is the same.
  NOT_ALLOWED: 0x01,
  SNOOZED: 0x02,
  COOLDOWN: 0x03,
} as const;
export type RingRefusalReasonValue =
  (typeof RingRefusalReason)[keyof typeof RingRefusalReason];

const KNOWN_REASONS: ReadonlySet<number> = new Set(
  Object.values(RingRefusalReason),
);

export function isRingRefusalReason(
  value: number,
): value is RingRefusalReasonValue {
  return KNOWN_REASONS.has(value);
}

// A ring id is a message id. The cap keeps a malformed peer from handing the
// chat store a kilobyte of "id".
const MAX_RING_ID_BYTES = 64;
const SENT_AT_BYTES = 8;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decodeId(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_RING_ID_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface Ring {
  ringID: string;
  sentAtMs: number;
}

export function encodeRing(ringID: string, sentAtMs: number): Uint8Array {
  const id = utf8(ringID);
  const out = new Uint8Array(SENT_AT_BYTES + id.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(sentAtMs / 2 ** 32));
  view.setUint32(4, sentAtMs % 2 ** 32);
  out.set(id, SENT_AT_BYTES);
  return out;
}

export function decodeRing(body: Uint8Array): Ring | null {
  if (body.length <= SENT_AT_BYTES) return null;
  const view = new DataView(body.buffer, body.byteOffset, SENT_AT_BYTES);
  const sentAtMs = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
  if (!Number.isSafeInteger(sentAtMs)) return null;
  const ringID = decodeId(body.slice(SENT_AT_BYTES));
  return ringID === null ? null : { ringID, sentAtMs };
}

export function encodeRingAck(ringID: string): Uint8Array {
  return utf8(ringID);
}

export function decodeRingAck(body: Uint8Array): string | null {
  return decodeId(body);
}

export function encodeRingRefused(
  ringID: string,
  reason: RingRefusalReasonValue,
): Uint8Array {
  const id = utf8(ringID);
  const out = new Uint8Array(1 + id.length);
  out[0] = reason;
  out.set(id, 1);
  return out;
}

export function decodeRingRefused(
  body: Uint8Array,
): { ringID: string; reason: RingRefusalReasonValue } | null {
  if (body.length < 2) return null;
  const reason = body[0];
  if (!isRingRefusalReason(reason)) return null;
  const ringID = decodeId(body.slice(1));
  if (ringID === null) return null;
  return { ringID, reason };
}
