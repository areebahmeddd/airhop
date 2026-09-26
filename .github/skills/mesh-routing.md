---
description: >
  Reference for the mesh flood routing, deduplication, and fragment reassembly
  rules. Read this before modifying src/core/mesh/routing/flood-router.ts,
  deduplicator.ts, or fragment-manager.ts. Subtle mistakes here cause routing
  loops, dropped messages, or broken interoperability with bitchat nodes.
---

# Mesh Routing and Deduplication

Implementation: `src/core/mesh/routing/flood-router.ts`, `deduplicator.ts`, `fragment-manager.ts`. Reference: `bitchat/ios/bitchat/Services/BLE/BLEService.swift` and bitchat-android.

## Flood Routing Rules

```
receive(packet, send) -> boolean
```

- Returns `true` if the packet is new; the caller should handle it locally.
- Returns `false` if the packet is a duplicate; the caller drops it silently.
- When the packet is new and `relayDecision` allows, a relay is scheduled automatically.

### Before the Router

`LEAVE`, `FILE_TRANSFER`, `VOICE_FRAME` and `BOARD_POST` are checked before `receive` sees them (`mayRelay` in `mesh-service.ts`), as bitchat-ios handles them before it schedules a relay: a LEAVE or file must verify against the key held for its sender, a voice frame must also be a broadcast, not our own and within 30 s, and a board payload must decode, verify its author signature and, as a post, still be live. A failure is dropped before dedup, so a forged copy cannot take the genuine packet's ID. A reassembled packet meets the same gate. Every other type reaches the router unchecked, since a relay carries traffic for peers whose keys it has never seen.

### TTL Handling

TTL is decremented **before** relay. The maximum is `7`. The relay decision is `relayDecision` in `flood-router.ts`, a transcription of bitchat-ios `RelayController.decide`:

- No relay for `REQUEST_SYNC`, for `ttl <= 1`, or for a packet whose sender or recipient is this node. The caller still handles it, which is how an announce under our own ID reveals the identity running elsewhere.
- Handshakes, and `NOISE_ENCRYPTED`, `DR_ENCRYPTED`, `COURIER_ENV`, `PING`, `PONG`, `NOSTR_CARRIER` and fragments with a recipient, go at full depth (`ttl - 1`).
- Broadcast fragments and live voice are capped at `7`, or `5` at degree 6 and up.
- Other broadcasts are capped by `relayLimit`: `7` at degree 2 or less, `6` at 3 to 5 (`7` for announces and urgent board posts), `5` at 6 and up. The relayed copy carries one less than the cap or its own TTL, whichever is lower.

An all-0xFF recipient (bitchat-android's broadcasts) counts as a broadcast, so such a fragment is clamped rather than relayed at full depth. A broadcast this node authors (channel, group, board, public file, live voice per burst) draws its TTL from `[ceiling - 2, ceiling]` of the same `relayLimit` at this node's degree (`origin-ttl.ts`; a public file uses the fragment ceiling), so the maximum alone does not mark the author; announces and directed traffic keep `7`.

Relays decrement TTL but do not re-sign. The original signature remains valid because signing normalizes TTL to `0` (see `bitchat-wire-format` skill).

### Originating Packets

Call `originate(packet)` when this node creates a packet. This records the packet ID in the dedup cache so the node does not relay its own broadcasts when it hears them echoed back.

### Jitter Delay

Relay is not immediate. A random delay is applied before the `send` callback fires, by class: `10-35 ms` for handshakes, `20-60 ms` for other directed traffic, `8-25 ms` for fragments and live voice, and for other broadcasts by degree, `10-40`, `60-150`, `80-180` or `100-220 ms` (degree 2 or less, 3 to 5, 6 to 9, 10 and up). This prevents cascade relay storms when many nodes receive the same packet at the same time. The delay is random, not deterministic.

A relay goes to every link but the one the packet arrived on. bitchat-ios's fanout subset is not implemented.

## Deduplication

The `Deduplicator` is a time-bounded LRU cache of packet IDs.

### Packet ID Formula

```
PacketID = SHA-256(type[1] | senderID[8] | timestamp_u64_BE[8] | payload)[0:16]
```

16 bytes (32 hex chars). Matches `PacketIdUtil.swift` / `PacketIdUtil.kt`. The same formula is used in `computePacketId` in `packet-codec.ts`.

### Cache Parameters

| Parameter     | Value     |
| ------------- | --------- |
| Max entries   | 1000      |
| Expiry window | 5 minutes |

Oldest entry is evicted when the cache is full. A packet seen again within the expiry window is a duplicate regardless of its content.

## Fragment Reassembly

Large packets are split into fragments. The fragment manager reassembles them
transparently.

**The budget is the whole encoded frame, not the payload.** 512 bytes is the
Bluetooth ATT ceiling for one attribute write: past it Android truncates and iOS
refuses, and a truncated frame fails to decode with nothing reported at either
end. Size the frame, then spend what is left on data.

### Fragment Payload Layout

```
[8 bytes: stream ID (u64 BE, random per original packet)]
[2 bytes: fragment index (u16 BE, 0-based)]
[2 bytes: total fragment count (u16 BE)]
[1 byte:  original packet type]
[up to 467 bytes: fragment data]
```

The 512-byte frame decomposes as: 16 v2 header + 8 senderID + 8 recipientID +
13 fragment header + 467 data. Fragments are unsigned, so no signature is
included; authenticity belongs to the inner packet, which is verified after
reassembly.

### Assembly Parameters

| Parameter                 | Value           |
| ------------------------- | --------------- |
| Frame budget              | 512 bytes       |
| Data per fragment         | 467 bytes       |
| Max concurrent assemblies | 128             |
| Reassembly timeout        | 30 seconds idle |
| Min non-final fragment    | 64 bytes        |
| Max reassembled size      | 1 MiB           |

These values match bitchat-ios `BLEFragmentHandler` / `BLEFragmentAssemblyBuffer` and `BLEOutboundFragmentPlanner.minimumChunkSize`, with one deliberate difference: the reassembly timeout is 30 s of silence since the last fragment, not since the first. bitchat-ios times out 30 s from the start, which cannot complete a 1 MiB file at its own pacing. Do not change them without checking the reference implementations.

Partial assemblies are silently dropped after 30 seconds with no fragment. The sender must retransmit if fragments are lost. An empty fragment, and a non-final one under 64 bytes, is refused: no sender cuts one that small.

## Gossip Sync

`REQUEST_SYNC` packets (type `0x21`) carry TTL=0 and are never relayed, whatever TTL one arrives with (`relayDecision` returns null for the type, as bitchat-ios's `RelayController` does). Gossip reconciliation is a question about the far end of one link, so it stays on that link.

A request is answered only when it is plainly the link peer's own, as bitchat-ios answers (`BLEService.handleRequestSync`): TTL 0, a `senderID` equal to the peer bound to the link it arrived on, and a signature verifying against the key held for that peer. The response budget (8 per 30 s) is then that peer's, and every reply goes back down that link only, at TTL 0 with `IS_RSR` set.

A packet tagged `IS_RSR` is judged on the sync rules alone, fresh or not (bitchat-ios `BLEIngressPacketGuard`): TTL 0, arriving on the link bound to a peer we sent a request to in the last 30 s, and a type sync serves within the age it serves it for, from `isSyncReplyInWindow` in `gossip-sync.ts`. Everything else is held to the ±2 minute ingress window, TTL 0 or not.

| Type                                                 | Served and accepted for                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `ANNOUNCE`                                           | 60 s                                                            |
| `CHANNEL_MSG`, `CHANNEL_MSG_AIRHOP`, `GROUP_MESSAGE` | 6 h                                                             |
| `BOARD_POST`                                         | 7 days                                                          |
| `FRAGMENT` (reply fragments)                         | 7 days; the reassembled packet is held to its own type's window |

The 6 h window is bitchat-ios's `syncPublicMessageMaxAgeSeconds`, which `BLEService` passes over `GossipSyncManager`'s 900 s default. Copy constants from where they are applied, not from a config default: a 15 minute window here refuses backfill bitchat-ios sends.

Airhop sends one request per round, as bitchat-ios does: announces, public and group messages every 15 s, board posts alone every 60 s, each with its own filter and since-cursor.

Only accepted packets are stored for sync, one store per kind (public messages 1000 and 8 MiB, group messages 200 and 4 MiB, board posts 200, the latest announce per peer), so a flood of one kind cannot evict another's history and a forgery is never served. A sync reply this node refused is advertised in its filters, so peers stop offering it, but never served. See PROTOCOLS.md section 5.

Gossip uses a Golomb-Coded Set (GCS) filter, not a bloom filter. The false positive rate formula is different. See `src/core/mesh/sync/gossip-sync.ts` and the reference `bitchat/ios/bitchat/Sync/GossipSyncManager.swift`.

## Announce Broadcasts

`ANNOUNCE` packets go out every 4 seconds while a node is alone, then every 15 to 30 seconds (jittered) once it has a peer. Receiving a valid `ANNOUNCE` is how a node learns another peer's `senderID` to `signingPubKey` mapping. It is checked before relaying `LEAVE`, `FILE_TRANSFER` and `VOICE_FRAME` from that sender (`BOARD_POST` carries its own author key); every other type is relayed unchecked.

## What Not to Do

- Do not relay a packet before decrementing TTL.
- Do not relay packets originating from this node (use `originate()` to register them).
- Do not change the fragment size, reassembly timeout, or dedup expiry without matching bitchat (the idle timeout above is the one stated difference).
- Do not track a packet for gossip before it is accepted.
- Do not use a bloom filter; the protocol requires a GCS filter for gossip.
