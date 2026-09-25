// One-time prekey stores for forward-secret asynchronous first contact.
//
// Two halves, mirroring bitchat's LocalPrekeyStore + PrekeyBundleStore:
//
//   LocalPrekeyStore  - our own one-time Curve25519 private prekeys. We publish
//                       their public halves in a signed bundle (0x24); a sender
//                       seals courier mail to one, and we open it with the
//                       matching private key, then consume it. Consumed keys are
//                       kept for a grace window so in-flight envelopes still open
//                       before the key is dropped, giving forward secrecy.
//
//   PeerPrekeyStore   - verified bundles from other peers. When we courier mail
//                       to a peer we hold a bundle for, we assign one of their
//                       unused prekeys and seal to it instead of their long-lived
//                       static key.
//
// The private prekeys live in one keychain item, as bitchat-ios keeps them in
// one Keychain blob. Forward secrecy rests on a dropped key being gone, and
// MMKV appends, so a deleted value lingers in its file until a rewrite. Peer
// bundles are public and stay in MMKV. Both are wiped on panic.

import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getStorage } from "@store/mmkv";
import {
  KEYCHAIN_ITEMS,
  readSecretSync,
  writeSecretSync,
} from "../../crypto/keychain";
import { base64ToBytes, bytesToBase64 } from "../../encoding/base64";
import { ANNOUNCE_MAX_SKEW_MS } from "../discovery/announce-manager";
import {
  PREKEY_MAX_PREKEYS,
  signPrekeyBundle,
  type Prekey,
  type PrekeyBundle,
} from "../wire/prekey-bundle";

// Keep a used prekey's private key this long after consumption so a second
// in-flight envelope sealed to it still opens (bitchat's consumed-grace window).
const CONSUMED_GRACE_MS = 48 * 60 * 60 * 1000;
// At most one batch of consumed keys is kept, whatever their age. Anyone
// holding our public bundle can spend prekeys at will, and every one kept
// grows a keychain value some platforms cap near 2 KiB. bitchat-ios keeps
// every consumed key for the grace window; this cap is Airhop's.
const MAX_CONSUMED = PREKEY_MAX_PREKEYS;
// Cap on stored peer bundles (sender-controlled volume via gossip).
const MAX_PEERS = 200;

// Blob layout, big-endian: nextId u32, generatedAt u64, then one 44-byte
// record per key: id u32, private key (32), consumedAt u64 (0 while unused).
// Public keys are derived on load.
const HEADER_BYTES = 12;
const RECORD_BYTES = 44;

interface LocalPrekey {
  id: number;
  priv: Uint8Array;
  pub: Uint8Array;
}
interface ConsumedPrekey extends LocalPrekey {
  consumedAt: number;
}
interface LocalState {
  nextId: number;
  generatedAt: number;
  prekeys: LocalPrekey[];
  consumed: ConsumedPrekey[];
}

// Where the blob lives. The keychain in the app; a test passes its own.
export interface PrekeySecretSlot {
  // Null when absent; throws when the keychain cannot be read.
  read(): string | null;
  write(value: string): void;
}

const KEYCHAIN_SLOT: PrekeySecretSlot = {
  read: () => readSecretSync(KEYCHAIN_ITEMS.localPrekeys),
  write: (value) => writeSecretSync(KEYCHAIN_ITEMS.localPrekeys, value),
};

function emptyState(): LocalState {
  return { nextId: 1, generatedAt: 0, prekeys: [], consumed: [] };
}

function encodeState(state: LocalState): string {
  const records = [
    ...state.prekeys.map((p) => ({ ...p, consumedAt: 0 })),
    ...state.consumed,
  ];
  const out = new Uint8Array(HEADER_BYTES + records.length * RECORD_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, state.nextId >>> 0, false);
  view.setBigUint64(4, BigInt(state.generatedAt), false);
  records.forEach((r, i) => {
    const off = HEADER_BYTES + i * RECORD_BYTES;
    view.setUint32(off, r.id >>> 0, false);
    out.set(r.priv, off + 4);
    view.setBigUint64(off + 36, BigInt(r.consumedAt), false);
  });
  return bytesToBase64(out);
}

// Null for a blob that does not parse, which is then replaced: keys that
// cannot be read are lost either way.
function decodeState(blob: string): LocalState | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(blob);
  } catch {
    return null;
  }
  if (
    bytes.length < HEADER_BYTES ||
    (bytes.length - HEADER_BYTES) % RECORD_BYTES !== 0
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const state: LocalState = {
    nextId: view.getUint32(0, false),
    generatedAt: Number(view.getBigUint64(4, false)),
    prekeys: [],
    consumed: [],
  };
  for (let off = HEADER_BYTES; off < bytes.length; off += RECORD_BYTES) {
    const priv = bytes.slice(off + 4, off + 36);
    const record = {
      id: view.getUint32(off, false),
      priv,
      pub: x25519.getPublicKey(priv),
    };
    const consumedAt = Number(view.getBigUint64(off + 36, false));
    if (consumedAt === 0) state.prekeys.push(record);
    else state.consumed.push({ ...record, consumedAt });
  }
  return state;
}

export class LocalPrekeyStore {
  // Null while the keychain cannot be read, as before first unlock on an iOS
  // relaunch. The store then holds no prekeys and mints none: minting would
  // overwrite the keys peers are already sealing mail to. Reads are retried
  // on every use.
  private state: LocalState | null = null;
  // Set when a write failed, so the next change tries it again.
  private unsaved = false;

  constructor(private readonly slot: PrekeySecretSlot = KEYCHAIN_SLOT) {
    this.load();
  }

  private load(): LocalState | null {
    if (this.state !== null) return this.state;
    let blob: string | null;
    try {
      blob = this.slot.read();
    } catch {
      return null;
    }
    this.state = (blob === null ? null : decodeState(blob)) ?? emptyState();
    this.ensure();
    return this.state;
  }

  private persist(): void {
    if (this.state === null) return;
    try {
      this.slot.write(encodeState(this.state));
      this.unsaved = false;
    } catch {
      // Kept in memory and retried on the next change; the pool stays usable.
      this.unsaved = true;
    }
  }

  // Ensure the pool holds a full batch of unused prekeys, generating fresh
  // Curve25519 keypairs as needed. Bumps generatedAt when the pool changes so a
  // freshly built bundle supersedes older copies for our noise key.
  private ensure(): void {
    const state = this.state;
    if (state === null) return;
    const pruned = this.pruneConsumed(state);
    let minted = false;
    while (state.prekeys.length < PREKEY_MAX_PREKEYS) {
      const priv = crypto.getRandomValues(new Uint8Array(32));
      state.prekeys.push({
        id: state.nextId,
        priv,
        pub: x25519.getPublicKey(priv),
      });
      state.nextId = (state.nextId + 1) >>> 0 || 1;
      minted = true;
    }
    if (minted) {
      state.generatedAt = Math.max(Date.now(), state.generatedAt + 1);
    }
    if (minted || pruned || this.unsaved) this.persist();
  }

  // A signed bundle over our current unused prekeys, for broadcast/gossip.
  // Null while the keychain is unreadable.
  buildBundle(
    noiseStaticPubKey: Uint8Array,
    signingPrivKey: Uint8Array,
  ): PrekeyBundle | null {
    const state = this.load();
    if (state === null) return null;
    this.ensure();
    const prekeys: Prekey[] = state.prekeys
      .slice(0, PREKEY_MAX_PREKEYS)
      .map((p) => ({ id: p.id, publicKey: p.pub }));
    if (prekeys.length === 0) return null;
    return signPrekeyBundle(
      {
        noiseStaticPublicKey: noiseStaticPubKey,
        prekeys,
        generatedAt: state.generatedAt,
      },
      signingPrivKey,
    );
  }

  // The private key for a prekey id, from the live pool or, inside its grace
  // window, the consumed set.
  privForId(id: number, now: number = Date.now()): Uint8Array | null {
    const state = this.load();
    if (state === null) return null;
    const live = state.prekeys.find((p) => p.id === id);
    if (live !== undefined) return live.priv;
    const spent = state.consumed.find((p) => p.id === id);
    if (spent === undefined || now - spent.consumedAt > CONSUMED_GRACE_MS) {
      return null;
    }
    return spent.priv;
  }

  // Mark a prekey used: move it to the grace window and replenish the pool.
  consume(id: number): void {
    const state = this.load();
    if (state === null) return;
    const idx = state.prekeys.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [used] = state.prekeys.splice(idx, 1);
    state.consumed.push({ ...used, consumedAt: Date.now() });
    this.pruneConsumed(state);
    this.persist();
    this.ensure();
  }

  // Drop consumed keys past their grace, and all but the newest batch.
  private pruneConsumed(state: LocalState): boolean {
    const cutoff = Date.now() - CONSUMED_GRACE_MS;
    const kept = state.consumed
      .filter((p) => p.consumedAt > cutoff)
      .slice(-MAX_CONSUMED);
    const changed = kept.length !== state.consumed.length;
    state.consumed = kept;
    return changed;
  }
}

interface StoredPeerBundle {
  generatedAt: number;
  prekeys: { id: number; pub: string }[]; // pub hex
  usedIds: number[];
  receivedAt: number;
}

export class PeerPrekeyStore {
  private readonly storage;
  private readonly key = "peers";
  private peers: Record<string, StoredPeerBundle>;

  constructor(mmkvId = "prekey-store") {
    this.storage = getStorage(mmkvId);
    this.peers = this.load();
  }

  private load(): Record<string, StoredPeerBundle> {
    const raw = this.storage.getString(this.key);
    if (raw !== undefined) {
      try {
        return JSON.parse(raw) as Record<string, StoredPeerBundle>;
      } catch {
        // fall through
      }
    }
    return {};
  }

  private persist(): void {
    this.storage.set(this.key, JSON.stringify(this.peers));
  }

  // Store a (caller-verified) bundle, replacing an older one for the same noise
  // key. A newer bundle resets the used-id set: its prekeys are fresh.
  //
  // One dated past the announce skew is refused, since "newer" is judged by
  // that date: a bundle stamped years ahead would shut out every genuine one
  // after it, and it is persisted. bitchat-ios has no future bound here.
  ingest(bundle: PrekeyBundle, now: number = Date.now()): void {
    if (bundle.generatedAt > now + ANNOUNCE_MAX_SKEW_MS) return;
    const noiseHex = bytesToHex(bundle.noiseStaticPublicKey);
    const existing = this.peers[noiseHex];
    if (existing !== undefined && bundle.generatedAt <= existing.generatedAt) {
      return; // not newer
    }
    this.peers[noiseHex] = {
      generatedAt: bundle.generatedAt,
      prekeys: bundle.prekeys.map((p) => ({
        id: p.id,
        pub: bytesToHex(p.publicKey),
      })),
      usedIds: [],
      receivedAt: Date.now(),
    };
    this.enforceCap();
    this.persist();
  }

  // Assign an unused prekey for sealing to this peer, marking it used so a
  // later message picks a different one. Null when we hold no fresh prekey.
  assign(
    noiseStaticPubKey: Uint8Array,
  ): { id: number; publicKey: Uint8Array } | null {
    const noiseHex = bytesToHex(noiseStaticPubKey);
    const peer = this.peers[noiseHex];
    if (peer === undefined) return null;
    const used = new Set(peer.usedIds);
    const next = peer.prekeys.find((p) => !used.has(p.id));
    if (next === undefined) return null;
    peer.usedIds.push(next.id);
    this.persist();
    return { id: next.id, publicKey: hexToBytes(next.pub) };
  }

  has(noiseStaticPubKey: Uint8Array): boolean {
    return this.peers[bytesToHex(noiseStaticPubKey)] !== undefined;
  }

  // Drop what we hold for one peer, when it was checked against a signing key
  // that turned out not to be theirs.
  forget(noiseStaticPubKey: Uint8Array): void {
    const noiseHex = bytesToHex(noiseStaticPubKey);
    if (this.peers[noiseHex] === undefined) return;
    delete this.peers[noiseHex];
    this.persist();
  }

  private enforceCap(): void {
    const entries = Object.entries(this.peers);
    if (entries.length <= MAX_PEERS) return;
    entries
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt)
      .slice(0, entries.length - MAX_PEERS)
      .forEach(([k]) => delete this.peers[k]);
  }

  clearAll(): void {
    this.peers = {};
    this.storage.remove(this.key);
  }
}
