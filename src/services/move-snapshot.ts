// What a transfer carries, how the old phone reads it and how the new one
// installs it.
//
// Every partition and keychain item has an entry below, typed against the panic
// wipe's registry, so a new store does not compile until someone decides
// whether it moves.
//
// The new phone writes in this order, each step read back:
//
//   1. the "receiving" marker, so a crash below is wiped on the next launch
//   2. every partition
//   3. the wallet, under this phone's own file key
//   4. the wallet's secrets
//   5. the identity, last: its presence is what makes a launch treat the phone
//      as set up
//   6. the "committed" marker, then the stores reload
//
// Straight to MMKV, not through store setters: the live stores are empty and
// each setter would persist that emptiness over what arrived.

import { loadIdentity } from "@core/crypto/identity";
import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "@core/crypto/keychain";
import type { MoveSection } from "@core/move/move-bundle";
import { applyLayoutDirection, resolvePreference } from "@i18n";
import { x25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { useBlockedStore } from "@store/blocked-store";
import {
  dropPendingChatPersistence,
  flushChatPersistence,
  useChatStore,
} from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { useGeohashBookmarksStore } from "@store/geohash-bookmarks-store";
import { useGroupStore } from "@store/group-store";
import { getStorage } from "@store/mmkv";
import { useOutboxStore } from "@store/outbox-store";
import { DEVICE_SETTINGS, useSettingsStore } from "@store/settings-store";
import { exportWalletState, importWalletState } from "@store/wallet-store";
import { setMoveMarker } from "./move-marker";
import { MMKV_STORE_IDS } from "./panic-wipe";

type StoreId = (typeof MMKV_STORE_IDS)[number];
type SecretName = keyof typeof KEYCHAIN_ITEMS;

interface MovedPartition {
  // "history": only with the chats. An outbox without its threads would resend
  // messages that appear nowhere.
  carry: "always" | "history";
  edit?: (value: string, history: boolean) => string;
  reload: () => void;
}

// Edits the state inside a zustand-persisted value and leaves anything else.
function editPersisted(
  value: string,
  edit: (state: Record<string, unknown>) => void,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (typeof parsed !== "object" || parsed === null) return value;
  const state = (parsed as { state?: unknown }).state;
  if (typeof state !== "object" || state === null) return value;
  edit(state as Record<string, unknown>);
  return JSON.stringify(parsed);
}

const PARTITIONS: Record<StoreId, MovedPartition | null> = {
  // Rooms and their keys always move; without history their threads are empty.
  "chat-store": {
    carry: "always",
    edit: (value, history) =>
      history
        ? value
        : editPersisted(value, (state) => {
            state.messages = {};
            state.unreadCounts = {};
            state.lastThread = "";
          }),
    reload: () => void useChatStore.persist.rehydrate(),
  },
  "blocked-store": {
    carry: "always",
    reload: () => void useBlockedStore.persist.rehydrate(),
  },
  "outbox-store": {
    carry: "history",
    reload: () => void useOutboxStore.persist.rehydrate(),
  },
  // Verification carries over: the keys checked are the keys that arrive.
  "contacts-store": {
    carry: "always",
    reload: () => void useContactsStore.persist.rehydrate(),
  },
  // Notification history of this phone.
  "activity-store": null,
  "settings-store": {
    carry: "always",
    edit: (value) =>
      editPersisted(value, (state) => {
        for (const key of DEVICE_SETTINGS) delete state[key];
      }),
    reload: () => {
      void useSettingsStore.persist.rehydrate();
      // A direction change applies on the next launch; the shell's notice says so.
      applyLayoutDirection(
        resolvePreference(useSettingsStore.getState().language),
      );
    },
  },
  // Public and gossiped: the mesh brings it back.
  "board-store": null,
  // Private prekeys never leave their phone. The new one publishes a fresh
  // batch, and senders' outboxes retry mail sealed to the old ones.
  "prekey-store": null,
  // Other people's mail; other carriers hold copies.
  "courier-store": null,
  "group-store": {
    carry: "always",
    reload: () => useGroupStore.getState().reload(),
  },
  // Read from disk on every call.
  "group-invite-outbox": { carry: "always", reload: () => undefined },
  "geohash-bookmarks-store": {
    carry: "always",
    reload: () => void useGeohashBookmarksStore.persist.rehydrate(),
  },
  // A cache, rebuilt on demand.
  "place-names-store": null,
  // Cooldowns on this phone's clock.
  "ring-store": null,
  // This phone's own progress.
  "move-marker": null,
};

const SECRETS: Record<SecretName, "move" | "regenerate"> = {
  identity: "move",
  // Protects a file that stays behind.
  walletEncryptionKey: "regenerate",
  // Nutzaps already locked to it, and kind 10019 still names it.
  walletP2pkKey: "move",
  walletRecoveryPhrase: "move",
};

const PARTITION_PREFIX = "mmkv:";
const SECRET_PREFIX = "secret:";
const WALLET_SECTION = "wallet";
const IDENTITY_SECTION = `${SECRET_PREFIX}identity`;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function movedPartitions(): [StoreId, MovedPartition][] {
  return (
    Object.entries(PARTITIONS) as [StoreId, MovedPartition | null][]
  ).filter((entry): entry is [StoreId, MovedPartition] => entry[1] !== null);
}

function movedSecrets(): SecretName[] {
  return (Object.keys(SECRETS) as SecretName[]).filter(
    (name) => SECRETS[name] === "move",
  );
}

// The section names a receiver accepts.
export function isKnownSection(name: string): boolean {
  if (name === WALLET_SECTION) return true;
  // Own keys only: "constructor" is a valid section name and `in` would find it.
  const own = (table: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(table, key);
  if (name.startsWith(PARTITION_PREFIX)) {
    const id = name.slice(PARTITION_PREFIX.length);
    return own(PARTITIONS, id) && PARTITIONS[id as StoreId] !== null;
  }
  if (name.startsWith(SECRET_PREFIX)) {
    const secret = name.slice(SECRET_PREFIX.length);
    return own(SECRETS, secret) && SECRETS[secret as SecretName] === "move";
  }
  return false;
}

// ---- Old phone ----

// Read after the mesh has stopped, so nothing lands in a store halfway through.
export async function snapshotForMove(
  history: boolean,
): Promise<MoveSection[]> {
  flushChatPersistence();
  const sections: MoveSection[] = [];

  for (const [id, policy] of movedPartitions()) {
    if (policy.carry === "history" && !history) continue;
    const storage = getStorage(id);
    const entries: Record<string, string> = {};
    for (const key of storage.getAllKeys()) {
      const value = storage.getString(key);
      if (value === undefined) continue;
      entries[key] = policy.edit ? policy.edit(value, history) : value;
    }
    if (Object.keys(entries).length === 0) continue;
    sections.push({
      name: PARTITION_PREFIX + id,
      data: utf8.encode(JSON.stringify(entries)),
    });
  }

  const wallet = await exportWalletState();
  if (wallet !== null) {
    sections.push({ name: WALLET_SECTION, data: utf8.encode(wallet) });
  }

  // The identity is required, and goes last.
  for (const name of movedSecrets()) {
    if (name === "identity") continue;
    const value = await readSecret(KEYCHAIN_ITEMS[name]);
    if (value !== null) {
      sections.push({ name: SECRET_PREFIX + name, data: utf8.encode(value) });
    }
  }
  const identity = await readSecret(KEYCHAIN_ITEMS.identity);
  if (identity === null) throw new Error("move-snapshot-no-identity");
  sections.push({ name: IDENTITY_SECTION, data: utf8.encode(identity) });
  return sections;
}

// ---- New phone ----

export type ApplyFailure = "invalid" | "storage";

export class MoveApplyError extends Error {
  constructor(readonly failure: ApplyFailure) {
    super(`move-apply-${failure}`);
  }
}

// The Noise public key the bundle's identity derives, or null if unparseable.
function identityNoiseKey(raw: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(raw) as { noisePrivHex?: unknown };
    if (typeof parsed.noisePrivHex !== "string") return null;
    const priv = hexToBytes(parsed.noisePrivHex);
    return priv.length === 32 ? x25519.getPublicKey(priv) : null;
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function parseEntries(data: Uint8Array): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(fromUtf8.decode(data));
    if (typeof parsed !== "object" || parsed === null) return null;
    const entries = parsed as Record<string, unknown>;
    for (const value of Object.values(entries)) {
      if (typeof value !== "string") return null;
    }
    return entries as Record<string, string>;
  } catch {
    return null;
  }
}

async function writeAndVerify(
  item: (typeof KEYCHAIN_ITEMS)[SecretName],
  value: string,
): Promise<void> {
  await writeSecret(item, value);
  if ((await readSecret(item)) !== value) {
    throw new MoveApplyError("storage");
  }
}

// `senderNoiseKey` is the static key the old phone proved in the handshake; the
// identity must be its private half. Throws MoveApplyError, leaving whatever it
// wrote under the "receiving" marker for the caller to wipe.
export async function applyMove(
  sections: Map<string, Uint8Array>,
  senderNoiseKey: Uint8Array,
): Promise<string> {
  for (const name of sections.keys()) {
    if (!isKnownSection(name)) throw new MoveApplyError("invalid");
  }
  const identityData = sections.get(IDENTITY_SECTION);
  if (identityData === undefined) throw new MoveApplyError("invalid");
  const identityRaw = fromUtf8.decode(identityData);
  const noiseKey = identityNoiseKey(identityRaw);
  if (noiseKey === null || !sameBytes(noiseKey, senderNoiseKey)) {
    throw new MoveApplyError("invalid");
  }
  const partitions: [StoreId, Record<string, string>][] = [];
  for (const [id] of movedPartitions()) {
    const data = sections.get(PARTITION_PREFIX + id);
    if (data === undefined) continue;
    const entries = parseEntries(data);
    if (entries === null) throw new MoveApplyError("invalid");
    partitions.push([id, entries]);
  }

  try {
    setMoveMarker("receiving");
    // A throttled write still in flight would land over what arrives.
    dropPendingChatPersistence();
    for (const [id, entries] of partitions) {
      const storage = getStorage(id);
      storage.clearAll();
      for (const [key, value] of Object.entries(entries)) {
        storage.set(key, value);
      }
      for (const [key, value] of Object.entries(entries)) {
        if (storage.getString(key) !== value) {
          throw new MoveApplyError("storage");
        }
      }
    }

    const wallet = sections.get(WALLET_SECTION);
    if (wallet !== undefined) await importWalletState(fromUtf8.decode(wallet));

    for (const name of movedSecrets()) {
      if (name === "identity") continue;
      const data = sections.get(SECRET_PREFIX + name);
      if (data !== undefined) {
        await writeAndVerify(KEYCHAIN_ITEMS[name], fromUtf8.decode(data));
      }
    }
    await writeAndVerify(KEYCHAIN_ITEMS.identity, identityRaw);
  } catch (error) {
    if (error instanceof MoveApplyError) throw error;
    throw new MoveApplyError("storage");
  }

  const identity = await loadIdentity().catch(() => null);
  if (identity === null || !sameBytes(identity.noiseStaticPubKey, noiseKey)) {
    throw new MoveApplyError("storage");
  }
  setMoveMarker("committed");
  for (const [, policy] of movedPartitions()) policy.reload();
  return identity.peerID;
}
