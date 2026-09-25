// Wallet service: the single place that talks to Cashu mints, so the rules that
// protect real money live here rather than in each screen. A screen that
// open-codes "pick proofs, serialise, delete them" loses the value on any crash
// between the delete and the delivery.
//
// Guarantees:
//  1. Proofs are never deleted to send. They are reserved against a transaction
//     id and dropped only once delivery is confirmed (`reclaimSend` recovers).
//  2. Nothing is credited without a mint swap or a passing DLEQ check; offline
//     credits are marked unverified and redeemed first when online.
//  3. No mint call goes over the clear net while Tor is on (iOS: Arti wraps
//     only WebSockets, not fetch).
//  4. A (mint, unit) pair is one account; units never mix.
//
// Offline is the normal case: `getWallet` builds from cached keysets, so fees,
// selection and DLEQ work with the radio off. Only swap, mint and melt need the
// network.

import {
  getTokenMetadata,
  isMintOperationError,
  MeltChangeError,
  Mint,
  NetworkError,
  OutputData,
  setGlobalRequestOptions,
  Wallet,
  type CounterSource,
  type GetInfoResponse,
  type KeyChainCache,
  type MeltQuoteBolt11Response,
  type MintPreview,
  type MintQuoteBolt11Response,
  type Proof,
  type ProofLike,
  type SendResponse,
  type SerializedOutputData,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "@core/crypto/keychain";
import type { NostrClient } from "@core/nostr/nostr-client";
import {
  bareToken,
  buildToken,
  decodeToken,
  feeForProofs,
  mintsOfUnresolvedTokens,
  selectProofsForAmount,
  toProofLike,
  toStoredProof,
  verifyTokenOffline,
  type TokenInfo,
} from "@core/payments/cashu";
import {
  fetchNutzapInfo,
  publishNutzap,
  publishNutzapInfo,
  subscribeNutzaps,
  type NutzapInfo,
} from "@core/payments/nutzap";
import {
  rebuildSwapPreview,
  serializeSwapPreview,
  swapPreviewKeepCount,
  swapPreviewOutputs,
  type StoredSwapPreview,
} from "@core/payments/swap-preview";
import {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  loadStoredPhrase,
  normalizeRecoveryPhrase,
  recoveryPhraseToSeed,
  storePhrase,
} from "@core/payments/wallet-seed";
import { t } from "@i18n";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import {
  accountKey,
  bootstrapWalletStorage,
  isWalletStorageReady,
  normalizeMintUrl,
  parseAccountKey,
  rehydrateAfterReset,
  selectKeysetIds,
  useWalletStore,
  whenWalletHydrated,
  type StoredMint,
  type StoredProof,
  type WalletTx,
} from "@store/wallet-store";
import { Platform } from "react-native";

// ---- Network limits ----

// Every mint request is bounded. cashu-ts only aborts when given a timeout and
// React Native's fetch has none, so a mint that accepts the connection and never
// answers (captive portal, cell handover, overloaded mint) hangs forever. A hang
// is worse than an error: the confirm button spins, the per-mint refresh lock
// blocks every other mint, and startup stalls before the nutzap watcher is
// installed. 20s is generous for a slow round trip and inside a user's patience.
const MINT_REQUEST_TIMEOUT_MS = 20_000;

// A bolt11 melt legitimately takes longer while Lightning routes. Aborting does
// not cancel the payment, it only leaves us unsure whether it settled (the state
// `reconcile` cleans up), so melts get a longer but still bounded ceiling.
const MELT_REQUEST_TIMEOUT_MS = 180_000;

setGlobalRequestOptions({ requestTimeout: MINT_REQUEST_TIMEOUT_MS });

// cashu-ts v4 lets the global option override per-call ones, so a per-request
// timeout cannot widen it and the global is widened for the melt instead. Safe: the AbortController is built at issue time, so
// restoring cannot shorten a call in flight, and concurrent calls merely get a
// longer timeout.
async function withMeltTimeout<T>(run: () => Promise<T>): Promise<T> {
  setGlobalRequestOptions({ requestTimeout: MELT_REQUEST_TIMEOUT_MS });
  try {
    return await run();
  } finally {
    setGlobalRequestOptions({ requestTimeout: MINT_REQUEST_TIMEOUT_MS });
  }
}

// ---- Errors ----

export type WalletErrorCode =
  // The encrypted proof store could not be opened (Keychain/Keystore refused).
  | "locked"
  // The mint could not be reached. The offline path may still be available.
  | "offline"
  // Tor is on and this platform would send the mint request in the clear.
  | "tor-blocked"
  // Not enough spendable balance at any single mint for this amount.
  | "insufficient"
  // The exact amount cannot be made from the proofs held, offline.
  | "inexact"
  // No mint is configured, or the named mint is unknown.
  | "no-mint"
  // An incoming payment named a mint this wallet does not hold. A refusal, not
  // a failure: retrying cannot fix it.
  | "untrusted-mint"
  // The mint does not support a NUT this operation needs.
  | "unsupported"
  // The mint accepted the request and rejected it on its own terms.
  | "mint-error"
  // The token string did not decode.
  | "invalid-token"
  // A DLEQ witness failed: the mint did not sign this. Do not credit it.
  | "forged-token"
  // The mint says these proofs are already spent.
  | "already-spent"
  // A melt is PAID but its NUT-08 change is not unblinded yet. Not a failure:
  // `reconcile` recovers the unused reserve. Neither "refused" nor "success"
  // would be true, hence its own code.
  | "change-pending";

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly detail?: string;
  // The mint may have acted and never said. The money is committed until
  // `reconcile` finds out, so a caller must not pay again another way.
  readonly inDoubt: boolean;

  constructor(
    code: WalletErrorCode,
    message: string,
    detail?: string,
    opts: { inDoubt?: boolean } = {},
  ) {
    super(message);
    this.name = "WalletError";
    this.code = code;
    this.detail = detail;
    this.inDoubt = opts.inDoubt === true;
  }
}

// Whether a failure after a swap was staged proves the mint did nothing. Only a
// mint refusal does, and not "already spent" (see `isAlreadySpentError`).
// Anything else, including an error raised here after the mint's answer
// arrived, leaves open that the mint signed outputs only the stored preview can
// recover.
function isDefiniteRefusal(err: unknown): boolean {
  if (!isMintOperationError(err)) return false;
  return !isAlreadySpentError(asWalletError(err, "mint-error"));
}

// cashu-ts retries lost requests on NUT-19 mints, so "already spent" may be our
// own earlier attempt succeeding. It means "the mint has taken these inputs",
// never "the operation failed"; callers must ask the mint which.
function isAlreadySpentError(err: WalletError): boolean {
  return /spent|already|TOKEN_ALREADY/i.test(err.detail ?? err.message);
}

// Whether a failure is the radio rather than the mint, read from the whole
// cause chain. An operation meeting an unseen keyset id refreshes first, and a
// failed refresh surfaces as `UnknownKeysetError: ... mint refresh failed` with
// the transport error as `cause`; the top line never says network. The receive
// path branches on this, and misreading a dead zone as a mint refusal refuses a
// good token that should have been stored offline.
function isNetworkFailure(err: unknown): boolean {
  // Bounded so a cycle in `cause` cannot hang the error path.
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    // The mint answered, so its wording ("payment timeout") says nothing about
    // the transport.
    if (isMintOperationError(current)) return false;
    if (current instanceof NetworkError) return true;
    const message =
      current instanceof Error ? current.message : String(current);
    // fetch failures in React Native surface as a bare "Network request failed".
    if (/network|fetch|timeout|abort/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function asWalletError(err: unknown, fallback: WalletErrorCode): WalletError {
  if (err instanceof WalletError) return err;
  if (isMintOperationError(err)) {
    return new WalletError("mint-error", err.message, String(err));
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isNetworkFailure(err)) {
    return new WalletError(
      "offline",
      t("wallet.svc.mint_unreachable"),
      message,
    );
  }
  return new WalletError(fallback, message, String(err));
}

// ---- Network policy ----

// Refuse a mint call that would leak this device's IP while the user believes
// they are on Tor. iOS routes only the Nostr WebSocket through Arti, so a plain
// fetch would go in the clear and tell the mint exactly who is swapping which
// proofs. Android's OkHttp client carries the proxy, so the request is tunnelled
// or fails closed, and refusing there would take the wallet away to prevent a
// leak that cannot happen.
//
// Either `torActive` or `torEnabled` refuses. They diverge in one state: iOS
// revalidation drops the claim after a failed bootstrap while the preference
// (and the toggle) stay on, so the user still believes they are covered. Gating
// on `torActive` alone would leak their IP exactly when Tor is struggling.
// Overshooting costs a call the user can allow; undershooting costs anonymity
// they think they have. Matches the `torEnabled` gate in `version-screen.tsx`.
//
// Read from stores, not `isTorRoutingActive()`, which imports the BLE native
// module; this file is reachable from the panic wipe, which must load without a
// native host.
function assertMintNetworkAllowed(): void {
  const settings = useSettingsStore.getState();
  // Internet off means Bluetooth only. "offline" so a receive stores the token
  // unconfirmed, as with no signal.
  if (!settings.internetEnabled) {
    throw new WalletError(
      "offline",
      t("wallet.svc.internet_off"),
      t("wallet.svc.internet_off_body", {
        setting: t("settings.network.internet"),
      }),
    );
  }
  const torClaimed =
    useMeshStateStore.getState().torActive || settings.torEnabled;
  if (!torClaimed) return;

  if (Platform.OS !== "ios") return;
  // The one explicit escape hatch.
  if (settings.allowMintOverClearnet) return;
  throw new WalletError(
    "tor-blocked",
    t("wallet.svc.tor_ios"),
    t("wallet.svc.tor_ios_body", {
      setting: t("settings.conn.mint_clearnet"),
    }),
  );
}

// Why a mint call would be refused right now, or null when it would go out, so
// the screen can grey an action out and say why before it is tapped.
export function mintNetworkBlock(): "internet-off" | "tor" | null {
  try {
    assertMintNetworkAllowed();
    return null;
  } catch (err) {
    return err instanceof WalletError && err.code === "tor-blocked"
      ? "tor"
      : "internet-off";
  }
}

// ---- Recovery phrase (NUT-13 deterministic secrets) ----

// Seed from the recovery phrase, created with the wallet rather than at opt-in.
// Null before bootstrap, or when the keychain refused the phrase (random
// secrets). It alone decides whether new proofs are recoverable; wallets are
// rebuilt when it flips.
let activeSeed: Uint8Array | null = null;

// Not the same as `backupEnabled`, which records that the user has seen the
// words. Recoverability checks want this one.
function isSeedActive(): boolean {
  return activeSeed !== null;
}

// NUT-13 secrets derive from (seed, keyset id, counter); a reused counter is a
// duplicate the mint rejects, so the cursor is persisted and only moves forward.
// A crash before the encrypted write can lose a bump: the next swap fails
// retryably, restore repairs the cursor, and the inputs are untouched.
const counterSource: CounterSource = {
  reserve(keysetId: string, n: number) {
    return Promise.resolve(
      useWalletStore.getState().reserveCounters(keysetId, n),
    );
  },
  advanceToAtLeast(keysetId: string, minNext: number) {
    useWalletStore.getState().advanceCounter(keysetId, minNext);
    return Promise.resolve();
  },
  snapshot() {
    return Promise.resolve({ ...useWalletStore.getState().counters });
  },
};

// ---- Wallet instances ----

// One Wallet per (mint, unit), reused for the process lifetime because building
// one online costs a round trip. Keysets are re-fetched by a `forceRefresh`
// rebuild (`refreshAccount`, restore) or by cashu-ts itself on a rotation.
const wallets = new Map<string, Wallet>();

// Wallets capture the seed at construction, so a seed change must drop them or
// cached wallets keep minting random secrets outside the phrase.
function invalidateWallets(): void {
  wallets.clear();
}

function walletOptions(unit: string): {
  unit: string;
  bip39seed?: Uint8Array;
  secretsPolicy?: "deterministic" | "random";
  counterSource?: CounterSource;
} {
  if (activeSeed === null) return { unit, secretsPolicy: "random" };
  return {
    unit,
    bip39seed: activeSeed,
    secretsPolicy: "deterministic",
    counterSource,
  };
}

// How long a cached keyset is trusted online. Mints rotate rarely; a day keeps
// fees and keys current without a round trip per send.
const KEYSET_TTL_MS = 24 * 60 * 60 * 1000;

function storedMint(mintUrl: string): StoredMint | undefined {
  return useWalletStore.getState().mints[normalizeMintUrl(mintUrl)];
}

// Build a Wallet whose keyset repairs reach disk. On evidence of a rotation (a
// proof naming an unseen keyset, or the mint rejecting one the snapshot calls
// active) cashu-ts refreshes its in-memory snapshot and throws. Unpersisted, the
// next cold start reloads the stale cache, finds it inside `KEYSET_TTL_MS`, and
// until it refreshes again `verifyTokenOffline` has no key for the new keyset, so
// a good token is stored unverified in a dead zone. `keychainUpdated` is a local
// emitter (free on a mint that never rotates) that fires only for refreshes the
// library makes itself; explicit `loadMint` and `ensureOperableKeysets` calls
// persist at their call sites.
function newWallet(url: string, unit: string): Wallet {
  const wallet = new Wallet(new Mint(url), walletOptions(unit));
  const epoch = walletEpoch;
  wallet.on.keychainUpdated(() => {
    // An operation in flight across a panic wipe must not write the deleted
    // snapshot back.
    if (walletEpoch !== epoch || !isWalletStorageReady()) return;
    persistMintSnapshot(url, unit, wallet);
  });
  return wallet;
}

// `offline: true` never touches the network (cached keysets or "offline").
// Otherwise the cache is preferred and refreshed only when missing or stale.
async function getWallet(
  mintUrl: string,
  unit: string,
  opts: { offline?: boolean; forceRefresh?: boolean } = {},
): Promise<Wallet> {
  const url = normalizeMintUrl(mintUrl);
  const key = accountKey(url, unit);
  const cached = wallets.get(key);
  if (cached && !opts.forceRefresh) return cached;

  const record = storedMint(url);
  const cacheFresh =
    record?.keysetCache !== undefined &&
    record.infoResponse !== undefined &&
    Date.now() - (record.keysetCacheAtMs ?? 0) < KEYSET_TTL_MS;

  const wallet = newWallet(url, unit);

  if (!opts.forceRefresh && cacheFresh) {
    try {
      wallet.loadMintFromCache(
        record.infoResponse as GetInfoResponse,
        record.keysetCache as KeyChainCache,
      );
      wallets.set(key, wallet);
      return wallet;
    } catch {
      // Older cashu-ts cache or corrupt: re-fetch below.
    }
  }

  if (opts.offline === true) {
    // A stale cache still verifies DLEQ and prices fees for unrotated keysets.
    if (
      record?.keysetCache !== undefined &&
      record.infoResponse !== undefined
    ) {
      try {
        wallet.loadMintFromCache(
          record.infoResponse as GetInfoResponse,
          record.keysetCache as KeyChainCache,
        );
        wallets.set(key, wallet);
        return wallet;
      } catch {
        // fall through to the throw below
      }
    }
    throw new WalletError(
      "offline",
      t("wallet.svc.keys_uncached"),
      t("wallet.svc.keys_uncached_body"),
    );
  }

  assertMintNetworkAllowed();
  const epoch = walletEpoch;
  try {
    await wallet.loadMint(opts.forceRefresh === true);
  } catch (err) {
    throw asWalletError(err, "offline");
  }
  // The snapshot re-adds the mint, so a wipe during the fetch must stop it.
  if (walletEpoch !== epoch) throw lockedError();
  persistMintSnapshot(url, unit, wallet);
  wallets.set(key, wallet);
  return wallet;
}

// Persist what the mint told us so a cold start works offline: keys for DLEQ,
// fees for selection, units and NUTs for feature gating.
function persistMintSnapshot(
  mintUrl: string,
  unit: string,
  wallet: Wallet,
): void {
  const store = useWalletStore.getState();
  let cache: KeyChainCache | undefined;
  let feePpkByKeysetId: Record<string, number> | undefined;
  let units: string[] | undefined;
  try {
    cache = wallet.keyChain.cache;
    feePpkByKeysetId = {};
    units = [];
    for (const keyset of cache.keysets) {
      feePpkByKeysetId[keyset.id] = keyset.input_fee_ppk ?? 0;
      if (!units.includes(keyset.unit)) units.push(keyset.unit);
    }
  } catch {
    // A wallet built from a partial cache may not expose one; keep what we have.
  }

  let info: GetInfoResponse | undefined;
  let name: string | undefined;
  let description: string | undefined;
  let supportedNuts: number[] | undefined;
  try {
    // The raw /v1/info response, which `loadMintFromCache` wants back.
    info = wallet.getMintInfo().cache;
    name = typeof info.name === "string" ? info.name.slice(0, 64) : undefined;
    description =
      typeof info.description === "string"
        ? info.description.slice(0, 200)
        : undefined;
    supportedNuts = Object.keys(info.nuts ?? {})
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    // Mint info is optional for offline operation; keys are what matter.
  }

  store.addMint(mintUrl, {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(units !== undefined && units.length > 0
      ? { units }
      : { units: [unit] }),
    ...(supportedNuts !== undefined ? { supportedNuts } : {}),
    ...(info !== undefined ? { infoResponse: info } : {}),
    ...(cache !== undefined
      ? { keysetCache: cache, keysetCacheAtMs: Date.now() }
      : {}),
    ...(feePpkByKeysetId !== undefined ? { feePpkByKeysetId } : {}),
    lastSeenMs: Date.now(),
  });
}

// Drop all in-memory wallet state after a panic wipe, so a fresh identity
// inherits nothing: keysets, throttles, in-flight marks (their transactions are
// gone), the seed and the nutzap key (both from the wiped keychain). Bumping
// the epoch stops in-flight work from writing back.
//
// A reconcile pass on the wire cannot be cancelled, but dropping its handle
// stops later callers joining it. A kept seed would go on deriving proofs from a
// phrase the user can no longer see, and a kept P2PK key would put the previous
// identity's pubkey into the next kind 10019 after re-onboarding.
export function resetWalletService(): void {
  wallets.clear();
  reconcileInFlight = null;
  lastReconcileAtMs = 0;
  lastStateCheckAtMs.clear();
  swapsInFlight.clear();
  meltsInFlight.clear();
  keysetFetchedAtMs.clear();
  walletEpoch += 1;
  activeSeed = null;
  nutzapPrivKey = null;
}

// ---- Store readiness ----

// Open the encrypted proof store once at app start. False when the keystore is
// unavailable: the wallet stays locked rather than falling back to plaintext.
export async function initWalletService(): Promise<boolean> {
  try {
    await bootstrapWalletStorage();
  } catch {
    return false;
  }
  rehydrateAfterReset();
  // Hydration overwrites the store when it lands, discarding earlier writes,
  // and a failed read must not look like an empty wallet.
  await whenWalletHydrated();
  if (!isWalletStorageReady()) return false;
  // Before the first mint operation, or new proofs get random secrets outside
  // the recovery phrase.
  await loadBackupState();
  return true;
}

// ---- Backup lifecycle ----

// Load the recovery phrase and switch new proofs to deterministic secrets.
// Never throws: a phrase that cannot be used this session means random
// secrets, which the next refresh re-issues under the phrase (`needsSwap`).
async function loadBackupState(): Promise<void> {
  let stored;
  try {
    stored = await loadStoredPhrase();
  } catch {
    stored = null;
  }
  // Unreadable or no longer valid: the phrase and the flags describing it are
  // left exactly as they are. Only a confirmed absence may start a new one.
  if (stored === null || stored.state === "invalid") {
    activeSeed = null;
    invalidateWallets();
    return;
  }

  let phrase = stored.state === "valid" ? stored.phrase : null;

  // No phrase yet: make one now, not at opt-in. Random secrets can never be
  // re-derived, so NUT-09 restore would have nothing to ask the mint about, and
  // a default user would only learn that after losing the phone.
  // `backupEnabled` stays off: it means the user has seen the words, and the
  // Wallet screen's shield reads it.
  if (phrase === null) {
    // The keychain is the source of truth. A missing phrase with backup on
    // means a keychain reset or a device restore that dropped keychain items;
    // the old coins are unrecoverable, so stop saying they are covered. The
    // fresh seed covers only coins minted from here.
    if (useWalletStore.getState().backupEnabled) {
      useWalletStore.getState().setBackupEnabled(false);
    }
    try {
      const fresh = generateRecoveryPhrase();
      await storePhrase(fresh);
      phrase = fresh;
      // Derived marks belong to the lost phrase.
      useWalletStore.getState().clearDerived();
    } catch {
      // Keychain refused the write: random secrets, working but unrecoverable.
      activeSeed = null;
      if (useWalletStore.getState().backupEnabled) {
        useWalletStore.getState().setBackupEnabled(false);
      }
      return;
    }
  }

  activeSeed = recoveryPhraseToSeed(phrase);
  invalidateWallets();
}

export interface BackupSetup {
  phrase: string;
  // The existing phrase was returned; a second one would orphan every coin
  // derived from the first.
  existed: boolean;
}

// One-way: deleting a phrase coins derive from is deleting the coins. Only the
// panic wipe removes it.
export async function enableWalletBackup(): Promise<BackupSetup> {
  assertUnlocked();
  const existing = await readUsablePhrase();
  if (existing !== null) {
    activeSeed = recoveryPhraseToSeed(existing);
    useWalletStore.getState().setBackupEnabled(true);
    invalidateWallets();
    return { phrase: existing, existed: true };
  }

  const phrase = generateRecoveryPhrase();
  await storePhrase(phrase);
  activeSeed = recoveryPhraseToSeed(phrase);
  useWalletStore.getState().setBackupEnabled(true);
  // Held proofs stay random until swapped; rebuilt wallets derive from here.
  invalidateWallets();
  return { phrase, existed: false };
}

// Null only when no phrase is stored.
export function getRecoveryPhrase(): Promise<string | null> {
  return readUsablePhrase();
}

// The stored phrase, null when there is none, and a throw for one that exists
// but cannot be used, so no caller mistakes it for "none" and writes a new one.
async function readUsablePhrase(): Promise<string | null> {
  let stored;
  try {
    stored = await loadStoredPhrase();
  } catch {
    stored = null;
  }
  if (stored?.state === "absent") return null;
  if (stored?.state === "valid") return stored.phrase;
  throw new WalletError(
    "locked",
    t("wallet.svc.phrase_unreadable"),
    t("wallet.svc.phrase_unreadable_body"),
  );
}

// Here rather than in the UI so the flag never claims more than a live seed.
export function markBackupVerified(): void {
  if (activeSeed === null) return;
  useWalletStore.getState().setBackupVerified(true);
}

export interface RestoreProgress {
  mintUrl: string;
  keysetId: string;
  // 1-based index of the keyset being scanned, and how many there are.
  step: number;
  total: number;
}

export interface RestoreResult {
  // Recovered, confirmed-unspent value per unit.
  recovered: Record<string, number>;
  proofCount: number;
  // Signed but spent, so "recovered nothing" reads as spent, not as a failure.
  alreadySpent: number;
  mintsScanned: string[];
  // Mints that could not be reached; their balance may still be out there.
  mintsFailed: { mintUrl: string; reason: string }[];
}

// Empty counters to scan past the last signature before a keyset is exhausted.
// Counters advance one per output, so 200 is ample headroom.
const RESTORE_GAP_LIMIT = 200;
const RESTORE_BATCH_SIZE = 100;

// NUT-09 restore: re-derive every keyset's secrets and ask the mint which it
// signed. The mint answers from its own records, so this works on a fresh
// install. Two limits the UI must surface: a mint not named is never asked, and
// only coins whose secrets came from this phrase return (a receive never
// swapped carried the sender's secrets and is lost).
export async function restoreFromRecoveryPhrase(params: {
  phrase: string;
  mintUrls: string[];
  unit?: string;
  onProgress?: (progress: RestoreProgress) => void;
}): Promise<RestoreResult> {
  assertUnlocked();
  assertMintNetworkAllowed();

  const phrase = normalizeRecoveryPhrase(params.phrase);
  if (!isValidRecoveryPhrase(phrase)) {
    throw new WalletError(
      "invalid-token",
      t("wallet.svc.phrase_invalid"),
      t("wallet.svc.phrase_invalid_body"),
    );
  }
  if (params.mintUrls.length === 0) {
    throw new WalletError(
      "no-mint",
      t("wallet.svc.need_mint"),
      t("wallet.svc.need_mint_body"),
    );
  }

  const seed = recoveryPhraseToSeed(phrase);
  const epoch = walletEpoch;
  // Unreadable counts as different: the marks may belong to any phrase.
  const previous = await loadStoredPhrase().catch(() => null);
  // Never write a phrase into a keychain a wipe just cleared.
  assertSameWallet(epoch);

  // Switch before scanning so new outputs derive from the restored phrase.
  await storePhrase(phrase);
  assertSameWallet(epoch);
  // Coins held now derive from the replaced phrase: spendable, but uncovered
  // until a refresh re-issues them.
  const keepDerived =
    previous?.state === "absent" ||
    (previous?.state === "valid" && previous.phrase === phrase);
  if (!keepDerived) useWalletStore.getState().clearDerived();
  activeSeed = seed;
  useWalletStore.getState().setBackupEnabled(true);
  // Restoring proves the user holds the phrase.
  useWalletStore.getState().setBackupVerified(true);
  invalidateWallets();

  const store = useWalletStore.getState();
  const recovered: Record<string, number> = {};
  const mintsScanned: string[] = [];
  const mintsFailed: { mintUrl: string; reason: string }[] = [];
  let proofCount = 0;
  let alreadySpent = 0;

  for (const rawUrl of params.mintUrls) {
    const url = normalizeMintUrl(rawUrl);
    try {
      // Once per unit: `getKeysets()` is unit-scoped, so a sat-only pass never
      // sees usd keysets and reports "recovered nothing", which reads as "spent"
      // rather than "not looked". The forced refresh records every unit the
      // mint issues, even on a fresh install.
      await getWallet(url, params.unit ?? "sat", { forceRefresh: true });
      const units =
        params.unit !== undefined
          ? [params.unit]
          : (storedMint(url)?.units ?? ["sat"]);

      for (const unit of units) {
        const wallet = await getWallet(url, unit);
        const keysets = wallet.keyChain.getKeysets();

        for (const [index, keyset] of keysets.entries()) {
          params.onProgress?.({
            mintUrl: url,
            keysetId: keyset.id,
            step: index + 1,
            total: keysets.length,
          });

          // Not `withKeyset`: it builds a wallet defaulting to sat, which cannot
          // bind a keyset in another unit.
          const { proofs, lastCounterWithSignature } =
            await wallet.batchRestore(
              RESTORE_GAP_LIMIT,
              RESTORE_BATCH_SIZE,
              0,
              keyset.id,
            );

          // Past every signed counter, or the next swap is a duplicate.
          assertSameWallet(epoch);
          if (typeof lastCounterWithSignature === "number") {
            store.advanceCounter(keyset.id, lastCounterWithSignature + 1);
          }
          if (proofs.length === 0) continue;

          const grouped = await wallet.groupProofsByState(proofs);
          assertSameWallet(epoch);
          alreadySpent += grouped.spent.length;
          const live = [...grouped.unspent, ...grouped.pending];
          if (live.length === 0) continue;

          creditProofs(url, unit, live, { verified: true });
          proofCount += live.length;
          recovered[unit] =
            (recovered[unit] ?? 0) +
            live.reduce((sum, p) => sum + p.amount.toNumber(), 0);
        }
      }
      mintsScanned.push(url);
    } catch (err) {
      if (walletReplaced(epoch)) throw lockedError();
      mintsFailed.push({
        mintUrl: url,
        reason: asWalletError(err, "mint-error").message,
      });
    }
  }

  // One row per unit: summing sat and usd would be no currency at all.
  for (const [unit, amount] of Object.entries(recovered)) {
    if (amount <= 0) continue;
    recordTx({
      kind: "receive",
      status: "completed",
      amount,
      unit,
      mintUrl: mintsScanned[0] ?? params.mintUrls[0],
      memo: t("wallet.svc.restored"),
    });
  }

  return { recovered, proofCount, alreadySpent, mintsScanned, mintsFailed };
}

function assertUnlocked(): void {
  if (!isWalletStorageReady()) throw lockedError();
}

function lockedError(): WalletError {
  return new WalletError(
    "locked",
    t("wallet.svc.storage_locked"),
    t("wallet.svc.storage_locked_body"),
  );
}

// Whether a panic wipe landed since the operation began. Checked after every
// await that precedes a write, or the old wallet's proofs and history return.
function walletReplaced(epoch: number): boolean {
  return walletEpoch !== epoch || !isWalletStorageReady();
}

function assertSameWallet(epoch: number): void {
  if (walletReplaced(epoch)) throw lockedError();
}

// ---- Mints ----

export interface AddMintResult {
  mint: StoredMint;
  units: string[];
}

// Unreachable or non-Cashu URLs are rejected up front rather than saved.
export async function addMint(rawUrl: string): Promise<AddMintResult> {
  assertUnlocked();
  const url = normalizeMintUrl(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WalletError("no-mint", t("wallet.svc.bad_url"));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WalletError("no-mint", t("wallet.svc.needs_https"));
  }
  // http only for loopback (a local Nutshell); elsewhere proofs go unauthenticated.
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new WalletError(
      "no-mint",
      t("wallet.svc.refuse_http"),
      t("wallet.svc.refuse_http_body"),
    );
  }

  assertMintNetworkAllowed();

  const wallet = newWallet(url, "sat");
  try {
    await wallet.loadMint(true);
  } catch (err) {
    throw asWalletError(err, "no-mint");
  }
  persistMintSnapshot(url, "sat", wallet);
  wallets.set(accountKey(url, "sat"), wallet);

  const record = storedMint(url);
  if (!record) throw new WalletError("no-mint", t("wallet.svc.mint_not_saved"));
  return { mint: record, units: record.units ?? ["sat"] };
}

// ---- Recoverable swaps ----

// Inputs of unfinished swaps. They stay spendable (a dead zone still needs
// them), but only the swap's replay may ask the mint what became of them, so
// other balance checks leave them alone. A refresh that dropped them as spent
// would lower the balance, file a "spent proofs removed" receipt, then watch the
// replay put the same value back: each step correct, the history unreadable.
function secretsAwaitingSwapReplay(): Set<string> {
  const secrets = new Set<string>();
  for (const tx of useWalletStore.getState().history) {
    if (tx.status !== "pending" || tx.swapPreview === undefined) continue;
    const preview = rebuildSwapPreview(tx.swapPreview);
    if (preview === null) continue;
    for (const input of preview.inputs) secrets.add(input.secret);
  }
  return secrets;
}

// Prepare a swap so losing its answer is survivable. `wallet.receive` and
// `wallet.send` prepare, request and unblind in one call, so a lost response
// leaves the inputs spent and the blinding factors gone with the call frame;
// unlike a melt or deposit there is no quote to ask afterwards, and nothing on
// the device records the outputs existed. Order is the guarantee:
//   1. prepare   local: inputs and blinded outputs.
//   2. sign      local, exactly once. BIP-340 uses random aux data, so signing
//                at replay changes the body and misses the NUT-19 cache.
//   3. persist   the caller writes the transaction with `stored`.
//   4. complete  the only network step.
// Steps 3 and 4 are the caller's because only it knows what the transaction
// means. The live preview and its stored form are returned together so they
// cannot drift.
async function prepareRecoverableSwap(
  wallet: Wallet,
  prepare: () => Promise<SwapPreview>,
  privkey?: string,
): Promise<{ preview: SwapPreview; stored: StoredSwapPreview }> {
  const preview = await prepare();
  if (privkey !== undefined) {
    preview.inputs = wallet.signP2PKProofs(
      preview.inputs,
      privkey,
      swapPreviewOutputs(preview),
    );
  }
  return { preview, stored: serializeSwapPreview(preview) };
}

// Swaps on the wire in this process, which `reconcile` skips. A stored preview
// means "the mint may have this" forever, not "the answer is overdue". A replay
// racing the original would not corrupt anything (same signatures, `addProofs`
// dedupes by secret) but puts two writers on one transaction. Memory only:
// after a crash the next launch must see them as replayable.
const swapsInFlight = new Set<string>();

// Melts on the wire, also skipped by `reconcile`: until the mint marks the
// quote PENDING it reads UNPAID, and a pass would release proofs the melt is
// about to spend. Memory only; a crash leaves `recoverMeltChange` to finish.
const meltsInFlight = new Set<string>();

async function completeSwapInFlight(
  wallet: Wallet,
  txId: string,
  preview: SwapPreview,
): Promise<SendResponse> {
  swapsInFlight.add(txId);
  try {
    return await wallet.completeSwap(preview);
  } finally {
    swapsInFlight.delete(txId);
  }
}

// ---- Receive ----

export interface ReceiveResult {
  amount: number;
  unit: string;
  mintUrl: string;
  memo?: string;
  // "swapped"     redeemed at the mint; the value is now provably ours
  // "stored"      kept offline; DLEQ passed but the mint has not confirmed it
  //               is unspent, so it counts as unverified balance
  // "duplicate"   every proof was already in the wallet; nothing was credited
  outcome: "swapped" | "stored" | "duplicate" | "own-pending";
  // Why we did not swap, when outcome is "stored".
  offlineReason?: string;
  // Result of the offline DLEQ check, for the receipt UI.
  dleq: "valid" | "unchecked";
}

// Per-mint throttle for keyset fetches triggered by chat tokens.
const keysetFetchedAtMs = new Map<string, number>();
const KEYSET_FETCH_THROTTLE_MS = 5 * 60 * 1000;

// Held mints whose tokens in `text` need a newer keyset list to decode. A mint
// the user has not added is left out: nothing may contact it.
function heldMintsOfUnresolvedTokens(
  text: string,
): { mintUrl: string; unit: string }[] {
  const state = useWalletStore.getState();
  const held: { mintUrl: string; unit: string }[] = [];
  for (const mint of mintsOfUnresolvedTokens(text, selectKeysetIds(state))) {
    try {
      const url = normalizeMintUrl(mint.mintUrl);
      if (state.mints[url] !== undefined) held.push({ ...mint, mintUrl: url });
    } catch {
      // Not a URL.
    }
  }
  return held;
}

// Fetch the mint's current keysets and decode again. Throws when the mint is
// out of reach, since "unreadable" would then be false.
async function decodeUnderFreshKeysets(
  raw: string,
  epoch: number,
): Promise<TokenInfo | null> {
  const bare = bareToken(raw);
  const [mint] = bare === null ? [] : heldMintsOfUnresolvedTokens(bare);
  if (mint === undefined) return null;
  try {
    assertMintNetworkAllowed();
    await getWallet(mint.mintUrl, mint.unit, { forceRefresh: true });
  } catch (err) {
    const walletErr = asWalletError(err, "offline");
    if (walletErr.code !== "offline") throw walletErr;
    throw new WalletError(
      "offline",
      t("wallet.svc.keyset_unknown"),
      t("wallet.svc.keyset_unknown_body"),
    );
  }
  assertSameWallet(epoch);
  return decodeToken(raw, selectKeysetIds(useWalletStore.getState()));
}

// Fetch keysets for chat tokens that show as text; the store update re-renders
// them as cards. Quiet on failure, throttled per mint.
export async function fetchKeysetsForTokenText(text: string): Promise<void> {
  if (!isWalletStorageReady()) return;
  for (const mint of heldMintsOfUnresolvedTokens(text)) {
    const key = accountKey(mint.mintUrl, mint.unit);
    const last = keysetFetchedAtMs.get(key) ?? 0;
    if (Date.now() - last < KEYSET_FETCH_THROTTLE_MS) continue;
    keysetFetchedAtMs.set(key, Date.now());
    try {
      assertMintNetworkAllowed();
      await getWallet(mint.mintUrl, mint.unit, { forceRefresh: true });
    } catch {
      // Offline or refused: the token stays as text until the next try.
    }
  }
}

// Decode, verify DLEQ offline, swap at the mint, and store the raw proofs only
// when the mint is unreachable. A failed DLEQ is refused and never stored.
export async function receiveToken(
  raw: string,
  opts: { preferOffline?: boolean; counterparty?: string } = {},
): Promise<ReceiveResult> {
  assertUnlocked();
  const epoch = walletEpoch;

  let info = decodeToken(raw, selectKeysetIds(useWalletStore.getState()));
  if (!info && opts.preferOffline !== true) {
    info = await decodeUnderFreshKeysets(raw, epoch);
  }
  if (!info) {
    // Tell "unknown mint" (fixable) from "malformed". `getTokenMetadata` needs
    // no keyset data, so it answers when an unresolved short id stopped decode.
    const bare = bareToken(raw);
    if (bare !== null) {
      let mintUrl: string | undefined;
      try {
        mintUrl = normalizeMintUrl(getTokenMetadata(bare).mint);
      } catch {
        // Not even metadata: genuinely malformed, so fall through.
      }
      if (
        mintUrl !== undefined &&
        useWalletStore.getState().mints[mintUrl] === undefined
      ) {
        throw new WalletError(
          "no-mint",
          t("wallet.svc.unknown_mint"),
          t("wallet.svc.unknown_mint_body"),
        );
      }
    }
    throw new WalletError(
      "invalid-token",
      t("wallet.svc.unreadable_token"),
      t("wallet.svc.unreadable_token_body"),
    );
  }

  const store = useWalletStore.getState();
  const url = normalizeMintUrl(info.mintUrl);
  const record = store.mints[url];

  // Only mints the user chose, or a stranger's token could enrol an unvetted
  // mint and leave this wallet holding its paper. Refusing consumes nothing:
  // add the mint and receive again. The nutzap path enforces the same rule.
  if (record === undefined) {
    throw new WalletError(
      "no-mint",
      t("wallet.svc.unknown_mint"),
      t("wallet.svc.unknown_mint_body"),
    );
  }

  // With no network, DLEQ is the only defence against a forged token.
  const dleq = verifyTokenOffline(
    info.token,
    record?.keysetCache as KeyChainCache | undefined,
    info.unit,
  );
  if (dleq.status === "invalid") {
    throw new WalletError(
      "forged-token",
      t("wallet.svc.wrong_mint"),
      dleq.reason,
    );
  }

  const existing = new Set(
    (store.proofs[accountKey(url, info.unit)] ?? []).map((p) => p.secret),
  );
  if (info.token.proofs.every((p) => existing.has(p.secret))) {
    return {
      amount: info.amount,
      unit: info.unit,
      mintUrl: url,
      memo: info.memo,
      outcome: "duplicate",
      dleq: dleq.status === "valid" ? "valid" : "unchecked",
    };
  }

  // Our own unsettled send (reserved proofs). Redeeming would pay a swap fee
  // and file it as a receipt; reclaiming the send settles it directly.
  const reservedSecrets = new Set<string>();
  for (const entry of Object.values(store.reserved)) {
    for (const proof of entry.proofs) reservedSecrets.add(proof.secret);
  }
  if (
    reservedSecrets.size > 0 &&
    info.token.proofs.every((p) => reservedSecrets.has(p.secret))
  ) {
    return {
      amount: info.amount,
      unit: info.unit,
      mintUrl: url,
      memo: info.memo,
      outcome: "own-pending",
      dleq: dleq.status === "valid" ? "valid" : "unchecked",
    };
  }

  const dleqLabel =
    dleq.status === "valid" ? ("valid" as const) : ("unchecked" as const);

  // Already received and swapped, so the checks above miss it. Staging again
  // would open a pending row for a swap the mint must refuse.
  const firstSecret = info.token.proofs[0]?.secret;
  if (firstSecret !== undefined && store.claimedTokens.includes(firstSecret)) {
    return {
      amount: info.amount,
      unit: info.unit,
      mintUrl: url,
      memo: info.memo,
      outcome: "duplicate",
      dleq: dleqLabel,
    };
  }

  // Swap so the proofs are provably unspent and unknown to the sender.
  if (opts.preferOffline !== true) {
    const txId = newTxId();
    // Whether the mint could have seen the request.
    let staged = false;
    try {
      assertMintNetworkAllowed();
      const wallet = await getWallet(url, info.unit);
      // `requireDleq` checks DLEQ against freshly loaded keys, covering an
      // offline "unchecked" from missing cached keys. The NIP-61 key unlocks a
      // nutzap delivered by DM after its relay publish failed: without the
      // witness the mint refuses, and the money is neither claimable nor
      // reclaimable. Bearer tokens ignore it.
      const { preview, stored } = await prepareRecoverableSwap(
        wallet,
        () =>
          wallet.prepareSwapToReceive(info.token, {
            requireDleq: info.hasDleq,
          }),
        await getNutzapPrivKeyHex(),
      );
      assertSameWallet(epoch);
      // On disk before the request leaves, so a kill costs a delay, not money.
      store.addTx({
        id: txId,
        kind: "receive",
        status: "pending",
        amount: info.amount,
        unit: info.unit,
        mintUrl: url,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        memo: info.memo,
        counterparty: opts.counterparty,
        swapPreview: stored,
      });
      staged = true;

      const result = await completeSwapInFlight(wallet, txId, preview);
      assertSameWallet(epoch);
      creditProofs(url, info.unit, result.keep, { verified: true });
      markClaimed(info);
      store.updateTx(txId, { status: "completed", swapPreview: undefined });
      return {
        amount: info.amount,
        unit: info.unit,
        mintUrl: url,
        memo: info.memo,
        outcome: "swapped",
        dleq: dleqLabel,
      };
    } catch (err) {
      if (walletReplaced(epoch)) throw lockedError();
      const walletErr = asWalletError(err, "mint-error");
      // Never clear the preview here, not even on "already spent" (possibly our
      // own first attempt). Only `reconcile` can learn whether the mint took
      // the inputs.
      if (staged) store.updateTx(txId, { error: walletErr.message });
      if (walletErr.code === "mint-error" && isAlreadySpentError(walletErr)) {
        // Still reported as spent: nothing is credited yet, and the preview
        // stays for `reconcile` to settle.
        throw new WalletError(
          "already-spent",
          t("wallet.svc.already_spent"),
          t("wallet.svc.already_spent_body"),
        );
      }
      if (walletErr.code !== "offline" && walletErr.code !== "tor-blocked") {
        throw walletErr;
      }
      // The request may never have left, or only its answer was lost. Store
      // the proofs unverified and keep the preview on the same transaction; a
      // replay drops them as it credits the real outputs, so nothing counts
      // twice.
      return storeOffline(url, info, walletErr.message, dleqLabel, {
        counterparty: opts.counterparty,
        ...(staged ? { txId } : {}),
      });
    }
  }

  return storeOffline(url, info, t("wallet.svc.receiving_offline"), dleqLabel, {
    counterparty: opts.counterparty,
  });
}

// Keep the token's own proofs unverified: the offline mesh case, redeemed first
// by `refreshAccount`. `txId` is the receive already opened for a staged swap,
// so the token keeps one receipt with its preview attached.
function storeOffline(
  mintUrl: string,
  info: TokenInfo,
  reason: string,
  dleq: "valid" | "unchecked",
  opts: { counterparty?: string; txId?: string } = {},
): ReceiveResult {
  const store = useWalletStore.getState();
  store.addMint(mintUrl, { units: [info.unit] });
  const stored = info.token.proofs.map((p) =>
    toStoredProof(p, { verified: false }),
  );
  const { added } = store.addProofs(mintUrl, info.unit, stored);
  markClaimed(info);
  if (added === 0) {
    return {
      amount: info.amount,
      unit: info.unit,
      mintUrl,
      memo: info.memo,
      outcome: "duplicate",
      dleq,
    };
  }
  if (opts.txId !== undefined) {
    store.updateTx(opts.txId, { error: reason });
  } else {
    recordTx({
      kind: "receive",
      status: "pending",
      amount: info.amount,
      unit: info.unit,
      mintUrl,
      memo: info.memo,
      counterparty: opts.counterparty,
    });
  }
  return {
    amount: info.amount,
    unit: info.unit,
    mintUrl,
    memo: info.memo,
    outcome: "stored",
    offlineReason: reason,
    dleq,
  };
}

// Lets a chat payment card show "Claimed". Keyed on the first proof's secret,
// which is unique to the token.
function markClaimed(info: TokenInfo): void {
  const first = info.token.proofs[0]?.secret;
  if (first !== undefined) useWalletStore.getState().markTokenClaimed(first);
}

// Credit proofs the mint just signed. They came from a `getWallet` wallet, so
// `isSeedActive()` now is whether they are derived. `addProofs` dedupes by
// secret, leaving already-held originals (as in a `keep` array) untouched.
function creditProofs(
  mintUrl: string,
  unit: string,
  proofs: Proof[],
  opts: { verified: boolean },
): void {
  const store = useWalletStore.getState();
  const derived = isSeedActive();
  store.addMint(mintUrl, { units: [unit] });
  store.addProofs(
    mintUrl,
    unit,
    proofs.map((p) => toStoredProof(p, { verified: opts.verified, derived })),
  );
}

// ---- Send ----

export interface SendQuote {
  mintUrl: string;
  unit: string;
  // What the recipient will be able to claim.
  amount: number;
  // Face value leaving the wallet (amount + fee when the sender covers it).
  spend: number;
  // Mint input fee the recipient would otherwise have paid.
  fee: number;
  // False when held denominations cannot make the amount. Needs explicit
  // consent: offline there is no change, so the excess is a gift.
  exact: boolean;
  // Age of the cached fee schedule this was priced from, so the UI can show
  // it; a mint that raised fees since will take more. Undefined when live.
  pricedFromCacheAgeMs?: number;
  proofs: StoredProof[];
}

export interface PreparedSend extends SendQuote {
  txId: string;
  token: string;
}

// `keysetCacheAtMs` is stamped whenever keysets (and `input_fee_ppk`) refresh.
function feeCacheAgeMs(mintUrl: string): number | undefined {
  const at = storedMint(mintUrl)?.keysetCacheAtMs;
  if (at === undefined) return undefined;
  const age = Date.now() - at;
  return age > 0 ? age : undefined;
}

// Price a send without committing. NUT-02 charges the recipient an input fee
// on swap, so we select enough to cover it: "send 100" means "they get 100".
export async function quoteSend(params: {
  amount: number;
  mintUrl?: string;
  unit?: string;
}): Promise<SendQuote> {
  assertUnlocked();
  const unit = params.unit ?? "sat";
  const amount = Math.floor(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletError("insufficient", t("wallet.svc.amount_positive"));
  }

  const account = pickAccount(amount, unit, params.mintUrl);
  const record = storedMint(account.mintUrl);

  // With keysets cached, defer to cashu-ts's selector and fee handling, which
  // get rotated keysets and mixed fee schedules right.
  try {
    const wallet = await getWallet(account.mintUrl, unit, { offline: true });
    const proofLikes = account.proofs.map(toProofLike);
    const result = wallet.sendOffline(amount, proofLikes, {
      includeFees: true,
      exactMatch: true,
    });
    const selected = matchStored(account.proofs, result.send);
    const spend = selected.reduce((s, p) => s + p.amount, 0);
    // `matchStored` silently drops proofs it cannot map. Trusted blindly, that
    // quotes `exact: true` with a short or empty list and a negative fee, and
    // `prepareSend` reserves nothing, serialises a worthless token and reports
    // the payment sent; nothing downstream can tell. Throw into the catch,
    // which re-selects with our own selector: the same path as a cold cache,
    // so no new failure mode.
    if (selected.length !== result.send.length || spend < amount) {
      throw new Error(
        // Not user-facing: an invariant breach for the stack trace.
        `offline selection did not map back to stored proofs (matched ${String(selected.length)} of ${String(result.send.length)}, covering ${String(spend)} of ${String(amount)})`,
      );
    }
    return {
      mintUrl: account.mintUrl,
      unit,
      amount,
      spend,
      fee: spend - amount,
      exact: true,
      proofs: selected,
      pricedFromCacheAgeMs: feeCacheAgeMs(account.mintUrl),
    };
  } catch (err) {
    if (err instanceof WalletError && err.code === "locked") throw err;
    // No exact match or no cached keysets: our selector reports exactness.
    const selection = selectProofsForAmount(
      account.proofs,
      amount,
      record?.feePpkByKeysetId,
    );
    if (!selection) {
      throw new WalletError(
        "insufficient",
        t("wallet.svc.insufficient_at_mint", { mint: hostOf(account.mintUrl) }),
      );
    }
    return {
      mintUrl: account.mintUrl,
      unit,
      amount,
      spend: selection.total,
      fee: selection.fee,
      exact: selection.exact,
      proofs: selection.selected,
      pricedFromCacheAgeMs: feeCacheAgeMs(account.mintUrl),
    };
  }
}

// Reserve the proofs, serialise the token and open a pending transaction.
// Nothing is destroyed until `confirmSend`; the token is kept for re-sharing.
export async function prepareSend(params: {
  amount: number;
  mintUrl?: string;
  unit?: string;
  memo?: string;
  counterparty?: string;
  // The user accepted an inexact amount; otherwise it is refused.
  allowInexact?: boolean;
}): Promise<PreparedSend> {
  const quote = await quoteSend(params);
  if (!quote.exact && params.allowInexact !== true) {
    throw new WalletError(
      "inexact",
      t("wallet.svc.inexact_title", {
        amount: params.amount,
        unit: quote.unit,
      }),
      t("wallet.svc.inexact_detail", {
        spend: quote.spend,
        unit: quote.unit,
        extra: quote.spend - quote.amount,
      }),
    );
  }

  const txId = newTxId();
  const token = buildToken(
    quote.mintUrl,
    quote.proofs,
    quote.unit,
    params.memo,
  );

  const store = useWalletStore.getState();
  // Another send may have claimed these coins since the quote; reserving
  // settles the race, and losing it is a retry.
  if (!store.reserveProofs(txId, quote.mintUrl, quote.unit, quote.proofs)) {
    throw new WalletError(
      "insufficient",
      t("wallet.svc.coins_raced"),
      t("wallet.svc.coins_raced_body"),
    );
  }
  store.addTx({
    id: txId,
    kind: "send",
    status: "pending",
    amount: quote.amount,
    fee: quote.fee,
    unit: quote.unit,
    mintUrl: quote.mintUrl,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    memo: params.memo,
    counterparty: params.counterparty,
    token,
  });

  return { ...quote, txId, token };
}

export function confirmSend(txId: string): void {
  const store = useWalletStore.getState();
  store.dropReserved(txId);
  store.updateTx(txId, { status: "completed" });
}

// Put the proofs back, offline if need be. They come back unverified: the
// token still exists, and whoever holds it can redeem it first, so they are
// only ours once swapped for fresh secrets. `settleReclaim` does that swap
// when the mint is reachable; otherwise the next refresh does.
export function reclaimSend(txId: string): boolean {
  const store = useWalletStore.getState();
  const account = store.reserved[txId]?.account;
  const restored = store.releaseReserved(txId);
  if (!restored || account === undefined) return false;
  const { mintUrl, unit } = parseAccountKey(account);
  const secrets = restored.map((p) => p.secret);
  store.markUnverified(mintUrl, unit, secrets);
  store.updateTx(txId, { status: "reclaimed" });
  reclaimedSecrets.set(txId, secrets);
  return true;
}

// What each reclaim put back, for `settleReclaim`. Not persisted: after a
// restart the unverified flag alone still gets the coins swapped by a refresh.
const reclaimedSecrets = new Map<string, string[]>();

export type ReclaimOutcome = "secured" | "claimed" | "deferred";

// Finish a reclaim at the mint, as cashu.me does by receiving its own token.
// "secured": the coins were swapped, so the token handed out no longer works.
// "claimed": the recipient redeemed it first; the coins are dropped and the
// send counts as completed, since the money did arrive. "deferred": the mint
// could not be asked, and the next refresh settles it.
export async function settleReclaim(txId: string): Promise<ReclaimOutcome> {
  const secrets = reclaimedSecrets.get(txId);
  const tx = useWalletStore.getState().history.find((t) => t.id === txId);
  if (secrets === undefined || tx === undefined) return "deferred";
  if (mintNetworkBlock() !== null) return "deferred";
  const epoch = walletEpoch;
  try {
    const held = (
      useWalletStore.getState().proofs[accountKey(tx.mintUrl, tx.unit)] ?? []
    ).filter((p) => secrets.includes(p.secret));
    if (held.length === 0) return "deferred";
    const wallet = await getWallet(tx.mintUrl, tx.unit);
    const grouped = await wallet.groupProofsByState(held.map(toProofLike));
    assertSameWallet(epoch);
    if (grouped.spent.length === held.length) {
      const store = useWalletStore.getState();
      store.removeProofs(tx.mintUrl, tx.unit, secrets);
      store.updateTx(txId, { status: "completed" });
      reclaimedSecrets.delete(txId);
      return "claimed";
    }
    await refreshAccount(tx.mintUrl, tx.unit);
    reclaimedSecrets.delete(txId);
    return "secured";
  } catch {
    return "deferred";
  }
}

// Keeps the reservation so the token can still be reclaimed or re-shared.
export function failSend(txId: string, reason: string): void {
  useWalletStore.getState().updateTx(txId, { error: reason });
}

// The named mint, or one covering the amount alone: a token cannot combine
// proofs from two mints.
function pickAccount(
  amount: number,
  unit: string,
  preferredMint?: string,
): { mintUrl: string; proofs: StoredProof[] } {
  const state = useWalletStore.getState();
  const candidates = Object.entries(state.proofs)
    .filter(([key]) => key.endsWith(`|${unit}`))
    .map(([key, proofs]) => ({
      mintUrl: key.slice(0, key.length - unit.length - 1),
      proofs,
      balance: proofs.reduce((s, p) => s + p.amount, 0),
    }))
    .sort((a, b) => b.balance - a.balance);

  if (candidates.length === 0) {
    throw new WalletError(
      "no-mint",
      t("wallet.svc.no_ecash"),
      t("wallet.svc.no_ecash_body"),
    );
  }

  if (preferredMint) {
    const url = normalizeMintUrl(preferredMint);
    const hit = candidates.find((c) => c.mintUrl === url);
    if (!hit || hit.balance < amount) {
      throw new WalletError(
        "insufficient",
        t("wallet.svc.insufficient_at_mint", { mint: hostOf(url) }),
      );
    }
    return hit;
  }

  const covering = candidates.find((c) => c.balance >= amount);
  if (covering) return covering;

  const total = candidates.reduce((s, c) => s + c.balance, 0);
  if (total >= amount) {
    throw new WalletError(
      "insufficient",
      t("wallet.svc.split_across_mints"),
      t("wallet.svc.no_single_mint", { amount, unit }),
    );
  }
  throw new WalletError(
    "insufficient",
    t("wallet.svc.have_tried_send", { total, unit, amount }),
  );
}

// By secret, so a reservation removes exactly the rows cashu-ts chose. Drops
// what it cannot find; callers check the count.
function matchStored(stored: StoredProof[], chosen: Proof[]): StoredProof[] {
  const bySecret = new Map(stored.map((p) => [p.secret, p]));
  const out: StoredProof[] = [];
  for (const proof of chosen) {
    const hit = bySecret.get(proof.secret);
    if (hit) out.push(hit);
  }
  return out;
}

// ---- Refresh / reconcile ----

export interface RefreshResult {
  // Face value that was swapped for fresh proofs.
  swapped: number;
  // Number of proofs the mint reported as already spent, now removed.
  spentRemoved: number;
  stillUnverified: number;
  // Swapped only to bring it under the recovery phrase, not because suspect.
  securedForBackup: number;
}

// Bring an account into a known-good state:
//   1. NUT-07 state check; anything spent is removed, never shown as balance.
//   2. Swap surviving unverified proofs, confirming them and cutting the
//      sender's copy loose.
export async function refreshAccount(
  mintUrl: string,
  unit = "sat",
): Promise<RefreshResult> {
  assertUnlocked();
  assertMintNetworkAllowed();

  const url = normalizeMintUrl(mintUrl);
  const store = useWalletStore.getState();
  const key = accountKey(url, unit);
  const epoch = walletEpoch;
  const claimed = secretsAwaitingSwapReplay();
  const held = (store.proofs[key] ?? []).filter((p) => !claimed.has(p.secret));
  if (held.length === 0) {
    return {
      swapped: 0,
      spentRemoved: 0,
      stillUnverified: 0,
      securedForBackup: 0,
    };
  }

  const wallet = await getWallet(url, unit, { forceRefresh: true });

  // Map back to stored rows by secret, a proof's identity.
  let unspent: StoredProof[];
  let spent: StoredProof[];
  try {
    const bySecret = new Map(held.map((p) => [p.secret, p]));
    const grouped = await wallet.groupProofsByState(held.map(toProofLike));
    assertSameWallet(epoch);
    const pick = (list: ProofLike[]): StoredProof[] =>
      list
        .map((p) => bySecret.get(p.secret))
        .filter((p): p is StoredProof => p !== undefined);
    // "pending" means an in-flight melt at the mint, not spent. Keep those.
    unspent = [...pick(grouped.unspent), ...pick(grouped.pending)];
    spent = pick(grouped.spent);
  } catch (err) {
    throw asWalletError(err, "mint-error");
  }

  if (spent.length > 0) {
    store.removeProofs(
      url,
      unit,
      spent.map((p) => p.secret),
    );
    recordTx({
      kind: "swap",
      status: "failed",
      amount: spent.reduce((s, p) => s + p.amount, 0),
      unit,
      mintUrl: url,
      spentRemoved: true,
      error: t("wallet.svc.mint_says_spent"),
    });
  }

  // Swap when either:
  //   not verified  the sender still holds a copy; only fresh secrets make it
  //                 ours, whatever the state check said a moment ago.
  //   not derived   a random secret the phrase cannot rebuild.
  const seedOn = isSeedActive();
  const needsSwap = (proof: StoredProof): boolean =>
    proof.verified !== true || (seedOn && proof.derived !== true);

  const toSwap = unspent.filter(needsSwap);
  const securedOnly = toSwap.filter(
    (proof) => proof.verified === true && proof.derived !== true,
  );
  const securedForBackup = securedOnly.reduce((sum, p) => sum + p.amount, 0);

  store.markVerified(
    url,
    unit,
    unspent.map((p) => p.secret),
  );

  if (toSwap.length === 0) {
    return {
      swapped: 0,
      spentRemoved: spent.length,
      stillUnverified: 0,
      securedForBackup: 0,
    };
  }

  // One batch so the fee is charged once; a swap is all or nothing.
  const face = toSwap.reduce((s, p) => s + p.amount, 0);
  const txId = newTxId();
  let staged = false;
  try {
    // Proofs go in directly, not via a token: there is no mint claim to check.
    const { preview, stored } = await prepareRecoverableSwap(wallet, () =>
      wallet.prepareSwapToReceive(toSwap.map(toProofLike), {
        requireDleq: false,
      }),
    );
    assertSameWallet(epoch);
    // Reserved before the request leaves so a concurrent send cannot pick the
    // same coins and hand over a token this swap is about to spend.
    reserveSwapInputs(txId, url, unit, toSwap);
    store.addTx({
      id: txId,
      kind: "swap",
      status: "pending",
      amount: face,
      unit,
      mintUrl: url,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      swapPreview: stored,
    });
    staged = true;

    const result = await completeSwapInFlight(wallet, txId, preview);
    assertSameWallet(epoch);
    store.dropReserved(txId);
    creditProofs(url, unit, result.keep, { verified: true });
    const received = result.keep.reduce((s, p) => s + p.amount.toNumber(), 0);
    store.updateTx(txId, {
      status: "completed",
      amount: received,
      fee: face - received,
      swapPreview: undefined,
    });
    // Close receipts left open by offline receives, or they read "unconfirmed"
    // forever. One still holding a swap preview is left for `reconcile`.
    for (const open of useWalletStore.getState().history) {
      if (
        open.kind === "receive" &&
        open.status === "pending" &&
        open.swapPreview === undefined &&
        open.mintUrl === url &&
        open.unit === unit
      ) {
        store.updateTx(open.id, { status: "completed" });
      }
    }
    return {
      swapped: received,
      spentRemoved: spent.length,
      stillUnverified: 0,
      securedForBackup,
    };
  } catch (err) {
    // Step 1 stands. A staged swap stays pending with its preview and
    // reservation for `reconcile`, unless the mint refused outright.
    if (walletReplaced(epoch)) throw lockedError();
    const walletErr = asWalletError(err, "mint-error");
    if (staged && isDefiniteRefusal(err)) {
      abandonStagedSwap(txId, walletErr.message);
    } else if (staged) {
      store.updateTx(txId, { error: walletErr.message });
    } else {
      store.releaseReserved(txId);
    }
    throw walletErr;
  }
}

// Spending coins a concurrent send reserved would kill its token, so losing
// this race is a retry.
function reserveSwapInputs(
  txId: string,
  mintUrl: string,
  unit: string,
  inputs: StoredProof[],
): void {
  if (!useWalletStore.getState().reserveProofs(txId, mintUrl, unit, inputs)) {
    throw new WalletError(
      "insufficient",
      t("wallet.svc.coins_raced"),
      t("wallet.svc.coins_raced_body"),
    );
  }
}

// The mint refused outright, so the inputs are untouched and go back.
function abandonStagedSwap(txId: string, reason: string): void {
  const store = useWalletStore.getState();
  store.releaseReserved(txId);
  store.updateTx(txId, {
    status: "failed",
    swapPreview: undefined,
    error: reason,
  });
}

// One pass at a time: a pass walks every pending record serially, one round
// trip each, and can run for minutes, so overlapping passes double every round
// trip. Callers join the pass in flight, so an explicit refresh during an
// automatic pass still awaits a real answer.
let reconcileInFlight: Promise<void> | null = null;
let lastReconcileAtMs = 0;

// Bumped by `resetWalletService`. Long operations re-check it after each await
// so an orphaned pass cannot credit money back into a wiped wallet.
let walletEpoch = 0;

// Floor between automatic passes only; an explicit refresh is never throttled.
const RECONCILE_MIN_INTERVAL_MS = 60_000;

// Settle what a previous session or a lost response left hanging: paid
// deposits, unanswered melts and swaps, redeemed sends. Safe on resume and on
// reconnect: never spends, never credits without the mint, and never throws,
// since each step is best-effort so one dead mint does not block the rest.
export async function reconcile(): Promise<void> {
  if (reconcileInFlight !== null) return reconcileInFlight;
  const epoch = walletEpoch;
  reconcileInFlight = runReconcilePass().finally(() => {
    reconcileInFlight = null;
    // An orphaned pass must not re-arm the throttle a reset cleared.
    if (walletEpoch === epoch) lastReconcileAtMs = Date.now();
  });
  return reconcileInFlight;
}

// Fire-and-forget and throttled. Synchronous so a foreground handler cannot
// await minutes of round trips.
export function reconcileIfDue(): void {
  if (reconcileInFlight !== null) return;
  if (Date.now() - lastReconcileAtMs < RECONCILE_MIN_INTERVAL_MS) return;
  void reconcile().catch(() => {
    // Offline, or a mint is down. The next trigger tries again.
  });
}

// Long: a safety net, not a refresh (what the user sees uses `refreshAccount`).
const STATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Not persisted: a fresh process re-checking once is right.
const lastStateCheckAtMs = new Map<string, number>();

// NUT-07 sweep for proofs spent at the mint with no pending record to follow
// (a swap whose response was lost leaves none), so the next send does not pick
// them and fail. One account per pass, least recently checked, so many mints
// cannot turn a background pass into a burst. Removal only, so it cannot lose
// value; "pending" and replay-claimed proofs are left alone. Storage readiness
// is re-checked because a wipe closes it mid-await.
async function dropSpentProofs(wiped: () => boolean): Promise<void> {
  const claimed = secretsAwaitingSwapReplay();
  const accounts = Object.entries(useWalletStore.getState().proofs)
    .map(
      ([key, held]) =>
        [key, held.filter((p) => !claimed.has(p.secret))] as const,
    )
    .filter(([, held]) => held.length > 0);
  if (accounts.length === 0) return;

  const now = Date.now();
  const due = accounts
    .filter(
      ([key]) =>
        now - (lastStateCheckAtMs.get(key) ?? 0) >= STATE_CHECK_INTERVAL_MS,
    )
    .sort(
      ([a], [b]) =>
        (lastStateCheckAtMs.get(a) ?? 0) - (lastStateCheckAtMs.get(b) ?? 0),
    );
  const next = due[0];
  if (next === undefined) return;

  const [key, held] = next;
  lastStateCheckAtMs.set(key, now);
  const { mintUrl, unit } = parseAccountKey(key);
  try {
    if (wiped() || !isWalletStorageReady()) return;
    const wallet = await getWallet(mintUrl, unit);
    if (wiped() || !isWalletStorageReady()) return;
    const bySecret = new Map(held.map((p) => [p.secret, p]));
    const grouped = await wallet.groupProofsByState(held.map(toProofLike));
    if (wiped() || !isWalletStorageReady()) return;
    const spent = grouped.spent
      .map((p) => bySecret.get(p.secret))
      .filter((p): p is StoredProof => p !== undefined);
    if (spent.length === 0) return;
    useWalletStore.getState().removeProofs(
      mintUrl,
      unit,
      spent.map((p) => p.secret),
    );
  } catch {
    // Unreachable or no NUT-07: the next pass tries again.
  }
}

// Each replay costs up to two round trips (NUT-19, then NUT-09). Nothing is
// dropped: leftovers go first next pass, and passes run at most once a minute.
const MAX_SWAP_REPLAYS_PER_PASS = 4;

// Recover a swap whose answer never arrived. A melt or deposit can ask its
// quote; a swap cannot, so the preview persisted before the request left (the
// exact request plus the blinding factors) is the only way back:
//   NUT-19  resend the byte-identical request. A caching mint returns the same
//           signatures; one that never saw it processes it fresh, also correct.
//   NUT-09  on refusal, ask whether it signed these blinded messages; the
//           stored blinding factors unblind them, deterministic or not.
// Neither answering means the swap did not happen.
//
// Replay only while every input is still ours: an in-doubt token stays
// spendable and may have been handed on, and a mint that never saw the first
// request would process the replay fresh and kill the new holder's token.
// Otherwise NUT-09 alone asks whether the swap happened without making it.
async function replayLostSwap(
  tx: WalletTx,
  wiped: () => boolean,
): Promise<void> {
  const store = useWalletStore.getState();
  const preview = rebuildSwapPreview(tx.swapPreview);
  if (preview === null) {
    // Unreadable preview: a partial replay would be a fresh spend. Release the
    // inputs; `dropSpentProofs` catches them if the mint spent them.
    store.releaseReserved(tx.id);
    store.updateTx(tx.id, {
      status: "failed",
      swapPreview: undefined,
      error: t("wallet.svc.swap_unreadable"),
    });
    return;
  }

  const wallet = await getWallet(tx.mintUrl, tx.unit);
  if (wiped() || !isWalletStorageReady()) return;
  // Settled, or started again in this process, since the pass read history.
  const live = useWalletStore.getState().history.find((t) => t.id === tx.id);
  if (
    swapsInFlight.has(tx.id) ||
    live?.status !== "pending" ||
    live.swapPreview === undefined
  ) {
    return;
  }

  // A nutzap's inputs are locked to our key, so none can have been handed on.
  const replayable = tx.kind === "nutzap-in" || swapInputsHeld(tx, preview);
  if (replayable) {
    try {
      const result = await wallet.completeSwap(preview);
      if (wiped() || !isWalletStorageReady()) return;
      settleReplayedSwap(tx, preview, result.keep, result.send);
      return;
    } catch (err) {
      // Only a mint refusal is final; network errors retry next pass.
      if (asWalletError(err, "mint-error").code !== "mint-error") throw err;
    }
  }

  if (wiped() || !isWalletStorageReady()) return;
  let recovered: SendResponse;
  try {
    recovered = await restoreSwapOutputs(wallet, preview);
  } catch (err) {
    const walletErr = asWalletError(err, "mint-error");
    // A refusal means no NUT-09; a network failure is retried.
    if (walletErr.code !== "mint-error") throw walletErr;
    recovered = { keep: [], send: [] };
  }
  if (wiped() || !isWalletStorageReady()) return;

  if (recovered.keep.length > 0 || recovered.send.length > 0) {
    settleReplayedSwap(tx, preview, recovered.keep, recovered.send);
    return;
  }

  // Stored offline, then passed on, and never swapped: the receive stands, only
  // the in-flight claim goes.
  if (
    !replayable &&
    tx.kind === "receive" &&
    tokenWasStored(preview.inputs.map((p) => p.secret))
  ) {
    store.updateTx(tx.id, { swapPreview: undefined, error: undefined });
    return;
  }

  // Never signed, so the swap did not complete. Inputs go back; their state is
  // for `dropSpentProofs`.
  store.releaseReserved(tx.id);
  store.updateTx(tx.id, {
    status: "failed",
    swapPreview: undefined,
    error: t("wallet.svc.swap_lost"),
  });
}

// Every input is in the spendable pool or reserved to this swap.
function swapInputsHeld(tx: WalletTx, preview: SwapPreview): boolean {
  const state = useWalletStore.getState();
  const held = new Set(
    (state.proofs[accountKey(tx.mintUrl, tx.unit)] ?? []).map((p) => p.secret),
  );
  for (const proof of state.reserved[tx.id]?.proofs ?? []) {
    held.add(proof.secret);
  }
  return preview.inputs.every((input) => held.has(input.secret));
}

// `markClaimed` keys on one of the token's secrets.
function tokenWasStored(secrets: string[]): boolean {
  const claimed = new Set(useWalletStore.getState().claimedTokens);
  return secrets.some((secret) => claimed.has(secret));
}

// NUT-09 for a preview's exact blinded messages: one request, not the gap-limit
// seed scan `batchRestore` does.
async function restoreSwapOutputs(
  wallet: Wallet,
  preview: SwapPreview,
): Promise<SendResponse> {
  const outputs = swapPreviewOutputs(preview);
  const keepCount = swapPreviewKeepCount(preview);
  const response = await wallet.mint.restore({
    outputs: outputs.map((output) => output.blindedMessage),
  });

  // The mint returns only the subset it recognises: pair by blinded message.
  const indexByBlinded = new Map(
    outputs.map((output, index) => [output.blindedMessage.B_, index]),
  );
  const keyset = wallet.getKeyset(preview.keysetId);
  const keep: Proof[] = [];
  const send: Proof[] = [];
  response.outputs.forEach((output, position) => {
    const index = indexByBlinded.get(output.B_);
    const signature = response.signatures[position];
    if (index === undefined || signature === undefined) return;
    const target = outputs[index];
    if (target === undefined) return;
    // `swapPreviewOutputs` lays keeps out first; the rest may be locked to
    // the recipient and must not be credited.
    if (index < keepCount) keep.push(target.toProof(signature, keyset));
    else send.push(target.toProof(signature, keyset));
  });
  return { keep, send };
}

// A send whose token holds coins our swap just spent is dead (the value came
// back through the swap). Fail it rather than let `reconcile` read it as
// redeemed, and return the rest of its reservation.
function voidSendsSpentBySwap(spent: Set<string>): void {
  const store = useWalletStore.getState();
  for (const [txId, entry] of Object.entries(store.reserved)) {
    if (!entry.proofs.some((p) => spent.has(p.secret))) continue;
    const send = store.history.find((t) => t.id === txId);
    if (send?.kind !== "send") continue;
    const { mintUrl, unit } = parseAccountKey(entry.account);
    store.dropReserved(txId);
    store.addProofs(
      mintUrl,
      unit,
      entry.proofs.filter((p) => !spent.has(p.secret)),
    );
    store.updateTx(txId, {
      status: "failed",
      error: t("wallet.svc.send_spent_by_swap"),
    });
  }
}

function settleReplayedSwap(
  tx: WalletTx,
  preview: SwapPreview,
  keep: Proof[],
  send: Proof[],
): void {
  const store = useWalletStore.getState();
  // The inputs are definitively spent; any copy still held (offline-stored or
  // reserved) would count the value twice.
  const spent = preview.inputs.map((p) => p.secret);
  store.removeProofs(tx.mintUrl, tx.unit, spent);
  store.dropReserved(tx.id);
  voidSendsSpentBySwap(new Set(spent));
  if (keep.length > 0) {
    creditProofs(tx.mintUrl, tx.unit, keep, { verified: true });
  }
  const received = keep.reduce((sum, p) => sum + p.amount.toNumber(), 0);

  if (send.length > 0) {
    // Outputs locked to a nutzap recipient: keep the token pending until the
    // nutzap pass sees it redeemed.
    store.updateTx(tx.id, {
      swapPreview: undefined,
      token: buildToken(
        tx.mintUrl,
        send.map((p) => toStoredProof(p, { verified: true })),
        tx.unit,
      ),
      error: t("wallet.svc.locked_undelivered"),
    });
    return;
  }

  // Stops the next subscription redeeming a zap already banked.
  if (tx.nutzapEventId !== undefined)
    store.markNutzapRedeemed(tx.nutzapEventId);
  store.updateTx(tx.id, {
    status: "completed",
    swapPreview: undefined,
    error: undefined,
    ...(received > 0 ? { amount: received } : {}),
  });
}

async function runReconcilePass(): Promise<void> {
  if (!isWalletStorageReady()) return;
  if (mintNetworkBlock() !== null) return;

  const epoch = walletEpoch;
  const wiped = (): boolean => walletEpoch !== epoch;
  const state = useWalletStore.getState();

  // Deposits paid while the app was shut.
  for (const tx of state.history) {
    if (tx.kind !== "mint" || tx.status !== "pending" || !tx.quoteId) continue;
    if (wiped()) return;
    try {
      await claimLightningDeposit(tx.mintUrl, tx.unit, tx.quoteId);
    } catch {
      // Still unpaid, or the mint is unreachable. Left pending for next time.
    }
  }

  // Unanswered melts: if paid, the change is signed against blanks only this
  // device can unblind.
  for (const tx of state.history) {
    if (tx.kind !== "melt" || tx.status !== "pending") continue;
    if (!tx.quoteId || tx.meltOutputs === undefined) continue;
    // Its answer is not late, it is still on its way.
    if (meltsInFlight.has(tx.id)) continue;
    if (wiped()) return;
    try {
      await recoverMeltChange(tx);
    } catch {
      // Still unknown, or the mint is unreachable. The blanks stay put.
    }
  }

  // Unanswered swaps, before the send check: until replayed, their value is
  // unaccounted for, not merely mislabelled.
  let replayed = 0;
  for (const tx of state.history) {
    if (tx.status !== "pending" || tx.swapPreview === undefined) continue;
    // Its answer is not late, it is still on its way.
    if (swapsInFlight.has(tx.id)) continue;
    if (replayed >= MAX_SWAP_REPLAYS_PER_PASS) break;
    if (wiped() || !isWalletStorageReady()) return;
    replayed += 1;
    try {
      await replayLostSwap(tx, wiped);
    } catch {
      // The preview stays; the next pass asks again.
    }
  }

  // Sends and melts the recipient has redeemed: close them rather than offer a
  // reclaim the mint would refuse. Swaps and locks are skipped: their inputs
  // are spent because the swap happened, and only the replay can recover the
  // outputs. Likewise a send touching replay-claimed coins, where "spent" may
  // mean our own swap took them. Read fresh: a replay above may already have
  // failed a send, and confirming on the stale snapshot would overwrite it.
  const awaitingReplay = secretsAwaitingSwapReplay();
  const current = useWalletStore.getState();
  for (const [txId, entry] of Object.entries(current.reserved)) {
    const tx = current.history.find((t) => t.id === txId);
    if (!tx || tx.status !== "pending") continue;
    if (tx.kind === "swap" || tx.kind === "nutzap-out") continue;
    if (tx.swapPreview !== undefined || meltsInFlight.has(txId)) continue;
    if (entry.proofs.some((p) => awaitingReplay.has(p.secret))) continue;
    if (wiped()) return;
    try {
      const wallet = await getWallet(tx.mintUrl, tx.unit);
      const grouped = await wallet.groupProofsByState(
        entry.proofs.map(toProofLike),
      );
      if (wiped()) return;
      // Reclaimed or settled while the mint was answering.
      if (useWalletStore.getState().reserved[txId] === undefined) continue;
      if (grouped.spent.length === entry.proofs.length) confirmSend(txId);
    } catch {
      // Unreachable mint: leave the reservation alone.
    }
  }

  // Undelivered locked nutzaps (relay refused the kind 9321 and no transport
  // carried the token) are pending and deliberately not reclaimable. They have
  // no reservation, so the loop above misses them. Close each once the
  // recipient redeems (possibly via the outbox days later), or the sender's
  // Pending list shows a payment that landed.
  for (const tx of state.history) {
    if (tx.kind !== "nutzap-out" || tx.status !== "pending") continue;
    if (tx.token === undefined || state.reserved[tx.id] !== undefined) continue;
    if (wiped()) return;
    try {
      const info = decodeToken(
        tx.token,
        selectKeysetIds(useWalletStore.getState()),
      );
      if (!info) continue;
      const wallet = await getWallet(tx.mintUrl, tx.unit);
      const grouped = await wallet.groupProofsByState(info.token.proofs);
      if (grouped.spent.length === info.token.proofs.length) {
        useWalletStore
          .getState()
          .updateTx(tx.id, { status: "completed", error: undefined });
      }
    } catch {
      // Unreachable mint, or a token we can no longer parse. Try again later.
    }
  }

  // Last, so the targeted walks above resolve what they can first.
  if (!wiped()) await dropSpentProofs(wiped);
}

// ---- Lightning: deposit (mint) ----

export interface LightningDeposit {
  txId: string;
  quoteId: string;
  invoice: string;
  amount: number;
  unit: string;
  mintUrl: string;
  expiresAtMs?: number;
}

// Ask the mint for a bolt11 invoice whose payment mints ecash (NUT-04): the only
// way value enters without somebody handing over a token.
export async function createLightningDeposit(params: {
  amount: number;
  mintUrl: string;
  unit?: string;
  description?: string;
}): Promise<LightningDeposit> {
  assertUnlocked();
  assertMintNetworkAllowed();
  const unit = params.unit ?? "sat";
  const url = normalizeMintUrl(params.mintUrl);
  const amount = Math.floor(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletError("insufficient", t("wallet.svc.amount_positive"));
  }

  const wallet = await getWallet(url, unit);
  requireNut(url, 4, t("wallet.svc.issue_against_invoice"));

  let quote: MintQuoteBolt11Response;
  try {
    quote = await wallet.createMintQuoteBolt11(amount, params.description);
  } catch (err) {
    throw asWalletError(err, "mint-error");
  }

  const txId = newTxId();
  useWalletStore.getState().addTx({
    id: txId,
    kind: "mint",
    status: "pending",
    amount,
    unit,
    mintUrl: url,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    quoteId: quote.quote,
    invoice: quote.request,
    memo: params.description,
    counterparty: hostOf(url),
  });

  return {
    txId,
    quoteId: quote.quote,
    invoice: quote.request,
    amount,
    unit,
    mintUrl: url,
    expiresAtMs:
      typeof quote.expiry === "number" ? quote.expiry * 1000 : undefined,
  };
}

// The deposit sheet's poll and `reconcile` can overlap on one quote. The mint
// issues against one claim and refuses the other, and the loser's outputs would
// overwrite the winner's record. The second caller gets "still unpaid".
const claimsInFlight = new Set<string>();

// Mint the proofs once the invoice is paid. Throws while unpaid, so callers
// poll or leave it to `reconcile`.
export async function claimLightningDeposit(
  mintUrl: string,
  unit: string,
  quoteId: string,
): Promise<number> {
  assertUnlocked();
  assertMintNetworkAllowed();
  if (claimsInFlight.has(quoteId)) {
    throw new WalletError("offline", t("wallet.svc.invoice_unpaid"));
  }
  claimsInFlight.add(quoteId);
  try {
    return await claimLightningDepositOnce(mintUrl, unit, quoteId);
  } finally {
    claimsInFlight.delete(quoteId);
  }
}

async function claimLightningDepositOnce(
  mintUrl: string,
  unit: string,
  quoteId: string,
): Promise<number> {
  const url = normalizeMintUrl(mintUrl);
  const store = useWalletStore.getState();
  const epoch = walletEpoch;
  const tx = store.history.find(
    (t) => t.quoteId === quoteId && t.kind === "mint",
  );
  if (!tx) throw new WalletError("mint-error", t("wallet.svc.unknown_deposit"));

  const wallet = await getWallet(url, unit);
  let quote: MintQuoteBolt11Response;
  try {
    quote = await wallet.checkMintQuoteBolt11(quoteId);
  } catch (err) {
    throw asWalletError(err, "mint-error");
  }
  assertSameWallet(epoch);

  // NUT-04: UNPAID -> PAID -> ISSUED; only PAID mints, once. ISSUED with
  // stored outputs is a lost answer; without them the transaction just closes.
  if (quote.state === "ISSUED") {
    if (tx.mintOutputs !== undefined) {
      return recoverMintOutputs(wallet, tx, quote);
    }
    store.updateTx(tx.id, { status: "completed" });
    return 0;
  }
  if (quote.state !== "PAID") {
    const expired =
      typeof quote.expiry === "number" && quote.expiry * 1000 < Date.now();
    if (expired) {
      store.updateTx(tx.id, {
        status: "expired",
        error: t("wallet.svc.invoice_expired_before"),
      });
      throw new WalletError("mint-error", t("wallet.svc.invoice_expired"));
    }
    throw new WalletError("offline", t("wallet.svc.invoice_unpaid"));
  }

  // Outputs on disk before the request, so the ISSUED branch can replay a lost
  // response.
  let preview: MintPreview<MintQuoteBolt11Response>;
  try {
    preview = await wallet.prepareMint("bolt11", tx.amount, quote);
  } catch (err) {
    throw asWalletError(err, "mint-error");
  }
  assertSameWallet(epoch);
  store.updateTx(tx.id, {
    mintOutputs: preview.outputData.map((output) =>
      OutputData.serialize(output),
    ),
  });
  let proofs: Proof[];
  try {
    proofs = await wallet.completeMint(preview);
  } catch (err) {
    if (walletReplaced(epoch)) throw lockedError();
    const walletErr = asWalletError(err, "mint-error");
    store.updateTx(tx.id, { error: walletErr.message });
    throw walletErr;
  }
  assertSameWallet(epoch);
  creditProofs(url, unit, proofs, { verified: true });
  const minted = proofs.reduce((s, p) => s + p.amount.toNumber(), 0);
  store.updateTx(tx.id, {
    status: "completed",
    amount: minted,
    mintOutputs: undefined,
  });
  return minted;
}

// Rebuild an ISSUED deposit this device never received: NUT-19 replay, then
// NUT-09. If neither answers it closes with a note; the mint's answer will not
// change, and a phrase restore still reaches deterministic outputs.
async function recoverMintOutputs(
  wallet: Wallet,
  tx: WalletTx,
  quote: MintQuoteBolt11Response,
): Promise<number> {
  const store = useWalletStore.getState();
  const epoch = walletEpoch;
  let outputs: OutputData[];
  try {
    outputs = (tx.mintOutputs as SerializedOutputData[]).map((entry) =>
      OutputData.deserialize(entry),
    );
  } catch {
    outputs = [];
  }
  const keysetId = outputs[0]?.blindedMessage.id;
  if (outputs.length === 0 || keysetId === undefined) {
    store.updateTx(tx.id, {
      status: "completed",
      mintOutputs: undefined,
      error: t("wallet.svc.mint_lost"),
    });
    return 0;
  }

  let proofs: Proof[] = [];
  try {
    proofs = await wallet.completeMint({
      method: "bolt11",
      payload: {
        quote: quote.quote,
        outputs: outputs.map((output) => output.blindedMessage),
      },
      outputData: outputs,
      keysetId,
      quote,
    });
  } catch (err) {
    // Only a refusal is final; network errors retry next pass.
    if (asWalletError(err, "mint-error").code !== "mint-error") throw err;
  }

  if (proofs.length === 0) {
    try {
      const response = await wallet.mint.restore({
        outputs: outputs.map((output) => output.blindedMessage),
      });
      const byBlinded = new Map(
        outputs.map((output) => [output.blindedMessage.B_, output]),
      );
      // The keyset may have rotated since the outputs were built.
      await wallet.ensureOperableKeysets([keysetId]);
      persistMintSnapshot(tx.mintUrl, tx.unit, wallet);
      const keyset = wallet.getKeyset(keysetId);
      response.outputs.forEach((output, position) => {
        const target = byBlinded.get(output.B_);
        const signature = response.signatures[position];
        if (target !== undefined && signature !== undefined) {
          proofs.push(target.toProof(signature, keyset));
        }
      });
    } catch (err) {
      if (asWalletError(err, "mint-error").code !== "mint-error") throw err;
    }
  }

  assertSameWallet(epoch);
  const minted = proofs.reduce((sum, p) => sum + p.amount.toNumber(), 0);
  if (minted > 0) {
    creditProofs(tx.mintUrl, tx.unit, proofs, { verified: true });
  }
  store.updateTx(tx.id, {
    status: "completed",
    mintOutputs: undefined,
    ...(minted > 0
      ? { amount: minted, error: undefined }
      : { error: t("wallet.svc.mint_lost") }),
  });
  return minted;
}

// ---- Lightning: withdraw (melt) ----

// cashu-ts's documented `MeltChangeError` recovery: resolve every keyset in the
// signatures (a mint may sign across several), then rebuild from the blanks.
// Empty is not a failed melt; the caller keeps the blanks for
// `recoverMeltChange`.
async function rebuildMeltChange(
  wallet: Wallet,
  mintUrl: string,
  unit: string,
  err: MeltChangeError,
): Promise<Proof[]> {
  const signatures = err.quote.change ?? [];
  if (signatures.length === 0) return [];
  try {
    await wallet.ensureOperableKeysets(signatures.map((sig) => sig.id));
  } catch {
    // Keys that landed are kept; the rebuild decides.
  }
  // Explicit calls emit no `keychainUpdated`, so persist here.
  persistMintSnapshot(mintUrl, unit, wallet);
  try {
    return wallet.createMeltChangeProofs(err.outputData, signatures);
  } catch {
    // Bad DLEQ or mismatched count: only a NUT-09 restore can help.
    return [];
  }
}

// Settle a melt whose response was lost, from the blanks saved before the
// request. Only the mint knows whether the invoice was paid, so ask its quote:
//   PAID    rebuild and credit the change, drop the spent reservation.
//   UNPAID  never happened; release the reservation.
//   PENDING still routing; leave it.
async function recoverMeltChange(tx: WalletTx): Promise<void> {
  if (!tx.quoteId) return;
  const store = useWalletStore.getState();
  const epoch = walletEpoch;
  const wallet = await getWallet(tx.mintUrl, tx.unit);
  const quote = await wallet.checkMeltQuoteBolt11(tx.quoteId);
  if (walletReplaced(epoch)) return;
  // Started in this process after the pass read the history.
  if (meltsInFlight.has(tx.id)) return;

  if (quote.state === "PENDING") return;

  if (quote.state === "UNPAID") {
    store.releaseReserved(tx.id);
    store.updateTx(tx.id, {
      status: "failed",
      error: t("wallet.svc.mint_did_not_pay"),
      meltOutputs: undefined,
    });
    return;
  }

  // PAID.
  let recovered = 0;
  const signatures = quote.change ?? [];
  if (signatures.length > 0 && Array.isArray(tx.meltOutputs)) {
    try {
      const outputs = (tx.meltOutputs as SerializedOutputData[]).map((entry) =>
        OutputData.deserialize(entry),
      );
      // The change was signed when the mint paid, possibly under a keyset
      // newer than the snapshot. Fetch those keys first, or recoverable change
      // is written off for want of a key fetch.
      try {
        await wallet.ensureOperableKeysets(signatures.map((sig) => sig.id));
        persistMintSnapshot(tx.mintUrl, tx.unit, wallet);
      } catch {
        // Keys that landed are kept; the rebuild decides.
      }
      if (walletReplaced(epoch)) return;
      const change = wallet.createMeltChangeProofs(outputs, signatures);
      if (change.length > 0) {
        creditProofs(tx.mintUrl, tx.unit, change, { verified: true });
        recovered = change.reduce((sum, p) => sum + p.amount.toNumber(), 0);
      }
    } catch {
      // Bad blanks: the payment still succeeded, so close anyway.
    }
  }

  store.dropReserved(tx.id);
  store.updateTx(tx.id, {
    status: "completed",
    error: undefined,
    meltOutputs: undefined,
    ...(recovered > 0 ? { fee: Math.max(0, (tx.fee ?? 0) - recovered) } : {}),
  });
}

export interface MeltQuote {
  quoteId: string;
  mintUrl: string;
  unit: string;
  // Amount the invoice pays out.
  amount: number;
  // Routing reserve the mint holds back; any unused part comes back as change.
  feeReserve: number;
  // What leaves the wallet in the worst case.
  total: number;
  invoice: string;
  expiresAtMs?: number;
  // The mint's quote verbatim for `prepareMelt`. Holds Amount objects, so it
  // does not survive a restart; re-quoting is right anyway, since fee reserves
  // and invoice expiry both move.
  raw: MeltQuoteBolt11Response;
}

// The fee reserve is an upper bound (unused routing returns as change), so the
// UI shows it as "up to".
export async function quoteLightningWithdrawal(params: {
  invoice: string;
  mintUrl: string;
  unit?: string;
}): Promise<MeltQuote> {
  assertUnlocked();
  assertMintNetworkAllowed();
  const unit = params.unit ?? "sat";
  const url = normalizeMintUrl(params.mintUrl);
  const invoice = params.invoice.trim().replace(/^lightning:/i, "");
  if (!/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) {
    throw new WalletError(
      "invalid-token",
      t("wallet.svc.not_an_invoice"),
      t("wallet.svc.not_an_invoice_body"),
    );
  }

  const wallet = await getWallet(url, unit);
  requireNut(url, 5, t("wallet.svc.pay_invoice"));

  let quote: MeltQuoteBolt11Response;
  try {
    quote = await wallet.createMeltQuoteBolt11(invoice);
  } catch (err) {
    throw asWalletError(err, "mint-error");
  }

  const amount = quote.amount.toNumber();
  const feeReserve = quote.fee_reserve.toNumber();
  const total = amount + feeReserve;

  const balance = (
    useWalletStore.getState().proofs[accountKey(url, unit)] ?? []
  ).reduce((s, p) => s + p.amount, 0);
  if (balance < total) {
    throw new WalletError(
      "insufficient",
      t("wallet.svc.invoice_needs", { total, unit, balance }),
    );
  }

  return {
    quoteId: quote.quote,
    mintUrl: url,
    unit,
    amount,
    feeReserve,
    total,
    invoice,
    expiresAtMs:
      typeof quote.expiry === "number" ? quote.expiry * 1000 : undefined,
    raw: quote,
  };
}

interface MeltSelection {
  selected: StoredProof[];
  // What actually leaves the wallet; selectors over-select, so not `quote.total`.
  total: number;
}

// cashu-ts's selector first: ours ranks unverified proofs first, right for a
// send but wrong for a melt, where the mint checks every input at once. Ours is
// the cold-cache fallback.
function selectForMelt(
  wallet: Wallet,
  quote: MeltQuote,
  available: StoredProof[],
): MeltSelection {
  let selected: StoredProof[];
  try {
    const result = wallet.selectProofsToSend(
      available.map(toProofLike),
      quote.total,
      true,
    );
    selected = matchStored(available, result.send);
    // `matchStored` drops unmapped proofs, which would under-fund the melt.
    if (
      selected.length !== result.send.length ||
      selected.reduce((s, p) => s + p.amount, 0) < quote.total
    ) {
      throw new Error("melt selection did not map back to stored proofs");
    }
  } catch {
    const fallback = selectProofsForAmount(
      available,
      quote.total,
      storedMint(quote.mintUrl)?.feePpkByKeysetId,
    );
    if (!fallback) {
      throw new WalletError(
        "insufficient",
        t("wallet.svc.insufficient_for_invoice"),
      );
    }
    selected = fallback.selected;
  }
  return {
    selected,
    total: selected.reduce((sum, p) => sum + p.amount, 0),
  };
}

// Overshoot worth breaking up first. Ten percent is roughly where other wallets
// draw the line; the floor (in the account's unit) skips amounts too small to
// matter.
const MELT_SWAPDOWN_PERCENT = 10;
const MELT_SWAPDOWN_MIN_OVERAGE = 16;

// Swap an oversized selection down before the melt. No value is at stake:
// `prepareMelt` sizes the NUT-08 blanks from the actual overage, so the excess
// returns as change regardless. Time is: the reservation holds every input for
// minutes of routing, so paying 100 from a single 512 and walking into a dead
// zone leaves 412 nobody can be handed. Best effort, and the give-up rules are
// what make it safe in front of a confirmed payment:
//   nothing sent   melt with the original selection (slow success, not a
//                  failure).
//   request sent   the mint may have taken the inputs and spending them again
//                  would be a guess, so fail and let `reconcile` settle the
//                  swap; a retry picks up whatever it decided.
async function swapDownForMelt(
  wallet: Wallet,
  quote: MeltQuote,
  selection: MeltSelection,
): Promise<MeltSelection> {
  const overage = selection.total - quote.total;
  if (overage < MELT_SWAPDOWN_MIN_OVERAGE) return selection;
  if (overage * 100 < quote.total * MELT_SWAPDOWN_PERCENT) return selection;

  const store = useWalletStore.getState();
  const epoch = walletEpoch;
  const txId = newTxId();
  let staged = false;
  let result: SendResponse;
  const offered = new Set(selection.selected.map((p) => p.secret));
  let spending = 0;
  try {
    const online = await getWallet(quote.mintUrl, quote.unit);
    const { preview, stored } = await prepareRecoverableSwap(online, () =>
      online.prepareSwapToSend(
        quote.total,
        selection.selected.map(toProofLike),
        { includeFees: true },
      ),
    );
    assertSameWallet(epoch);
    // Only what the swap spends; the rest never leaves the pool.
    const inputs = matchStored(selection.selected, preview.inputs);
    if (inputs.length !== preview.inputs.length) return selection;
    try {
      reserveSwapInputs(txId, quote.mintUrl, quote.unit, inputs);
    } catch {
      // Raced by another payment; nothing sent, the melt's reservation reports it.
      return selection;
    }
    spending = inputs.reduce((sum, p) => sum + p.amount, 0);
    store.addTx({
      id: txId,
      kind: "swap",
      status: "pending",
      amount: spending,
      unit: quote.unit,
      mintUrl: quote.mintUrl,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      swapPreview: stored,
    });
    staged = true;
    result = await completeSwapInFlight(online, txId, preview);
    assertSameWallet(epoch);
  } catch (err) {
    if (walletReplaced(epoch)) throw lockedError();
    if (!staged) {
      store.releaseReserved(txId);
      return selection;
    }
    const walletErr = asWalletError(err, "mint-error");
    if (isDefiniteRefusal(err)) {
      abandonStagedSwap(txId, walletErr.message);
    } else {
      store.updateTx(txId, { error: walletErr.message });
    }
    throw walletErr;
  }

  // `keep` echoes untouched originals; credit only new proofs, or an original
  // spent or reserved meanwhile would come back.
  store.dropReserved(txId);
  const fresh = [...result.keep, ...result.send].filter(
    (p) => !offered.has(p.secret),
  );
  creditProofs(quote.mintUrl, quote.unit, fresh, { verified: true });
  const received = fresh.reduce((sum, p) => sum + p.amount.toNumber(), 0);
  store.updateTx(txId, {
    status: "completed",
    amount: received,
    fee: Math.max(0, spending - received),
    swapPreview: undefined,
  });

  // Re-select through the same path, so fees and shortfalls behave identically.
  return selectForMelt(
    wallet,
    quote,
    useWalletStore.getState().proofs[accountKey(quote.mintUrl, quote.unit)] ??
      [],
  );
}

// Pay a quoted invoice. Proofs are reserved first and dropped only on confirmed
// payment; an ambiguous failure keeps the reservation for `reconcile`.
export async function payLightningInvoice(quote: MeltQuote): Promise<{
  paid: number;
  fee: number;
  changeReturned: number;
  preimage?: string;
}> {
  assertUnlocked();
  assertMintNetworkAllowed();

  const store = useWalletStore.getState();
  const key = accountKey(quote.mintUrl, quote.unit);
  const epoch = walletEpoch;

  const wallet = await getWallet(quote.mintUrl, quote.unit, { offline: true });
  const selection = await swapDownForMelt(
    wallet,
    quote,
    selectForMelt(wallet, quote, useWalletStore.getState().proofs[key] ?? []),
  );
  assertSameWallet(epoch);

  const txId = newTxId();
  if (
    !store.reserveProofs(txId, quote.mintUrl, quote.unit, selection.selected)
  ) {
    throw new WalletError(
      "insufficient",
      t("wallet.svc.coins_raced"),
      t("wallet.svc.coins_raced_invoice_body"),
    );
  }
  store.addTx({
    id: txId,
    kind: "melt",
    status: "pending",
    amount: quote.amount,
    fee: quote.feeReserve,
    unit: quote.unit,
    mintUrl: quote.mintUrl,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    quoteId: quote.quoteId,
    invoice: quote.invoice,
    counterparty: "lightning",
  });

  // Before the blanks are written, so `reconcile` never sees this quote UNPAID
  // and releases proofs the melt is about to spend.
  meltsInFlight.add(txId);
  try {
    const wallet = await getWallet(quote.mintUrl, quote.unit);
    assertSameWallet(epoch);

    // Blanks on disk before the request: their blinding factors are the only
    // way to unblind the change after a lost response.
    const preview = await wallet.prepareMelt(
      "bolt11",
      quote.raw,
      selection.selected.map(toProofLike),
    );
    assertSameWallet(epoch);
    store.updateTx(txId, {
      meltOutputs: preview.outputData.map((output) =>
        OutputData.serialize(output),
      ),
    });

    let change: Proof[];
    let preimage: string | undefined;
    try {
      const result = await withMeltTimeout(() => wallet.completeMelt(preview));
      assertSameWallet(epoch);
      change = result.change;
      preimage = result.quote.payment_preimage ?? undefined;
    } catch (err) {
      if (!(err instanceof MeltChangeError)) throw err;
      assertSameWallet(epoch);
      // Not a failure: the invoice is PAID and only the change is stuck,
      // usually behind a keyset rotated since the quote.
      change = await rebuildMeltChange(wallet, quote.mintUrl, quote.unit, err);
      assertSameWallet(epoch);
      // Still no change: stay pending with the blanks for `recoverMeltChange`.
      // Its own code, so the user is not told a paid invoice was refused.
      if (change.length === 0 && (err.quote.change ?? []).length > 0) {
        throw new WalletError(
          "change-pending",
          t("wallet.svc.melt_change_pending"),
          t("wallet.svc.melt_change_pending_body"),
        );
      }
      // Only the bolt11 response carries a preimage; this path has the base
      // quote.
      preimage = undefined;
    }

    if (change.length > 0) {
      creditProofs(quote.mintUrl, quote.unit, change, { verified: true });
    }
    const changeReturned = change.reduce((s, p) => s + p.amount.toNumber(), 0);
    const spent = selection.total - changeReturned;

    store.dropReserved(txId);
    store.updateTx(txId, {
      status: "completed",
      fee: spent - quote.amount,
      meltOutputs: undefined,
    });
    return {
      paid: quote.amount,
      fee: spent - quote.amount,
      changeReturned,
      preimage,
    };
  } catch (err) {
    if (walletReplaced(epoch)) throw lockedError();
    const walletErr = asWalletError(err, "mint-error");
    // Release only on a definite refusal: after a network error the payment
    // may have gone through. "Already spent" may be the NUT-19 retry reporting
    // our own paid first attempt; releasing on it would show a balance the mint
    // burned and clear the blanks, losing the change for good. `change-pending`
    // is a paid invoice. Both stay with the blanks for the quote to decide.
    if (walletErr.code === "mint-error" && !isAlreadySpentError(walletErr)) {
      store.releaseReserved(txId);
      store.updateTx(txId, {
        status: "failed",
        error: walletErr.message,
        meltOutputs: undefined,
      });
    } else {
      // `change-pending` already knows it paid, so it is not called in doubt.
      store.updateTx(txId, {
        error:
          walletErr.code === "change-pending"
            ? walletErr.message
            : `${walletErr.message} ${t("wallet.svc.payment_unknown")}`,
      });
    }
    throw walletErr;
  } finally {
    meltsInFlight.delete(txId);
  }
}

// ---- Consolidate across mints ----

export interface ConsolidateResult {
  fromMintUrl: string;
  toMintUrl: string;
  unit: string;
  // What left the source mint, including the Lightning routing fee.
  spent: number;
  // What arrived at the destination.
  received: number;
  fee: number;
  // Source paid, destination not issued yet; `reconcile` claims the deposit.
  depositPending?: boolean;
}

// Fee reserves are usually under 1%, but the first guess needs room; the loop
// corrects it.
const CONSOLIDATE_FEE_GUESS = 0.02;
const CONSOLIDATE_MIN_BUFFER = 2;
// Each attempt is a live round trip; two corrections cover realistic fees.
const CONSOLIDATE_MAX_ATTEMPTS = 3;

// Move value between mints: the source melts to an invoice the destination
// issued. A token names one mint, so a split balance cannot be combined; this
// costs one routing fee rather than the two of doing it through an outside
// Lightning wallet. The fee reserve is only known once an invoice exists, which
// needs an amount, so this quotes, checks the fit and shrinks if needed.
export async function consolidateMints(params: {
  fromMintUrl: string;
  toMintUrl: string;
  unit?: string;
  // Amount to arrive at the destination. Omit to move as much as will fit.
  amount?: number;
}): Promise<ConsolidateResult> {
  assertUnlocked();
  assertMintNetworkAllowed();

  const unit = params.unit ?? "sat";
  const from = normalizeMintUrl(params.fromMintUrl);
  const to = normalizeMintUrl(params.toMintUrl);
  if (from === to) {
    throw new WalletError(
      "no-mint",
      t("wallet.svc.same_mint"),
      t("wallet.svc.same_mint_body"),
    );
  }

  requireNut(from, 5, t("wallet.svc.pay_invoice"));
  requireNut(to, 4, t("wallet.svc.issue_against_invoice"));

  const store = useWalletStore.getState();
  const available = store.proofs[accountKey(from, unit)] ?? [];
  const sourceBalance = available.reduce((s, p) => s + p.amount, 0);
  if (sourceBalance <= 0) {
    throw new WalletError(
      "insufficient",
      t("wallet.svc.nothing_to_move", { mint: hostOf(from), unit }),
    );
  }

  // First guess: everything, less a buffer for the routing fee.
  let target =
    params.amount ??
    sourceBalance -
      Math.max(
        CONSOLIDATE_MIN_BUFFER,
        Math.ceil(sourceBalance * CONSOLIDATE_FEE_GUESS),
      );

  for (let attempt = 0; attempt < CONSOLIDATE_MAX_ATTEMPTS; attempt++) {
    if (target <= 0) break;

    const deposit = await createLightningDeposit({
      amount: target,
      mintUrl: to,
      unit,
      description: t("wallet.svc.consolidate_memo", { mint: hostOf(from) }),
    });

    let quote: MeltQuote;
    try {
      quote = await quoteLightningWithdrawal({
        invoice: deposit.invoice,
        mintUrl: from,
        unit,
      });
    } catch (err) {
      abandonDeposit(deposit.txId, t("wallet.svc.quote_failed_retried"));
      const walletErr = asWalletError(err, "mint-error");
      if (walletErr.code !== "insufficient") throw walletErr;
      target = Math.floor(target * 0.95);
      continue;
    }

    // Invoice, routing reserve and input fees all come from one balance.
    const inputFee = feeForProofs(
      available,
      storedMint(from)?.feePpkByKeysetId,
    );
    if (quote.total + inputFee > sourceBalance) {
      abandonDeposit(deposit.txId, t("wallet.svc.amount_unfit_retried"));
      const overshoot = quote.total + inputFee - sourceBalance;
      target -= overshoot;
      continue;
    }

    let meltFee: number;
    try {
      meltFee = (await payLightningInvoice(quote)).fee;
    } catch (err) {
      // Paid, change outstanding: report the move at its worst-case fee.
      if (!(err instanceof WalletError && err.code === "change-pending")) {
        throw err;
      }
      meltFee = quote.feeReserve;
    }
    // After the melt, a failed claim is a delay: the deposit stays pending.
    let received = 0;
    let depositPending = false;
    try {
      received = await claimLightningDeposit(to, unit, deposit.quoteId);
    } catch (err) {
      if (err instanceof WalletError && err.code === "locked") throw err;
      depositPending = true;
    }

    // Actual cost, not `quote.total` (which includes the refunded reserve).
    const spent = quote.amount + meltFee;

    return {
      fromMintUrl: from,
      toMintUrl: to,
      unit,
      spent,
      received,
      fee: depositPending ? meltFee : spent - received,
      ...(depositPending ? { depositPending } : {}),
    };
  }

  throw new WalletError(
    "insufficient",
    t("wallet.svc.cannot_size"),
    t("wallet.svc.cannot_size_detail", { from: hostOf(from), to: hostOf(to) }),
  );
}

// Close an unused deposit quote so it does not show as awaiting payment.
function abandonDeposit(txId: string, reason: string): void {
  useWalletStore.getState().updateTx(txId, {
    status: "expired",
    error: reason,
  });
}

// ---- NUT support gating ----

// Fail before a network round trip when the mint has told us it cannot do this.
function requireNut(mintUrl: string, nut: number, what: string): void {
  const nuts = storedMint(mintUrl)?.supportedNuts;
  if (!nuts || nuts.length === 0) return; // unknown: let the mint decide
  if (nuts.includes(nut)) return;
  throw new WalletError(
    "unsupported",
    t("wallet.svc.mint_cannot", { mint: hostOf(mintUrl), action: what }),
    t("wallet.svc.no_nut", { nut }),
  );
}

// ---- P2PK identity (NIP-61) ----

// The P2PK key senders lock nutzaps to. It must be stable, or published kind
// 10019 events name a key we cannot spend from, and it lives in the keychain,
// never the proof store.
const P2PK_KEY_ITEM = KEYCHAIN_ITEMS.walletP2pkKey;

let nutzapPrivKey: Promise<string> | null = null;

async function getNutzapPrivKeyHex(): Promise<string> {
  // Single-flight: two concurrent first reads would each mint a key, and the
  // loser's pubkey could be published while the keychain holds the other.
  nutzapPrivKey ??= (async () => {
    const existing = await readSecret(P2PK_KEY_ITEM);
    if (typeof existing === "string" && /^[0-9a-f]{64}$/i.test(existing)) {
      return existing.toLowerCase();
    }
    const fresh = bytesToHex(secp256k1.utils.randomSecretKey());
    await writeSecret(P2PK_KEY_ITEM, fresh);
    return fresh;
  })();
  try {
    return await nutzapPrivKey;
  } catch (error) {
    // Do not cache a locked keychain as the answer.
    nutzapPrivKey = null;
    throw error;
  }
}

// 33-byte compressed, hex: the kind 10019 `pubkey` tag.
async function getNutzapPubKeyHex(): Promise<string> {
  const priv = await getNutzapPrivKeyHex();
  const pub = bytesToHex(secp256k1.getPublicKey(hexToBytes(priv), true));
  useWalletStore.getState().setNutzapPubkey(pub);
  return pub;
}

// ---- Nutzap redemption ----

// Redeem an incoming NIP-61 nutzap, signing the proofs locked to our key. Until
// that swap nobody else can spend them, which is what makes a nutzap safe to
// leave on a relay.
async function redeemNutzapProofs(params: {
  proofs: ProofLike[];
  mintUrl: string;
  unit: string;
  eventId: string;
  senderPubkey: string;
  comment?: string;
}): Promise<number> {
  assertUnlocked();
  const store = useWalletStore.getState();
  if (store.redeemedNutzaps.includes(params.eventId)) return 0;
  // Relays replay kind 9321 freely; a staged redemption is `reconcile`'s, and
  // a second would present the same locked proofs to the mint again.
  if (
    store.history.some(
      (tx) =>
        tx.nutzapEventId === params.eventId && tx.swapPreview !== undefined,
    )
  ) {
    return 0;
  }

  assertMintNetworkAllowed();
  const url = normalizeMintUrl(params.mintUrl);

  // Only held mints (what our kind 10019 advertises, per NIP-61, and the
  // invariant `core/payments/nutzap.ts` states). The URL comes verbatim from a
  // stranger's kind 9321 on an unattended watcher. A P2PK witness signs only
  // the secret, not the mint, so one made for a hostile mint could be replayed
  // at the real one to take the funds; it would also confirm our IP and
  // liveness and persist the attacker's server in the mint list.
  if (useWalletStore.getState().mints[url] === undefined) {
    throw new WalletError(
      "untrusted-mint",
      t("wallet.svc.unknown_mint"),
      t("wallet.svc.unknown_mint_body"),
    );
  }

  const epoch = walletEpoch;
  const wallet = await getWallet(url, params.unit);
  const privkey = await getNutzapPrivKeyHex();
  const txId = newTxId();

  let result: SendResponse;
  try {
    const { preview, stored } = await prepareRecoverableSwap(
      wallet,
      () => wallet.prepareSwapToReceive(params.proofs),
      privkey,
    );
    assertSameWallet(epoch);
    store.addTx({
      id: txId,
      kind: "nutzap-in",
      status: "pending",
      amount: params.proofs.reduce((s, p) => s + Number(p.amount), 0),
      unit: params.unit,
      mintUrl: url,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      memo: params.comment,
      counterparty: params.senderPubkey,
      nutzapEventId: params.eventId,
      swapPreview: stored,
    });
    result = await completeSwapInFlight(wallet, txId, preview);
    assertSameWallet(epoch);
  } catch (err) {
    if (walletReplaced(epoch)) throw lockedError();
    const walletErr = asWalletError(err, "mint-error");
    store.updateTx(txId, { error: walletErr.message });
    throw walletErr;
  }

  creditProofs(url, params.unit, result.keep, { verified: true });
  const amount = result.keep.reduce((s, p) => s + p.amount.toNumber(), 0);
  store.markNutzapRedeemed(params.eventId);
  store.updateTx(txId, {
    status: "completed",
    amount,
    swapPreview: undefined,
  });
  return amount;
}

// Lock proofs to a nutzap recipient. Always an online swap: the lock lives in
// the output secret, so held proofs cannot be retro-fitted.
export async function lockProofsForNutzap(params: {
  amount: number;
  mintUrl: string;
  unit: string;
  recipientPubkey: string;
}): Promise<{ locked: Proof[]; txId: string }> {
  assertUnlocked();
  assertMintNetworkAllowed();
  const url = normalizeMintUrl(params.mintUrl);
  const store = useWalletStore.getState();
  const key = accountKey(url, params.unit);
  const epoch = walletEpoch;

  const wallet = await getWallet(url, params.unit);
  assertSameWallet(epoch);
  const txId = newTxId();
  // Read after the await; the reservation below settles any remaining race.
  const available = useWalletStore.getState().proofs[key] ?? [];
  const offered = new Set(available.map((p) => p.secret));

  let result: SendResponse;
  let staged = false;
  try {
    const { preview, stored } = await prepareRecoverableSwap(wallet, () =>
      wallet.prepareSwapToSend(
        params.amount,
        available.map(toProofLike),
        { includeFees: true },
        { send: { type: "p2pk", options: { pubkey: params.recipientPubkey } } },
      ),
    );
    assertSameWallet(epoch);
    const inputs = matchStored(available, preview.inputs);
    if (inputs.length !== preview.inputs.length) {
      throw new WalletError("insufficient", t("wallet.svc.coins_raced"));
    }
    reserveSwapInputs(txId, url, params.unit, inputs);
    store.addTx({
      id: txId,
      kind: "nutzap-out",
      status: "pending",
      amount: params.amount,
      unit: params.unit,
      mintUrl: url,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      counterparty: params.recipientPubkey,
      swapPreview: stored,
    });
    staged = true;
    result = await completeSwapInFlight(wallet, txId, preview);
    assertSameWallet(epoch);
  } catch (err) {
    if (walletReplaced(epoch)) throw lockedError();
    const walletErr = asWalletError(err, "mint-error");
    if (!staged) {
      store.releaseReserved(txId);
      throw walletErr;
    }
    if (isDefiniteRefusal(err)) {
      abandonStagedSwap(txId, walletErr.message);
      throw walletErr;
    }
    // Maybe already locked to the recipient: held for `reconcile`, and flagged
    // in doubt so the caller does not pay twice.
    store.updateTx(txId, { error: walletErr.message });
    throw new WalletError(
      walletErr.code,
      t("wallet.svc.lock_in_doubt"),
      t("wallet.svc.lock_in_doubt_body"),
      { inDoubt: true },
    );
  }

  // `keep` echoes unselected originals; credit only the change.
  store.dropReserved(txId);
  creditProofs(
    url,
    params.unit,
    result.keep.filter((p) => !offered.has(p.secret)),
    { verified: true },
  );

  const sent = result.send.reduce((s, p) => s + p.amount.toNumber(), 0);
  // Pending until delivery, which `payment-router` owns.
  store.updateTx(txId, { amount: sent, swapPreview: undefined });

  return { locked: result.send, txId };
}

// ---- Nutzap send ----

// Money only, not delivery: DMs, retries and fallbacks live in
// `payment-router.ts`, the one module that imports both mesh and wallet.
// Delivery here would leave the DM out of the thread, unretried on a dropped
// relay, and on a publish timeout could reserve a second set of proofs for the
// same payment.

export interface NutzapTarget {
  // Where to lock: a mint they listed that we also hold enough value at.
  mintUrl: string;
  // Their 33-byte compressed P2PK key, from the kind 10019.
  p2pkPubkey: string;
  // Their kind 10019 relays. Publish there, not to ours, or they never see it.
  relays: string[];
}

export type NutzapLookup =
  { ok: true; target: NutzapTarget } | { ok: false; reason: string };

// Whether and where this person can be nutzapped. Never throws: a failure means
// "try another rail". `reason` is user-facing copy.
export async function findNutzapTarget(params: {
  recipientPubkey: string;
  amount: number;
  unit: string;
  client: NostrClient;
}): Promise<NutzapLookup> {
  let info: NutzapInfo | null = null;
  try {
    info = await fetchNutzapInfo(params.recipientPubkey, params.client);
  } catch {
    info = null;
  }
  if (!info) return { ok: false, reason: t("wallet.svc.no_nutzap_info") };

  // A mint on their list that we fund. No `assertUnlocked`: a locked wallet
  // reads as zero here, and the next rail raises the real "locked" error.
  const state = useWalletStore.getState();
  const shared = info.mintUrls
    .map(normalizeMintUrl)
    .find(
      (url) =>
        (state.proofs[accountKey(url, params.unit)] ?? []).reduce(
          (s, p) => s + p.amount,
          0,
        ) >= params.amount,
    );
  if (shared === undefined) {
    return { ok: false, reason: t("wallet.svc.no_shared_mint") };
  }
  return {
    ok: true,
    target: {
      mintUrl: shared,
      p2pkPubkey: info.p2pkPubkey,
      relays: info.relays,
    },
  };
}

// Publish locked proofs as kind 9321. The value is committed either way, so a
// failed publish is a delivery problem, never a reason to pay again. The token
// is saved first so a crash still leaves something to hand over.
export async function publishLockedNutzap(params: {
  locked: Proof[];
  txId: string;
  mintUrl: string;
  unit: string;
  recipientPubkey: string;
  senderPrivKey: Uint8Array;
  client: NostrClient;
  comment?: string;
  // Their kind 10019 relay list. See NutzapTarget.
  relays?: string[];
}): Promise<{ published: boolean; token: string }> {
  const store = useWalletStore.getState();
  const token = buildToken(
    params.mintUrl,
    params.locked.map((p) => toStoredProof(p, { verified: true })),
    params.unit,
    params.comment,
  );
  store.updateTx(params.txId, { token });

  try {
    await publishNutzap({
      proofs: params.locked,
      mintUrl: params.mintUrl,
      recipientPubkey: params.recipientPubkey,
      senderPrivKey: params.senderPrivKey,
      client: params.client,
      comment: params.comment,
      ...(params.relays !== undefined ? { relays: params.relays } : {}),
    });
    store.updateTx(params.txId, { status: "completed" });
    return { published: true, token };
  } catch {
    // The caller delivers the token another way.
    return { published: false, token };
  }
}

// Delivered by a route other than the relay.
export function settleNutzap(txId: string): void {
  useWalletStore.getState().updateTx(txId, { status: "completed" });
}

// Not reclaimable: locked proofs are the recipient's whatever happens.
export function failNutzapDelivery(txId: string, reason: string): void {
  useWalletStore.getState().updateTx(txId, { error: reason });
}

// ---- Nutzap receive ----

// Redeem incoming nutzaps. One missed offline stays on the relay for the next
// subscription; stored redeemed ids stop a replay crediting twice.
export function startNutzapWatcher(params: {
  myPubkey: string;
  client: NostrClient;
  onRedeemed?: (amount: number, unit: string, from: string) => void;
}): () => void {
  return subscribeNutzaps(params.myPubkey, params.client, (zap) => {
    void (async () => {
      const store = useWalletStore.getState();
      if (store.redeemedNutzaps.includes(zap.eventId)) return;
      try {
        const amount = await redeemNutzapProofs({
          proofs: zap.proofs,
          mintUrl: zap.mintUrl,
          unit: zap.unit,
          eventId: zap.eventId,
          senderPubkey: zap.senderPubkey,
          comment: zap.comment,
        });
        if (amount > 0) params.onRedeemed?.(amount, zap.unit, zap.senderPubkey);
      } catch (err) {
        // An unheld mint is final: mark it seen and record a failed row so the
        // user can add the mint if they trust it.
        if (err instanceof WalletError && err.code === "untrusted-mint") {
          store.markNutzapRedeemed(zap.eventId);
          recordTx({
            kind: "nutzap-in",
            status: "failed",
            amount: zap.proofs.reduce((s, p) => s + Number(p.amount), 0),
            unit: zap.unit,
            mintUrl: zap.mintUrl,
            counterparty: zap.senderPubkey,
            error: err.message,
          });
          return;
        }
        // Anything else (unreachable, Tor-blocked, already claimed) is left
        // unmarked for the next subscription.
      }
    })();
  });
}

// Our kind 10019, replaceable, so safe on every launch. Needs at least one mint.
export async function publishOwnNutzapInfo(params: {
  client: NostrClient;
  privKey: Uint8Array;
  relays: string[];
}): Promise<boolean> {
  if (!isWalletStorageReady()) return false;
  const mints = Object.keys(useWalletStore.getState().mints);
  if (mints.length === 0) return false;
  try {
    await publishNutzapInfo({
      mintUrls: mints,
      p2pkPubkey: await getNutzapPubKeyHex(),
      relays: params.relays,
      privKey: params.privKey,
      client: params.client,
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Helpers ----

function newTxId(): string {
  return `${Date.now().toString(36)}-${bytesToHex(
    crypto.getRandomValues(new Uint8Array(8)),
  )}`;
}

function recordTx(
  tx: Omit<WalletTx, "id" | "createdAtMs" | "updatedAtMs">,
): string {
  const id = newTxId();
  useWalletStore.getState().addTx({
    ...tx,
    id,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
  return id;
}

export function hostOf(mintUrl: string): string {
  try {
    return new URL(mintUrl).hostname;
  } catch {
    return mintUrl.replace(/^https?:\/\//, "");
  }
}
