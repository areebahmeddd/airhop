# Future work

Airhop's open security and product work: what each item buys a user, what it would take, and what it costs. Nothing here is built yet. Items are grouped by area and ordered by value within each group.

## How to read this

| Size     | Means                                   |
| -------- | --------------------------------------- |
| S        | Days                                    |
| M        | 1 to 3 weeks                            |
| L        | 1 to 3 months                           |
| XL       | Needs bitchat to move too               |
| External | Money and an outside team, not dev time |

| Breaking     | Means                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None         | No wire change. Nothing anyone else runs is affected                                                                                                            |
| Airhop only  | New behavior between Airhop phones, gated on capability bit 26. bitchat keeps working exactly as it does. No compatibility path is kept for older Airhop builds |
| bitchat-wide | Works only if bitchat changes too. Doing it alone would split the network                                                                                       |

## At a glance

| #   | Item                                    | What it buys                                               | Breaking               | Size           |
| --- | --------------------------------------- | ---------------------------------------------------------- | ---------------------- | -------------- |
| 1   | Independent audits                      | Outside proof the crypto and the mesh are right            | None                   | External       |
| 2   | Reproducible Android builds             | Anyone can check the APK matches the source                | None                   | M              |
| 3   | Forward-secret internet DMs             | A key leaked later no longer opens messages kept on relays | Airhop only            | M              |
| 4   | Deniable private messages               | A DM can't be proven to a third party                      | None, then Airhop only | S, then S to M |
| 5   | Forward secrecy for groups and channels | A leaked room key doesn't open the room's history          | Airhop only            | L              |
| 6   | Post-quantum key agreement              | Recorded traffic stays safe from a future quantum attack   | Airhop only            | M              |
| 7   | High-risk preset                        | Safe settings in one tap for the people who need them      | None                   | S to M         |
| 8   | Passphrase mode for data at rest        | A seized, locked phone gives up nothing                    | None                   | M to L         |
| 9   | Shared disappearing timer               | The other phone's copy expires too                         | Airhop only            | M              |
| 10  | Byte budget for live video reassembly   | A hostile stream can't exhaust a viewer's memory           | None                   | S              |
| 11  | Reed-Solomon vector from bitchat-ios    | Proof that live video repair works across the two apps     | None                   | S              |
| 12  | Relay sign-in (NIP-42)                  | Relays that demand sign-in serve Airhop too                | None                   | S              |
| 13  | Rotating radio IDs                      | No tracking a phone across places by its radio ID          | bitchat-wide           | XL             |
| 14  | Multiple devices per identity           | One identity on a phone and a tablet                       | bitchat-wide           | XL             |

## Assurance

### 1. Independent audits

Cryptographic correctness can't be self-certified, and until someone outside has checked it, Airhop shouldn't be recommended for high-risk use. Every leading messenger has outside review: Signal has formal analyses of its protocol, Threema's Ibex has a published security analysis [1], and Briar, SimpleX and Session have each had paid audits. Airhop has had internal reviews only.

**What it takes.** Two audits, as the roadmap plans: one on the cryptography (Noise XX, the Double Ratchet, courier seals and one-time prekeys, packet signing, the keychain, the panic wipe, device transfer, the wallet), and one on the mesh, the Nostr bridge and Tor. Apply to the OTF Security Lab, which funds audits of internet freedom tools [2], or hire a firm, and publish the reports in full. Land items 3 and 4 first so the audit covers the protocol as it will ship.

**Breaking:** None. **Size:** External.

### 2. Reproducible Android builds

A user who can't rebuild the APK has to trust that it matches the source. Signal for Android and Briar publish builds anyone can reproduce [3]. Airhop's Tor client and pluggable transports are already reproducible and hash-pinned, and the APK has signed provenance, but the APK itself can't be rebuilt byte for byte.

**What it takes.** Pin the whole toolchain in a container, remove timestamps and machine paths from the JS bundle and the native libraries, and check that two clean builds match. Then publish through F-Droid with its reproducibility check [4], which also reaches people who can't use the Play Store. iOS builds can't be reproduced by anyone, so Android is where this matters.

**Breaking:** None. **Size:** M.

## Message security

### 3. Forward-secret internet DMs

Internet DMs are the automatic route to a contact out of radio range, and the internet is on by default. They follow bitchat's NIP-17 gift-wrap format [5], encrypted to long-term keys, and relays keep the ciphertext. A key leaked later, from a seized phone for example, decrypts every internet DM anyone captured. They're unpadded too, so lengths show. Mesh DMs between Airhop phones and courier mail already have forward secrecy, which leaves the internet, the one route where ciphertext is stored, as the weak link. Signal, Threema [1] and SimpleX give every message forward secrecy.

**What it takes.** Between Airhop phones, seal each internet DM to one of the recipient's one-time prekeys, the same ones courier mail uses, pad it to a fixed bucket, and carry it inside the existing gift wrap so relays see nothing new. bitchat keeps getting plain NIP-17. Two decisions first:

- **Running out of prekeys.** Prekeys travel only over the mesh and are never published to Nostr. A contact who stays away long enough exhausts the supply, so decide between falling back to the long-term key (and saying so) or refilling prekeys over an internet DM.
- **Prekeys or a ratchet.** A Double Ratchet carried over Nostr would heal after a compromise, but the ratchet lives in memory and is bound to one Noise session, so it would need persisted state. Prekeys are the smaller step.

**Breaking:** Airhop only. **Size:** M.

### 4. Deniable private messages

Airhop signs every DM packet with the sender's long-term Ed25519 key: plain Noise transport packets and Double Ratchet packets alike. Anyone holding a copy of the packet, plus the message key the recipient can reveal, can prove to a third party who wrote it. bitchat sends Noise transport unsigned, so its DMs are deniable, and so are Signal's and SimpleX's. For someone whose chat partner is compromised or coerced, a signed message is evidence.

**What it takes.** Two steps, in this order. Both are needed: while either signature remains, authorship stays provable.

1. **Stop signing Noise transport packets.** The session's AEAD already authenticates them, bitchat already sends them unsigned, and Airhop already accepts them either way. Confirm no receive or relay path expects the signature from an Airhop sender. Breaking: none. Size: S.
2. **Carry ratchet messages inside the Noise transport,** as an Airhop Noise payload type that replaces the separately signed ratchet packet. The signature exists because the ratchet header travels in the clear: a forged header would cost a Diffie-Hellman and up to 1,000 key derivations before failing. The Noise AEAD rejects a forgery just as cheaply, is deniable, and hides the header from listeners. It has to keep the ratchet bound to its session through a rekey and its grace window. Dropping the ratchet signature without this step would make forgeries cheap to send and expensive to reject. Breaking: Airhop only. Size: S to M.

Ed25519 stays on everything public: announces, room messages, public files, voice and video frames, board posts and identity proofs.

**Breaking:** None, then Airhop only. **Size:** S, then S to M.

### 5. Forward secrecy for groups and private channels

A private group message is sealed under the group's current epoch key. The epoch turns on every roster change, so a removed member can't read what follows, but anyone who later gets hold of an epoch key reads every message recorded under it. A private channel is weaker: its key rides in the invite link and never changes, so anyone who ever held the link reads everything, past and future, and nobody can be removed. Signal uses sender keys with rotation, and SimpleX runs pairwise ratchets in small groups.

**What it takes.**

- **Groups.** When every member runs Airhop, give each member a sender-key chain that ratchets forward per message and restarts with each epoch, delivered inside each member's Noise session as epoch keys are. bitchat-format groups stay as they are.
- **Private channels.** Let the creator rotate the key and hand out a fresh link, so an old link stops reading new messages. Who gets the new link is a product decision, since a channel has no roster.

**Breaking:** Airhop only. **Size:** L.

### 6. Post-quantum key agreement

An adversary recording traffic now could decrypt it once quantum computers break X25519. The real target is ciphertext that sits on relays (internet DMs, courier drops), more than radio traffic nobody stored, so this is worth more once item 3 lands. Signal added PQXDH for the first exchange [6] and SPQR inside the ratchet [7]. SimpleX adds a post-quantum exchange at every ratchet step [8].

**What it takes.** Between Airhop phones, run an ML-KEM-768 exchange [9] inside the Noise session and mix its secret into the ratchet seed. The ratchet is reseeded with every session and every rekey, so the exchange runs once per session: about 2.3 KB, roughly five Bluetooth fragments in total. Two gates first:

- Confirm `@noble/post-quantum` [10] has had an independent audit before depending on it.
- AGENTS.md allows only the three audited `@noble` libraries, so the rule changes with it.

**Breaking:** Airhop only. **Size:** M.

## On the device

### 7. High-risk preset

Airhop's defaults favor reach: the internet is on without Tor, Wi-Fi Aware is on, the app lock is off, and messages are kept until deleted. Someone at a protest, or facing a border search, has to find and set each switch alone. Briar routes everything through Tor by default.

**What it takes.** One switch, offered at onboarding and in Settings: Tor on (or the internet off), Wi-Fi Aware and the local network off, the app lock on with no delay, and disappearing messages at 1 day. Show what it changed, and leave each setting adjustable afterward.

**Breaking:** None. **Size:** S to M.

### 8. Passphrase mode for data at rest

Keys are readable any time after the phone's first unlock since boot [11], which iOS needs to relaunch Airhop for a Bluetooth event while the phone is locked. History relies on the operating system's file encryption with the same availability, so a phone seized while on, even locked, is in its weakest state. A second key in the keychain would add nothing, since it shares that availability. A passphrase isn't on the phone at all. Briar derives its database key from a password, and Threema offers a passphrase lock.

**What it takes.** An optional mode: a key derived from a passphrase with a memory-hard function encrypts history, keychain items are readable only while the phone is unlocked, and nothing relaunches in the background. The cost is real: the mesh stops receiving and relaying while the phone is locked or the passphrase hasn't been entered, and every store opens asynchronously, as the wallet does.

**Breaking:** None. **Size:** M to L.

### 9. Shared disappearing timer

Disappearing messages clear this phone's copy only. The other person's phone keeps theirs for as long as they like. Signal, Threema, SimpleX and Session let a chat agree a timer both phones honor.

**What it takes.** A per-chat timer carried in Airhop DMs, applied by both phones from the same rule and shown in the thread whenever either side changes it. bitchat ignores it, so a chat with a bitchat peer stays local-only and the thread has to say so. It still can't stop a screenshot or a modified client.

**Breaking:** Airhop only. **Size:** M.

## Live and recorded media

### 10. Byte budget for live video reassembly

The live video assembler bounds pending frames by count, not by bytes. A hostile sender, or a few, signing valid streams over Wi-Fi Aware or LAN could make a viewer hold far more memory than a low-end Android phone gives an app, and the OS would kill it. One stream per sender, a per-stream cap and closing a stream that runs over its rate keep this well contained, so it's hardening rather than a hole.

**What it takes.** A per-stream byte budget across pending frames, and expiring a pending frame after about twice the gap wait.

**Breaking:** None. **Size:** S.

### 11. Reed-Solomon vector from bitchat-ios

Live video's erasure code uses bitchat-ios's polynomial and coefficients, but its tests check Airhop only against itself. If the coefficient order differed, streams would play between the two apps until the first lost packet, and then repair would silently fail.

**What it takes.** Take a parity vector with more than one data shard (three data, two parity, for example) from bitchat-ios and pin it in a test.

**Breaking:** None. **Size:** S.

## Internet reach

### 12. Relay sign-in (NIP-42)

Some relays ask a client to sign a challenge before they serve a subscription or take a post. Airhop never signs in, so it treats such a relay as one that refuses. Of the 368 relays in the bundled list that answered a probe on 7 November 2026, 74 sent a challenge and 25 refused a read without one, about 7%. Location channels and DMs use several relays at once, so nothing visibly breaks today; the share is likely to grow as relays fight spam.

**What it takes.** `NostrClient` takes a signer per operation and each service passes its own: a location's key for that location's traffic, the main key for the DM inbox, and a throwaway key for publishing a gift wrap or courier drop, never the main key, which would link the sender. A read meant to stay anonymous passes none. A relay that refuses the proof stays refused, as now.

**Mind the library.** nostr-tools signs in when a call passes `onauth`, but the subscription it reopens after signing in is never added to the list its closer walks, so it outlives the call: a location's feed would keep running after the user leaves the cell. Sign-in on a read therefore belongs in `NostrClient`'s own reopen path, which on a close reason starting `auth-required:` signs in and opens again, where its closer tracks the result. `onauth` on a post is fine. The pool-wide `automaticallyAuth` stays off, since it answers every challenge a relay sends unprompted, which is how an account key ends up proving itself to a location's relays.

**Breaking:** None. **Size:** S.

## Parked until bitchat moves

### 13. Rotating radio IDs

Every packet carries a peer ID derived from the long-term key, so anyone sniffing Bluetooth can follow a phone between places and across days. SimpleX has no user identifiers [12], and Briar talks only to contacts. bitchat's own whitepaper lists this as future work.

**What it takes.** Only together with bitchat. Peer ID derivation is fixed (AGENTS.md), and gossip sync and DM addressing depend on it.

**Breaking:** bitchat-wide. **Size:** XL.

### 14. Multiple devices per identity

Signal, Threema and Session let one identity run on several devices. Airhop's device transfer moves an identity from one phone to another and never copies it.

**What it takes.** Nothing for now. The peer ID is one device's key, and prekeys and sessions are per device, so this needs a new identity model shared with bitchat.

**Breaking:** bitchat-wide. **Size:** XL.

## References

1. Threema, Ibex protocol: <https://threema.com/en/blog/ibex>, cryptography whitepaper: <https://threema.com/assets/documents/threema-cryptography-whitepaper.pdf>
2. OTF Security Lab: <https://www.opentech.fund/labs/security-lab/>
3. Reproducible Builds: <https://reproducible-builds.org/>
4. F-Droid, reproducible builds: <https://f-droid.org/docs/Reproducible_Builds/>
5. NIP-17 private direct messages: <https://github.com/nostr-protocol/nips/blob/master/17.md>, NIP-59 gift wrap: <https://github.com/nostr-protocol/nips/blob/master/59.md>
6. Signal, PQXDH specification: <https://signal.org/docs/specifications/pqxdh/>
7. Signal, post-quantum ratchets (SPQR): <https://signal.org/blog/spqr/>
8. SimpleX, quantum resistance in the double ratchet: <https://simplex.chat/blog/20240314-simplex-chat-v5-6-quantum-resistance-signal-double-ratchet-algorithm.html>
9. NIST FIPS 203, ML-KEM: <https://csrc.nist.gov/pubs/fips/203/final>
10. noble-post-quantum: <https://github.com/paulmillr/noble-post-quantum>
11. Apple, data protection classes: <https://support.apple.com/guide/security/data-protection-classes-secb010e978a/web>
12. SimpleX Chat: <https://github.com/simplex-chat/simplex-chat>
