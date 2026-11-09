// TTL flood router: which packets this node passes on, how far and how soon,
// with deduplication.
//
// Rules per PROTOCOLS.md section 4:
//   - Every packet whose ID has not been seen is handed to the caller, relayed
//     or not. relayDecision says whether it goes further, at what TTL.
//   - Relay is delayed by a random jitter so the room's relays do not collide.
//   - Duplicate packets (same ID within 5 min) are dropped silently. Unlike
//     bitchat-ios, which cancels its pending relay on a duplicate once it has
//     more than two neighbors, a duplicate never cancels this node's: Bluetooth
//     links are point to point, so a neighbor's copy reaching us says nothing
//     about whether our other neighbors have it.
//
// The router verifies no signature. The few types that must be checked before
// they are relayed are checked by the caller first (mesh-service mayRelay),
// between a `seen` peek and the `receive` that records the ID.
import { equalBytes } from "@noble/curves/utils.js";
import { isLiveMedia } from "../links/write-deadline";
import { boardUrgentFlag } from "../wire/board-packet";
import {
  computePacketId,
  isBroadcast,
  PacketType,
  type Packet,
  type SendFn,
} from "../wire/packet-codec";
import { isRelayFirmwareType } from "../wire/packet-type";
import { Deduplicator } from "./deduplicator";

// bitchat-ios TransportConfig.messageTTLDefault. Anything higher is clamped.
const DEFAULT_TTL = 7;

// Neighbor count at which the mesh counts as dense, bitchat-ios
// TransportConfig.bleHighDegreeThreshold.
const HIGH_DEGREE_THRESHOLD = 6;

// Media fragments and live voice and video: bleFragmentRelayTtlCap and
// bleFragmentRelayTtlCapDense, then bleFragmentRelayMinDelayMs and MaxDelayMs.
// A stream emits 15 to 24 packets a second into a 350 ms jitter buffer, so the
// ordinary window (up to 220 ms a hop) would spend the buffer in three hops.
const STREAM_TTL_CAP = 7;
const STREAM_TTL_CAP_DENSE = 5;
const STREAM_MIN_DELAY_MS = 8;
const STREAM_MAX_DELAY_MS = 25;

// Other broadcasts, by degree (RelayController's clamp).
const BROADCAST_TTL_CAP_DENSE = 5;
const BROADCAST_TTL_CAP_MID = 6;
const BROADCAST_TTL_CAP_MID_PRIORITY = 7;

// Live voice and video IDs, in a set of their own so a room stream cannot
// push chat out of the 5 minute window (a DM stream is `NOISE_ENCRYPTED`, its
// type unknown until decrypted, and shares the message set). Held for 150 s: the 30 s past which
// mayRelay refuses a live frame (PTT_FRAME_MAX_AGE_MS) plus the 2 minutes a
// sender's clock may run ahead (PACKET_MAX_SKEW_MS), since only the past is
// bounded and a frame dated ahead stays fresh that much longer. A copy
// replayed after the ID left would otherwise be handled and relayed again.
// 10,000 holds that window at Bluetooth rates (about 35 IDs a second for a
// stream plus a push-to-talk burst); a Wi-Fi-rate stream evicts sooner, and
// the voice player's and receiver's own memories of finished bursts and
// streams stop a replay from playing.
const LIVE_DEDUP_MAX = 10_000;
const LIVE_DEDUP_EXPIRY_MS = 150_000;

function isStream(type: PacketType): boolean {
  return (
    type === PacketType.FRAGMENT ||
    type === PacketType.VOICE_FRAME ||
    type === PacketType.VIDEO_FRAME
  );
}

export interface RelayDecision {
  ttl: number; // the TTL the relayed copy carries
  delayMs: number;
}

// The highest TTL a relay at this degree lets a broadcast of this class leave
// with, before its own hop is taken off. Shared with originTtl, so what this
// node authors starts inside the range its neighbors' relays produce.
//
// Live media floods like a fragment, a stream that a dense graph must
// contain; announces and urgent board posts get a hop more than other traffic
// at mid degree; a thin chain (degree 2 or less) relays at full depth, since
// every hop counts there and flooding costs little.
export function relayLimit(
  type: PacketType,
  isUrgentBoard: boolean,
  degree: number,
): number {
  const dense = degree >= HIGH_DEGREE_THRESHOLD;
  if (isStream(type)) {
    return dense ? STREAM_TTL_CAP_DENSE : STREAM_TTL_CAP;
  }
  if (dense) return BROADCAST_TTL_CAP_DENSE;
  if (degree <= 2) return DEFAULT_TTL;
  return type === PacketType.ANNOUNCE || isUrgentBoard
    ? BROADCAST_TTL_CAP_MID_PRIORITY
    : BROADCAST_TTL_CAP_MID;
}

// Types that travel to one peer, given a recipient: bitchat-ios
// BLEReceivePipeline's isDirectedEncrypted set, plus Airhop's DR_ENCRYPTED.
// A directed packet is relayed at full depth with no clamp, since fewer hops
// means fewer deliveries.
function isDirectedType(type: PacketType): boolean {
  switch (type) {
    case PacketType.NOISE_ENCRYPTED:
    case PacketType.DR_ENCRYPTED:
    case PacketType.COURIER_ENV:
    case PacketType.PING:
    case PacketType.PONG:
    case PacketType.NOSTR_CARRIER:
      return true;
    default:
      return false;
  }
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Ordinary broadcast jitter, by degree (RelayController's windows). Sparse
// relays go almost at once; the denser the room, the wider its relays spread
// so they do not collide on the air.
function broadcastDelayMs(degree: number): number {
  if (degree <= 2) return randomInt(10, 40);
  if (degree <= 5) return randomInt(60, 150);
  if (degree <= 9) return randomInt(80, 180);
  return randomInt(100, 220);
}

// Whether to relay `packet`, and how, or null for no relay. Mirrors bitchat-ios
// RelayController.decide over the inputs BLEReceivePipeline.relayDecision
// derives from the packet.
//
// A recipient means the packet is not a broadcast. An all-0xFF recipient,
// which bitchat-android writes on its broadcasts, counts as none here, so
// such a fragment is clamped like any broadcast rather than relayed at full
// depth.
export function relayDecision(
  packet: Packet,
  degree: number,
  localPeerID: Uint8Array,
): RelayDecision | null {
  const ttlCap = Math.min(packet.ttl, DEFAULT_TTL);

  // Link-local, never relayed: one crafted with TTL headroom would otherwise
  // turn every node it reached into a responder replaying its store.
  if (packet.type === PacketType.REQUEST_SYNC) return null;
  // A relay node's firmware update traffic, link-local the same way. Sent at
  // TTL 0, so this binds only on a copy claiming headroom, which a phone would
  // otherwise flood across the mesh one firmware chunk at a time.
  if (isRelayFirmwareType(packet.type)) return null;

  // Our own packet is ours to send, not to forward, and one addressed to us
  // has arrived. The caller still handles both: an announce under our ID
  // that we never sent is how a second phone on this identity shows itself.
  if (
    ttlCap <= 1 ||
    equalBytes(packet.senderID, localPeerID) ||
    equalBytes(packet.recipientID, localPeerID)
  ) {
    return null;
  }

  const hasRecipient = !isBroadcast(packet);
  const isHandshake = packet.type === PacketType.NOISE_HANDSHAKE;
  if (
    isHandshake ||
    (hasRecipient &&
      (packet.type === PacketType.FRAGMENT || isDirectedType(packet.type)))
  ) {
    return {
      ttl: ttlCap - 1,
      delayMs: isHandshake ? randomInt(10, 35) : randomInt(20, 60),
    };
  }

  // ttlCap is at least 2 here and every limit at least 5, so the max(2, ...)
  // and ttlLimit > 1 guards RelayController carries never bind.
  const isUrgentBoard =
    packet.type === PacketType.BOARD_POST && boardUrgentFlag(packet.payload);
  const limit = Math.min(
    ttlCap,
    relayLimit(packet.type, isUrgentBoard, degree),
  );
  return {
    ttl: limit - 1,
    delayMs: isStream(packet.type)
      ? randomInt(STREAM_MIN_DELAY_MS, STREAM_MAX_DELAY_MS)
      : broadcastDelayMs(degree),
  };
}

export class FloodRouter {
  private readonly dedup = new Deduplicator();
  // Fragments in a set of their own. One 1 MiB file is over two thousand of
  // them, which in the shared set would push every message ID out in about
  // half a minute instead of five. bitchat-ios keeps fragments out of its
  // message dedup entirely; a set is still needed here, since fragments are
  // relayed and a loop must end.
  private readonly fragmentDedup = new Deduplicator();
  private readonly liveDedup = new Deduplicator(
    LIVE_DEDUP_MAX,
    LIVE_DEDUP_EXPIRY_MS,
  );

  // `getDegree` is our current neighbor count, which the relay policy scales
  // with. It defaults to 0 (sparse), which keeps the router usable in tests
  // without a live peer count.
  constructor(
    private readonly localPeerID: Uint8Array,
    private readonly getDegree: () => number = () => 0,
  ) {}
  // Scheduled relay timers, keyed by packet ID hex, held for flush().
  private readonly pending: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  // Whether this packet's ID is already recorded, without recording it, so the
  // caller can drop a duplicate before paying for its signature check and
  // record the ID only once that check passes (receive).
  seen(packet: Packet): boolean {
    return this.dedupFor(packet).has(computePacketId(packet));
  }

  // Process an incoming packet.
  //
  // Returns true if the packet is new (caller should handle it locally).
  // Returns false if the packet is a duplicate (caller should drop silently).
  //
  // When the packet is new and relayDecision allows, a relay is scheduled
  // through the provided send function.
  receive(packet: Packet, send: SendFn): boolean {
    const pid = computePacketId(packet);
    const dedup = this.dedupFor(packet);
    if (dedup.has(pid)) return false;
    dedup.add(pid);

    const decision = relayDecision(packet, this.getDegree(), this.localPeerID);
    if (decision !== null) {
      this.scheduleRelay(
        { ...packet, ttl: decision.ttl },
        pid,
        send,
        decision.delayMs,
      );
    }

    return true;
  }

  // Dedup without relaying, for a packet that reached us some way other than
  // the flood: one reassembled from fragments, whose fragments already
  // relayed. Returns true if the packet is new. Recording it also means a whole
  // copy arriving later over another radio is dropped rather than handled twice.
  admit(packet: Packet): boolean {
    const pid = computePacketId(packet);
    const dedup = this.dedupFor(packet);
    if (dedup.has(pid)) return false;
    dedup.add(pid);
    return true;
  }

  // Originate a packet from this node. Records the ID so we do not relay
  // our own broadcasts back to ourselves.
  originate(packet: Packet): void {
    this.dedupFor(packet).add(computePacketId(packet));
  }

  // Let whole packets already seen be handled again. For sync replies refused
  // only for want of their author's key: once it is pinned, peers offer them
  // again under the same IDs, which would otherwise be dropped as duplicates
  // for the rest of the dedup window. Never fragment IDs, which a re-offered
  // packet does not reuse (its fragments carry a fresh stream ID).
  forget(packetIds: readonly Uint8Array[]): void {
    for (const pid of packetIds) this.dedup.delete(pid);
  }

  private dedupFor(packet: Packet): Deduplicator {
    if (packet.type === PacketType.FRAGMENT) return this.fragmentDedup;
    return isLiveMedia(packet.type) ? this.liveDedup : this.dedup;
  }

  private scheduleRelay(
    packet: Packet,
    pid: Uint8Array,
    send: SendFn,
    delayMs: number,
  ): void {
    const idKey = Array.from(pid)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const timer = setTimeout(() => {
      this.pending.delete(idKey);
      send(packet);
    }, delayMs);

    this.pending.set(idKey, timer);
  }

  // Cancel all pending relay timers, for when the mesh stops.
  flush(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  get defaultTTL(): number {
    return DEFAULT_TTL;
  }
}
