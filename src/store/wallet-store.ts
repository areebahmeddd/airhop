// Local Cashu wallet state: proofs, mints, in-flight sends and history. Proofs
// are bearer value, so the MMKV file is encrypted under a keychain key: AES-256
// in CFB mode, MMKV's own, for confidentiality only. Its CRC detects
// corruption, not tampering, which is accepted: writing the app's files takes
// the same access that reads the keychain. No network here; mint calls live
// in wallet-service.
//
// Keyed by account, a (mint URL, unit) pair: one mint can issue sat, usd and
// eur, and units are never summed. Proofs are in one of three states:
//   spendable + verified    swapped or minted by us; nobody else holds them.
//   spendable + unverified  received offline, or a reclaimed send. DLEQ (when
//                           we hold the keys) proves the mint signed it, never
//                           that the sender has not spent it elsewhere.
//                           Counted in the balance, shown apart, and redeemed
//                           first, one receipt at a time.
//   reserved                serialised into a token for a send not yet
//                           confirmed. Out of the balance so one coin cannot
//                           go to two people.
// Reserving moves, never deletes, and the token string stays on the tx, so a
// crash mid-send can be re-shared or reclaimed.
//
// Secrets derive from the recovery phrase (NUT-13), so a new device can ask the
// mint which of them it signed (NUT-09). `counters` is the per-keyset cursor
// that makes that reproducible. The phrase itself lives in the keychain only.

import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "@core/crypto/keychain";
import { bytesToBase64 } from "@core/encoding/base64";
import { NUTZAP_LOOKBACK_S } from "@core/payments/nutzap";
import { createMMKV, deleteMMKV } from "react-native-mmkv";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// ---- Constants ----

export const WALLET_STORAGE_ID = "wallet-store";
// Predates the naming convention (ARCHITECTURE.md) and stays as it is.
const WALLET_PERSIST_NAME = "wallet-state";

const ENCRYPTION_KEY_ITEM = KEYCHAIN_ITEMS.walletEncryptionKey;

// MMKV caps keys at 32 bytes: 24 random bytes is exactly 32 base64 characters.
const ENCRYPTION_KEY_BYTES = 24;

// Mint URLs cannot contain it.
const ACCOUNT_SEP = "|";

// ---- Types ----

export interface SerializedDleq {
  e: string;
  s: string;
  r?: string;
}

// `amount` is a plain number in the account's unit (`Amount` is not JSON).
export interface StoredProof {
  id: string; // Keyset ID
  amount: number;
  secret: string;
  C: string; // Unblinded signature from the mint
  dleq?: SerializedDleq; // NUT-12 discrete-log-equality witness, when present
  witness?: string; // NUT-11 P2PK / NUT-14 HTLC witness, when present
  // True only for outputs the mint signed for us (a swap, mint or melt): the
  // sender holds no copy. A state check is not enough; NUT-07 calls a coin it
  // has never seen unspent.
  verified?: boolean;
  // Secret derived from the recovery phrase, so restorable. Received proofs
  // carry the sender's secrets until swapped.
  derived?: boolean;
  receivedAtMs?: number;
  // Unverified only: the transaction that brought the coin in (an offline
  // receive, or a reclaimed send). A refresh swaps each receipt on its own,
  // so a mint refusing one token's coins cannot block the others.
  receiptTxId?: string;
}

export type TxKind =
  | "send" // outgoing ecash token (BLE, QR, share sheet)
  | "receive" // incoming ecash token
  | "mint" // Lightning deposit (bolt11 invoice paid to the mint)
  | "melt" // Lightning withdrawal (mint pays an invoice out)
  | "swap" // refresh/consolidate at the mint, no net value change
  | "nutzap-out" // NIP-61 outgoing
  | "nutzap-in"; // NIP-61 incoming

export type TxStatus =
  | "pending" // reserved/awaiting the mint or the recipient
  | "completed"
  | "failed"
  | "reclaimed" // a pending send the user pulled back into the balance
  | "expired"; // a mint quote that ran out before it was paid

export interface WalletTx {
  id: string;
  kind: TxKind;
  status: TxStatus;
  // Face value moved, always positive. Direction comes from `kind`.
  amount: number;
  // Mint fee paid on top (NUT-02 input fees, or a melt fee reserve).
  fee?: number;
  unit: string;
  mintUrl: string;
  createdAtMs: number;
  updatedAtMs: number;
  memo?: string;
  // Peer ID, npub, or mint host, depending on `kind`.
  counterparty?: string;
  // A pending send's token, to re-share or reclaim after a restart.
  token?: string;
  quoteId?: string;
  invoice?: string;
  // The three below hold blinding factors, which otherwise live only in memory
  // for the call. Written BEFORE the request and cleared once credited, so
  // `reconcile` can rebuild coins whose response was lost.
  // Melt: NUT-08 blanks for the unused routing reserve, returned as change.
  meltOutputs?: unknown;
  // Mint: the mint marks the quote ISSUED on its side of /v1/mint, so a lost
  // response leaves paid-for coins only these can rebuild.
  mintOutputs?: unknown;
  // Swap: the one operation with no quote to ask about afterwards; a lost
  // response spends the inputs while the outputs exist nowhere. The stored
  // preview (swap-preview.ts) is replayed (NUT-19 returns the same signatures)
  // or, failing that, restored (NUT-09).
  swapPreview?: unknown;
  // Nutzap only: lets a late replayed swap mark the zap redeemed, and stops a
  // second redemption of one already in flight.
  nutzapEventId?: string;
  // Swap only: proofs the mint reported spent were dropped. The one swap whose
  // value really left.
  spentRemoved?: boolean;
  // Shown verbatim on `failed`.
  error?: string;
}

// A trusted mint plus what we cache to stay useful offline.
export interface StoredMint {
  url: string;
  addedAtMs: number;
  name?: string;
  description?: string;
  units?: string[];
  supportedNuts?: number[];
  // cashu-ts `keyChain.cache`, verbatim. Public keys only, so not secret, but
  // it is what makes offline DLEQ verification possible.
  keysetCache?: unknown;
  keysetCacheAtMs?: number;
  // Raw `/v1/info`, for `loadMintFromCache` on an offline cold start.
  infoResponse?: unknown;
  // NUT-02 input fee, parts per thousand, for offline fee maths.
  feePpkByKeysetId?: Record<string, number>;
  lastSeenMs?: number;
}

export interface AccountBalance {
  key: string;
  mintUrl: string;
  unit: string;
  // Spendable, verified and unverified.
  balance: number;
  unverified: number;
  // What the phrase cannot rebuild (secrets not derived from it). Zero until
  // the user has accepted the phrase, since a "mostly covered" split would
  // promise a safety net that only written-down words deliver.
  unbacked: number;
  reserved: number;
  proofCount: number;
}

interface WalletState {
  // Spendable, keyed by `accountKey`.
  proofs: Record<string, StoredProof[]>;
  // Keyed by txId.
  reserved: Record<string, { account: string; proofs: StoredProof[] }>;
  mints: Record<string, StoredMint>;
  // Newest first, capped at MAX_HISTORY.
  history: WalletTx[];
  // 33-byte compressed P2PK key for kind 10019; private half in the keychain.
  nutzapPubkey?: string;
  // Kind 9321 events already dealt with (redeemed, or refused for good), so a
  // relay replay neither credits twice nor costs another mint request.
  // `createdAt` (event seconds, never later than when it was seen) is how long
  // one is kept: past the subscription's lookback no relay is asked for it.
  settledNutzaps: { id: string; createdAt: number }[];
  // First secret of each token taken in, so a chat card reads "Claimed".
  // Display only: `addProofs` is the spend guard.
  claimedTokens: string[];

  // The user has seen the phrase. A phrase is generated with the wallet, so
  // secrets derive regardless; this gates only the claim made to the user.
  backupEnabled: boolean;
  // The user proved they wrote it down. Tracked apart because a phrase never
  // copied out is the worst state: the wallet looks protected and is not.
  backupVerified: boolean;
  // Next NUT-13 counter per keyset. Forward only (a reused counter recreates a
  // secret the mint has seen), persisted before the outputs it covers are sent.
  counters: Record<string, number>;

  // ---- Mints ----
  addMint: (mintUrl: string, patch?: Partial<StoredMint>) => void;
  updateMint: (mintUrl: string, patch: Partial<StoredMint>) => void;
  removeMint: (mintUrl: string) => void;

  // ---- Proofs ----
  addProofs: (
    mintUrl: string,
    unit: string,
    proofs: StoredProof[],
  ) => { added: number; duplicates: number };
  removeProofs: (mintUrl: string, unit: string, secrets: string[]) => void;
  replaceProofs: (mintUrl: string, unit: string, proofs: StoredProof[]) => void;
  // For coins someone else may also hold, such as a reclaimed token: the next
  // refresh swaps them, as receipt `receiptTxId`, which makes them ours alone.
  markUnverified: (
    mintUrl: string,
    unit: string,
    secrets: string[],
    receiptTxId: string,
  ) => void;
  // On phrase replacement: old coins stay spendable but the new phrase cannot
  // rebuild them, so they read as uncovered until a refresh re-issues them.
  clearDerived: () => void;

  // ---- Reservations ----
  // False, changing nothing, if any proof is already taken: the only guard
  // against two concurrent sends putting one coin in two tokens.
  reserveProofs: (
    txId: string,
    mintUrl: string,
    unit: string,
    proofs: StoredProof[],
  ) => boolean;
  // Send never landed.
  releaseReserved: (txId: string) => StoredProof[] | null;
  // Recipient confirmed, or mint says spent.
  dropReserved: (txId: string) => void;

  // ---- History ----
  addTx: (tx: WalletTx) => void;
  updateTx: (id: string, patch: Partial<WalletTx>) => void;

  // ---- Nutzap ----
  setNutzapPubkey: (pubkey: string) => void;
  markNutzapSettled: (eventId: string, createdAt: number) => void;
  // A nutzap row the mint refused outright: nothing moved, and spam must not
  // fill Activity or push real history out.
  removeTx: (id: string) => void;
  markTokenClaimed: (firstSecret: string) => void;

  // ---- Backup / NUT-13 counters ----
  setBackupEnabled: (enabled: boolean) => void;
  setBackupVerified: (verified: boolean) => void;
  // Synchronous read-modify-write with no await, so concurrent callers never
  // share a range.
  reserveCounters: (
    keysetId: string,
    n: number,
  ) => { start: number; count: number };
  // Never moves back: a lower value re-issues counters behind live proofs.
  advanceCounter: (keysetId: string, minNext: number) => void;

  // ---- Wipe ----
  clearAccount: (mintUrl: string, unit: string) => void;
  clearAll: () => void;
}

// MMKV holds the whole blob in memory on read.
const MAX_HISTORY = 500;

// Oldest settled rows go first. Pinned, whatever their age: pending rows (how
// `reconcile` finds a deposit to claim or a send to settle), rows a reservation
// is keyed by, and rows holding swap, melt or mint outputs (the only way back to
// coins whose response went missing). Dropping one loses the money with it.
function capHistory(
  history: WalletTx[],
  reserved: Record<string, unknown>,
): WalletTx[] {
  if (history.length <= MAX_HISTORY) return history;
  const pinned = (tx: WalletTx): boolean =>
    tx.status === "pending" ||
    reserved[tx.id] !== undefined ||
    tx.swapPreview !== undefined ||
    tx.meltOutputs !== undefined ||
    tx.mintOutputs !== undefined;
  let room = MAX_HISTORY - history.filter(pinned).length;
  return history.filter((tx) => {
    if (pinned(tx)) return true;
    if (room <= 0) return false;
    room -= 1;
    return true;
  });
}

// Cosmetic: an evicted marker just lets a very old card offer Claim again.
const MAX_CLAIMED_TOKENS = 1000;

// ---- Account keys ----

// So `https://m.example.com/` and `https://m.example.com` are one mint.
// Lowercases the host (RFC 3986) but not the path, which is case-sensitive.
export function normalizeMintUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    url.search = "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function accountKey(mintUrl: string, unit: string): string {
  return `${normalizeMintUrl(mintUrl)}${ACCOUNT_SEP}${unit}`;
}

export function parseAccountKey(key: string): {
  mintUrl: string;
  unit: string;
} {
  const idx = key.lastIndexOf(ACCOUNT_SEP);
  if (idx < 0) return { mintUrl: key, unit: "sat" };
  return { mintUrl: key.slice(0, idx), unit: key.slice(idx + 1) };
}

function setUnverified(
  state: WalletState,
  mintUrl: string,
  unit: string,
  secrets: string[],
  receiptTxId: string,
): Partial<WalletState> {
  const key = accountKey(mintUrl, unit);
  const existing = state.proofs[key];
  if (!existing) return state;
  const mark = new Set(secrets);
  return {
    proofs: {
      ...state.proofs,
      [key]: existing.map((p) =>
        mark.has(p.secret) ? { ...p, verified: false, receiptTxId } : p,
      ),
    },
  };
}

// ---- Encrypted storage bootstrap ----

// MMKV needs its key at construction and the keychain is async, so the instance
// cannot exist at module scope. Persist goes through an async adapter gated on
// `ready`, invisible to callers apart from hydration readiness below.

type MMKVLike = ReturnType<typeof createMMKV>;

let instance: MMKVLike | null = null;
let ready: Promise<MMKVLike> | null = null;
// Never reset. MMKV hands every later open the instance it first created, with
// the key it was first opened under; a reopen after a wipe must re-key it.
let openedThisProcess = false;
// Bumped on reset, so a bootstrap straddling a wipe cannot install its handle.
let storageGeneration = 0;

function randomKey(): string {
  return bytesToBase64(
    crypto.getRandomValues(new Uint8Array(ENCRYPTION_KEY_BYTES)),
  );
}

async function loadOrCreateEncryptionKey(): Promise<string> {
  const existing = await readSecret(ENCRYPTION_KEY_ITEM);
  if (typeof existing === "string" && existing.length > 0) return existing;
  const fresh = randomKey();
  await writeSecret(ENCRYPTION_KEY_ITEM, fresh);
  return fresh;
}

// Idempotent: later calls await the first.
export function bootstrapWalletStorage(): Promise<MMKVLike> {
  ready ??= (async () => {
    const generation = storageGeneration;
    let encryptionKey: string | undefined;
    try {
      encryptionKey = await loadOrCreateEncryptionKey();
    } catch {
      // Locked device, simulator, missing native module. Never fall back to
      // plaintext, which would silently downgrade bearer tokens: the store
      // stays empty and the wallet shows as locked.
      encryptionKey = undefined;
    }
    if (encryptionKey === undefined) {
      throw new Error("wallet-keystore-unavailable");
    }
    if (generation !== storageGeneration) {
      throw new Error("wallet-storage-reset");
    }
    const mmkv = createMMKV({
      id: WALLET_STORAGE_ID,
      encryptionKey,
      encryptionType: "AES-256",
    });
    // A no-op when the keys already agree.
    if (openedThisProcess) mmkv.encrypt(encryptionKey, "AES-256");
    openedThisProcess = true;
    instance = mmkv;
    return mmkv;
  })();
  return ready;
}

// Panic wipe. Empties an open partition rather than `deleteMMKV`: that frees
// the native instance while the async adapter may still hold a write (the
// store's own clearAll schedules one), which then locks a null mutex, a SIGSEGV
// no JS catch can see. References are dropped first so no new write finds a
// handle, then the data is cleared through the one already open. The AES key
// dies with the keychain, so what stays on disk is unreadable. `deleteMMKV` is
// still right when nothing opened the partition: no handle, no race.
export function wipeWalletStorage(): void {
  const open = instance;
  resetWalletStorage();
  if (open === null) {
    try {
      deleteMMKV(WALLET_STORAGE_ID);
    } catch {
      // Never opened on this device, or already gone.
    }
    return;
  }
  try {
    open.clearAll();
  } catch {
    // Its key is gone either way, so what stays on disk is unreadable.
  }
}

// Forget the open partition so the next bootstrap opens a real one. Otherwise
// readiness keeps answering true (an empty balance shown as real), a later
// write through the stale handle recreates the file under an AES key whose
// keychain copy is gone, and re-onboarding in-process writes the new identity's
// proofs under that dead key. Does not close the handle: a close racing an
// in-flight persist would crash.
export function resetWalletStorage(): void {
  storageGeneration += 1;
  instance = null;
  ready = null;
  hydrated = false;
  hydrationSettled = false;
  // Run the waiters, not drop them, so their promises and timers settle.
  for (const waiter of hydrationWaiters.splice(0)) waiter();
}

// Opening the file is step one; zustand then reads it asynchronously and
// overwrites the store, discarding any write made before it lands (a nutzap
// credited one tick early would be erased, a balance check would say empty).
// So money paths gate on this, not just on `instance`. False on failure (an
// unreadable keychain, a corrupt file), so the wallet reads as locked, not empty.
let hydrated = false;
let hydrationSettled = false;
const hydrationWaiters: (() => void)[] = [];
// The generation the latest hydration read. zustand hydrates once, at store
// creation, so without `rehydrateAfterReset` comparing this, re-onboarding after
// a wipe would wait out the timeout and stay locked until a relaunch.
let hydrationGeneration = 0;

// Only for a read that never settles, so it cannot hang startup.
const HYDRATION_TIMEOUT_MS = 15_000;

// From `onRehydrateStorage`, on success and failure. `onFinishHydration` never
// fires on failure (zustand leaves `hasHydrated` false and skips its finish
// listeners), so waiting on it would deadlock.
function settleHydration(ok: boolean): void {
  if (hydrationSettled) return;
  hydrated = ok;
  hydrationSettled = true;
  for (const waiter of hydrationWaiters.splice(0)) waiter();
}

// Everything that spends, credits or reports a balance gates on this.
export function isWalletStorageReady(): boolean {
  return instance !== null && hydrated;
}

// No-op unless the partition was reset since the last read.
export function rehydrateAfterReset(): void {
  if (hydrationGeneration === storageGeneration) return;
  // A timed-out waiter may have settled this generation as failed.
  hydrated = false;
  hydrationSettled = false;
  void useWalletStore.persist.rehydrate();
}

// Settles on success or failure: re-check `isWalletStorageReady()` after.
export function whenWalletHydrated(): Promise<void> {
  if (hydrationSettled) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleHydration(false);
    }, HYDRATION_TIMEOUT_MS);
    hydrationWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Writes never open the partition. Opening mints an AES key when the keychain
// has none, and after a wipe it has none: an operation still in flight (a melt
// can hold a request open for minutes) would persist the destroyed wallet into
// a fresh file under a fresh key. Only hydration and `initWalletService` open
// it. A write racing a bootstrap waits, then checks the handle is still the
// current one, honouring a reset in between.
async function openHandle(): Promise<MMKVLike | null> {
  if (instance !== null) return instance;
  const pending = ready;
  if (pending === null) return null;
  let mmkv: MMKVLike;
  try {
    mmkv = await pending;
  } catch {
    return null;
  }
  return instance === mmkv ? mmkv : null;
}

const asyncMMKVStorage = {
  async getItem(name: string): Promise<string | null> {
    const mmkv = await bootstrapWalletStorage();
    return mmkv.getString(name) ?? null;
  },
  async setItem(name: string, value: string): Promise<void> {
    const mmkv = await openHandle();
    mmkv?.set(name, value);
  },
  async removeItem(name: string): Promise<void> {
    const mmkv = await openHandle();
    mmkv?.remove(name);
  },
};

// The persisted wallet, decrypted, for a transfer. Throws when locked rather
// than carry an empty wallet. Read after a macrotask, so the async adapter's
// last write has landed.
export async function exportWalletState(): Promise<string | null> {
  const mmkv = await bootstrapWalletStorage();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return mmkv.getString(WALLET_PERSIST_NAME) ?? null;
}

// Installs a transferred wallet under this phone's own file key, read back, then
// rehydrated so the store's launch-time empty state is not written back.
export async function importWalletState(raw: string): Promise<void> {
  const mmkv = await bootstrapWalletStorage();
  mmkv.set(WALLET_PERSIST_NAME, raw);
  if (mmkv.getString(WALLET_PERSIST_NAME) !== raw) {
    throw new Error("wallet-import-readback");
  }
  hydrated = false;
  hydrationSettled = false;
  await useWalletStore.persist.rehydrate();
}

// Through the one handle this module owns; zero while not open.
export function walletStorageByteSize(): number {
  if (instance === null) return 0;
  try {
    return instance.byteSize;
  } catch {
    return 0;
  }
}

// ---- Selectors ----

// Selectors take slices of this: exactly what a component subscribed to.
export type WalletData = Pick<
  WalletState,
  | "proofs"
  | "reserved"
  | "mints"
  | "history"
  | "settledNutzaps"
  | "claimedTokens"
  | "backupEnabled"
  | "backupVerified"
  | "counters"
>;

function sum(proofs: StoredProof[]): number {
  return proofs.reduce((total, p) => total + p.amount, 0);
}

// Coins derive from the phrase from first launch; `unbacked` is reported only
// once `backupEnabled` says the user has seen the words.
export function selectAccounts(
  state: Pick<WalletData, "proofs" | "reserved" | "mints"> &
    Partial<Pick<WalletData, "backupEnabled">>,
): AccountBalance[] {
  const keys = new Set(Object.keys(state.proofs));
  for (const mint of Object.values(state.mints)) {
    for (const unit of mint.units ?? ["sat"])
      keys.add(accountKey(mint.url, unit));
  }
  for (const res of Object.values(state.reserved)) keys.add(res.account);

  return [...keys]
    .map((key) => {
      const { mintUrl, unit } = parseAccountKey(key);
      const proofs = state.proofs[key] ?? [];
      const reserved = Object.values(state.reserved)
        .filter((r) => r.account === key)
        .flatMap((r) => r.proofs);
      return {
        key,
        mintUrl,
        unit,
        balance: sum(proofs),
        unverified: sum(proofs.filter((p) => p.verified !== true)),
        unbacked:
          state.backupEnabled === true
            ? sum(proofs.filter((p) => p.derived !== true))
            : 0,
        reserved: sum(reserved),
        proofCount: proofs.length,
      };
    })
    .sort((a, b) => b.balance - a.balance || a.key.localeCompare(b.key));
}

// Across every mint, one unit only.
export function selectBalanceForUnit(
  state: Pick<WalletData, "proofs">,
  unit: string,
): number {
  return Object.entries(state.proofs).reduce(
    (total, [key, proofs]) =>
      parseAccountKey(key).unit === unit ? total + sum(proofs) : total,
    0,
  );
}

export function selectUnits(
  state: Pick<WalletData, "proofs" | "reserved">,
): string[] {
  const units = new Set<string>();
  for (const [key, proofs] of Object.entries(state.proofs)) {
    if (proofs.length > 0) units.add(parseAccountKey(key).unit);
  }
  for (const res of Object.values(state.reserved)) {
    units.add(parseAccountKey(res.account).unit);
  }
  return [...units].sort();
}

// Every cached keyset with its unit, flat (cashu-ts matches by id). A V4 token
// carries SHORT keyset ids, and a v2 one ("01" prefix) cannot be decoded
// without the full id: cashu-ts throws rather than guessing, as NUT-00
// requires, since an unresolved id means the proof can be neither verified nor
// fee-priced. The unit is what a token's own label is checked against.
// Decoding is offline, so the answer comes from here, not the mint. Takes
// `mints` so a component can memoise on it; the fresh array would re-render on
// every store write.
export function keysetRefsOf(
  mints: Record<string, StoredMint>,
): { id: string; unit: string }[] {
  const out: { id: string; unit: string }[] = [];
  for (const record of Object.values(mints)) {
    const cache = record.keysetCache as
      { keysets?: { id?: unknown; unit?: unknown }[] } | undefined;
    if (cache?.keysets === undefined) continue;
    for (const keyset of cache.keysets) {
      if (typeof keyset.id === "string" && typeof keyset.unit === "string") {
        out.push({ id: keyset.id, unit: keyset.unit });
      }
    }
  }
  return out;
}

export function selectKeysetRefs(
  state: WalletState,
): { id: string; unit: string }[] {
  return keysetRefsOf(state.mints);
}

export function selectSecrets(
  state: Pick<WalletData, "proofs">,
  key: string,
): Set<string> {
  return new Set((state.proofs[key] ?? []).map((p) => p.secret));
}

// ---- Store ----

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      proofs: {},
      reserved: {},
      mints: {},
      history: [],
      settledNutzaps: [],
      claimedTokens: [],
      backupEnabled: false,
      backupVerified: false,
      counters: {},

      // ---- Mints ----

      addMint(mintUrl, patch) {
        const url = normalizeMintUrl(mintUrl);
        set((state) => {
          const existing = state.mints[url];
          return {
            mints: {
              ...state.mints,
              [url]: {
                ...existing,
                ...patch,
                url,
                addedAtMs: existing?.addedAtMs ?? Date.now(),
              },
            },
          };
        });
      },

      updateMint(mintUrl, patch) {
        const url = normalizeMintUrl(mintUrl);
        set((state) => {
          const existing = state.mints[url];
          if (!existing) return state;
          return {
            mints: { ...state.mints, [url]: { ...existing, ...patch } },
          };
        });
      },

      removeMint(mintUrl) {
        const url = normalizeMintUrl(mintUrl);
        set((state) => {
          const mints = { ...state.mints };
          delete mints[url];
          const proofs = { ...state.proofs };
          for (const key of Object.keys(proofs)) {
            if (parseAccountKey(key).mintUrl === url) delete proofs[key];
          }
          return { mints, proofs };
        });
      },

      // ---- Proofs ----

      addProofs(mintUrl, unit, incoming) {
        if (incoming.length === 0) return { added: 0, duplicates: 0 };
        const key = accountKey(mintUrl, unit);
        let added = 0;
        let duplicates = 0;
        set((state) => {
          const existing = state.proofs[key] ?? [];
          // Dedup by secret, including reserved proofs: a replay or re-paste
          // must never count the same value twice.
          const seen = new Set(existing.map((p) => p.secret));
          for (const res of Object.values(state.reserved)) {
            for (const p of res.proofs) seen.add(p.secret);
          }
          const novel = incoming.filter((p) => {
            if (seen.has(p.secret)) return false;
            seen.add(p.secret);
            return true;
          });
          added = novel.length;
          duplicates = incoming.length - novel.length;
          if (novel.length === 0) return state;
          return {
            proofs: { ...state.proofs, [key]: [...existing, ...novel] },
          };
        });
        return { added, duplicates };
      },

      removeProofs(mintUrl, unit, secrets) {
        if (secrets.length === 0) return;
        const key = accountKey(mintUrl, unit);
        const drop = new Set(secrets);
        set((state) => {
          const existing = state.proofs[key];
          if (!existing) return state;
          return {
            proofs: {
              ...state.proofs,
              [key]: existing.filter((p) => !drop.has(p.secret)),
            },
          };
        });
      },

      replaceProofs(mintUrl, unit, proofs) {
        const key = accountKey(mintUrl, unit);
        set((state) => ({ proofs: { ...state.proofs, [key]: proofs } }));
      },

      // Nothing to mark skips the write, which would persist an unchanged store.
      markUnverified(mintUrl, unit, secrets, receiptTxId) {
        if (secrets.length === 0) return;
        set((state) =>
          setUnverified(state, mintUrl, unit, secrets, receiptTxId),
        );
      },

      clearDerived() {
        const strip = (list: StoredProof[]): StoredProof[] =>
          list.map((p) => (p.derived === true ? { ...p, derived: false } : p));
        set((state) => {
          const proofs: Record<string, StoredProof[]> = {};
          for (const [key, list] of Object.entries(state.proofs)) {
            proofs[key] = strip(list);
          }
          const reserved: WalletState["reserved"] = {};
          for (const [txId, entry] of Object.entries(state.reserved)) {
            reserved[txId] = { ...entry, proofs: strip(entry.proofs) };
          }
          return { proofs, reserved };
        });
      },

      // ---- Reservations ----

      reserveProofs(txId, mintUrl, unit, proofs) {
        const key = accountKey(mintUrl, unit);
        const want = new Set(proofs.map((p) => p.secret));
        let reserved = false;

        // Validate and move in one synchronous pass: callers select, await the
        // mint, then land here, so two sends can arrive holding the same coins.
        // Trusting the caller would put one proof in two tokens: both
        // recipients see a balance, only the first to the mint has it.
        set((state) => {
          if (state.reserved[txId] !== undefined) return state;
          const existing = state.proofs[key] ?? [];
          const spendable = new Set(existing.map((p) => p.secret));
          for (const secret of want) {
            if (!spendable.has(secret)) return state;
          }
          reserved = true;
          return {
            proofs: {
              ...state.proofs,
              [key]: existing.filter((p) => !want.has(p.secret)),
            },
            reserved: {
              ...state.reserved,
              [txId]: { account: key, proofs },
            },
          };
        });

        return reserved;
      },

      releaseReserved(txId) {
        const entry = get().reserved[txId];
        if (!entry) return null;
        set((state) => {
          const reserved = { ...state.reserved };
          delete reserved[txId];
          const existing = state.proofs[entry.account] ?? [];
          const seen = new Set(existing.map((p) => p.secret));
          const restored = entry.proofs.filter((p) => !seen.has(p.secret));
          return {
            reserved,
            proofs: {
              ...state.proofs,
              [entry.account]: [...existing, ...restored],
            },
          };
        });
        return entry.proofs;
      },

      dropReserved(txId) {
        set((state) => {
          if (state.reserved[txId] === undefined) return state;
          const reserved = { ...state.reserved };
          delete reserved[txId];
          return { reserved };
        });
      },

      // ---- History ----

      addTx(tx) {
        set((state) => ({
          history: capHistory([tx, ...state.history], state.reserved),
        }));
      },

      updateTx(id, patch) {
        set((state) => ({
          history: state.history.map((tx) =>
            tx.id === id ? { ...tx, ...patch, updatedAtMs: Date.now() } : tx,
          ),
        }));
      },

      // ---- Nutzap ----

      setNutzapPubkey(pubkey) {
        set({ nutzapPubkey: pubkey });
      },

      setBackupEnabled(enabled) {
        set(
          enabled
            ? { backupEnabled: true }
            : {
                backupEnabled: false,
                backupVerified: false,
              },
        );
      },

      setBackupVerified(verified) {
        set({ backupVerified: verified });
      },

      reserveCounters(keysetId, n) {
        const start = get().counters[keysetId] ?? 0;
        if (n <= 0) return { start, count: 0 };
        set((state) => ({
          counters: { ...state.counters, [keysetId]: start + n },
        }));
        return { start, count: n };
      },

      advanceCounter(keysetId, minNext) {
        set((state) => {
          const current = state.counters[keysetId] ?? 0;
          if (current >= minNext) return state;
          return { counters: { ...state.counters, [keysetId]: minNext } };
        });
      },

      markTokenClaimed(firstSecret) {
        set((state) =>
          state.claimedTokens.includes(firstSecret)
            ? state
            : {
                claimedTokens: [firstSecret, ...state.claimedTokens].slice(
                  0,
                  MAX_CLAIMED_TOKENS,
                ),
              },
        );
      },

      // Pruned by age, not count: a count cap lets a burst of spam evict the
      // markers of genuine zaps, which a later replay would then stage again.
      // A sender picks `created_at`, so a future one is clamped to now.
      markNutzapSettled(eventId, createdAt) {
        const nowS = Math.floor(Date.now() / 1000);
        const cutoff = nowS - NUTZAP_LOOKBACK_S;
        set((state) => {
          if (state.settledNutzaps.some((entry) => entry.id === eventId)) {
            return state;
          }
          return {
            settledNutzaps: [
              { id: eventId, createdAt: Math.min(createdAt, nowS) },
              ...state.settledNutzaps.filter(
                (entry) => entry.createdAt >= cutoff,
              ),
            ],
          };
        });
      },

      removeTx(id) {
        set((state) => ({
          history: state.history.filter((tx) => tx.id !== id),
        }));
      },

      // ---- Wipe ----

      clearAccount(mintUrl, unit) {
        const key = accountKey(mintUrl, unit);
        set((state) => {
          const proofs = { ...state.proofs };
          delete proofs[key];
          return { proofs };
        });
      },

      clearAll() {
        set({
          proofs: {},
          reserved: {},
          mints: {},
          history: [],
          settledNutzaps: [],
          claimedTokens: [],
          nutzapPubkey: undefined,
          // The wipe clears the keychain phrase too, so claiming these coins
          // are restorable would be a lie.
          backupEnabled: false,
          backupVerified: false,
          counters: {},
        });
      },
    }),
    {
      name: WALLET_PERSIST_NAME,
      storage: createJSONStorage(() => asyncMMKVStorage),
      version: 1,
      // Fires on success and failure (see `settleHydration`).
      onRehydrateStorage: () => {
        const generation = storageGeneration;
        hydrationGeneration = generation;
        return (_state, error) => {
          if (generation !== storageGeneration) return;
          settleHydration(error === undefined);
        };
      },
      partialize: (state) =>
        ({
          proofs: state.proofs,
          reserved: state.reserved,
          mints: state.mints,
          history: state.history,
          settledNutzaps: state.settledNutzaps,
          // Chat messages survive a restart, so the marker must too, or the
          // chip offers Claim on a token already taken in and the tap errors.
          claimedTokens: state.claimedTokens,
          nutzapPubkey: state.nutzapPubkey,
          backupEnabled: state.backupEnabled,
          backupVerified: state.backupVerified,
          counters: state.counters,
        }) as unknown as WalletState,
    },
  ),
);
