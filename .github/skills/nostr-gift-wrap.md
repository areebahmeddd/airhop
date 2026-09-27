---
description: >
  Reference for Nostr DMs (NIP-17 gift wrap with bitchat's nip44-v2 cipher),
  the bitchat1: envelope inside them, courier drops (kind 1401) and relay
  subscriptions. Read this before touching src/core/nostr/. The layering has
  key and verification requirements that are not obvious from the NIPs alone,
  and the cipher is deliberately not the published NIP-44.
---

# Nostr Gift Wrap and Courier Relay

How a DM, a receipt or parked courier mail crosses the internet when no radio reaches the peer. Kinds and constants are in [PROTOCOLS.md section 8](../../docs/spec/PROTOCOLS.md#8-identity--nostr-constants); the cipher's divergence from NIP-44 is [section 7.1](../../docs/spec/PROTOCOLS.md#71-the-nostr-dm-construction-is-not-the-published-nip-44).

## Key Files

| Path                                  | Holds                                                          |
| ------------------------------------- | -------------------------------------------------------------- |
| `src/core/nostr/gift-wrap.ts`         | `wrapDm`, `unwrapDm`, `deriveNostrPrivKey`                     |
| `src/core/nostr/bitchat-nip44.ts`     | bitchat's `nip44-v2` encryption, even-Y key normalisation      |
| `src/core/nostr/bitchat-envelope.ts`  | The `bitchat1:` content: DM, receipt and contact card          |
| `src/core/nostr/courier-relay.ts`     | `publishCourierDrop`, `subscribeCourierDrops` (kind 1401)      |
| `src/core/nostr/nostr-client.ts`      | `NostrClient`: pool, per-relay subscriptions, `isConnected`    |
| `src/core/nostr/opened-gift-wraps.ts` | Wraps already opened this session                              |
| `src/core/nostr/geohash-identity.ts`  | Per-cell identity for location channels and their DMs          |
| `src/services/mesh-service.ts`        | Inbox subscription, `publishNostrAck`, `sendReadReceipts`      |
| `src/services/tor-routing.ts`         | Whether relay sockets may open at all                          |
| `bitchat/ios/bitchat/Nostr/`          | Reference: `NostrProtocol.swift`, `NostrEmbeddedBitChat.swift` |

## Keys

| Key          | Curve     | Used for                                      |
| ------------ | --------- | --------------------------------------------- |
| Noise static | X25519    | Mesh sessions (Noise XX), peer ID             |
| Signing key  | Ed25519   | Packet, board, prekey and group-state signing |
| Nostr key    | secp256k1 | Nostr events; derived, never stored           |

The Ed25519 key is **not** the Nostr key; Nostr signs with BIP-340 Schnorr on secp256k1. `deriveNostrPrivKey(signingPrivKey)` is `HKDF-SHA256(ikm = signing key, info = "airhop-nostr-key-v1", 32)`. Location channels derive a further identity per geohash from the same key (`geohash-identity.ts`), so presence in one cell cannot be linked to another; a DM from a location channel is wrapped from that per-cell key.

## Gift Wrap (NIP-17 Shape, bitchat Cipher)

```text
content (a bitchat1: envelope)
  -> Rumor     kind 14, unsigned, pubkey = sender, tags []
  -> Seal      kind 13, signed by the sender, rumor encrypted to the recipient
  -> Gift wrap kind 1059, signed by a fresh throwaway key, tags [["p", recipient]]
```

- **Cipher.** Both layers use `bitchatNip44Encrypt`: XChaCha20-Poly1305, key `HKDF(compressed ECDH point, salt empty, info "nip44-v2")`, no padding, framed `"v2:" + base64url(nonce24 || ciphertext || tag)`. It is not NIP-44 and must stay byte-identical to bitchat's, since the event signature covers the ciphertext. Reaching for `nip44` in nostr-tools produces DMs no bitchat or Airhop peer can open, silently at both ends.
- **Keys.** Private keys are normalised to even Y before ECDH, and decrypt tries both parities of the sender's x-only key, as bitchat does.
- **Timestamps.** Seal and wrap `created_at` are randomised ±15 minutes (bitchat's window, not NIP-59's two days). The rumor keeps the real send time.
- **The throwaway key** is new for every wrap, so relays see neither sender nor linkage between wraps.

### Receive (`unwrapDm`)

1. Decrypt the wrap with our key and the wrap's `pubkey`.
2. `verifyEvent(seal)`, and require kind 13. **Security-critical:** without it anyone who knows our pubkey can forge DMs.
3. Decrypt the seal with our key and the seal's `pubkey`.
4. `validateEvent(rumor)`, require kind 14, and require `seal.pubkey === rumor.pubkey`. The rumor is unsigned, so this is the only shape check it gets; a missing or non-numeric `created_at` would otherwise slip past every comparison.
5. Require the rumor's `created_at` within the subscription's lookback (plus 15 minutes) and at most 15 minutes ahead, so nobody chooses where their message lands in a thread.

No recipient tag is checked on the rumor: the seal is encrypted to our key, so a rumor meant for anyone else cannot open. The inbox subscribes to kind 1059 `#p` our key with a 7-day lookback (the sender's outbox lifetime), and skips a wrap ID already opened (`OpenedGiftWraps`) so a relay replaying the window after a reconnect is not decrypted and acknowledged twice. A sender's retry arrives in a new wrap and is acknowledged again.

## The bitchat1: Envelope

bitchat never puts raw text in a Nostr DM. The rumor's content is `"bitchat1:" + base64url(packet)`, where the packet is an unsigned `NOISE_ENCRYPTED` frame (the mesh wire format) holding a Noise payload: `PRIVATE_MESSAGE`, `DELIVERED`, `READ_RECEIPT`, or Airhop's `CONTACT_CARD`. A bitchat client drops a DM without the prefix.

- Content is capped at one `PrivateMessagePacket`, 255 UTF-8 bytes; `encodeBitchatDmEnvelope` returns null past it.
- A pseudonymous (location-channel) DM puts random bytes in `senderID`, never our mesh ID, which would tie the cell identity to it.
- **Receipts.** A message read after its sender left range has no mesh route for its receipt, so `sendReadReceipts` sends it over Nostr, as bitchat-ios routes one; a DM that arrived over Nostr is acknowledged over Nostr. Couriered mail is acknowledged over both routes.

## Courier Drop (Kind 1401)

Sealed courier envelopes parked on relays, so delivery does not need a carrier to meet the recipient (bitchat-ios `BridgeCourierService`).

```text
kind:    1401
tags:    [["x", recipientTagHex], ["expiration", unixSeconds]]
content: base64(CourierEnvelope TLV), as bitchat-ios createCourierDropEvent
```

- Signed by a throwaway key minted per publish, never the device identity: the envelope authenticates its sender inside the Noise X seal, and a stable publisher key would make every drop attributable to one npub. The key is not a parameter, so no caller can pass the identity.
- Published once per message with `copies` 1, since a relay copy goes to the recipient, never to another carrier.
- The `x` tag is the envelope's daily recipient tag (see [`courier-envelopes.md`](courier-envelopes.md)). It is not unlinkable: anyone holding the peer's static key computes it for any day.
- **Subscription:** `{ kinds: [1401], "#x": candidateTags (yesterday, today, tomorrow), since: now - 24 h, limit: 100 }`, renewed when the UTC day rolls over. The limit is bitchat-ios's `courierDrops`; there is no paging with `until`, since a flood can outrun any page budget and every junk page costs Schnorr checks.
- NIP-40 relays expire the event; a drop whose expiry has passed is ignored.

## Relays and Subscriptions

- **One subscription per relay and filter.** nostr-tools 2.25.2 records an event ID as seen before verifying it, in a set shared across the relays of one call, so a hostile relay's forged copy under a genuine ID would hide every honest relay's copy, and a far-future event from one relay would move the `since` another reconnects with. `NostrClient.subscribe` keeps its own delivered-ID set per call, recorded only after verification, and hands nostr-tools a lookup-only `alreadyHaveEvent`. Collapse back to one call once a release carries nbd-wtf/nostr-tools#560.
- **Gift-wrap filters keep their `since`.** nostr-tools moves `since` past the newest `created_at` on reconnect, and a wrap's is blurred up to 15 minutes ahead, so relays would withhold newer wraps (`pinGiftWrapSince`).
- **`isConnected` reads the sockets on every call**, so a gateway that just lost signal stops advertising and publishing into a dead pool.
- **Tor.** Relay sockets open only when `tor-routing.ts` allows. While Tor is wanted and not yet carrying, or held after a failed start, `nostrBlockedByTor` holds the pool: nothing falls back to the clear net.

## What Not to Do

- Use nostr-tools `nip44`, or any standard NIP-44 library, for DM layers.
- Sign the rumor, or skip `verifyEvent(seal)` or the `seal.pubkey === rumor.pubkey` check.
- Reuse a throwaway key across wraps or drops, or sign a drop with the device identity.
- Use the Ed25519 signing key directly with nostr-tools; derive the secp256k1 key first.
- Put raw text in a DM rumor, or our mesh ID in a location-channel envelope.
- Subscribe across relays in one call, or open a relay socket around the Tor gate.
