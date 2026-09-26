// Gossip sync using Golomb-Coded Set (GCS) filters.
//
// Wire-compatible with bitchat-ios GossipSyncManager / RequestSyncPacket.
//
// Protocol flow:
//   1. Every 15 seconds, send each connected peer one REQUEST_SYNC per round
//      that is due (see SYNC_ROUNDS), each a GCS filter of the packet IDs we
//      hold of that round's types.
//   2. On receiving a REQUEST_SYNC from a peer, decode the filter and send
//      back any packets we have that the peer appears to be missing.
//
// Three rules the other implementations enforce too:
//
//   * REQUEST_SYNC is link-local (ttl 0). It asks what the peer on the far end
//     of this link is missing; relaying it asks the wrong node.
//   * Responses are link-local (ttl 0) and tagged IS_RSR. Without ttl 0 the
//     requester's flood router treats each replayed packet as new, which it
//     is, and re-floods it. One peer rejoining after a partition would push
//     the entire archive back across the mesh.
//   * Requests are unicast, so a response can be attributed to a request we
//     made. See request-sync-manager.ts.
//
// Packet ID (per PacketIdUtil.swift / PacketIdUtil.kt):
//   SHA-256(type[1] | senderID[8] | timestamp_u64_BE[8] | payload)[0:16]
//   See computePacketId in packet-codec.ts.
//
// GCS hash for filter membership:
//   h64 = first 8 bytes of SHA-256(packetID) as big-endian u64
//
// Wire format for REQUEST_SYNC payload (TLV, type-u8, length-u16-BE, value):
//   0x01  P       (uint8)   Golomb-Rice parameter
//   0x02  M       (uint32 BE) hash range
//   0x03  data    (bytes)   Golomb-Rice bitstream
//   0x04  types   (1-8 bytes LE) SyncTypeFlags bitmask
//   0x05  since   (uint64 BE) filter-coverage cursor, ms since epoch

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { SlidingWindowLimiter } from "../routing/sliding-window-limiter";
import {
  computePacketId,
  Flags,
  isBroadcast,
  PacketType,
  signPacket,
  type Packet,
} from "../wire/packet-codec";
import { PacketStore } from "./packet-store";

// Constants per PROTOCOLS.md section 5.
const SYNC_INTERVAL_MS = 15_000;
export const GCS_MAX_BYTES = 400;
export const GCS_TARGET_FPR = 0.01; // 1%
// The largest Golomb-Rice parameter a request may carry, bitchat-ios
// GCSFilter.maxP. RequestSyncPacket.decode refuses anything outside 1..32.
const GCS_MAX_P = 32;

// One store per kind of packet, sized as bitchat-ios GossipSyncManager.Config
// sizes its own, so one kind flooding cannot evict another's history. Public
// messages: seenCapacity and messageByteBudget. Group messages, opaque to
// anyone outside the group and so carried unverified: groupMessageCapacity
// and groupMessageByteBudget. Board posts: boardCapacity, the board store's
// own cap; a post is a control frame, so 200 need no byte budget.
const MESSAGE_CAPACITY = 1000;
const MESSAGE_BUDGET_BYTES = 8 * 1024 * 1024;
const GROUP_CAPACITY = 200;
const GROUP_BUDGET_BYTES = 4 * 1024 * 1024;
const BOARD_CAPACITY = 200;
// Announces are kept one per peer, the latest, as bitchat-ios keeps them
// (latestAnnouncementByPeer). It sets no count; this one is Airhop's, since a
// verified announce costs nothing more than a freshly minted identity.
const ANNOUNCE_CAPACITY = 1000;
// Sync replies remembered without being kept (see GossipSync.noteReply), as
// many as the message store holds.
const DECLINED_CAPACITY = MESSAGE_CAPACITY;

// REQUEST_SYNC and every packet sent in answer to one travel exactly one hop.
// bitchat sets ttl 0 in both directions (GossipSyncManager.sendRequestSync and
// every `toSend.ttl = 0` on the response path) and its sync spec states it as
// a MUST. See the header note for what goes wrong without it.
const SYNC_TTL = 0;

// How long a packet stays worth offering, per type. One blanket window would be
// wrong in both directions: it would keep presence alive after its sender left,
// and expire board posts meant to outlive everyone carrying them.

// Presence that outlives its sender misreports who is in the room. 60s is a
// consensus rule in bitchat-android's sync.md and matches bitchat-ios's
// stale-peer timeout.
const MAX_AGE_ANNOUNCE_MS = 60_000;
// Carrying the room's recent history across a partition is the point of gossip.
// bitchat-ios serves and accepts six hours of it (syncPublicMessageMaxAgeSeconds
// in TransportConfig, which BLEService passes over GossipSyncManager's 900 s
// default). A shorter window here would refuse the backfill it sends.
const MAX_AGE_MESSAGE_MS = 6 * 60 * 60 * 1000;
// Board posts carry their own author-chosen expiry (max 7 days, PROTOCOLS.md
// section 3) and the board store enforces it on receipt. This is only a
// backstop against an entry sitting in the LRU forever.
const MAX_AGE_BOARD_MS = 7 * 24 * 60 * 60 * 1000;

// Group messages, same window public messages get, as in bitchat-ios
// (GossipSyncManager.isPacketFresh). A group is a conversation, and a member who
// was away for a while is the case backfill exists for. A roster change rotates
// the epoch key, so a message sealed under the old one stops being readable
// whatever its age.
const MAX_AGE_GROUP_MS = MAX_AGE_MESSAGE_MS;

// One REQUEST_SYNC can replay the whole store, so a peer asking in a tight loop
// is an amplifier pointed at us and at the shared radio. Bounds how often one
// peer can make us run a diff pass. Matches bitchat-ios
// responseRateLimitMaxResponses / responseRateLimitWindowSeconds.
const RESPONSE_LIMIT_MAX = 8;
const RESPONSE_LIMIT_WINDOW_MS = 30_000;

// SyncTypeFlags bit indices (bit -> message type), matching bitchat's
// SyncTypeFlags.swift so a board sync round is mutually intelligible.
const TYPE_BIT_ANNOUNCE = 0; // bit 0
const TYPE_BIT_MESSAGE = 1; // bit 1
const TYPE_BIT_BOARD = 8; // bit 8 (board posts persist and sync until expiry)
// bit 10 (private group messages). bitchat defines this bit, caches group
// packets, advertises them and serves them; Airhop defined none of it, so a group
// had no store-and-forward at all. Airhop-to-Airhop nothing was ever backfilled,
// and toward bitchat the exchange was one-directional: bitchat filled our gaps
// and we never answered its requests. The payload stays sealed under the epoch
// key either way, so a relay learns nothing by carrying it.
const TYPE_BIT_GROUP = 10;
// Airhop's named public channels (CHANNEL_MSG_AIRHOP). Without a bit of their
// own these messages would have no catch-up at all, since they no longer ride
// bit 1 with the mesh room.
//
// Airhop-only, and safe in both directions: bitchat's SyncTypeFlags masks off
// bits that map to no known type, so a request carrying this one is answered
// with the types bitchat does know, and bitchat never sets it.
//
// Bit 24, not 11. bitchat's table ends at 10 and it allocates forward, so 11 is
// the next value it would reach for. 24 leaves it thirteen and stays under 31,
// which the encoder needs: `1 << 31` is negative in JavaScript and `v & 0xff`
// in encodeTypeFlags coerces to a 32-bit int, so a higher bit would silently
// fold onto a lower one.
const TYPE_BIT_AIRHOP_CHANNEL = 24;

// Map a packet type to its SyncTypeFlags bit, or null when it is not gossiped.
//
// FILE_TRANSFER is bit 7 in bitchat and is deliberately absent here, which is
// the one place this table diverges from theirs. An attachment is up to 1 MiB,
// so serving one from sync is ten to forty-five seconds of exclusive radio time
// per asking peer, against a GCS filter sized at 400 bytes for items that are
// small and numerous. bitchat's own reassembly also expires 30 seconds after the
// first fragment, so a re-flooded file frequently fails on arrival anyway and
// the airtime buys nothing.
//
// The interop cost is bounded and symmetric: a bitchat peer may ask for bit 7
// and we answer with nothing, and we never ask for it ourselves. Neither side
// errors, because an unmatched bit maps to no type. What it means for a user is
// that a channel attachment missed while out of range is not backfilled, where
// text, board posts and group messages are. Media on the mesh is best-effort at
// the moment it is sent.
function syncBitForType(type: PacketType): number | null {
  switch (type) {
    case PacketType.ANNOUNCE:
      return TYPE_BIT_ANNOUNCE;
    case PacketType.CHANNEL_MSG:
      return TYPE_BIT_MESSAGE;
    case PacketType.CHANNEL_MSG_AIRHOP:
      return TYPE_BIT_AIRHOP_CHANNEL;
    case PacketType.BOARD_POST:
      return TYPE_BIT_BOARD;
    case PacketType.GROUP_MESSAGE:
      return TYPE_BIT_GROUP;
    default:
      return null;
  }
}

function inTypes(type: PacketType, types: number): boolean {
  const bit = syncBitForType(type);
  return bit !== null && (types & (1 << bit)) !== 0;
}

export interface SyncRound {
  types: number; // SyncTypeFlags bitmask
  everyTicks: number; // of the 15 s sync tick
}

// One request per round rather than one filter over everything, as bitchat-ios
// sends one per due schedule (GossipSyncManager.performPeriodicMaintenance).
// Each round gets the whole 400-byte filter and its own since-cursor. In one
// filter a busy room's messages push board posts behind the cursor, where
// nobody offers them again, and with six hours of messages held that takes
// minutes rather than days.
//
// The rounds are bitchat-ios's: announces, public and group messages together
// (its message schedule, 15 s), and board posts alone every 60 s
// (boardSyncIntervalSeconds). Airhop's named channels ride the message round.
// That is at most three requests per peer in any 30 s, well inside the
// eight a responder answers.
export const SYNC_ROUNDS: readonly SyncRound[] = [
  {
    types:
      (1 << TYPE_BIT_ANNOUNCE) |
      (1 << TYPE_BIT_MESSAGE) |
      (1 << TYPE_BIT_GROUP) |
      (1 << TYPE_BIT_AIRHOP_CHANNEL),
    everyTicks: 1,
  },
  { types: 1 << TYPE_BIT_BOARD, everyTicks: 4 },
];

// How long a packet of this type stays a sync candidate. Null for types that
// are never gossiped, which syncBitForType already rejects.
function maxAgeForType(type: PacketType): number | null {
  switch (type) {
    case PacketType.ANNOUNCE:
      return MAX_AGE_ANNOUNCE_MS;
    case PacketType.CHANNEL_MSG:
    case PacketType.CHANNEL_MSG_AIRHOP:
      return MAX_AGE_MESSAGE_MS;
    case PacketType.BOARD_POST:
      return MAX_AGE_BOARD_MS;
    case PacketType.GROUP_MESSAGE:
      return MAX_AGE_GROUP_MS;
    default:
      return null;
  }
}

// Whether an old packet may be taken as an answer to our own sync request: only
// a type we ask for, inside the window we would serve it for ourselves. A
// FRAGMENT gets the longest (board) window because bitchat stamps a reply's
// fragments with the time of the packet inside, and that packet is held to its
// own type's window again once reassembled. Everything else in a reply is
// either fresh or a replay dressed as one.
export function isSyncReplyInWindow(packet: Packet, now: number): boolean {
  const maxAge =
    packet.type === PacketType.FRAGMENT
      ? MAX_AGE_BOARD_MS
      : maxAgeForType(packet.type);
  return maxAge !== null && now - packet.timestamp <= maxAge;
}

// Whether a tracked packet is still worth advertising or offering.
//
// A future timestamp is treated as expired rather than fresh: a packet stamped
// past the local clock is either a badly skewed device or a sender trying to
// pin an entry at the head of everyone's candidate set forever, and neither is
// something to carry on someone else's behalf.
function isFreshCandidate(
  packet: Pick<Packet, "type" | "timestamp">,
  now: number,
): boolean {
  const maxAge = maxAgeForType(packet.type);
  if (maxAge === null) return false;
  const age = now - packet.timestamp;
  return age >= -MAX_AGE_ANNOUNCE_MS && age <= maxAge;
}

// The bitfield is a little-endian integer, 1-8 bytes with trailing zero bytes
// trimmed (bit 8 widens it from 1 to 2 bytes). Unknown high bits are ignored by
// the decoder, so old clients simply never match the newer bits.
function encodeTypeFlags(types: number): Uint8Array {
  const bytes: number[] = [];
  let v = types;
  while (v > 0 && bytes.length < 8) {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes.length === 0) bytes.push(0);
  return new Uint8Array(bytes);
}

function decodeTypeFlags(bytes: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < bytes.length && i < 8; i++) v += bytes[i] * 256 ** i;
  return v;
}

// ---- GCS h64 derivation ----

// 8-byte value for GCS membership check:
// h64 = first 8 bytes of SHA-256(packetID) as big-endian u64, sign bit cleared.
// The sign-bit mask matches bitchat-ios GCSFilter.h64(_:).
function packetIdToH64(packetId: Uint8Array): bigint {
  const hash = sha256(packetId);
  const view = new DataView(hash.buffer);
  const raw =
    (BigInt(view.getUint32(0, false)) << 32n) |
    BigInt(view.getUint32(4, false));
  return raw & 0x7fff_ffff_ffff_ffffn; // clear sign bit
}

// ---- GCS filter (Golomb-Coded Set) ----

function deriveP(fpr: number): number {
  const f = Math.max(0.000001, Math.min(0.25, fpr));
  return Math.max(1, Math.ceil(Math.log2(1 / f)));
}

// Roughly how many elements fit in a filter of this size at this P, per
// bitchat's GCS spec: N_max ~= floor((8 * sizeBytes) / (P + 2)). An estimate
// only; the encoder below trims further if the real encoding overflows.
function estimateMaxElements(sizeBytes: number, p: number): number {
  return Math.max(1, Math.floor((8 * sizeBytes) / (p + 2)));
}

// Build a GCS filter. The caller must pass h64 values newest-first.
//
// Returns the wire parameters plus `includedCount`: how many inputs the filter
// covers. Trimming drops from the tail of a newest-first list, so the covered
// set is a contiguous newest-prefix and the since-cursor can name an exact
// timestamp. Trimming in hash order would leave an arbitrary subset that no
// timestamp describes.
//
// M formula: M = count * 2^P, matching bitchat-ios GCSFilter.hashRange().
// This gives FPR ~= 1/2^P per element regardless of the set size.
export function buildGcsFilter(
  h64s: bigint[],
  maxBytes: number,
  targetFpr: number,
): { p: number; m: number; data: Uint8Array; includedCount: number } {
  const p = deriveP(targetFpr);
  if (h64s.length === 0) {
    return { p, m: 1, data: new Uint8Array(0), includedCount: 0 };
  }

  const cap = estimateMaxElements(maxBytes, p);
  // The modulus is fixed to the initial candidate count so `m` stays stable as
  // the tail is trimmed below. A modulus that moved with each retry would
  // change every mapped value, so the trimming loop would never converge on
  // anything meaningful.
  const raw = Math.min(h64s.length, cap) * (1 << p);
  const mNum = Math.max(1, Math.min(raw, 0xffffffff));
  const modulo = BigInt(mNum);

  const encodeFirst = (count: number): Uint8Array => {
    // Map each h64 to [1, M), sort, and drop duplicates (normalizeMappedValues).
    const mapped = h64s
      .slice(0, count)
      .map((v) => {
        const x = v % modulo;
        return x === 0n ? 1n : x;
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const sorted: bigint[] = [];
    let last = 0n;
    for (const v of mapped) {
      if (v > last) {
        sorted.push(v);
        last = v;
      }
    }
    return sorted.length === 0
      ? new Uint8Array(0)
      : encodeGolombRice(sorted, p);
  };

  // Shrink until it fits. Dropping 10% per pass converges quickly and matches
  // bitchat's loop. Emitting nothing on overflow would be worse than it sounds:
  // an empty filter reads as "I have nothing", so the responder replies with
  // its entire store, and overflow is likeliest on the busiest mesh.
  let count = Math.min(h64s.length, cap);
  let encoded = encodeFirst(count);
  while (encoded.length > maxBytes && count > 1) {
    count = Math.max(1, Math.floor((count * 9) / 10));
    encoded = encodeFirst(count);
  }
  // A single element that still overflows cannot be represented at all.
  if (encoded.length > maxBytes) {
    return { p, m: mNum, data: new Uint8Array(0), includedCount: 0 };
  }

  return {
    p,
    m: mNum,
    data: encoded,
    includedCount: encoded.length === 0 ? 0 : count,
  };
}

function encodeGolombRice(sorted: bigint[], p: number): Uint8Array {
  const bits: number[] = [];

  function writeBit(b: number): void {
    bits.push(b & 1);
  }

  let prev = 0n;
  for (const v of sorted) {
    const delta = v - prev;
    if (delta <= 0n) continue; // skip duplicates
    prev = v;
    const x = delta - 1n; // encode x+1 -> store x
    const q = Number(x >> BigInt(p));
    const r = Number(x & BigInt((1 << p) - 1));
    // Unary: q ones then zero
    for (let i = 0; i < q; i++) writeBit(1);
    writeBit(0);
    // P-bit remainder (MSB first)
    for (let i = p - 1; i >= 0; i--) writeBit((r >> i) & 1);
  }

  // Pack bits into bytes (MSB first within each byte).
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

// Decode a GCS filter and return the sorted set of mapped h64 values.
export function decodeGcsFilter(
  p: number,
  m: number,
  data: Uint8Array,
): bigint[] {
  if (p < 1 || p > 32 || m <= 1 || data.length === 0) return [];

  const modulo = BigInt(m);
  const values: bigint[] = [];
  let bitPos = 0;
  let acc = 0n;

  function readBit(): number | null {
    if (bitPos >= data.length * 8) return null;
    const b = (data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return b;
  }

  function readUnary(): number | null {
    let q = 0;
    while (true) {
      const b = readBit();
      if (b === null) return null;
      if (b === 0) return q;
      q++;
      if (q > 0xffff) return null; // guard against malformed input
    }
  }

  function readBits(count: number): number | null {
    let result = 0;
    for (let i = 0; i < count; i++) {
      const b = readBit();
      if (b === null) return null;
      result = (result << 1) | b;
    }
    return result;
  }

  while (true) {
    const q = readUnary();
    if (q === null) break;
    const r = readBits(p);
    if (r === null) break;
    const x = (BigInt(q) << BigInt(p)) + BigInt(r) + 1n;
    acc += x;
    if (acc >= modulo) break;
    values.push(acc);
  }

  return values;
}

// Check whether a h64 value is contained in a decoded filter set.
function filterContains(sortedValues: bigint[], candidate: bigint): boolean {
  let lo = 0;
  let hi = sortedValues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] === candidate) return true;
    if (sortedValues[mid] < candidate) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// ---- Wire encode/decode for REQUEST_SYNC payload ----

// TLV encoder: type (u8), length (u16 BE), value
function encodeTlv(type: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + value.length);
  out[0] = type;
  new DataView(out.buffer).setUint16(1, value.length, false); // BE
  out.set(value, 3);
  return out;
}

export interface GossipFilterPayload {
  p: number;
  m: number;
  data: Uint8Array;
  types?: number; // SyncTypeFlags bitmask
  // Oldest timestamp our filter actually covers, ms since epoch. A responder
  // holding something older than this knows it is outside the filter rather
  // than missing from it, and skips it instead of re-sending it every round.
  since?: number;
}

// Encode a u64 big-endian from a JS number. Timestamps are milliseconds, well
// inside 2^53, so the split is exact.
function u64be(value: number): Uint8Array {
  const b = new Uint8Array(8);
  const view = new DataView(b.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000), false);
  view.setUint32(4, value >>> 0, false);
  return b;
}

export function encodeGossipFilterPayload(
  params: GossipFilterPayload,
): Uint8Array {
  const parts: Uint8Array[] = [
    encodeTlv(0x01, new Uint8Array([params.p & 0xff])),
    encodeTlv(
      0x02,
      (() => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, params.m, false);
        return b;
      })(),
    ),
    encodeTlv(0x03, params.data),
  ];
  if (params.types !== undefined && params.types !== 0) {
    parts.push(encodeTlv(0x04, encodeTypeFlags(params.types)));
  }
  if (params.since !== undefined && params.since > 0) {
    parts.push(encodeTlv(0x05, u64be(params.since)));
  }
  return concatBytes(...parts);
}

export function decodeGossipFilterPayload(
  payload: Uint8Array,
): GossipFilterPayload | null {
  let off = 0;
  let p: number | undefined;
  let m: number | undefined;
  let data: Uint8Array | undefined;
  let types: number | undefined;
  let since: number | undefined;

  while (off + 3 <= payload.length) {
    const type = payload[off];
    off++;
    const len = new DataView(
      payload.buffer,
      payload.byteOffset + off,
    ).getUint16(0, false);
    off += 2;
    if (off + len > payload.length) return null;
    const value = payload.slice(off, off + len);
    off += len;

    switch (type) {
      case 0x01:
        if (value.length === 1) p = value[0];
        break;
      case 0x02:
        if (value.length === 4)
          m = new DataView(value.buffer, value.byteOffset).getUint32(0, false);
        break;
      case 0x03:
        if (value.length <= GCS_MAX_BYTES + 16) data = value;
        break;
      case 0x04:
        if (value.length >= 1 && value.length <= 8)
          types = decodeTypeFlags(value);
        break;
      case 0x05:
        if (value.length === 8) {
          const view = new DataView(value.buffer, value.byteOffset);
          since =
            view.getUint32(0, false) * 0x100000000 + view.getUint32(4, false);
        }
        break;
    }
  }

  if (p === undefined || m === undefined || data === undefined) return null;
  // As bitchat-ios RequestSyncPacket.decode: m 0 would make every membership
  // test a division by zero, and a p outside 1..32 is no filter anyone built.
  // m 1 stays valid; it is the empty filter meaning "I hold nothing".
  if (p < 1 || p > GCS_MAX_P || m === 0) return null;
  return { p, m, data, types, since };
}

// ---- GossipSync class ----

export type SendToPeerFn = (peerID: string, packet: Packet) => void;

export interface GossipSyncIdentity {
  peerID: string;
  signingPrivKey: Uint8Array;
}

export interface GossipSyncWiring {
  // One request per connected peer, so responses can be attributed.
  sendToPeer: SendToPeerFn;
  // Peers we currently hold a link to, by peerID.
  getPeers: () => readonly string[];
  // Told about every request we send, so the receive path can recognise a
  // solicited response. See request-sync-manager.ts.
  onRequest: (peerID: string) => void;
  // Once a tick, before any request, for state that ages on the same clock.
  onTick?: (now: number) => void;
}

// Holds the recent packets seen for gossip reconciliation.
// Only ANNOUNCE, CHANNEL_MSG, CHANNEL_MSG_AIRHOP, BOARD_POST and GROUP_MESSAGE
// are gossiped; syncBitForType is the single place that decides.
export class GossipSync {
  private readonly messages = new PacketStore(
    MESSAGE_CAPACITY,
    MESSAGE_BUDGET_BYTES,
  );
  private readonly groups = new PacketStore(GROUP_CAPACITY, GROUP_BUDGET_BYTES);
  private readonly boards = new PacketStore(BOARD_CAPACITY);
  // Keyed by sender rather than packet ID: one per peer.
  private readonly announces = new PacketStore(ANNOUNCE_CAPACITY);
  private readonly stores = [
    this.announces,
    this.messages,
    this.groups,
    this.boards,
  ];
  // Sync replies we were handed and did not keep, by packet ID. See noteReply.
  private readonly declined = new Map<string, FilterEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // Not a deduplicator: a peer asks every 15s and gets an answer. This only
  // caps one asking far faster, since each answer costs a store scan and a
  // burst of writes on a shared radio.
  private readonly rateLimiter = new SlidingWindowLimiter(
    RESPONSE_LIMIT_MAX,
    RESPONSE_LIMIT_WINDOW_MS,
  );

  // Start the 15-second sync tick. Every request is unicast to a peer we hold
  // a link to: a broadcast one has no peer to register against, so nothing it
  // drew back would be taken as a reply.
  start(identity: GossipSyncIdentity, wiring: GossipSyncWiring): void {
    if (this.timer !== null) this.stop();
    let tick = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.prune(now);
      wiring.onTick?.(now);
      const peers = wiring.getPeers();
      for (const round of SYNC_ROUNDS) {
        if (tick % round.everyTicks !== 0) continue;
        for (const peerID of peers) {
          const pkt = this.buildFilterPacket(
            identity,
            peerID,
            round.types,
            now,
          );
          // Registered BEFORE the send: on a fast link the response can
          // outrun our own continuation, and a response that lands before its
          // registration looks exactly like an unsolicited one.
          wiring.onRequest(peerID);
          wiring.sendToPeer(peerID, pkt);
        }
      }
      tick++;
    }, SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Drop candidates past their per-type window, and response budgets nobody
  // has spent inside theirs. Idempotent; driven from the sync tick rather than
  // a timer of its own.
  prune(now: number = Date.now()): void {
    for (const store of this.stores) {
      store.removeWhere((packet) => !isFreshCandidate(packet, now));
    }
    for (const [key, entry] of this.declined) {
      if (!isFreshCandidate(entry, now)) this.declined.delete(key);
    }
    this.rateLimiter.prune(now);
  }

  // A link went down. Clears that peer's response budget so a genuine
  // reconnect is not throttled by the previous session's traffic.
  forgetPeer(peerID: string): void {
    this.rateLimiter.forget(peerID);
  }

  // The user blocked this peer: stop carrying their public messages for
  // others, as bitchat-ios does (removePublicMessages(from:)). Their messages
  // are no longer accepted, so nothing re-adds them.
  forgetMessagesFrom(peerID: string): void {
    this.messages.removeWhere(
      (packet) => bytesToHex(packet.senderID) === peerID,
    );
  }

  // Keep a packet to offer peers who missed it. Called only once the packet
  // was accepted: a store fed before verification fills with forgeries that
  // evict real history and are then served to everyone who asks. Broadcasts
  // only, and never a type that is not gossiped. An announce replaces its
  // sender's older one.
  track(packet: Packet): void {
    if (!isBroadcast(packet) || syncBitForType(packet.type) === null) return;
    const key = bytesToHex(computePacketId(packet));
    this.declined.delete(key);
    switch (packet.type) {
      case PacketType.ANNOUNCE: {
        const sender = bytesToHex(packet.senderID);
        const held = this.announces.get(sender);
        if (held !== undefined && held.timestamp >= packet.timestamp) return;
        this.announces.insert(sender, packet);
        return;
      }
      case PacketType.CHANNEL_MSG:
      case PacketType.CHANNEL_MSG_AIRHOP:
        this.messages.insert(key, packet);
        return;
      case PacketType.GROUP_MESSAGE:
        this.groups.insert(key, packet);
        return;
      case PacketType.BOARD_POST:
        this.boards.insert(key, packet);
        return;
      default:
        return;
    }
  }

  // A packet that arrived as a reply to one of our requests, before any
  // handler has judged it. One a handler goes on to accept is tracked, which
  // takes it off this list. One it refuses stays, most often history from an
  // author whose announce this node never heard and so cannot verify: nothing
  // here is ever served, but the ID goes into our own filters, or every peer
  // we ask would offer it again every round for as long as it stays servable.
  // Only replies are remembered, so only a neighbour we asked could plant an
  // ID here, and it could as easily withhold the packet.
  noteReply(packet: Packet): void {
    if (!isBroadcast(packet) || syncBitForType(packet.type) === null) return;
    const id = computePacketId(packet);
    const key = bytesToHex(id);
    this.declined.delete(key);
    this.declined.set(key, {
      type: packet.type,
      timestamp: packet.timestamp,
      id,
    });
    for (const oldest of this.declined.keys()) {
      if (this.declined.size <= DECLINED_CAPACITY) break;
      this.declined.delete(oldest);
    }
  }

  private *packets(): Generator<Packet> {
    for (const store of this.stores) yield* store.values();
  }

  // Build a REQUEST_SYNC for `toPeerID` covering the packet types in `types`.
  // ttl 0: this is a question for the far end of one link, and relaying it
  // asks a node that was never being addressed. Built even when we hold none
  // of those types: the empty filter asks for everything, which is how a
  // newcomer collects the board.
  buildFilterPacket(
    identity: GossipSyncIdentity,
    toPeerID: string,
    types: number,
    now: number = Date.now(),
  ): Packet {
    // Newest first: the filter builder trims from the tail when it overflows
    // its byte budget, so this ordering is what makes the covered set a
    // contiguous newest-prefix and the cursor below exact.
    const held: FilterEntry[] = [...this.packets()].map((p) => ({
      type: p.type,
      timestamp: p.timestamp,
      id: computePacketId(p),
    }));
    const candidates = [...held, ...this.declined.values()]
      .filter((e) => inTypes(e.type, types) && isFreshCandidate(e, now))
      .sort((a, b) => b.timestamp - a.timestamp);

    const h64s = candidates.map((e) => packetIdToH64(e.id));
    const { p, m, data, includedCount } = buildGcsFilter(
      h64s,
      GCS_MAX_BYTES,
      GCS_TARGET_FPR,
    );

    // The cursor goes out only when the filter could not cover everything we
    // hold. It means "my filter was truncated and reaches back this far", not
    // "do not send me anything older than my oldest packet". Getting that
    // backwards breaks catch-up silently: a device that just joined holds only
    // recent packets because it was not there, so a cursor at its oldest entry
    // would withhold exactly the history it turned up to collect.
    const since =
      includedCount > 0 && includedCount < candidates.length
        ? candidates[includedCount - 1].timestamp
        : undefined;

    const payload = encodeGossipFilterPayload({ p, m, data, types, since });

    const packet: Packet = {
      type: PacketType.REQUEST_SYNC,
      ttl: SYNC_TTL,
      flags: Flags.SIGNED | Flags.HAS_RECIPIENT,
      senderID: hexToBytes(identity.peerID),
      recipientID: hexToBytes(toPeerID),
      timestamp: now,
      signature: new Uint8Array(64),
      payload,
    };
    packet.signature = signPacket(packet, identity.signingPrivKey);
    return packet;
  }

  // Handle an incoming REQUEST_SYNC from `fromPeerID`. Returns the packets we
  // hold that the peer appears to be missing, ready to write straight back down
  // the link it asked on.
  //
  // Responses come back ttl 0 and flagged IS_RSR. ttl 0 keeps them link-local,
  // or the requester's flood router would see each one as new and push it
  // across the mesh. IS_RSR marks them as the answer to the requester's own
  // question, so it can exempt them from its freshness window. Both fields are
  // normalised out of the signing preimage, so retagging a stored packet leaves
  // its signature verifiable.
  handleFilter(
    filterPacket: Packet,
    fromPeerID?: string,
    now: number = Date.now(),
  ): Packet[] {
    // Decoded first, which costs a few TLVs, so a malformed request spends
    // none of its peer's budget. The limit then comes before the diff pass,
    // the expensive part, which a peer asking in a loop must not make us pay
    // for. bitchat-ios limits first; either order answers it the same.
    const params = decodeGossipFilterPayload(filterPacket.payload);
    if (params === null) return [];
    if (
      fromPeerID !== undefined &&
      !this.rateLimiter.tryAcquire(fromPeerID, now)
    ) {
      return [];
    }

    const decodedFilter = decodeGcsFilter(params.p, params.m, params.data);
    const missing: Packet[] = [];

    // A request without a types field is a pre-type-aware peer: answer with the
    // original announce+message set only.
    const requestedTypes =
      params.types ?? (1 << TYPE_BIT_ANNOUNCE) | (1 << TYPE_BIT_MESSAGE);

    for (const packet of this.packets()) {
      // Never offer something we would not advertise ourselves. Otherwise a
      // peer whose own window has closed keeps being handed packets it will
      // drop, every round, forever.
      if (!isFreshCandidate(packet, now)) continue;

      // Only offer a packet whose type the requester actually asked for, so a
      // board round never draws announces and vice versa.
      if (!inTypes(packet.type, requestedTypes)) continue;

      // Outside the requester's filter coverage: not missing, just older than
      // what it asked about.
      if (params.since !== undefined && packet.timestamp < params.since)
        continue;

      const id = computePacketId(packet);
      const h64 = packetIdToH64(id);
      const inPeerFilter = filterContains(
        decodedFilter,
        h64 % BigInt(params.m),
      );
      if (!inPeerFilter) {
        missing.push({ ...packet, ttl: SYNC_TTL, isRSR: true });
      }
    }

    return missing;
  }

  get seenCount(): number {
    return this.stores.reduce((sum, store) => sum + store.size, 0);
  }

  reset(): void {
    for (const store of this.stores) store.clear();
    this.declined.clear();
    this.rateLimiter.reset();
  }
}

// What a filter needs of a packet: enough to date it, type it and hash it.
interface FilterEntry {
  type: PacketType;
  timestamp: number;
  id: Uint8Array;
}

// ---- Helpers ----

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
