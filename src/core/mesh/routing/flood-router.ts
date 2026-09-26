// TTL flood router: which packets this node passes on, how far and how soon,
// with deduplication.
//
// Rules per PROTOCOLS.md section 4:
//   - Every packet whose ID has not been seen is handed to the caller, relayed
//     or not. relayDecision says whether it goes further, at what TTL.
//   - Relay is delayed by a random jitter so the room's relays do not collide
//     and duplicate suppression has time to work.
//   - Duplicate packets (same ID within 5 min) are dropped silently.
//
// Packet ID matches bitchat PacketIdUtil:
// SHA-256(type|senderID|timestamp|payload)[0:16]
//
// The router verifies no signature. The few types that must be checked before
// they are relayed are checked by the caller first (mesh-service mayRelay).
import { equalBytes } from "@noble/curves/utils.js";
import { boardUrgentFlag } from "../wire/board-packet";
import {
  computePacketId,
  isBroadcast,
  PacketType,
  type Packet,
  type SendFn,
} from "../wire/packet-codec";
import { Deduplicator } from "./deduplicator";

// bitchat-ios TransportConfig.messageTTLDefault. Anything higher is clamped.
const DEFAULT_TTL = 7;

// Neighbour count at which the mesh counts as dense, bitchat-ios
// TransportConfig.bleHighDegreeThreshold.
const HIGH_DEGREE_THRESHOLD = 6;

// Media fragments and live voice: bleFragmentRelayTtlCap and
// bleFragmentRelayTtlCapDense, then bleFragmentRelayMinDelayMs and MaxDelayMs.
// A talker emits ~15 packets a second into a 350 ms jitter buffer, so the
// ordinary window (up to 220 ms a hop) would spend the buffer in three hops.
const STREAM_TTL_CAP = 7;
const STREAM_TTL_CAP_DENSE = 5;
const STREAM_MIN_DELAY_MS = 8;
const STREAM_MAX_DELAY_MS = 25;

// Other broadcasts, by degree (RelayController's clamp).
const BROADCAST_TTL_CAP_DENSE = 5;
const BROADCAST_TTL_CAP_MID = 6;
const BROADCAST_TTL_CAP_MID_PRIORITY = 7;

export interface RelayDecision {
  ttl: number; // the TTL the relayed copy carries
  delayMs: number;
}

// The highest TTL a relay at this degree lets a broadcast of this class leave
// with, before its own hop is taken off. Shared with originTtl, so what this
// node authors starts inside the range its neighbours' relays produce.
//
// Live voice floods like a fragment, a stream that a dense graph must
// contain; announces and urgent board posts get a hop more than other traffic
// at mid degree; a thin chain (degree 2 or less) relays at full depth, since
// every hop counts there and flooding costs little.
export function relayLimit(
  type: PacketType,
  isUrgentBoard: boolean,
  degree: number,
): number {
  const dense = degree >= HIGH_DEGREE_THRESHOLD;
  if (type === PacketType.FRAGMENT || type === PacketType.VOICE_FRAME) {
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

// Ordinary broadcast jitter, by degree. Sparse relays go almost at once so a
// packet is not cancelled before it spreads; dense ones wait, so someone
// else's relay usually wins and duplicate suppression does the rest.
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

  // Link-local: relayed, one crafted with TTL headroom would turn every node
  // it reached into a responder replaying its store.
  if (packet.type === PacketType.REQUEST_SYNC) return null;

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
  const isStream =
    packet.type === PacketType.FRAGMENT ||
    packet.type === PacketType.VOICE_FRAME;
  return {
    ttl: limit - 1,
    delayMs: isStream
      ? randomInt(STREAM_MIN_DELAY_MS, STREAM_MAX_DELAY_MS)
      : broadcastDelayMs(degree),
  };
}

export class FloodRouter {
  private readonly dedup = new Deduplicator();

  // `getDegree` is our current neighbour count, which the relay policy scales
  // with. It defaults to 0 (sparse), which keeps the router usable in tests
  // without a live peer count.
  constructor(
    private readonly localPeerID: Uint8Array,
    private readonly getDegree: () => number = () => 0,
  ) {}
  // Scheduled relay timers, keyed by packet ID hex. Stored so callers can
  // flush on shutdown if needed.
  private readonly pending: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  // Process an incoming packet from the BLE layer.
  //
  // Returns true if the packet is new (caller should handle it locally).
  // Returns false if the packet is a duplicate (caller should drop silently).
  //
  // When the packet is new and relayDecision allows, a relay is scheduled
  // through the provided send function.
  receive(packet: Packet, send: SendFn): boolean {
    const pid = computePacketId(packet);
    if (this.dedup.has(pid)) return false;
    this.dedup.add(pid);

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
    if (this.dedup.has(pid)) return false;
    this.dedup.add(pid);
    return true;
  }

  // Originate a packet from this node. Records the ID so we do not relay
  // our own broadcasts back to ourselves.
  originate(packet: Packet): void {
    this.dedup.add(computePacketId(packet));
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

  // Cancel all pending relay timers (e.g., on BLE disconnect or shutdown).
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
