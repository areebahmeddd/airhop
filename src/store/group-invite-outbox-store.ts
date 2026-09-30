// Creator-signed group states owed to a member we could not reach yet.
//
// You can pick a member for a group from their announce alone, long before any
// Noise handshake has happened, so an invite frequently has nowhere to go at the
// moment it is created. MeshService holds it here and flushes it when the session
// comes up.
//
// Persisted, for the same reason the DM outbox is: "they will get this when they
// are next in range" has to survive an app restart to mean anything. In memory
// only, closing the app would lose every owed invite and rotation, leaving the
// creator a working group the member never learns exists. bitchat does not
// queue these at all (ChatGroupCoordinator only sends to currently-connected
// members and gives up), so this is deliberately better than upstream rather
// than a divergence from it.
//
// The stored payload is a group state, which carries the epoch key. That is the
// same key group-store already holds for the same group on the same device, so
// this adds no exposure that was not already there, and panic wipe clears both.

import { decodeGroupState } from "@core/mesh/rooms/group-protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getStorage } from "./mmkv";

export interface OwedGroupState {
  // NoisePayloadType: GROUP_INVITE (0x06) or GROUP_KEY_UPDATE (0x07). Carried
  // with the bytes rather than assumed. A flush that hardcodes invite mislabels
  // a rotation delivered to a reconnecting member.
  type: number;
  stateHex: string;
  queuedAtMs: number;
}

// Give up after this long. A week-old invite is to a roster that has almost
// certainly rotated since, and a state at a stale epoch is unusable anyway.
export const OWED_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Per-peer cap. A creator repeatedly re-keying a group a member never joins
// would otherwise grow this without bound; only the newest states can still be
// at a live epoch, so the oldest are the ones to drop.
const MAX_PER_PEER = 8;

const STORAGE_ID = "group-invite-outbox";
const STORAGE_KEY = "owed";
const storage = getStorage(STORAGE_ID);

type Owed = Record<string, OwedGroupState[]>;

function load(): Owed {
  const raw = storage.getString(STORAGE_KEY);
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as Owed;
  } catch {
    return {};
  }
}

function epochOf(
  stateBytes: Uint8Array,
): { groupHex: string; epoch: number } | null {
  const state = decodeGroupState(stateBytes);
  return state === null
    ? null
    : { groupHex: bytesToHex(state.groupID), epoch: state.epoch };
}

function save(owed: Owed): void {
  if (Object.keys(owed).length === 0) storage.remove(STORAGE_KEY);
  else storage.set(STORAGE_KEY, JSON.stringify(owed));
}

// Hold a state for a peer. Same (type, bytes) twice is one entry: a retry must
// not make the member receive the invite twice when they finally connect.
//
// Only the newest epoch of a group is owed. An older one is unusable once the
// newer lands, and sent together over several hops, the two can arrive out of
// order: a key update landing after the removal that replaced it would put a
// removed member back into a group nobody else is in.
export function queueOwedGroupState(
  peerID: string,
  type: number,
  stateBytes: Uint8Array,
  nowMs: number = Date.now(),
): void {
  const owed = load();
  const stateHex = bytesToHex(stateBytes);
  const held = owed[peerID] ?? [];
  if (held.some((e) => e.type === type && e.stateHex === stateHex)) return;
  const incoming = epochOf(stateBytes);
  // The epoch of an entry for the same group, or null for any other entry.
  const rival = (e: OwedGroupState): number | null => {
    if (incoming === null) return null;
    const other = epochOf(hexToBytes(e.stateHex));
    return other?.groupHex === incoming.groupHex ? other.epoch : null;
  };
  if (
    incoming !== null &&
    held.some((e) => (rival(e) ?? -1) > incoming.epoch)
  ) {
    return;
  }
  const kept = held.filter((e) => {
    const epoch = rival(e);
    return epoch === null || incoming === null || epoch >= incoming.epoch;
  });
  const next = [...kept, { type, stateHex, queuedAtMs: nowMs }];
  owed[peerID] = next.length > MAX_PER_PEER ? next.slice(-MAX_PER_PEER) : next;
  save(owed);
}

// Everything still owed to a peer, oldest first, expired entries dropped. Takes
// them out of the store: the caller is about to send them, and a state that fails
// to send is re-queued by the normal send path rather than retried from here.
export function takeOwedGroupStates(
  peerID: string,
  nowMs: number = Date.now(),
): { type: number; stateBytes: Uint8Array }[] {
  const owed = load();
  const entries = owed[peerID];
  if (entries === undefined || entries.length === 0) return [];
  delete owed[peerID];
  save(owed);
  return entries
    .filter((e) => nowMs - e.queuedAtMs < OWED_STATE_TTL_MS)
    .map((e) => ({ type: e.type, stateBytes: hexToBytes(e.stateHex) }));
}

// Drop anything past the TTL across every peer. Cheap, and worth doing on
// startup so a device that was off for a fortnight does not carry dead states.
export function evictExpiredOwedGroupStates(nowMs: number = Date.now()): void {
  const owed = load();
  let changed = false;
  for (const [peerID, entries] of Object.entries(owed)) {
    const live = entries.filter(
      (e) => nowMs - e.queuedAtMs < OWED_STATE_TTL_MS,
    );
    if (live.length === entries.length) continue;
    changed = true;
    if (live.length === 0) delete owed[peerID];
    else owed[peerID] = live;
  }
  if (changed) save(owed);
}

export function clearOwedGroupStates(): void {
  storage.remove(STORAGE_KEY);
}
