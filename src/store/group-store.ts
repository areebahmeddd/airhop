// Private groups this device belongs to: metadata, roster, and the current
// epoch's symmetric key. Persisted to MMKV (wiped on panic, since the epoch key
// decrypts every group message). The chat itself lives in chat-store under the
// virtual channel `group:<groupID hex>`.
//
// State arrives two ways: our own groups (we are the creator) via upsertLocal,
// and groups we are invited to via a creator-signed GroupStatePayload the caller
// has already verified. An invite waits in `invites` until the user joins
// (acceptInvite) or declines it, so nobody can put us in a group unasked. A
// newer epoch replaces an older one.

import {
  type BitchatGroup,
  type GroupMember,
  type GroupStatePayload,
} from "@core/mesh/rooms/group-protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { create } from "zustand";
import { getStorage } from "./mmkv";

interface StoredMember {
  fingerprint: string;
  signingKey: string; // hex
  nickname: string;
}
export interface StoredGroup {
  groupID: string; // hex
  name: string;
  epoch: number;
  members: StoredMember[];
  creatorFingerprint: string;
  key: string; // hex epoch key
}

interface StoredInvite extends StoredGroup {
  receivedAtMs: number;
}

export interface RuntimeGroup {
  groupID: Uint8Array;
  name: string;
  epoch: number;
  members: GroupMember[];
  creatorFingerprint: string;
  key: Uint8Array;
}

interface GroupState {
  groups: StoredGroup[];
  // Groups the user left. The creator is never told, so its next key rotation
  // would otherwise bring the group back as "you were added".
  left: string[];
  invites: StoredInvite[];
  upsertLocal: (group: BitchatGroup, key: Uint8Array) => void;
  upsertFromState: (payload: GroupStatePayload) => void;
  // Holds a verified state as an invite, or updates the one held. Null when
  // refused (another creator, or an older epoch); otherwise the invites the
  // cap pushed out, whose rows the caller removes.
  addInvite: (payload: GroupStatePayload) => string[] | null;
  invite: (groupIDHex: string) => RuntimeGroup | undefined;
  acceptInvite: (groupIDHex: string) => boolean;
  get: (groupIDHex: string) => RuntimeGroup | undefined;
  getByID: (groupID: Uint8Array) => RuntimeGroup | undefined;
  nameForChannel: (channel: string) => string | undefined;
  remove: (groupIDHex: string) => void;
  leave: (groupIDHex: string) => void;
  hasLeft: (groupIDHex: string) => boolean;
  // Re-reads disk after a transfer wrote underneath the store.
  reload: () => void;
  clearAll: () => void;
}

const STORAGE_ID = "group-store";
const STORAGE_KEY = "groups";
const LEFT_KEY = "left";
const INVITES_KEY = "invites";
// Newest kept. Anyone who completes a handshake can invite us, so the list is
// bounded however many arrive.
const MAX_INVITES = 20;
const storage = getStorage(STORAGE_ID);

function toStoredMember(m: GroupMember): StoredMember {
  return {
    fingerprint: m.fingerprint,
    signingKey: bytesToHex(m.signingKey),
    nickname: m.nickname,
  };
}

function toStored(group: BitchatGroup, key: Uint8Array): StoredGroup {
  return {
    groupID: bytesToHex(group.groupID),
    name: group.name,
    epoch: group.epoch,
    members: group.members.map(toStoredMember),
    creatorFingerprint: group.creatorFingerprint,
    key: bytesToHex(key),
  };
}

function toRuntime(g: StoredGroup): RuntimeGroup {
  return {
    groupID: hexToBytes(g.groupID),
    name: g.name,
    epoch: g.epoch,
    members: g.members.map((m) => ({
      fingerprint: m.fingerprint,
      signingKey: hexToBytes(m.signingKey),
      nickname: m.nickname,
    })),
    creatorFingerprint: g.creatorFingerprint,
    key: hexToBytes(g.key),
  };
}

function loadLeft(): string[] {
  const raw = storage.getString(LEFT_KEY);
  if (raw === undefined) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function loadInvites(): StoredInvite[] {
  const raw = storage.getString(INVITES_KEY);
  if (raw === undefined) return [];
  try {
    return (JSON.parse(raw) as StoredInvite[]).filter(
      (i) => creatorKeyOf(i) !== undefined,
    );
  } catch {
    return [];
  }
}

function stateToStored(payload: GroupStatePayload): StoredGroup {
  return toStored(
    {
      groupID: payload.groupID,
      name: payload.name,
      epoch: payload.epoch,
      members: payload.members,
      creatorFingerprint: payload.creatorFingerprint,
    },
    payload.key,
  );
}

// Whether `entry` may replace `existing`: the same creator under the same key,
// at an epoch no older.
function supersedes(entry: StoredGroup, existing: StoredGroup): boolean {
  return (
    entry.epoch >= existing.epoch &&
    entry.creatorFingerprint === existing.creatorFingerprint &&
    creatorKeyOf(entry) === creatorKeyOf(existing)
  );
}

function creatorKeyOf(g: StoredGroup): string | undefined {
  return g.members.find((m) => m.fingerprint === g.creatorFingerprint)
    ?.signingKey;
}

// What was written is re-checked on the way back in, since it is the one input
// put() never saw: one entry per group, the newest epoch, and a creator who is
// in its own roster.
function load(): StoredGroup[] {
  const raw = storage.getString(STORAGE_KEY);
  if (raw === undefined) return [];
  let parsed: StoredGroup[];
  try {
    parsed = JSON.parse(raw) as StoredGroup[];
  } catch {
    return [];
  }
  const byID = new Map<string, StoredGroup>();
  for (const g of parsed) {
    if (creatorKeyOf(g) === undefined) continue;
    const kept = byID.get(g.groupID);
    if (kept === undefined || g.epoch > kept.epoch) byID.set(g.groupID, g);
  }
  return [...byID.values()];
}

export const useGroupStore = create<GroupState>((set, get) => {
  function persist(groups: StoredGroup[]): void {
    if (groups.length === 0) storage.remove(STORAGE_KEY);
    else storage.set(STORAGE_KEY, JSON.stringify(groups));
  }

  function put(entry: StoredGroup): void {
    set((state) => {
      const existing = state.groups.find((g) => g.groupID === entry.groupID);
      // An older epoch is ignored: the newest key and roster win. And a group
      // keeps the creator it was created with.
      //
      // The epoch guard above orders updates but says nothing about who is
      // allowed to make them, and the caller only checks that a state is signed
      // by the creator it names, which an attacker satisfies by naming
      // themselves. groupID and epoch travel in cleartext in every group
      // message, so both are free to read off the air: anyone could send a
      // self-signed state for a known groupID at a higher epoch and replace the
      // key, the roster and the creator in one step. Members would then encrypt
      // to a key the attacker holds, while the real group silently stopped
      // seeing them.
      //
      // Pinning here rather than at the call site because this is the last
      // point every path goes through, local and remote alike.
      if (existing !== undefined && !supersedes(entry, existing)) return state;
      const groups = [
        ...state.groups.filter((g) => g.groupID !== entry.groupID),
        entry,
      ];
      persist(groups);
      return { groups };
    });
  }

  function persistLeft(left: string[]): void {
    if (left.length === 0) storage.remove(LEFT_KEY);
    else storage.set(LEFT_KEY, JSON.stringify(left));
  }

  function setInvites(invites: StoredInvite[]): void {
    if (invites.length === 0) storage.remove(INVITES_KEY);
    else storage.set(INVITES_KEY, JSON.stringify(invites));
    set({ invites });
  }

  function forgetLeft(groupIDHex: string): void {
    if (!get().hasLeft(groupIDHex)) return;
    const left = get().left.filter((id) => id !== groupIDHex);
    persistLeft(left);
    set({ left });
  }

  return {
    groups: load(),
    left: loadLeft(),
    invites: loadInvites(),

    upsertLocal(group, key) {
      put(toStored(group, key));
    },

    // An accepted state is the creator adding us, including back into a group
    // we once left.
    upsertFromState(payload) {
      forgetLeft(bytesToHex(payload.groupID));
      put(stateToStored(payload));
    },

    addInvite(payload) {
      const entry = stateToStored(payload);
      const existing = get().invites.find((i) => i.groupID === entry.groupID);
      if (existing !== undefined && !supersedes(entry, existing)) return null;
      const all = [
        ...get().invites.filter((i) => i.groupID !== entry.groupID),
        { ...entry, receivedAtMs: existing?.receivedAtMs ?? Date.now() },
      ];
      setInvites(all.slice(-MAX_INVITES));
      return all.slice(0, -MAX_INVITES).map((i) => i.groupID);
    },

    invite(groupIDHex) {
      const i = get().invites.find((x) => x.groupID === groupIDHex);
      return i !== undefined ? toRuntime(i) : undefined;
    },

    acceptInvite(groupIDHex) {
      const invite = get().invites.find((i) => i.groupID === groupIDHex);
      if (invite === undefined) return false;
      setInvites(get().invites.filter((i) => i.groupID !== groupIDHex));
      forgetLeft(groupIDHex);
      const { receivedAtMs: _received, ...group } = invite;
      put(group);
      return true;
    },

    get(groupIDHex) {
      const g = get().groups.find((x) => x.groupID === groupIDHex);
      return g !== undefined ? toRuntime(g) : undefined;
    },

    getByID(groupID) {
      return get().get(bytesToHex(groupID));
    },

    nameForChannel(channel) {
      if (!channel.startsWith("group:")) return undefined;
      const id = channel.slice("group:".length);
      return (
        get().groups.find((g) => g.groupID === id)?.name ??
        get().invites.find((i) => i.groupID === id)?.name
      );
    },

    remove(groupIDHex) {
      set((state) => {
        const groups = state.groups.filter((g) => g.groupID !== groupIDHex);
        persist(groups);
        return { groups };
      });
    },

    // Declining an invite is leaving too, so the creator's next rotation does
    // not ask again.
    leave(groupIDHex) {
      get().remove(groupIDHex);
      if (get().invites.some((i) => i.groupID === groupIDHex)) {
        setInvites(get().invites.filter((i) => i.groupID !== groupIDHex));
      }
      if (get().hasLeft(groupIDHex)) return;
      const left = [...get().left, groupIDHex];
      persistLeft(left);
      set({ left });
    },

    hasLeft(groupIDHex) {
      return get().left.includes(groupIDHex);
    },

    reload() {
      set({ groups: load(), left: loadLeft(), invites: loadInvites() });
    },

    clearAll() {
      set({ groups: [], left: [], invites: [] });
      storage.remove(STORAGE_KEY);
      storage.remove(LEFT_KEY);
      storage.remove(INVITES_KEY);
    },
  };
});

// The virtual chat channel for a group.
export function groupChannel(groupIDHex: string): string {
  return `group:${groupIDHex}`;
}
