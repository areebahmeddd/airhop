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
- When the packet is new and `ttl > 1`, a relay is scheduled automatically.

### TTL Handling

TTL is decremented **before** relay. The relayed copy has `packet.ttl - 1`. A packet with `ttl <= 1` is never relayed (only handled locally if new). The maximum is `7`. A broadcast this node authors (channel, group, board, public file, live voice per burst) leaves with a draw from `5..7` (`core/mesh/routing/origin-ttl.ts`), so the maximum alone does not mark the author; announces and directed traffic keep `7`.

Relays decrement TTL but do not re-sign. The original signature remains valid because signing normalizes TTL to `0` (see `bitchat-wire-format` skill).

### Originating Packets

Call `originate(packet)` when this node creates a packet. This records the packet ID in the dedup cache so the node does not relay its own broadcasts when it hears them echoed back.

### Jitter Delay

Relay is not immediate. A random delay of `10-220 ms` is applied before the `send` callback fires. This prevents cascade relay storms when many nodes receive the same packet at the same time. The delay is random, not deterministic.

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

| Parameter                 | Value      |
| ------------------------- | ---------- |
| Frame budget              | 512 bytes  |
| Data per fragment         | 467 bytes  |
| Max concurrent assemblies | 128        |
| Reassembly timeout        | 30 seconds |
| Max reassembled size      | 1 MiB      |

These values match bitchat-ios `BLEFragmentHandler` / `BLEFragmentAssemblyBuffer`. Do not change them without checking the reference implementations.

Partial assemblies are silently dropped after 30 seconds. The sender must retransmit if fragments are lost.

## Gossip Sync

`REQUEST_SYNC` packets (type `0x21`) carry TTL=0 and are never relayed, whatever TTL one arrives with (`relayTtl` returns 0 for the type, as bitchat-ios's `RelayController` does). Gossip reconciliation is a question about the far end of one link, so it stays on that link.

A request is answered only when it is plainly the link peer's own, as bitchat-ios answers (`BLEService.handleRequestSync`): TTL 0, a `senderID` equal to the peer bound to the link it arrived on, and a signature verifying against the key held for that peer. The response budget (8 per 30 s) is then that peer's, and every reply goes back down that link only, at TTL 0 with `IS_RSR` set.

A packet tagged `IS_RSR` is judged on the sync rules alone, fresh or not (bitchat-ios `BLEIngressPacketGuard`): TTL 0, arriving on the link bound to a peer we sent a request to in the last 30 s, and a type sync serves within the age it serves it for, from `isSyncReplyInWindow` in `gossip-sync.ts`. Everything else is held to the ±2 minute ingress window, TTL 0 or not.

| Type                                                 | Served and accepted for                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `ANNOUNCE`                                           | 60 s                                                            |
| `CHANNEL_MSG`, `CHANNEL_MSG_AIRHOP`, `GROUP_MESSAGE` | 6 h                                                             |
| `BOARD_POST`                                         | 7 days                                                          |
| `FRAGMENT` (reply fragments)                         | 7 days; the reassembled packet is held to its own type's window |

The 6 h window is bitchat-ios's `syncPublicMessageMaxAgeSeconds`, which `BLEService` passes over `GossipSyncManager`'s 900 s default. Copy constants from where they are applied, not from a config default: a 15 minute window here refuses backfill bitchat-ios sends.

Gossip uses a Golomb-Coded Set (GCS) filter, not a bloom filter. The false positive rate formula is different. See `src/core/mesh/sync/gossip-sync.ts` and the reference `bitchat/ios/bitchat/Sync/GossipSyncManager.swift`.

## Announce Broadcasts

`ANNOUNCE` packets go out every 4 seconds while a node is alone, then every 15 to 30 seconds (jittered) once it has a peer. Receiving a valid `ANNOUNCE` is how a node learns another peer's `senderID` to `signingPubKey` mapping. This mapping must be verified before relaying any other packet from that sender.

## What Not to Do

- Do not relay a packet before decrementing TTL.
- Do not relay packets originating from this node (use `originate()` to register them).
- Do not change the fragment size, reassembly timeout, or dedup expiry without matching bitchat.
- Do not use a bloom filter; the protocol requires a GCS filter for gossip.
