---
description: >
  Reference for Noise sessions and the Double Ratchet in Airhop: when to use XX
  vs X, how a handshake runs and recovers, the transport message format, and
  how the ratchet is seeded. Mistakes here produce sessions that appear
  established but silently fail to decrypt, with no thrown error.
---

# Noise Sessions

How two peers get a live encrypted session, keep it, and heal it when the two sides fall out of step. Wire-compatible with bitchat-ios; background and rationale are in [ARCHITECTURE.md section 5](../../docs/spec/ARCHITECTURE.md#5-encryption).

## Key Files

| Path                                                                                                         | Holds                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/core/crypto/noise-xx.ts`                                                                                | `NoiseHandshake` (create, write/read msg1 to msg3, `clone`, `split`) and `NoiseSession`         |
| `src/core/crypto/noise-x.ts`                                                                                 | `noiseXSeal` / `noiseXOpen`, one-way sealing for courier mail                                   |
| `src/core/crypto/double-ratchet.ts`                                                                          | Signal Double Ratchet for Airhop-to-Airhop DMs                                                  |
| `src/core/mesh/routing/handshake-rate-limiter.ts`                                                            | Handshake budgets                                                                               |
| `src/core/mesh/wire/peer-state-packet.ts`                                                                    | The `0x21` identity proof sent inside a new session                                             |
| `src/services/mesh-service.ts`                                                                               | Handshake dispatch (`onNoiseHandshake`), `reapExpiredHandshakes`, `recoverSession`, `tryInitDR` |
| `bitchat/ios/bitchat/Noise/NoiseProtocol.swift`, `NoiseSessionManager.swift`, `NoiseSecurityConstants.swift` | Reference                                                                                       |
| `bitchat/ios/bitchat/Services/BLE/BLENoisePacketHandler.swift`                                               | Reference: what a failed decrypt does                                                           |

## Which Pattern

| Pattern  | Algorithm name                     | Use                                   |
| -------- | ---------------------------------- | ------------------------------------- |
| Noise XX | `Noise_XX_25519_ChaChaPoly_SHA256` | Live sessions between reachable peers |
| Noise X  | `Noise_X_25519_ChaChaPoly_SHA256`  | One-way sealing of courier envelopes  |

XX whenever the peer can answer. X only for store-and-forward: it has no forward secrecy of its own, which is why courier mail seals to one-time prekeys when it can (see [`courier-envelopes.md`](courier-envelopes.md)).

## Noise XX Handshake

```text
msg1  initiator -> responder   -> e             32 bytes
msg2  responder -> initiator   <- e, ee, s, es  96 bytes
msg3  initiator -> responder   -> s, se         64 bytes
```

The prologue is empty on every mesh session, as bitchat sends it; only a device transfer binds one, to the scanned code. The payload length alone says which message it is.

**Roles.** Whoever sends msg1 is the initiator. A 32-byte msg1 is answered as responder even mid-handshake (a peer restart, or a stale attempt of ours), carrying any queued DMs across. The one exception is a crossed initiation: while we hold a live initiator attempt and our peer ID sorts lower, the incoming msg1 is ignored and the peer yields, as in bitchat-ios, so exactly one session forms. The claimed sender of a msg1 is unauthenticated, so a forged one can displace a live attempt, as it can in bitchat-ios; the rate limit bounds it and the next attempt or the outbox recovers (simulation C13b).

**Completing.** msg2 and msg3 are read on a `clone()` of the pending handshake, which is replaced only by a bound session, so one forged or garbled reply cannot end a genuine handshake. After `split()` the session's remote static key must hash to the claimed peer ID (`sessionBindsTo`), or it is discarded. The initiator completes on msg2, one message before the responder, so it sends msg3 **first**, then its `0x21` identity proof, then seeds the ratchet and releases queued DMs and group invites. The responder, completing on msg3, sends its proof first too.

**Keys after split.** Initiator sends with k1 and receives with k2; the responder the reverse. `split()` handles it, and also yields `exporterSecret`, a third HKDF output for keys outside the transport. k1 and k2 are bit-identical to a two-output split, so bitchat interop is unaffected.

## Limits and Recovery

| Rule                    | Value                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| Per claimed peer        | 10 per minute: inbound msg1, inbound msg2/msg3, and our own initiations |
| Global                  | 30 per minute, **inbound msg1 only**                                    |
| Pending attempt timeout | 30 s (`HANDSHAKE_TIMEOUT_MS`)                                           |
| Sweep                   | On every new attempt, and on the 45 s outbox sweep                      |

bitchat-ios counts every handshake message in its global bucket, so a flood of forged msg1 starves its own initiations; here the global bucket covers only the one unauthenticated message that creates state and floods a reply, and a per-peer refusal spends no global budget. The msg1 gate runs before any DH. A refused initiation of ours leaves the DM in the outbox.

- **Lost msg3.** A responder attempt that expires while we still hold a session with that peer means the initiator completed on msg2 and its msg3 never arrived: the two sides now hold different sessions. As in bitchat-ios's rollback, the old session stays and we send one msg1 of our own, whose session replaces it only on completion. The attempt waits while the peer is unheard or no link is up.
- **Failed decrypt.** A Noise or Double Ratchet packet that fails to decrypt is discarded and never clears a session (Signal DR section 3.5; bitchat-ios `BLENoisePacketHandler`). A genuine signed packet replayed after it leaves the 1000-entry dedup fails this way, so clearing on failure would let anyone who recorded one evict working keys.
- **No session.** Sealed traffic from an announced peer we hold no session with (their side survived a crash on ours) is answered with a handshake (`recoverSession`). A peer that never announced gets nothing, so forged sender IDs cannot fan out into flooded handshakes.
- **Out of step past `MAX_SKIP`.** More than 1000 lost messages in one ratchet chain leave the pair out of step until a restart or a `LEAVE`. A replay raises the same error, so healing on it would bring back the replay teardown; bitchat-ios makes the same trade.

## Transport Messages

```text
[4-byte BE nonce][ciphertext + 16-byte Poly1305 tag]
```

The nonce is prepended so the receiver can decrypt out of order (bitchat's `useExtractedNonce: true`). The 12-byte AEAD nonce inside is `00 00 00 00 | counter u32 LE | 00 00 00 00`, as in bitchat-ios `NoiseCipherState`.

**Replay window.** 1024 nonces per session; `decrypt()` throws on a replay or anything further back. Bit `o` records nonce `highest - o`, LSB-first (byte `o >> 3`, mask `1 << (o & 7)`). A new highest nonce ages every offset by `shift`, which on this layout is a **left** shift within each byte, carrying from the byte below:

```text
new[i] = (old[i - bs] << bt) | (old[i - bs - 1] >> (8 - bt))   // bs = shift >> 3, bt = shift & 7
```

bitchat-ios and bitchat-android shift right, which forgets recent nonces: after 0 to 100 in order, 93 to 99 decrypt a second time. `NOISE_ENCRYPTED` packets are unsigned and their dedup ID covers a timestamp anyone can restamp, so this window is the only replay guard for session payloads. Do not copy their `markNonceAsSeen`.

## Double Ratchet

Airhop-to-Airhop DMs ride `DR_ENCRYPTED` for per-message forward secrecy; bitchat peers, and any peer that announced no Nostr key (TLV `0x07`), keep plain Noise transport.

- **Seed.** `HKDF(exporterSecret, info "airhop-dr-seed-v1")` from the completed XX session. Never the handshake hash, which is public: every input to it crossed the air. Initiator seeds a sender, responder a receiver.
- **Binding.** A ratchet counts only while the session it was seeded from is the one held (`ratchetFor`).
- **Receive.** The packet is signed and its signature checked before the ratchet is touched, since the 40-byte ratchet header is cleartext. A responder that receives DR traffic before seeding one seeds it then.
- **Receipts** go over the ratchet when `canEncrypt` (a fresh responder has no sending chain until the initiator's first message), otherwise over Noise in bitchat's format.
- **Skipped keys** are capped at `MAX_SKIP` (1000).

## Noise X Sealing

```text
[32 bytes: ephemeral e][48 bytes: enc_s + tag][payload + 16-byte tag]
```

Pattern `-> e, es, s, ss`. The sender's static key travels inside the ciphertext, so the recipient authenticates who sealed it; identify the sender from it, never from the packet header. The prologue is a required argument to `noiseXSeal` and `noiseXOpen`, mixed in before the recipient's key; courier seals use bitchat-ios's two prologues, and an empty one fails silently on bitchat-ios.

## Sessions Are Per Peer

One session per peer ID, whichever radio carries it: BLE, Wi-Fi Aware or LAN. Sessions live in memory only and are re-established after a restart.

## What Not to Do

- Encrypt or decrypt on anything but a session returned by `split()`.
- Read msg2 or msg3 on the pending handshake itself, or accept a session whose static key does not derive to the claimed peer ID.
- Send anything under a new session before msg3, or content before the `0x21` proof.
- Clear or replace a session because a packet failed to decrypt.
- Seed the ratchet from the handshake hash or from static keys.
- Create a separate session per transport, or persist one across restarts.
- Use Noise X for live DMs.
