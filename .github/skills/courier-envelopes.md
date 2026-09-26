---
description: >
  Reference for one-time prekey bundles (0x24) and the forward-secret courier
  envelopes that seal to them. Read before touching prekey-bundle.ts,
  prekey-store.ts, or courier-store.ts. Breaking forward secrecy here is silent:
  the message still delivers, it just stops being protected.
---

# Courier Envelopes

> Read before touching `prekey-bundle.ts`, `prekey-store.ts`, `courier-store.ts`, or any offline-delivery path.
>
> Source of truth: `bitchat/ios/localPackages/BitFoundation/Sources/BitFoundation/PrekeyBundle.swift` and `CourierEnvelope.swift`.

## Why this exists

A courier envelope lets you message someone who is offline: you seal it and hand it to a peer who may physically meet them later. Sealed to the recipient's long-lived static key, every undelivered envelope is exposed the day that key leaks.

One-time prekeys fix this. Each device publishes a batch of single-use public keys. A sender seals to one of them; the recipient opens it and destroys that key. A later compromise of the static key does not open past mail. This is the whole point, and it fails **silently** if broken: the message still delivers, it just is not forward secret any more. Reviews must check it explicitly.

## Bundle wire format (`0x24`)

TLV, 2-byte big-endian lengths. Broadcast and gossiped.

| Tag    | Field                | Notes                                        |
| ------ | -------------------- | -------------------------------------------- |
| `0x01` | noiseStaticPublicKey | 32 bytes; identifies whose prekeys these are |
| `0x02` | prekeys              | N x (4-byte BE id + 32-byte pubkey), N <= 8  |
| `0x03` | generatedAt          | u64 BE ms; newer replaces older per key      |
| `0x04` | signature            | 64-byte Ed25519 over `signableBytes()`       |

Signature covers, in order: 1-byte-length-prefixed context `"bitchat-prekey-bundle-v1"`, the 32-byte noise key, a 1-byte prekey count, each (id BE, 32-byte key), then `generatedAt` BE. Encoders and verifiers must derive these identically. Duplicate prekey IDs are rejected at decode: one consumed ID must never shadow another.

## Rules

- Bundles are **public and unencrypted by design**. They carry only public halves. Do not "fix" this by sealing them; bitchat gossips them in the clear and sealing breaks interop.
- Verify every inbound bundle before storing. The bundle itself carries only the noise key, so resolve the owner via `peerID = hex(SHA-256(noiseStaticPublicKey))[0:16]`. The packet must come from that owner (`senderID` equal to it), its outer packet signature must verify, and the inner bundle signature must verify against `knownSigningKey(owner)` in `mesh-service.ts` (session-proven, then saved contact, then announce pin). No signing key means no verification, so ignore it (the flood layer still relays it for others). Our own bundle coming back is ignored.
- A bundle dated more than 15 minutes ahead (`generatedAt`) is refused, so a forged future date cannot pin itself as the newest. bitchat-ios has no such bound.
- When a session proof (`0x21`) corrects a peer's signing key, bundles taken under the wrong key are dropped (`PeerPrekeyStore.forget`).
- Private prekeys never leave the device. They live in one keychain item, `airhop.prekeys.local.v1` (`KEYCHAIN_ITEMS.localPrekeys`), as one base64 blob, as bitchat-ios keeps them in one Keychain blob. Never in MMKV: it appends, so a consumed key deleted there lingers in the file until a rewrite. Peer bundles are public and stay in MMKV.
- The keychain is read synchronously. A read that throws leaves no state: nothing is minted, nothing written, no bundle built, and the next use retries (an iOS relaunch before first unlock lands here). A write that throws keeps the state in memory and retries on the next change. The launch sweep leaves the item alone; the panic wipe deletes it.
- A prekey is **single use**. On opening an envelope, consume it and publish a fresh bundle so senders stop using the spent key.
- Consumed private keys are kept for a grace window (48h) so a second in-flight envelope sealed to the same key still opens, then dropped, and a consumed key past its grace no longer opens anything. Do not keep them forever; the grace window is the forward-secrecy boundary.
- **At most 8 consumed keys are kept**, whatever their age. This is an Airhop-only deviation: bitchat-ios keeps every consumed key for the whole grace window. Anyone holding our public bundle can spend prekeys at will, and every one kept grows a keychain value some platforms cap near 2 KiB.
- Prekeys never move to a new phone; the new one publishes its own batch.

## Courier envelope: v1 vs v2

`CourierEnvelope` gains one optional TLV:

| Tag    | Field    | Meaning                                      |
| ------ | -------- | -------------------------------------------- |
| `0x05` | prekeyID | Present = v2, sealed to that one-time prekey |
|        | (absent) | v1, sealed to the recipient's static key     |

The tag is omitted for v1 so the bytes stay identical to the pre-prekey format. A v1-only decoder skips `0x05` as unknown, carries the envelope opaquely, and simply fails to open one addressed to it. That degradation is intentional.

**The routing tag always derives from the recipient's STATIC key**, in both v1 and v2. Delivery matching must not change when the seal target changes, or carriers stop recognising envelopes.

## Seal and open

Sealing to a prekey reuses the same one-way Noise X primitive with the prekey pair substituted for the static pair. The prologue differs by seal target, as in bitchat-ios (`NoiseEncryptionService` `courierPrologue` and `prekeyPrologue`), and is mixed in before the recipient's key:

| Seal       | Prologue (`courier-store.ts`)                                      |
| ---------- | ------------------------------------------------------------------ |
| v1, static | `COURIER_PROLOGUE` = `"bitchat-courier-v1"`                        |
| v2, prekey | `prekeyPrologue(id)` = `"bitchat-prekey-v1"` \|\| u32 BE prekey ID |

`sealPrologue(prekeyID)` picks one from the envelope's `0x05` TLV on both sides. The v2 prologue binds the ID, so a v2 ciphertext does not open against another prekey. There is no trial-open without a prologue. `docs/spec/courier-seal-vectors.json` holds reference seals from Python `noiseprotocol`, which `courier-vectors.test.ts` opens.

```typescript
// Sender: prefer a prekey when we hold a bundle for them.
const prekey = peerPrekeys.assign(recipientNoisePub) ?? undefined;
const ciphertext = noiseXSeal(
  senderStaticPriv,
  prekey?.publicKey ?? recipientNoisePub, // prekey when available
  plaintext,
  sealPrologue(prekey?.id),
);
// tag still from the STATIC key
recipientTag: computeRecipientTag(recipientNoisePub),
prekeyID: prekey?.id,
```

```typescript
// Recipient: pick the opening key from the envelope, then burn it.
const openKey =
  env.prekeyID !== undefined
    ? localPrekeys.privForId(env.prekeyID) // null if unknown or past its grace
    : identity.noiseStaticPrivKey;
if (openKey === null) return; // cannot open, drop
const { plaintext, senderStaticPubKey } = noiseXOpen(
  openKey,
  env.ciphertext,
  sealPrologue(env.prekeyID),
);
if (env.prekeyID !== undefined) {
  localPrekeys.consume(env.prekeyID);
  emitPrekeyBundle(); // republish so senders stop using the spent key
}
```

The sender's identity is authenticated **inside** the ciphertext. Identify the sender from `senderStaticPubKey`, never from the packet header, which names whoever relayed it.

## Review checklist

- Bundle signed by the identity key, and verified on receipt against the owner's held key, from the owner itself: **required**
- Private prekey never serialised off-device, and held only in its keychain item: **required**
- Seal and open with bitchat-ios's prologue for the envelope's version: **required**
- Consumed prekey never reused to open a second envelope: **required**
- Routing tag derived from the static key even on v2: **required**
- Sender identified from the sealed static key, not the packet header: **required**
