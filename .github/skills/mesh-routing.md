---
description: >
  Reference for mesh flood routing, deduplication, fragment reassembly and
  gossip sync. Read this before modifying src/core/mesh/routing/ or
  src/core/mesh/sync/. Subtle mistakes here cause routing loops, dropped
  messages, or broken interoperability with bitchat nodes.
---

# Mesh Routing and Deduplication

Which packets a node passes on, how far and how soon, how large packets are cut and rebuilt, and how peers backfill what they missed. The constants are in [PROTOCOLS.md](../../docs/spec/PROTOCOLS.md) sections 3.4, 4 and 5; this card is the working summary.

## Key Files

| Path                                                                              | Holds                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/core/mesh/routing/flood-router.ts`                                           | `relayDecision`, `relayLimit`, `FloodRouter` (`receive`, `admit`, `originate`) |
| `src/core/mesh/routing/deduplicator.ts`                                           | The packet-ID seen set                                                         |
| `src/core/mesh/routing/fragment-manager.ts`                                       | Fragmentation and reassembly                                                   |
| `src/core/mesh/routing/origin-ttl.ts`                                             | The TTL a broadcast this node authors leaves with                              |
| `src/core/mesh/routing/source-route.ts`                                           | `nextHopFor`: following another node's source route                            |
| `src/core/mesh/sync/gossip-sync.ts`, `request-sync-manager.ts`, `packet-store.ts` | GCS gossip sync                                                                |
| `src/services/mesh-service.ts`                                                    | Ingress gates (`isFreshOrSolicited`, `mayRelay`), dispatch                     |
| `bitchat/ios/bitchat/Services/RelayController.swift`                              | Reference: the relay decision                                                  |
| `bitchat/ios/bitchat/Services/BLE/`                                               | Reference: `BLEService`, `BLEFragmentHandler`, `BLEIngressPacketGuard`         |
| `bitchat/ios/bitchat/Sync/GossipSyncManager.swift`                                | Reference: gossip sync                                                         |

## Ingress, in Order

1. **Freshness.** A packet more than 2 minutes from our clock (`PACKET_MAX_SKEW_MS`) is dropped before relay or handling. A packet tagged `IS_RSR` is judged on the sync rules instead (below). A late fragment of a stream already under way passes, so a slow transfer is not cut off.
2. **Pre-relay checks** (`mayRelay`), as bitchat-ios checks the same four before scheduling a relay: a `LEAVE` or `FILE_TRANSFER` must verify against the key held for its sender; a `VOICE_FRAME` must verify, be a broadcast, not be ours and be under 30 s old; a `BOARD_POST` must decode, carry a valid author signature and, as a post, still be live. A failure is dropped **before dedup**, so a forged copy cannot take the genuine packet's ID. Every other type is relayed unchecked, since a relay carries traffic for peers whose keys it has never seen.
3. **Dedup and relay** (`FloodRouter.receive`): a seen ID returns `false` and is dropped silently; a new one returns `true` for the caller to handle, and a relay is scheduled when `relayDecision` allows.

A packet rebuilt from fragments goes through `admit`, not `receive`: it is deduplicated and held to the same checks, but not relayed again, since its fragments already were.

## Relay Decision

`relayDecision` in `flood-router.ts` transcribes bitchat-ios `RelayController.decide`. TTL is capped at 7 and decremented **before** the relay.

- **Never relayed:** `REQUEST_SYNC`, anything with `ttl <= 1`, and a packet whose sender or recipient is this node. The caller still handles it, which is how an announce under our own ID reveals the identity running elsewhere.
- **Full depth** (`ttl - 1`): handshakes, and with a recipient `NOISE_ENCRYPTED`, `DR_ENCRYPTED`, `COURIER_ENV`, `PING`, `PONG`, `NOSTR_CARRIER` and fragments.
- **Clamped by degree** (`relayLimit`), the relayed copy carrying one less than the cap or its own TTL, whichever is lower:

| Class                           | Degree ≤ 2 | 3 to 5 | ≥ 6 |
| ------------------------------- | ---------- | ------ | --- |
| Broadcast fragments, live voice | 7          | 7      | 5   |
| Announces, urgent board posts   | 7          | 7      | 5   |
| Other broadcasts                | 7          | 6      | 5   |

An all-`0xFF` recipient (bitchat-android's broadcast) counts as a broadcast, so such a fragment is clamped rather than relayed at full depth.

**Origin TTL.** A broadcast this node authors (channel, group, board, public file, live voice per burst) draws its TTL from `[ceiling - 2, ceiling]` of `relayLimit` at this node's degree, so the maximum alone does not mark the author. Announces keep `7`, because a directly heard announce is recognised by `ttl === ANNOUNCE_TTL`; directed traffic, prekey bundles and gateway carriers keep `7` too.

**Jitter.** Every relay waits a random delay so a room's relays do not collide and dedup has time to work: 10 to 35 ms for handshakes, 20 to 60 ms for other directed traffic, 8 to 25 ms for fragments and live voice, and for other broadcasts 10 to 40, 60 to 150, 80 to 180 or 100 to 220 ms at degree ≤ 2, 3 to 5, 6 to 9 and 10 up.

**Fanout.** A relay goes to every link but the one it arrived on. bitchat-ios's fanout subset is not implemented. A source-routed packet naming this node goes to the next named hop instead, falling back to the flood when anything about the route is unclear. Airhop follows routes and never originates them.

Relays decrement TTL but never re-sign: the signature covers the packet with TTL zeroed (see [`bitchat-wire-format.md`](bitchat-wire-format.md)).

## Deduplication

```text
PacketID = SHA-256(type[1] | senderID[8] | timestamp_u64_BE[8] | payload)[0:16]
```

| Parameter     | Value     |
| ------------- | --------- |
| Max entries   | 1000      |
| Expiry window | 5 minutes |

Oldest evicted on overflow. Call `originate(packet)` for everything this node sends, so its own broadcasts echoing back are not relayed.

## Fragmentation

**The budget is the whole encoded frame, not the payload.** 512 bytes is the Bluetooth ATT ceiling for one attribute write, and a frame past it fails to decode at the far end with nothing reported on either side.

```text
[8 bytes: stream ID, u64 BE, random per original packet]
[2 bytes: index, u16 BE, 0-based]
[2 bytes: total, u16 BE]
[1 byte:  original packet type]
[up to 467 bytes: data]
```

512 = 16 v2 header + 8 senderID + 8 recipientID + 13 fragment header + 467 data. Fragments are unsigned; authenticity belongs to the inner packet, verified after reassembly. A fragment copies only `ttl` and `recipientID` from the packet it carries.

| Parameter                 | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| Frame budget              | 512 bytes                                                            |
| Data per fragment         | 467 bytes                                                            |
| Max concurrent assemblies | 128                                                                  |
| Reassembly timeout        | 30 s since the **last** fragment                                     |
| Min non-final fragment    | 64 bytes; empty ones refused                                         |
| Max fragments per stream  | 10,000                                                               |
| Max reassembled size      | The inner type's ceiling in `payload-limits.ts`, plus frame overhead |

Two deliberate differences from bitchat-ios: its chunk is 469 bytes from a smaller header count (a sender-side choice the receiver never has to agree with), and its 30 s timeout runs from the first fragment, which cannot complete a 1 MiB file at its own pacing.

## Gossip Sync

`REQUEST_SYNC` is link-local: sent at TTL 0 to one link peer, never relayed whatever TTL it arrives with.

- **Answering.** Only a request that is plainly the link peer's own, as bitchat-ios answers (`BLEService.handleRequestSync`): TTL 0, `senderID` equal to the peer bound to the link it arrived on, and a signature verifying against the key held for that peer. The budget is 8 responses per 30 s per peer, and replies go back down that link only, at TTL 0 with `IS_RSR` set.
- **Accepting a reply.** An `IS_RSR` packet is judged on the sync rules alone, fresh or not (bitchat-ios `BLEIngressPacketGuard`): TTL 0, arriving on the link bound to a peer we asked in the last 30 s, never dated past the 2 minute skew, and a type we sync within the age we serve it for (`isSyncReplyInWindow`).

| Type                                                 | Served and accepted for                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `ANNOUNCE`                                           | 60 s                                                       |
| `CHANNEL_MSG`, `CHANNEL_MSG_AIRHOP`, `GROUP_MESSAGE` | 6 h                                                        |
| `BOARD_POST`                                         | 7 days                                                     |
| `FRAGMENT` (reply fragments)                         | 7 days; the reassembled packet meets its own type's window |

The 6 h window is bitchat-ios's `syncPublicMessageMaxAgeSeconds`, which `BLEService` passes over `GossipSyncManager`'s 900 s default. Copy constants from where they are applied, not from a config default.

- **Rounds** (`SYNC_ROUNDS`), as bitchat-ios: announces, public, named-channel and group messages every 15 s; board posts alone every 60 s. Each round has its own 400-byte filter and since-cursor.
- **Stores.** Only accepted packets are stored, one store per kind (public messages 1000 and 8 MiB, group messages 200 and 4 MiB, board posts 200, the latest announce per peer), so one kind cannot evict another and a forgery is never served. A sync reply this node refused is advertised in its filters, so peers stop offering it, but never served.
- **Never synced:** prekey bundles, DMs, voice, files.
- **Filter.** A Golomb-Coded Set, not a bloom filter; the false-positive formula differs.

## Announce Cadence

Every 4 s while the node hears nobody, then every 15 to 30 s (jittered) once it has a peer. A new link gets our announce immediately, with re-origination throttled so a room meeting at once does not flood fresh packets. A valid announce is how a node learns a peer's `senderID` to signing-key mapping.

## What Not to Do

- Relay before decrementing TTL, or relay a packet this node originated (register it with `originate()`).
- Dedup before the pre-relay checks, or add a signature check for types outside `mayRelay`.
- Relay `REQUEST_SYNC`, or answer one that did not come from the link's bound peer.
- Size a fragment by payload rather than by the encoded frame.
- Change the fragment budget, reassembly timeout or dedup expiry without matching bitchat.
- Track a packet for gossip before it is accepted.
- Use a bloom filter for gossip.
