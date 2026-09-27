---
description: >
  Reference for one-time prekey bundles (0x24), the forward-secret courier
  envelopes that seal to them, and how carriers deposit, hand over and spray
  them. Read before touching prekey-bundle.ts, prekey-store.ts, courier-store.ts
  or any offline-delivery path. Breaking forward secrecy here is silent: the
  message still delivers, it just stops being protected.
---

# Courier Envelopes

How a DM reaches someone out of range: sealed once, carried by phones that may meet them later, and parked on Nostr relays as well. The constants are in [PROTOCOLS.md section 6](../../docs/spec/PROTOCOLS.md#6-store-and-forward-courier-constants), pinned by `courier-test-vectors.json` and `courier-seal-vectors.json` in `docs/spec/`.

## Key Files

| Path                                                             | Holds                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/mesh/wire/prekey-bundle.ts`                            | Bundle codec, signing and verification                                                                |
| `src/core/mesh/courier/prekey-store.ts`                          | `LocalPrekeyStore` (ours, keychain) and `PeerPrekeyStore` (theirs, MMKV)                              |
| `src/core/mesh/courier/courier-store.ts`                         | Envelope codec, recipient tag, prologues, the carried pool                                            |
| `src/core/nostr/courier-relay.ts`                                | Kind 1401 relay drops (see [`nostr-gift-wrap.md`](nostr-gift-wrap.md))                                |
| `src/services/mesh-service.ts`                                   | `sendViaCourier`, `onCourierEnvelope`, `openCourierEnvelopeForUs`, `sprayCourierTo`, `onPrekeyBundle` |
| `bitchat/ios/localPackages/BitFoundation/Sources/BitFoundation/` | Reference: `PrekeyBundle.swift`, `CourierEnvelope.swift`                                              |
| `bitchat/ios/bitchat/Services/Courier/CourierStore.swift`        | Reference: the carrier's pool                                                                         |

## Why Prekeys

An envelope sealed to the recipient's long-lived static key is exposed the day that key leaks. Each device therefore publishes a batch of single-use public keys; a sender seals to one, the recipient opens it and destroys that key, and a later compromise of the static key opens no past mail. It fails **silently** if broken, so reviews check it explicitly.

## Prekey Bundle (`0x24`)

TLV with 2-byte big-endian lengths. Broadcast and relayed; never carried by gossip sync.

| Tag    | Field                | Notes                                            |
| ------ | -------------------- | ------------------------------------------------ |
| `0x01` | noiseStaticPublicKey | 32 bytes; whose prekeys these are                |
| `0x02` | prekeys              | N x (4-byte BE id + 32-byte key), N ≤ 8          |
| `0x03` | generatedAt          | u64 BE ms; newer replaces older per key          |
| `0x04` | signature            | 64-byte Ed25519 over `prekeyBundleSignableBytes` |

The signature covers, in order: the 1-byte-length-prefixed context `"bitchat-prekey-bundle-v1"`, the 32-byte Noise key, a 1-byte prekey count, each (id BE, key), then `generatedAt` BE. Duplicate prekey IDs are refused at decode, so one consumed ID never shadows another.

**Accepting one** (`onPrekeyBundle`, as bitchat-ios `BLEService.handlePrekeyBundle`): the owner is `hex(SHA-256(noiseStaticPublicKey))[0:16]`; the packet's `senderID` must be that owner; the packet signature and the bundle signature must both verify against `knownSigningKey(owner)` (proven in a session, then saved contact, then announce pin). No key, no verification, and the bundle is ignored here while the flood still relays it for others. Our own bundle coming back is ignored. `ingest` refuses one dated more than 15 minutes ahead, since a far-future date would pin itself as newest (bitchat-ios has no such bound). When a session proof (`0x21`) corrects a peer's signing key, bundles taken under the wrong one are dropped (`forget`).

## Prekey Rules

- **Bundles are public by design.** They carry only public halves; bitchat floods them in the clear, and sealing them breaks interop.
- **Private prekeys never leave the device.** One keychain item, `airhop.prekeys.local.v1` (`KEYCHAIN_ITEMS.localPrekeys`), one blob, as bitchat-ios keeps one Keychain blob. Never MMKV: it appends, so a deleted key lingers in the file until a rewrite. Peer bundles are public and stay in MMKV. The panic wipe deletes both; prekeys never move to a new phone.
- **Keychain failures leave no state.** A read that throws mints nothing, writes nothing and builds no bundle, and the next use retries (an iOS relaunch before first unlock lands here). A write that throws keeps the state in memory and retries on the next change.
- **Single use, consumed first.** Consume the prekey the moment an envelope opens under it, before any block, payload-type or message-ID check can return, then publish a fresh bundle (`emitPrekeyBundle(true)`) so senders stop using it. bitchat-ios consumes inside `openPrekeyPayload` for the same reason.
- **One prekey per message.** `PeerPrekeyStore.assign(noiseKey, messageID)` returns the prekey already assigned to that message, so every re-seal for a new courier or a retry spends the same one (bitchat-ios `assignRecipientPrekey`). A newer bundle from the owner keeps used IDs and assignments for prekeys it still offers.
- **Grace, then gone.** A consumed private key is kept 48 h so a second in-flight envelope sealed to it still opens, then dropped. At most 8 consumed keys are kept whatever their age, an Airhop-only cap: anyone holding our bundle can spend prekeys at will, and every one kept grows a keychain value some platforms cap near 2 KiB.

## Envelope

TLV with 2-byte big-endian lengths, byte-identical to bitchat-ios `CourierEnvelope`:

| Tag    | Field        | Notes                                                     |
| ------ | ------------ | --------------------------------------------------------- |
| `0x01` | recipientTag | 16 bytes                                                  |
| `0x02` | expiry       | u64 BE ms                                                 |
| `0x03` | ciphertext   | Noise X, at most 16 KiB                                   |
| `0x04` | copies       | Spray budget; omitted when 1, clamped to 1 to 8 on decode |
| `0x05` | prekeyID     | u32 BE. Present = v2, sealed to that one-time prekey      |

With `0x05` absent the envelope is v1, sealed to the static key and byte-identical to the pre-prekey format. A v1-only decoder skips `0x05`, still carries the envelope, and cannot open one addressed to it; that degradation is intended.

**Recipient tag** = `HMAC-SHA256(key = recipient static Noise key, "bitchat-courier-tag-v1" || epochDay u32 BE)[0:16]`, always from the **static** key, v1 or v2, or carriers stop recognising mail. Matching tries yesterday's, today's and tomorrow's (`candidateTags`). Anyone who heard one announce can compute a peer's tags for any day: do not call courier mail unlinkable.

**Plaintext** is a typed Noise `PRIVATE_MESSAGE` (`0x01`), whose message ID and content are each capped at 255 UTF-8 bytes. bitchat refuses any other payload type. A message too long to encode has no courier form and stays in the outbox.

## Seal and Open

| Seal       | Prologue (`courier-store.ts`)                                      |
| ---------- | ------------------------------------------------------------------ |
| v1, static | `COURIER_PROLOGUE` = `"bitchat-courier-v1"`                        |
| v2, prekey | `prekeyPrologue(id)` = `"bitchat-prekey-v1"` \|\| u32 BE prekey ID |

`sealPrologue(prekeyID)` picks one from the envelope's `0x05` on both sides. The v2 prologue binds the ID, so a v2 ciphertext does not open against another prekey, and there is no trial-open without a prologue.

```typescript
// Sender (sendViaCourier). The static key comes from courierSealKey: the
// announce pin, else the saved contact. Never a reachability-gated lookup,
// since a courier exists for a peer who has left.
const prekey = peerPrekeys.assign(noisePub, messageID) ?? undefined;
const ciphertext = noiseXSeal(
  identity.noiseStaticPrivKey,
  prekey?.publicKey ?? noisePub,
  encodeNoisePrivateMessage(messageID, text),
  sealPrologue(prekey?.id),
);
// recipientTag: computeRecipientTag(noisePub), always the STATIC key
```

```typescript
// Recipient (openCourierEnvelopeForUs), shared by the mesh and relay paths.
const openKey =
  env.prekeyID !== undefined
    ? localPrekeys.privForId(env.prekeyID) // null if unknown or past grace
    : identity.noiseStaticPrivKey;
if (openKey === null) return;
const { plaintext, senderStaticPubKey } = noiseXOpen(
  openKey,
  env.ciphertext,
  sealPrologue(env.prekeyID),
);
if (env.prekeyID !== undefined && localPrekeys.consume(env.prekeyID)) {
  emitPrekeyBundle(true); // before any check that can drop the message
}
// Sender = hash of senderStaticPubKey, never the packet header.
```

The recipient dedupes copies on the sender's message ID, which also collapses a courier copy against the direct one. It sends `DELIVERED` over both routes, a mesh session and Nostr when it knows the sender's npub, since the sender is by definition out of range; a read receipt is owed as for any DM.

## Sending

The sender seals **once** per message and addresses the same bytes to every courier, which is what lets carriers merge copies.

- **Couriers** are directly linked, announced peers with a known Noise key, up to 4 per message, skipping any it already went to. Each gets the full budget of 4 copies (bitchat's `courierInitialCopies`); splitting it would starve busy rooms, and merging on deposit keeps the total bounded.
- **Delivery** is a directed `COURIER_ENV` down the courier's own link, or flooded when it is a hop away. Only a write accepted onto that exact peer's link counts as taken.
- **Relay drop.** When relays are up, a copy with `copies: 1` is parked as kind 1401 once per message, whether or not a courier was in range.
- **Retries.** `courierQueuedMail` offers every queued DM for an unreachable recipient to whatever carriers are in range, on the events that matter (a peer appearing, a resume, a reconnect), so mail written with nobody near leaves with the first phone that walks up.

`sendViaCourier` returns true only when a courier took it; a relay drop alone is not "carried by a friend".

## Carrying

**Deposit** (`onCourierEnvelope`). Only an envelope addressed to this node (`recipientID`), from a depositor whose packet verifies (`senderIsAuthentic`), is accepted; relays passing a flooded copy never deposit it. Then `CourierStore.deposit` applies:

| Limit                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| Pool                 | 40 envelopes; verified tier at most 20                      |
| Per depositor        | 5 for a saved contact (favorite), 2 otherwise (verified)    |
| Expiry               | At most 24 h plus 1 h slack; longer is refused, not clamped |
| Identical ciphertext | Merged; the budget rises only before the first spray        |

**On a verified announce** (`sprayCourierTo`), as bitchat-ios splits it:

- **On a link we hold:** hand over the peer's own mail with a budget of 1, retired only once the write lands (`offerHandover` / `commitHandover`); then spray half the budget of anything else, once per peer, never back to its depositor and never their own mail (`offerSpray` / `commitSpray`). Both commit only after the transport confirms, so a full GATT queue costs nothing.
- **Heard through relays:** flood the peer's own mail toward them at most once per envelope per 10 minutes, and keep carrying it (`offerRemoteHandover`). Never spray: a flood cannot confirm a carrier took the copy, so no budget would be spent and every peer within seven hops would end up carrying one.

bitchat-ios hands over only on a link whose Noise session was made on that link. Airhop does not record which link a session came from, so it hands over on any link bound by a direct announce.

## What Not to Do

- Seal a bundle, or store one without verifying both signatures against the owner's held key.
- Serialize a private prekey anywhere but its keychain item.
- Seal or open without bitchat-ios's prologue for the envelope's version.
- Return before consuming a prekey that opened an envelope, or spend a second prekey on a re-seal of one message.
- Derive the routing tag from the prekey instead of the static key.
- Identify the sender from the packet header.
- Re-seal per courier, deposit a flooded copy not addressed to us, or retire an envelope before its handover write lands.
- Spray to a peer heard only through relays.
