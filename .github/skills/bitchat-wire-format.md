---
description: >
  Reference for the bitchat v2 binary wire format. Read this before touching
  src/core/mesh/wire/packet-codec.ts, the BLE native modules, or any code that
  constructs or parses packets. A one-byte mistake silently breaks
  interoperability with every bitchat-ios and bitchat-android node on the mesh.
---

# bitchat Wire Format

The packet frame, the type registry and the payloads every other subsystem rides on. The full specification, with every payload layout, is [PROTOCOLS.md](../../docs/spec/PROTOCOLS.md) sections 1 to 3; this card is the working summary.

## Key Files

| Path                                                                                          | Holds                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/core/mesh/wire/packet-codec.ts`                                                          | Frame encode and decode, signing, packet ID, broadcast test  |
| `src/core/mesh/wire/packet-type.ts`                                                           | The type byte, and the retired values                        |
| `src/core/mesh/wire/payload-limits.ts`                                                        | Receive-side ceiling on each type's decoded payload          |
| `src/core/mesh/wire/message-padding.ts`, `packet-compression.ts`                              | PKCS#7 block padding, raw DEFLATE                            |
| `src/core/mesh/wire/noise-payload.ts`                                                         | The typed plaintext inside `NOISE_ENCRYPTED`                 |
| `src/core/mesh/wire/private-media-id.ts`                                                      | bitchat's stable ID for a sealed photo or voice note         |
| `src/core/mesh/discovery/announce-manager.ts`                                                 | `ANNOUNCE` TLV and capability bits                           |
| `src/core/router/message-router.ts`                                                           | Public channel payloads (`channelPacketType` and its codecs) |
| `bitchat/ios/localPackages/BitFoundation/Sources/BitFoundation/`                              | Reference: `BinaryProtocol.swift`, `MessageType.swift`       |
| `bitchat/android/app/src/main/java/com/bitchat/android/protocol/`                             | Reference: `BinaryProtocol.kt`                               |
| `src/core/mesh/wire/__tests__/packet-frame-vectors.test.ts`, `packet-payload-vectors.test.ts` | Byte layouts pinned against bitchat                          |

## Frame

Two header versions exist and both are **decoded**; read the version byte, never assume. v1 is 14 bytes with a `u16` payload length and no route section, and bitchat still emits it for its core broadcasts (announce, message, leave). v2 is 16 bytes with a `u32` length. Airhop **emits v2 for everything**, which bitchat decodes for every type.

| Offset | Size | Type   | Field         | Notes                                       |
| ------ | ---- | ------ | ------------- | ------------------------------------------- |
| 0      | 1    | u8     | version       | `2` on send; `1` and `2` accepted           |
| 1      | 1    | u8     | type          | See the registry below                      |
| 2      | 1    | u8     | ttl           | Hop budget; zeroed in the signed bytes      |
| 3-10   | 8    | u64-BE | timestamp     | Unix **milliseconds**                       |
| 11     | 1    | u8     | flags         | See below                                   |
| 12-15  | 4    | u32-BE | payloadLength | Payload plus `originalSize`; excludes route |

Then, in this order:

```text
senderID      8 bytes    always
recipientID   8 bytes    only with HAS_RECIPIENT
route         variable   v2 only, with HAS_ROUTE: [count u8][hop 8B] x count
originalSize  2 or 4 B   only with COMPRESSED (the length field's width)
payload       N bytes    compressed bytes when COMPRESSED, else raw
signature     64 bytes   only with SIGNED (Ed25519)
```

| Bit | Hex    | Codec name      | Meaning                                         |
| --- | ------ | --------------- | ----------------------------------------------- |
| 0   | `0x01` | `HAS_RECIPIENT` | `recipientID` present                           |
| 1   | `0x02` | `SIGNED`        | Signature appended (bitchat's `hasSignature`)   |
| 2   | `0x04` | `COMPRESSED`    | Raw-DEFLATE payload, preceded by `originalSize` |
| 3   | `0x08` | `HAS_ROUTE`     | Source-route hop list present                   |
| 4   | `0x10` | `IS_RSR`        | Solicited sync response                         |

**TTL.** Announces and directed traffic leave at `7`. A broadcast this node authors draws its TTL from the top three values under its degree's relay ceiling (`origin-ttl.ts`), so the maximum alone does not mark the author. Relays clamp and decrement per [`mesh-routing.md`](mesh-routing.md).

**Broadcast** has three spellings, all accepted by `isBroadcast`: `HAS_RECIPIENT` clear (what Airhop and bitchat-ios emit; decoded as all-zeros), an all-zero `recipientID`, and an all-`0xFF` `recipientID` with the flag set, which bitchat-android writes on live voice and public files.

**Padding** means two different things ([PROTOCOLS section 2.1](../../docs/spec/PROTOCOLS.md#21-padding-two-different-rules)):

- The **signing preimage** is padded for every type, always.
- The **outbound frame** is PKCS#7-padded only where ciphertext length leaks plaintext length: `NOISE_ENCRYPTED`, `NOISE_HANDSHAKE`, `DR_ENCRYPTED` and `CHANNEL_ENC` (`padsBLEFrame`). Decoders accept either form.

## Signing and Packet ID

Sign or verify over `encodePacket` with `ttl = 0`, `IS_RSR` cleared, `SIGNED` cleared (no signature field) and padding forced on. This is bitchat's `toBinaryDataForSigning()`: relays decrement TTL and tag sync replies without invalidating the signature.

A decoded packet keeps its payload exactly as received, compressed bytes and the compress decision included, and re-encoding reuses that form. DEFLATE output is not canonical across zlib, Apple's encoder and pako, so re-compressing on verify or relay would change the preimage and break the signature for every node downstream.

```text
PacketID = SHA-256(type[1] | senderID[8] | timestamp_u64_BE[8] | payload)[0:16]
```

No nonce field; deduplication is content-addressed (`computePacketId`, bitchat's `PacketIdUtil`).

## Packet Type Registry

Everything up to `0x29` is bitchat's. bitchat allocates forward and has reached `0x2C` (`0x2A` and `0x2B` reserved for courier spray-ack, `0x2C` `announceV2`), so Airhop's extensions start at `0x50`. `conformance.test.ts` parses bitchat's `MessageType.swift` and fails if its frontier comes within 16 of an Airhop type; `DR_ENCRYPTED` (`0x12`, never assigned by bitchat) is the one listed exemption. bitchat-android implements only `0x01` to `0x03`, `0x10`, `0x11`, `0x20` to `0x22` and `0x29`.

A bitchat node never interprets a type it does not know, but it relays it: the unknown case falls through to `scheduleRelayIfNeeded`, and `RelayController.decide` treats it as an ordinary broadcast. An Airhop-only type therefore crosses a mesh of bitchat phones, invisible to their users. Two projects giving one number two meanings is the risk, not relaying.

| Name                 | Hex             | Direction         | Carries                                                   |
| -------------------- | --------------- | ----------------- | --------------------------------------------------------- |
| `ANNOUNCE`           | `0x01`          | Broadcast         | Signed presence heartbeat, TLV payload                    |
| `CHANNEL_MSG`        | `0x02`          | Broadcast         | `#bluetooth` message, bare UTF-8                          |
| `LEAVE`              | `0x03`          | Broadcast         | Peer departing, signed                                    |
| `COURIER_ENV`        | `0x04`          | Directed          | Sealed store-and-forward envelope                         |
| `NOISE_HANDSHAKE`    | `0x10`          | Unicast           | Noise XX msg1, msg2 or msg3                               |
| `NOISE_ENCRYPTED`    | `0x11`          | Unicast           | Typed Noise payload (below)                               |
| `DR_ENCRYPTED`       | `0x12`          | Unicast           | Double Ratchet DM, signed (Airhop only)                   |
| `FRAGMENT`           | `0x20`          | Broadcast/Unicast | One fragment of a larger packet                           |
| `REQUEST_SYNC`       | `0x21`          | Unicast           | GCS gossip request, TTL 0, addressed to one link peer     |
| `FILE_TRANSFER`      | `0x22`          | Broadcast/Unicast | `BitchatFilePacket`, 1 MiB content cap                    |
| `BOARD_POST`         | `0x23`          | Broadcast         | Signed bulletin-board post or tombstone                   |
| `PREKEY_BUNDLE`      | `0x24`          | Broadcast         | Signed one-time prekeys; flooded, never gossip-synced     |
| `GROUP_MESSAGE`      | `0x25`          | Broadcast         | Private group: cleartext groupID + epoch, ChaChaPoly body |
| `PING` / `PONG`      | `0x26` / `0x27` | Unicast           | Directed echo (nonce + origin TTL)                        |
| `NOSTR_CARRIER`      | `0x28`          | Broadcast/Unicast | Gateway-ferried signed Nostr event                        |
| `VOICE_FRAME`        | `0x29`          | Broadcast         | Live push-to-talk burst, signed                           |
| `CHANNEL_ENC`        | `0x50`          | Broadcast         | Private channel, XChaCha20-Poly1305 (Airhop only)         |
| `CHANNEL_MSG_AIRHOP` | `0x51`          | Broadcast         | Named public channel, a location cell (Airhop only)       |

Retired, never to be reused: `0x30 VIDEO_FRAME` (a same-platform Wi-Fi path, so never cross-platform; video ships as a file) and `0x40 CASHU_TOKEN` (ecash is text in an ordinary DM, found by `findTokensInText()`).

Every type has a decoded-payload ceiling in `payload-limits.ts`, mirroring bitchat-ios `PacketPayloadLimits`. A new type needing more than a v1 frame has to be added there before it ships, or receivers drop it.

## Public Channel Payloads

The packet type decides the payload, so neither form carries a marker byte.

| Channel      | Type   | Payload                                      |
| ------------ | ------ | -------------------------------------------- |
| `#bluetooth` | `0x02` | The message text as UTF-8, nothing else      |
| Any other    | `0x51` | `[chLen u8][channel][idLen u8][msgId][text]` |

bitchat's mesh has one public room, and `BLEPublicMessageHandler` renders the whole payload as the body, so `#bluetooth` sends and accepts the bare form. It needs no message ID: bitchat-ios derives one from sender, timestamp and content (`MeshMessageIdentity.stableID`), and Airhop's `bridgeStableID` matches it. The payload is decoded strictly; invalid UTF-8 is dropped, not rendered as replacement characters.

Location cells travel under `0x51`, where both bitchat clients see an unknown type and relay it. Catch-up comes from its own gossip-sync bit, 24, which bitchat masks off ([PROTOCOLS section 5.2](../../docs/spec/PROTOCOLS.md#52-sync-type-bits)).

## ANNOUNCE TLV

`[type u8][length u8][value]`. Tags `0x01` to `0x06` are bitchat's.

| Tag    | Field           | Size           | Notes                                                                                |
| ------ | --------------- | -------------- | ------------------------------------------------------------------------------------ |
| `0x01` | nickname        | up to 32 bytes | UTF-8, NFC-canonicalized, cut on a character boundary                                |
| `0x02` | Noise pub key   | 32 bytes       | X25519 static key; `senderID` must derive from it                                    |
| `0x03` | signing pub key | 32 bytes       | Ed25519                                                                              |
| `0x04` | neighbor IDs    | up to 80 bytes | Decoded, never emitted: it hands a passive listener the room's adjacency graph       |
| `0x05` | capabilities    | 1 to 4 bytes   | Minimal little-endian bitfield; omitted when zero                                    |
| `0x06` | bridge geohash  | up to 12 bytes | Rendezvous cell a bridge gateway serves                                              |
| `0x07` | Nostr pub key   | 32 bytes       | Airhop only, x-only secp256k1. A claim, not a proof: see `bindNostrPubkey`           |
| `0xB1` | Bitle role      | 1 byte         | Read, never written. Bit 0 marks a dedicated relay; cosmetic only, since self-signed |

Receive rules: signature mandatory, and `senderID` must derive from the `0x02` key. Freshness is the ingress rule every packet meets (within 2 minutes of our clock, unless a solicited sync reply; see [`mesh-routing.md`](mesh-routing.md)), and the announce handler also refuses one more than 15 minutes off (`isAnnounceFresh`).

## Noise Inner Payload

The plaintext of `NOISE_ENCRYPTED` is `[type u8][body]` (`NoisePayloadType`). bitchat drops an unknown type, so raw text is never valid here. Full table and capability bits: [PROTOCOLS section 3.3](../../docs/spec/PROTOCOLS.md#33-noise-inner-payload-types).

| Type          | Name                                | Type             | Name                                                        |
| ------------- | ----------------------------------- | ---------------- | ----------------------------------------------------------- |
| `0x01`        | `PRIVATE_MESSAGE`                   | `0x20`           | `PRIVATE_FILE`                                              |
| `0x02`        | `READ_RECEIPT`                      | `0x09`           | alias of `0x20`, accepted, never sent                       |
| `0x03`        | `DELIVERED`                         | `0x21`           | `AUTHENTICATED_PEER_STATE`                                  |
| `0x06`/`0x07` | `GROUP_INVITE` / `GROUP_KEY_UPDATE` | `0x22`           | `CONTACT_CARD` (Airhop)                                     |
| `0x08`        | `VOICE_FRAME`                       | `0x50` to `0x53` | `LOCATION_PIN`, `RING`, `RING_ACK`, `RING_REFUSED` (Airhop) |

- `PRIVATE_MESSAGE` fields have one-byte lengths, so message ID and content are each capped at 255 UTF-8 bytes on all three clients.
- A DM attachment goes only sealed as `0x20`, and only to a peer that proved capability bit 8 inside its `0x21`. The cleartext directed `FILE_TRANSFER` is still received, never sent.
- A sealed photo or voice note is keyed by `privateMediaStableID` (`media-<32 hex>`, from sender, recipient and an `img_<UUID>.jpg` or `voice_<UUID>.m4a` name), and the receiver answers with a `DELIVERED` naming it.
- Capabilities in `0x21` are authoritative; announced bits are a hint that chooses wording, never how to send.
- Airhop's own Noise payload types start at `0x50`; `0x22` predates the rule.

A Nostr DM carries the same bytes: an unsigned `NOISE_ENCRYPTED` packet holding a Noise payload, base64url behind `bitchat1:` (`bitchat-envelope.ts`, see [`nostr-gift-wrap.md`](nostr-gift-wrap.md)).

## BLE Identifiers and Peer ID

These never change without a coordinated protocol version bump.

| Identifier          | Value                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Service UUID        | `F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C`                                                       |
| Characteristic UUID | `A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D`                                                       |
| Protocol version    | `2`                                                                                          |
| Peer ID in advert   | Android: 8 bytes in scan-response service data. iOS: none, service UUID only, as bitchat-ios |

```text
peerID = hex(SHA-256(noiseStaticPubKey)).slice(0, 16)
```

The peer ID derives from the Noise static key, never the Ed25519 key. A scanner that reads no ID from the advert connects anyway and learns the peer from its first `ANNOUNCE`.

## What Not to Do

- Change a byte of the frame layout without bumping the protocol version.
- Sign over an unpadded preimage, or re-compress a received payload before verifying or relaying it.
- Treat only `HAS_RECIPIENT` clear as broadcast; bitchat-android's all-`0xFF` form is a broadcast too.
- Claim a type byte below `0x50`, or reuse `0x30` or `0x40`.
- Put a marker byte, channel field or message ID into a `#bluetooth` payload.
- Emit the `0x04` neighbor TLV or originate a source route.
- Send a DM attachment as a cleartext `FILE_TRANSFER`, or act on an announced capability bit.
