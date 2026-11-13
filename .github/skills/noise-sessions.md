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

| Path                                                                                                         | Holds                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/core/crypto/noise-xx.ts`                                                                                | `NoiseHandshake` (create, write/read msg1 to msg3, `clone`, `split`) and `NoiseSession`      |
| `src/core/crypto/noise-x.ts`                                                                                 | `noiseXSeal` / `noiseXOpen`, one-way sealing for courier mail                                |
| `src/core/crypto/double-ratchet.ts`                                                                          | Signal Double Ratchet for Airhop-to-Airhop DMs                                               |
| `src/core/crypto/session-rekey.ts`                                                                           | When a session is renewed, and how long a replaced one keeps decrypting                      |
| `src/core/mesh/wire/nostr-key-payload.ts`                                                                    | `0x54`, the Nostr key handed over inside a session                                           |
| `src/core/mesh/routing/handshake-rate-limiter.ts`                                                            | Handshake budgets                                                                            |
| `src/core/mesh/wire/peer-state-packet.ts`                                                                    | The `0x21` identity proof sent inside a new session                                          |
| `src/services/mesh-service.ts`                                                                               | `onNoiseHandshake`, `adoptSession`, `stageSwitch`, `rekeyAgedSessions`, `seedRatchetOnProof` |
| `bitchat/ios/bitchat/Noise/NoiseProtocol.swift`, `NoiseSessionManager.swift`, `NoiseSecurityConstants.swift` | Reference                                                                                    |
| `bitchat/ios/bitchat/Noise/SecureNoiseSession.swift` (`needsRenegotiation`), `NoiseEncryptionService.swift`  | Reference: when bitchat-ios rekeys                                                           |
| `bitchat/ios/bitchat/Services/BLE/BLENoisePacketHandler.swift`                                               | Reference: what a failed decrypt does                                                        |

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

**Completing.** msg2 and msg3 are read on a `clone()` of the pending handshake, which is replaced only by a bound session, so one forged or garbled reply cannot end a genuine handshake. After `split()` the session's remote static key must hash to the claimed peer ID (`sessionBindsTo`), or it is discarded. The initiator completes on msg2, one message before the responder, so it sends msg3 **first**, then its `0x21` identity proof, then releases queued DMs and group invites over plain Noise. The responder, completing on msg3, sends its proof first too. Neither seeds the ratchet yet (see Double Ratchet).

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

## Rekey

A session is renewed by a fresh XX handshake at 21.6 h of age (90% of 24 h), checked every 60 s (`rekeyAgedSessions`). A leaked transport key then reads at most a day of traffic.

| Rule                  | Value                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who starts it         | The lower peer ID at 21.6 h; the higher only at 24 h. A bitchat peer starts its own at 21.6 h                                                                                                           |
| Switching (initiator) | Toward a peer that proved bit 26: keeps sending under the old session until anything decrypts under the new one; after 5 s it resends msg3 and its `0x21`, then switches. Toward bitchat: at once       |
| Switching (responder) | On msg3, at once: msg3 proves the initiator holds the new session                                                                                                                                       |
| Replaced session      | Held receive-only for 60 s with the ratchet bound to it, and past that while a fragmented packet from the peer is still assembling, let go only on the minute tick; decrypt tries current, staged, held |
| Ratchet               | Reseeded on the new session, never carried over                                                                                                                                                         |

- **Why the lower ID only.** Two Airhop phones cross 90% within milliseconds; both initiating every day would spend a tiebreak and a round trip. The higher side's 24 h deadline only fires if the lower side's attempt never landed.
- **Why wait for the answer.** The initiator completes on msg2; anything it seals under the new session before msg3 lands is lost if msg3 is. The responder's `0x21`, sent only after reading msg3, is the answer it waits for. A timeout usually means msg3 and the proof were lost together, so both go once more before the switch; the msg3 resend is built afresh, since relays drop an identical copy as a duplicate, and a peer that already completed ignores it.
- **Why not toward bitchat.** bitchat-ios resets the old session the moment msg3 completes the new one, and bitchat-android destroys it on msg1, so a staged switch would keep sealing under a session the peer no longer holds. Staging needs the proven bit 26.
- **Why reseed.** The ratchet lives in memory only, so a rekey and a peer that restarted look identical on the wire. A ratchet carried over to a peer that seeded afresh fails every message with no error.
- **Why hold the old one.** A message sealed just before the switch, or bitchat-ios rekeying toward us mid-conversation, still arrives under the old keys. A 1 MiB file sealed just before a rekey takes about a minute on Bluetooth and opens only once its last fragment lands, hence the extension while one is assembling. A failed decrypt leaves state untouched, so trying each held session in turn costs only the attempt.
- **Teardown.** A verified `LEAVE`, a block (`forgetPeer`) and stopping the mesh drop the current, staged and held sessions and every bound ratchet, so a panic wipe mid-rekey leaves nothing behind.

## Transport Messages

```text
[4-byte BE nonce][ciphertext + 16-byte Poly1305 tag]
```

The nonce is prepended so the receiver can decrypt out of order (bitchat's `useExtractedNonce: true`). The 12-byte AEAD nonce inside is `00 00 00 00 | counter u32 LE | 00 00 00 00`, as in bitchat-ios `NoiseCipherState`.

**Replay window.** 1024 nonces per session; `decrypt()` throws on a replay or anything further back. Bit `o` records nonce `highest - o`, LSB-first (byte `o >> 3`, mask `1 << (o & 7)`). A new highest nonce ages every offset by `shift`, which on this layout is a **left** shift within each byte, carrying from the byte below:

```text
new[i] = (old[i - bs] << bt) | (old[i - bs - 1] >> (8 - bt))   // bs = shift >> 3, bt = shift & 7
```

bitchat-ios and bitchat-android shift right, which forgets recent nonces: after 0 to 100 in order, 93 to 99 decrypt a second time. `NOISE_ENCRYPTED` signatures are not checked on receive, and their dedup ID covers a timestamp anyone can restamp, so this window is the only replay guard for session payloads. Do not copy their `markNonceAsSeen`.

## Double Ratchet

Airhop-to-Airhop DMs ride `DR_ENCRYPTED` for per-message forward secrecy; bitchat peers, and any peer whose `0x21` does not prove capability bit 26 (`doubleRatchet`), keep plain Noise transport. Nothing public says a peer is Airhop: the bit travels in `0x21` only, never in an announce.

- **Seed.** `HKDF(exporterSecret, info "airhop-dr-seed-v1")` from the completed XX session. Never the handshake hash, which is public: every input to it crossed the air. Initiator seeds a sender, responder a receiver.
- **When.** On the peer's `0x21` carrying bit 26, under the session sent under (`seedRatchetOnProof`), once per session: the proof is sent again (the echo, a re-proven ring grant) and reseeding a live ratchet desyncs it. The initiator seeds on the responder's proof, which follows msg3, so its first ratchet message cannot fall into the msg2 window. Until both proofs cross, DMs ride plain Noise; the initiator holds its queue up to 5 s for the responder's proof, so a long DM goes on the ratchet rather than to the relays.
- **Binding.** A ratchet counts only while the session it was seeded from is the one held (`ratchetFor`), apart from the grace a replaced one is held for decrypting.
- **Receive.** The packet is signed and its signature checked before the ratchet is touched, since the 40-byte ratchet header is cleartext. A responder that receives DR traffic before the initiator's proof seeds then; it never sends DR first.
- **Nostr key.** Each side sends `0x54` to a peer that proved bit 26 and is a saved contact or someone a DM has passed with: after each such proof, so a lost one is made good, and once when the first DM passes in a proven session. A stranger who only completes a handshake never gets it. A receiver applies it only after the same session's `0x21` is accepted, which may drop a Nostr key planted on the contact.
- **First message.** A responder has no sending chain until it hears the initiator's first ratchet message, so the initiator sends one on seeding: an empty `DELIVERED` receipt under a random message ID, filed nowhere. When the chain appears the responder flushes what waited for it, and `waitForDmProof` (a payment, a video's budget) resolves only once this side can seal.
- **Receipts** go over the ratchet when `canEncrypt` (a fresh responder has no sending chain until the initiator's first message), otherwise over Noise in bitchat's format.
- **Skipped keys** are capped at `MAX_SKIP` (1000).

## Noise X Sealing

```text
[32 bytes: ephemeral e][48 bytes: enc_s + tag][payload + 16-byte tag]
```

Pattern `-> e, es, s, ss`. The sender's static key travels inside the ciphertext, so the recipient authenticates who sealed it; identify the sender from it, never from the packet header. The prologue is a required argument to `noiseXSeal` and `noiseXOpen`, mixed in before the recipient's key; courier seals use bitchat-ios's two prologues, and an empty one fails silently on bitchat-ios.

## Sessions Are Per Peer

One session per peer ID, whichever radio carries it: BLE, Wi-Fi Aware or LAN, plus at most a staged rekey and the replaced sessions still held for stragglers. Sessions live in memory only and are re-established after a restart.

## What Not to Do

- Encrypt or decrypt on anything but a session returned by `split()`.
- Read msg2 or msg3 on the pending handshake itself, or accept a session whose static key does not derive to the claimed peer ID.
- Send anything under a new session before msg3, or content before the `0x21` proof.
- Clear or replace a session because a packet failed to decrypt.
- Seed the ratchet from the handshake hash or from static keys, at handshake completion, or a second time in one session.
- Carry a ratchet over a rekey, or send under a rekey's session before the peer has answered under it.
- Set bit 26 anywhere but a `0x21`, or send `0x54` to a peer that has not proved the bit.
- Create a separate session per transport, or persist one across restarts.
- Use Noise X for live DMs.
