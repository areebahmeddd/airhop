// Every secret Airhop stores in the OS keychain, and the only access to it.
//
// expo-secure-store has no clear-all, so the panic wipe deletes the items listed
// here and nothing else. A secret written outside this registry survives a wipe.
// `KeychainItem` is a union of these names, so callers cannot write one.

import * as SecureStore from "expo-secure-store";

// Item names are the on-device addresses of the data: renaming one orphans the
// secret rather than moving it. Shape is `airhop.<domain>.<thing>.v1`, per
// ARCHITECTURE.md.
export const KEYCHAIN_ITEMS = {
  // JSON: Noise static and Ed25519 signing private keys, hex.
  identity: "airhop.identity.v1",
  // AES-256 key for the wallet's MMKV partition.
  walletEncryptionKey: "airhop.wallet.mmkvKey.v1",
  // secp256k1 private key, hex. Nutzaps lock to its public half.
  walletP2pkKey: "airhop.wallet.p2pk.v1",
  // 12-word BIP-39 phrase, generated with the wallet whether or not the user
  // has seen it yet.
  walletRecoveryPhrase: "airhop.wallet.recovery.v1",
  // Base64 blob: our one-time prekey private keys (courier/prekey-store.ts).
  localPrekeys: "airhop.prekeys.local.v1",
} as const;

export type KeychainItem = (typeof KEYCHAIN_ITEMS)[keyof typeof KEYCHAIN_ITEMS];

// iOS only; Android uses Keystore either way.
//
// AFTER_FIRST_UNLOCK: iOS relaunches the app on a BLE event, and that relaunch
// must load the identity to join the mesh. The WHEN_UNLOCKED default refuses
// that read on a locked phone.
//
// THIS_DEVICE_ONLY: the default class is included in encrypted iCloud/iTunes
// backups and restorable onto another device.
//
// Trade: unreadable between boot and first unlock.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Null when absent, throws when the keychain is unreachable. Callers must keep
// these apart: a locked keystore read as "no identity" sends a returning user
// back through onboarding.
export async function readSecret(item: KeychainItem): Promise<string | null> {
  return SecureStore.getItemAsync(item, OPTIONS);
}

export async function writeSecret(
  item: KeychainItem,
  value: string,
): Promise<void> {
  await SecureStore.setItemAsync(item, value, OPTIONS);
}

// Synchronous, for the one caller that is: the prekey store answers inside
// packet handling and must not leave a write in flight across a teardown.
// Same null-or-throw contract as readSecret.
export function readSecretSync(item: KeychainItem): string | null {
  return SecureStore.getItem(item, OPTIONS);
}

export function writeSecretSync(item: KeychainItem, value: string): void {
  SecureStore.setItem(item, value, OPTIONS);
}

export async function deleteSecret(item: KeychainItem): Promise<void> {
  await SecureStore.deleteItemAsync(item, OPTIONS);
}

// Every item is attempted even after one fails, since a keychain that refuses
// one value may release the next. Throws if anything was left behind, so the
// caller reports `keysDestroyed: false` rather than overclaiming.
export async function wipeAllSecrets(): Promise<void> {
  const items = Object.values(KEYCHAIN_ITEMS);
  const results = await Promise.allSettled(items.map(deleteSecret));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    throw new Error(`keychain wipe left ${String(failed)} item(s) behind`);
  }
}

// Enforce the invariant that no identity means no secrets, and report whether
// anything defied it. Called at launch, and only on the branch where there is
// definitively no identity to own them.
//
// This is what turns a failed panic wipe from permanent into a retry. The wipe
// most likely to fail is the one that matters: `AFTER_FIRST_UNLOCK` refuses
// reads and deletes on a phone that has booted but not been unlocked, which is
// exactly the seizure the gesture exists for. Without a retry the keys stay for
// good. The next launch is past that unlock, where the same delete usually just
// works.
//
// Not framed as "retry the wipe", because it does not need to know a wipe ever
// happened - which is the point. A secret with no identity to own it has no
// owner and no reader; deleting it is unconditionally correct, so this needs no
// persisted "a wipe was attempted here" flag, and a wipe leaves no trace of
// having been attempted.
//
// The identity itself is deliberately NOT swept, and the reason is a race rather
// than a scruple. The caller runs this without waiting, on its way to showing
// the welcome screen, and the very next thing onboarding does is WRITE an
// identity. A delete still in flight when that lands would destroy the key the
// user just created, leaving an app that cannot start - a far worse outcome than
// the one this exists to fix. Nothing is lost by skipping it: the caller only
// reaches here because loadIdentity found no identity, so there is nothing to
// delete, and in the one case where there might be (a read that failed while the
// item survived) a keychain refusing reads refuses deletes too.
//
// Nor is the wallet's file key: the wallet partition opens under it at launch
// on every install, identity or not, and deleting it leaves that partition
// writing under a key the next launch cannot find. It guards nothing a wipe has
// not already cleared.
//
// Nor are the local prekeys, for the identity's reason: the mesh can mint and
// publish a batch right after onboarding, and a delete landing late would drop
// keys peers are already sealing to. The panic wipe still deletes them.
//
// Returns true ONLY when a leftover is positively confirmed: the delete was
// refused AND a read afterwards still hands back a value. A keychain that
// refuses both is unreadable rather than dirty, and claiming otherwise would put
// an alarm about data at rest in front of someone whose device is merely locked.
export async function sweepOrphanedSecrets(): Promise<boolean> {
  const orphanable = Object.values(KEYCHAIN_ITEMS).filter(
    (item) =>
      item !== KEYCHAIN_ITEMS.identity &&
      item !== KEYCHAIN_ITEMS.walletEncryptionKey &&
      item !== KEYCHAIN_ITEMS.localPrekeys,
  );
  const deletes = await Promise.allSettled(orphanable.map(deleteSecret));
  if (deletes.every((r) => r.status === "fulfilled")) return false;
  // Something refused, so ask what actually survived it.
  const reads = await Promise.allSettled(orphanable.map(readSecret));
  return reads.some((r) => r.status === "fulfilled" && r.value !== null);
}
