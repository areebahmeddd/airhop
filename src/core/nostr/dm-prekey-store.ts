// The keys behind forward-secret internet DMs (dm-prekeys.ts): ours, private
// halves in the keychain, and each contact's, public halves in MMKV.
//
// Ours sit in the keychain, as courier prekeys do: forward secrecy rests on a
// deleted key being gone, which MMKV, appending, does not promise. Some
// platforms cap a keychain value near 2 KiB, so the pool is split across
// DM_PREKEY_ITEMS of at most KEYS_PER_ITEM keys each, and bounded:
// MAX_ONE_TIME one-time keys across every contact and at most MAX_LAST_RESORT
// last-resort keys. A one-time key opens once and is deleted as it opens. A
// contact holds at most one batch of unused keys and one of retired ones
// (handed over before their latest batch, kept a grace for mail already sealed
// to them), so no contact crowds out the rest. A key a contact may still seal
// to is never evicted for another's: a contact that finds the pool full is
// handed the last-resort key alone, so no message fails to open for want of
// room. One sealed to a key past its keep is not opened; the recipient answers
// with a fresh batch asking the sender's outbox to seal it again.
//
// Each item, base64, big-endian: nextId u32, then per key: id u32, kind u8,
// private (32), createdAt u64, issuedTo (8 bytes, a peer ID; zero for a
// last-resort key), retiredAt u64 (0 while it is the contact's current batch).

import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getStorage } from "@store/mmkv";
import {
  DM_PREKEY_ITEMS,
  readSecretSync,
  writeSecretSync,
} from "../crypto/keychain";
import { base64ToBytes, bytesToBase64 } from "../encoding/base64";
import {
  DM_PREKEY_LAST_RESORT,
  DM_PREKEY_ONE_TIME,
  DM_PREKEYS_PER_BATCH,
  type DmPrekey,
  type DmPrekeyBatch,
  type DmPrekeyKind,
} from "./dm-prekeys";

const DAY_MS = 24 * 60 * 60 * 1000;

// 19 keys at 61 bytes each, after the 4-byte counter, come to 1,552 base64
// characters, inside the 2 KiB some keychains allow. Four items hold 72
// one-time keys and 3 last-resort keys: a batch each for 24 contacts.
const KEYS_PER_ITEM = 19;
const MAX_ONE_TIME = 72;
const MAX_LAST_RESORT = 3;
// A sender seals to a key for a week after it arrived (one-time) or was made
// (last resort). The message may then wait on relays for the inbox's week,
// and a batch sent over the internet may itself have waited a week, so each
// key is kept past both: a last-resort key 15 days from its making (the most
// a later leak exposes), an unused one-time key 22 days from its issue.
const LAST_RESORT_ROTATE_MS = 7 * DAY_MS;
const LAST_RESORT_KEEP_MS = 15 * DAY_MS;
export const SEAL_LAST_RESORT_MAX_AGE_MS = 7 * DAY_MS;
export const SEAL_ONE_TIME_MAX_AGE_MS = 7 * DAY_MS;
const UNUSED_KEEP_MS = 22 * DAY_MS;
// A one-time key retired by a newer batch to the same contact is kept this
// long for mail already sealed to it.
const RETIRED_GRACE_MS = 2 * DAY_MS;
// A contact is topped up once fewer of their keys than this are unused.
const LOW_WATER = 2;

const RECORD_BYTES = 61;
const NO_PEER = "0000000000000000";

interface LocalKey {
  id: number;
  kind: DmPrekeyKind;
  priv: Uint8Array;
  createdAt: number;
  issuedTo: string;
  // When a newer batch to the same contact retired it; 0 while current.
  retiredAt: number;
}

function readU64(view: DataView, at: number): number {
  return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
}

function writeU64(view: DataView, at: number, value: number): void {
  view.setUint32(at, Math.floor(value / 2 ** 32));
  view.setUint32(at + 4, value % 2 ** 32);
}

function decodeKeys(raw: string): { nextId: number; keys: LocalKey[] } {
  const bytes = base64ToBytes(raw);
  if (bytes.length < 4) return { nextId: 1, keys: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const keys: LocalKey[] = [];
  for (let at = 4; at + RECORD_BYTES <= bytes.length; at += RECORD_BYTES) {
    const kind = bytes[at + 4];
    if (kind !== DM_PREKEY_ONE_TIME && kind !== DM_PREKEY_LAST_RESORT) {
      continue;
    }
    keys.push({
      id: view.getUint32(at),
      kind,
      priv: bytes.slice(at + 5, at + 37),
      createdAt: readU64(view, at + 37),
      issuedTo: bytesToHex(bytes.slice(at + 45, at + 53)),
      retiredAt: readU64(view, at + 53),
    });
  }
  return { nextId: view.getUint32(0), keys };
}

function encodeKeys(nextId: number, keys: LocalKey[]): string {
  const bytes = new Uint8Array(4 + keys.length * RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, nextId);
  keys.forEach((key, i) => {
    const at = 4 + i * RECORD_BYTES;
    view.setUint32(at, key.id);
    bytes[at + 4] = key.kind;
    bytes.set(key.priv, at + 5);
    writeU64(view, at + 37, key.createdAt);
    bytes.set(hexToBytes(key.issuedTo), at + 45);
    writeU64(view, at + 53, key.retiredAt);
  });
  return bytesToBase64(bytes);
}

export class LocalDmPrekeyStore {
  // Null while the keychain cannot be read, as before first unlock on an iOS
  // relaunch. Nothing is issued then: saving would overwrite the keys
  // contacts are sealing to. Reads are retried on every use.
  private keys: LocalKey[] | null = null;
  private nextId = 1;
  // The last batch's issuedAt, so two in one millisecond still rise. The wall
  // clock carries it across a relaunch or a device transfer.
  private lastIssuedAt = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.load();
  }

  // Every item, merged. A key two items both hold (a save one of them did
  // not take) is kept once.
  private load(): LocalKey[] | null {
    if (this.keys !== null) return this.keys;
    const keys = new Map<number, LocalKey>();
    let nextId = 1;
    for (const item of DM_PREKEY_ITEMS) {
      let raw: string | null;
      try {
        raw = readSecretSync(item);
      } catch {
        return null;
      }
      if (raw === null || raw === "") continue;
      try {
        const loaded = decodeKeys(raw);
        nextId = Math.max(nextId, loaded.nextId);
        for (const key of loaded.keys) {
          if (!keys.has(key.id)) keys.set(key.id, key);
        }
      } catch {
        // A damaged item loses only its own keys.
      }
    }
    this.nextId = nextId;
    this.keys = [...keys.values()].sort((a, b) => a.id - b.id);
    if (this.prune(this.keys)) this.save(this.keys);
    return this.keys;
  }

  // False while the keychain cannot be read, so a sealed message is left to be
  // opened later rather than refused.
  readable(): boolean {
    return this.load() !== null;
  }

  // Deletes what has outlived its use. Run on a timer as well as on every use,
  // so a phone no DM reaches still lets keys go when the spec says.
  sweep(): void {
    const keys = this.load();
    if (keys !== null && this.prune(keys)) this.save(keys);
  }

  // False when any write failed. The keys stay in memory and go with the
  // next write; a batch is never handed out on an unsaved state, since a
  // relaunch would lose keys the contact then seals to.
  private save(keys: LocalKey[]): boolean {
    let saved = true;
    DM_PREKEY_ITEMS.forEach((item, i) => {
      const share = keys.slice(i * KEYS_PER_ITEM, (i + 1) * KEYS_PER_ITEM);
      try {
        writeSecretSync(item, encodeKeys(this.nextId, share));
      } catch {
        saved = false;
      }
    });
    return saved;
  }

  private mint(
    keys: LocalKey[],
    kind: DmPrekeyKind,
    issuedTo: string,
  ): LocalKey {
    const key: LocalKey = {
      id: this.nextId,
      kind,
      priv: x25519.utils.randomSecretKey(),
      createdAt: this.now(),
      issuedTo,
      retiredAt: 0,
    };
    this.nextId = (this.nextId % 0xffffffff) + 1;
    keys.push(key);
    return key;
  }

  // Drops what has outlived its use, in place. True when anything went.
  private prune(keys: LocalKey[]): boolean {
    const now = this.now();
    const kept = keys.filter((key) =>
      key.kind === DM_PREKEY_LAST_RESORT
        ? now - key.createdAt < LAST_RESORT_KEEP_MS
        : key.retiredAt > 0
          ? now - key.retiredAt < RETIRED_GRACE_MS
          : now - key.createdAt < UNUSED_KEEP_MS,
    );
    if (kept.length === keys.length) return false;
    keys.splice(0, keys.length, ...kept);
    return true;
  }

  // Retires what `peerID` was handed before, keeping only the newest batch's
  // worth of retired keys: a contact seals to the newest it holds, so older
  // retired keys are the least likely to have mail on its way.
  private retire(keys: LocalKey[], peerID: string): void {
    const now = this.now();
    for (const key of keys) {
      if (key.issuedTo === peerID && key.retiredAt === 0) key.retiredAt = now;
    }
    const retired = keys
      .filter((key) => key.issuedTo === peerID && key.retiredAt > 0)
      .sort((a, b) => b.retiredAt - a.retiredAt || b.id - a.id);
    for (const old of retired.slice(DM_PREKEYS_PER_BATCH)) {
      keys.splice(keys.indexOf(old), 1);
    }
  }

  private oneTimeCount(keys: LocalKey[]): number {
    return keys.filter((key) => key.kind === DM_PREKEY_ONE_TIME).length;
  }

  private currentLastResort(keys: LocalKey[]): LocalKey {
    const newestFirst = (): LocalKey[] =>
      keys
        .filter((key) => key.kind === DM_PREKEY_LAST_RESORT)
        .sort((a, b) => b.createdAt - a.createdAt);
    const newest = newestFirst()[0];
    if (
      newest !== undefined &&
      this.now() - newest.createdAt < LAST_RESORT_ROTATE_MS
    ) {
      return newest;
    }
    const minted = this.mint(keys, DM_PREKEY_LAST_RESORT, NO_PEER);
    for (const old of newestFirst().slice(MAX_LAST_RESORT)) {
      keys.splice(keys.indexOf(old), 1);
    }
    return minted;
  }

  // Whether `peerID` holds fewer keys of ours they would still seal to than a
  // reply needs. A key issued over a week ago counts as gone, since a sender
  // stops sealing to it a week after it arrived.
  needsTopUp(peerID: string): boolean {
    const keys = this.load();
    if (keys === null) return false;
    const now = this.now();
    const fresh = keys.filter(
      (key) =>
        key.kind === DM_PREKEY_ONE_TIME &&
        key.issuedTo === peerID &&
        key.retiredAt === 0 &&
        now - key.createdAt < SEAL_ONE_TIME_MAX_AGE_MS,
    );
    return fresh.length < LOW_WATER;
  }

  // Whether a batch would carry any one-time key.
  hasRoom(): boolean {
    const keys = this.load();
    return keys !== null && this.oneTimeCount(keys) < MAX_ONE_TIME;
  }

  // A fresh batch for `peerID` alone: as many new one-time keys as the pool
  // has room for, and the current last-resort key. It replaces what the peer
  // held, so the keys handed them before are retired. Null while the keychain
  // cannot be read or written.
  issue(peerID: string, resend = false): DmPrekeyBatch | null {
    const keys = this.load();
    if (keys === null) return null;
    this.prune(keys);
    this.retire(keys, peerID);
    const lastResort = this.currentLastResort(keys);
    const oneTime: LocalKey[] = [];
    while (
      oneTime.length < DM_PREKEYS_PER_BATCH &&
      this.oneTimeCount(keys) < MAX_ONE_TIME
    ) {
      oneTime.push(this.mint(keys, DM_PREKEY_ONE_TIME, peerID));
    }
    keys.sort((a, b) => a.id - b.id);
    if (!this.save(keys)) return null;
    const pub = (key: LocalKey): DmPrekey => ({
      id: key.id,
      pub: x25519.getPublicKey(key.priv),
    });
    this.lastIssuedAt = Math.max(this.now(), this.lastIssuedAt + 1);
    return {
      issuedAt: this.lastIssuedAt,
      lastResort: { ...pub(lastResort), createdAt: lastResort.createdAt },
      oneTime: oneTime.map(pub),
      resend,
    };
  }

  // The private half that opens a message sealed to this key, if still held.
  // Nothing is spent until the seal has opened and named its sender (spend):
  // anyone can name a key id.
  find(kind: DmPrekeyKind, id: number): Uint8Array | null {
    const keys = this.load();
    if (keys === null) return null;
    if (this.prune(keys)) this.save(keys);
    return keys.find((k) => k.id === id && k.kind === kind)?.priv ?? null;
  }

  // A message from `peerID` opened under this key. A one-time key opens only
  // for the peer it was handed to, and once: it is deleted here. Another
  // relay's copy of the same gift wrap never reaches this, since the inbox
  // drops a wrap it has opened (ProcessedEvents). A write the keychain refuses
  // stays in memory and goes with the next. False refuses the message.
  spend(kind: DmPrekeyKind, id: number, peerID: string): boolean {
    const keys = this.load();
    if (keys === null) return false;
    const key = keys.find((k) => k.id === id && k.kind === kind);
    if (key === undefined) return false;
    if (kind === DM_PREKEY_LAST_RESORT) return true;
    if (key.issuedTo !== peerID) return false;
    keys.splice(keys.indexOf(key), 1);
    this.save(keys);
    return true;
  }
}

// Each contact's keys, public halves, in the prekey partition the panic wipe
// clears and a device transfer leaves behind. Beside them, the signing key
// their batches were checked against, so one sent over the internet is still
// accepted after a relaunch has forgotten the session that proved it.
const PEER_KEY = "dm-prekeys";
const MAX_PEERS = 200;

interface PeerEntry {
  signingKey: string;
  issuedAt: number;
  lastResort: { id: number; pub: string; createdAt: number };
  oneTime: { id: number; pub: string; receivedAt: number }[];
}

export class PeerDmPrekeyStore {
  private readonly storage = getStorage("prekey-store");
  // Parsed once: read on every send and by every capability check.
  private cache: Record<string, PeerEntry> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  private read(): Record<string, PeerEntry> {
    if (this.cache !== null) return this.cache;
    const raw = this.storage.getString(PEER_KEY);
    try {
      this.cache =
        raw === undefined ? {} : (JSON.parse(raw) as Record<string, PeerEntry>);
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private write(all: Record<string, PeerEntry>): void {
    this.cache = all;
    this.storage.set(PEER_KEY, JSON.stringify(all));
  }

  // A batch from `peerID`, checked against `signingKey`, replaces what was
  // held: it reflects what they hold. One issued no later than the batch held
  // is refused, so a copy that waited on a relay cannot roll them back to keys
  // they have retired. A held batch dated ahead of this phone's clock refuses
  // nothing, so an issuer whose clock once ran far ahead is not shut out once
  // it is set right.
  store(peerID: string, batch: DmPrekeyBatch, signingKey: Uint8Array): boolean {
    const all = this.read();
    const held = all[peerID];
    const now = this.now();
    if (
      held !== undefined &&
      batch.issuedAt <= held.issuedAt &&
      held.issuedAt <= now
    ) {
      return false;
    }
    delete all[peerID];
    all[peerID] = {
      signingKey: bytesToHex(signingKey),
      issuedAt: batch.issuedAt,
      lastResort: {
        id: batch.lastResort.id,
        pub: bytesToHex(batch.lastResort.pub),
        createdAt: batch.lastResort.createdAt,
      },
      oneTime: batch.oneTime.map((key) => ({
        id: key.id,
        pub: bytesToHex(key.pub),
        receivedAt: now,
      })),
    };
    const peers = Object.keys(all);
    for (const old of peers.slice(0, Math.max(0, peers.length - MAX_PEERS))) {
      delete all[old];
    }
    this.write(all);
    return true;
  }

  // The key `peerID`'s batches were last checked against.
  signingKey(peerID: string): Uint8Array | undefined {
    const hex = this.read()[peerID]?.signingKey;
    return hex === undefined ? undefined : hexToBytes(hex);
  }

  // The key the next DM to `peerID` is sealed to: an unused one-time key,
  // spent here, or the last-resort key while fresh. None sends it under the
  // long-term key, and the recipient answers with a batch.
  take(peerID: string): { kind: DmPrekeyKind; key: DmPrekey } | null {
    const all = this.read();
    const entry = all[peerID];
    if (entry === undefined) return null;
    const now = this.now();
    entry.oneTime = entry.oneTime.filter(
      (key) => now - key.receivedAt < SEAL_ONE_TIME_MAX_AGE_MS,
    );
    const next = entry.oneTime.shift();
    this.write(all);
    if (next !== undefined) {
      return {
        kind: DM_PREKEY_ONE_TIME,
        key: { id: next.id, pub: hexToBytes(next.pub) },
      };
    }
    const lastResort = entry.lastResort;
    if (now - lastResort.createdAt >= SEAL_LAST_RESORT_MAX_AGE_MS) return null;
    return {
      kind: DM_PREKEY_LAST_RESORT,
      key: { id: lastResort.id, pub: hexToBytes(lastResort.pub) },
    };
  }

  // Whether `peerID` ever handed over a batch: only Airhop sends one.
  has(peerID: string): boolean {
    return this.read()[peerID] !== undefined;
  }

  // Their identity changed: keys they handed over before are not theirs now.
  forget(peerID: string): void {
    const all = this.read();
    if (all[peerID] === undefined) return;
    delete all[peerID];
    this.write(all);
  }
}
