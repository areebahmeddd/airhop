// The packet type byte, per PROTOCOLS.md section 3. Its own module so the
// payload limits can key on it without importing the codec that imports them.
//
// Everything up to VOICE_FRAME matches bitchat MessageType.swift /
// MessageType.kt (public domain). bitchat allocates forward and has reached
// 0x2C, so the values just past it are theirs to take, not ours. Airhop's own
// types live at 0x50 and up; see the note there before adding one.
export const enum PacketType {
  ANNOUNCE = 0x01, // "I'm here" with nickname
  CHANNEL_MSG = 0x02, // Public channel message
  LEAVE = 0x03, // Peer departing
  COURIER_ENV = 0x04, // Store-and-forward envelope
  NOISE_HANDSHAKE = 0x10, // Noise XX handshake (init or response)
  NOISE_ENCRYPTED = 0x11, // Post-handshake Noise-transport encrypted DM
  DR_ENCRYPTED = 0x12, // Double Ratchet encrypted DM (Airhop-to-Airhop only)
  FRAGMENT = 0x20, // Single BLE fragment of a larger message
  REQUEST_SYNC = 0x21, // GCS filter gossip request (local-only, TTL=2)
  FILE_TRANSFER = 0x22, // Binary file / audio / image payload
  BOARD_POST = 0x23, // Signed geohash/mesh bulletin-board post or tombstone
  PREKEY_BUNDLE = 0x24, // Signed batch of one-time prekeys (gossiped)
  GROUP_MESSAGE = 0x25, // Group-encrypted broadcast (cleartext group ID + AEAD)
  PING = 0x26, // Directed mesh echo request (nonce + origin TTL)
  PONG = 0x27, // Directed mesh echo reply (echoed nonce + origin TTL)
  NOSTR_CARRIER = 0x28, // Gateway-ferried signed Nostr event
  VOICE_FRAME = 0x29, // PTT audio burst (matches bitchat-ios voiceFrame)

  // Airhop extensions, allocated at 0x50 to stay clear of bitchat's frontier.
  // bitchat assigns forward and has reached 0x2C, so anything just past their
  // last shipped value is contested ground: one byte with two meanings makes
  // each side's parser depend on the other's validation to not misfire. 0x50
  // leaves them 36 values of room, and conformance.test.ts fails if they come
  // within 16, so a future collision surfaces in CI rather than in the field.
  CHANNEL_ENC = 0x50, // Airhop private channel: XChaCha20-Poly1305 sealed msg
  // Not 0x02: bitchat's BLE mesh has one public room, so a location cell sent as
  // 0x02 would render there, addressed to an audience its author never chose, on
  // top of the Nostr copy bitchat already receives. `#bluetooth` keeps 0x02.
  CHANNEL_MSG_AIRHOP = 0x51,
}

// Retired values, recorded so they are not reintroduced:
//
//   0x30 VIDEO_FRAME  specified over a same-platform WiFi path, so
//                     cross-platform video was never reachable on it.
//   0x40 CASHU_TOKEN  ecash travels as text inside an ordinary encrypted DM and
//                     is found by findTokensInText(). A dedicated type would be
//                     a second path to keep in sync.
