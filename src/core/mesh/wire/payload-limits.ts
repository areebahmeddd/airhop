// Receive-side ceilings on a packet's decoded payload, per type. Mirrors
// bitchat-ios PacketPayloadLimits.
//
// DEFLATE lets ~1 KB on air declare ~1 MB decoded, which dedup and gossip then
// hold on every node, so only media types get the framed-file ceiling; the rest
// get twice the largest payload any encoder produces. A new type needing more
// than a v1 frame must be added here before it ships, or receivers drop it.

import { MAX_FRAMED_FILE_BYTES } from "./file-packet";
import { PacketType } from "./packet-type";

// DEFLATE's hard expansion bound: a 258-byte match costs at least two bits.
// A declared size past this multiple of the compressed bytes cannot be real.
export const MAX_DEFLATE_RATIO = 1032;

const FRAGMENT_BYTES = 1_280; // 13 B header + a 467 B chunk
const CONTROL_BYTES = 4 * 1024; // announce, board post, prekeys: under ~750 B
const REQUEST_SYNC_BYTES = 8 * 1024; // a 400 B filter plus TLVs
const ENVELOPE_BYTES = 64 * 1024; // 16 KiB courier or carrier body plus TLVs
const TWICE_V1_FRAME_BYTES = 128 * 1024; // a v1 frame's 16-bit length, doubled

export function maxPayloadBytes(type: PacketType): number {
  switch (type) {
    case PacketType.FILE_TRANSFER:
    case PacketType.NOISE_ENCRYPTED:
      return MAX_FRAMED_FILE_BYTES;
    case PacketType.CHANNEL_MSG:
    case PacketType.CHANNEL_MSG_AIRHOP:
    case PacketType.CHANNEL_ENC:
    case PacketType.GROUP_MESSAGE:
    case PacketType.DR_ENCRYPTED:
      return TWICE_V1_FRAME_BYTES;
    case PacketType.COURIER_ENV:
    case PacketType.NOSTR_CARRIER:
      return ENVELOPE_BYTES;
    case PacketType.REQUEST_SYNC:
      return REQUEST_SYNC_BYTES;
    case PacketType.FRAGMENT:
      return FRAGMENT_BYTES;
    case PacketType.ANNOUNCE:
    case PacketType.LEAVE:
    case PacketType.BOARD_POST:
    case PacketType.PREKEY_BUNDLE:
    case PacketType.VOICE_FRAME:
    case PacketType.NOISE_HANDSHAKE:
    case PacketType.PING:
    case PacketType.PONG:
      return CONTROL_BYTES;
    default:
      // An unknown type stays relayable up to a v1 frame.
      return TWICE_V1_FRAME_BYTES;
  }
}
