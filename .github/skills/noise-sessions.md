---
description: >
  Reference for the Noise session lifecycle in Airhop: when to use XX vs X,
  how handshake roles are assigned, the transport message format, and the
  session-per-peer model. Mistakes here produce sessions that appear established
  but silently decrypt to garbage, with no thrown error.
---

# Noise Sessions

Airhop uses two Noise protocol patterns. Both are implemented in `src/core/crypto/`. Wire-compatible with `bitchat/ios/bitchat/Noise/NoiseProtocol.swift`.

## Which Pattern to Use

| Pattern  | Algorithm name                     | Use case                                      |
| -------- | ---------------------------------- | --------------------------------------------- |
| Noise XX | `Noise_XX_25519_ChaChaPoly_SHA256` | Interactive sessions between live peers (DMs) |
| Noise X  | `Noise_X_25519_ChaChaPoly_SHA256`  | One-way sealing for courier envelopes         |

Use **XX** when the peer may be online and can respond. Use **X** only for courier store-and-forward where the recipient is offline. Noise X has no forward secrecy: compromise of the recipient's static key exposes all sealed envelopes.

## Noise XX: Three-Message Handshake

```
msg1: initiator -> responder   -> e            (32 bytes)
msg2: responder -> initiator   <- e, ee, s, es (96 bytes)
msg3: initiator -> responder   -> s, se        (64 bytes)
```

After msg3 both sides call `split()` to derive two independent transport keys.

### Role Assignment

The node that **sends msg1** is the initiator. The node that **receives msg1** is the responder. This is determined by which side opens the connection, not by comparing peer IDs.

If both sides try to initiate simultaneously (race condition), the side that receives a 32-byte msg1 while its own handshake is still in progress drops its own attempt and switches to responder. Bitchat iOS implements this in `NoiseSessionManager.handleIncomingHandshake()`. A 32-byte incoming message when already handshaking resets and starts fresh as responder. That means a forged msg1 under a peer's ID can displace a live attempt, as it can in bitchat-ios; the DM recovers on the next exchange (simulation C13b), and this is accepted rather than guarded.

### Handshake Limits

`src/core/mesh/routing/handshake-rate-limiter.ts`, with bitchat-ios's numbers (`NoiseSecurityConstants`):

- **10 per minute per claimed peer**, for inbound msg1, inbound msg2/msg3, and our own initiations.
- **30 per minute in total, for inbound msg1 only.** bitchat-ios counts every handshake message globally, so a flood of forged msg1 also starves its own initiations. Here the global bucket covers only the one unauthenticated message that creates state and floods a reply. A per-peer refusal spends no global budget.
- The msg1 gate runs before any DH. A refused initiation of ours leaves the DM in the outbox ("handshaking") rather than failing it.
- Pending handshakes expire after 30 s, swept on every insert, so memory stays bounded under a flood.
- msg2 and msg3 are read on a `clone()` of the pending handshake. The pending entry is replaced only by a bound session; a failure keeps it, so one forged or garbled reply cannot end a genuine handshake.

### Session State

A session has three states: `uninitialized`, `handshaking`, `established`. Only call `encrypt` / `decrypt` on an established session.

### Transport Message Format

After the handshake, transport messages use:

```
[4-byte BE nonce][ciphertext + 16-byte Poly1305 tag]
```

The nonce is prepended as a big-endian u32 so the receiver can decrypt out-of-order messages using the replay guard. This matches bitchat's `useExtractedNonce: true` mode.

### Replay Protection

A sliding window of 1024 nonces is maintained per session. Messages with a nonce more than 1024 positions behind the highest seen nonce are rejected. `decrypt()` throws on replay.

Bit `o` of the window records nonce `highest - o`, stored LSB-first: byte `o >> 3`, mask `1 << (o & 7)`. A new highest nonce ages every recorded offset by `shift`, which on this layout is a **left** shift within each byte, carrying from the byte below:

```
new[i] = (old[i - bs] << bt) | (old[i - bs - 1] >> (8 - bt))   // bs = shift >> 3, bt = shift & 7
```

bitchat-ios and bitchat-android shift right, which forgets recent nonces: after nonces 0..100 in order, 93..99 decrypt a second time. `NOISE_ENCRYPTED` packets are unsigned and their dedup ID covers a timestamp anyone can restamp, so this window is the only replay guard for session payloads. Do not copy their `markNonceAsSeen`. Tests pin 0..100 in order, the gaps left by {0,1,2,3,5,9,10}, and jumps of 8, 1023 and 1024.

### Key Assignment After Split

```
initiator sends with k1, receives with k2
responder sends with k2, receives with k1
```

This is handled automatically inside `NoiseHandshake.split()`. Do not swap keys manually.

## Noise X: One-Way Sealing

Wire format:

```
[32 bytes: ephemeral pub key e]
[48 bytes: enc_s + 16-byte tag]
[payload_len + 16 bytes: enc_payload + tag]
```

The sender's static key (`s`) is transmitted inside the ciphertext, so the recipient can authenticate who sealed the envelope. There is no response message.

The prologue is a required argument to `noiseXSeal` and `noiseXOpen`, mixed into the transcript before the recipient's static key. Courier seals use bitchat-ios's two prologues (see `courier-envelopes.md`); an empty one never opened on bitchat-ios, and fails silently.

## Sessions Are Per Peer ID, Not Per Transport

One `NoiseSession` object is shared for a given peer regardless of whether the connection is over BLE or WiFi. Do not create a new session when the transport changes. The session stays valid as long as the peer is reachable.

## ChaCha20-Poly1305 Nonce Layout

The 12-byte AEAD nonce used internally (not the 4-byte transport prefix):

```
bytes [0-3]  = 0x00
bytes [4-7]  = counter as little-endian u32
bytes [8-11] = 0x00
```

This matches the bitchat-ios nonce construction in `NoiseCipherState`.

## What Not to Do

- Do not use `encrypt` / `decrypt` before `isEstablished()` returns true.
- Do not create a separate session per transport (BLE, WiFi) for the same peer.
- Do not use Noise X for live interactive DMs; it has no forward secrecy.
- Do not cache or persist a `NoiseSession` across app restarts; regenerate on reconnect.
