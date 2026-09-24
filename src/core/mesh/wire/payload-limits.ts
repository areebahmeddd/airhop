// Receive-side ceilings on a packet's decoded payload, per type. Mirrors
// bitchat-ios PacketPayloadLimits.
//
// A compressed frame declares its original size, and raw DEFLATE lets ~1 KB
// on air stand for ~1 MB decoded. Every accepted packet is then held at that
// size by the dedup and gossip stores and re-served by sync, so one ceiling
// for every type turns airtime into memory on every node. Only the types that
// carry media keep the framed-file ceiling; the rest are capped at no less than
// twice the largest payload any Airhop or bitchat encoder produces for them.
// A new type that needs more than a v1 frame must be added here before it
// ships, or current receivers drop it at decode.

import { MAX_FRAMED_FILE_BYTES } from "./file-packet";
import { PacketType } from "./packet-codec";

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
