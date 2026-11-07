// How long a write may wait in a link's native queue before native drops it
// unsent (writeToLink's ttlMs). Native never reads the bytes, so the deadline
// is chosen here, from the packet type, and handed down with each write.

import { PacketType } from "../wire/packet-codec";

// bitchat's live video branch value (BLEOutboundPacketPolicy.liveQueueDeadline,
// 1.5 s). A live frame later than this has missed every jitter buffer behind
// it, and holding it only delays the frames queued after it.
export const LIVE_WRITE_TTL_MS = 1_500;

// Push-to-talk and live video: worthless once late, and sent at a steady rate,
// so a queue holding them grows rather than drains.
export function isLiveMedia(type: PacketType): boolean {
  return type === PacketType.VOICE_FRAME || type === PacketType.VIDEO_FRAME;
}

// The ttlMs a write of this packet type carries; 0 never expires.
export function writeTtlMs(type: PacketType): number {
  return isLiveMedia(type) ? LIVE_WRITE_TTL_MS : 0;
}
