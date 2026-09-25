// What launch finds in the keychain: an identity, none, or no answer.
//
// The three must stay apart. A read that throws or never answers, read as "no
// identity", sends a returning user to onboarding, sweeps the wallet secrets on
// the way, and lets onboarding write over the identity once the keychain wakes.
// iOS gives exactly that answer to a background relaunch before first unlock.
// So "unreadable" is its own outcome, and the launch waits for the person.
//
// An identity a panic wipe could not delete never boots (see ./wipe-marker):
// it is deleted again here, and if the keychain still refuses, launch treats
// it as absent with the keys reported as surviving.

import { type Identity, loadIdentity } from "@core/crypto/identity";
import { deleteSecret, KEYCHAIN_ITEMS } from "@core/crypto/keychain";
import { withTimeout } from "@utils/with-timeout";
import { clearCondemnedIdentity, isIdentityCondemned } from "./wipe-marker";

export type LaunchIdentity =
  | { kind: "present"; identity: Identity }
  // `keysRemain`: a condemned identity refused its delete again.
  | { kind: "absent"; keysRemain: boolean }
  | { kind: "unreadable" };

// A healthy read takes single-digit milliseconds, so a slow but working device
// never reaches this, and a Keystore that stalls, which never rejects, does.
export const IDENTITY_LOAD_TIMEOUT_MS = 8_000;

export async function readLaunchIdentity(): Promise<LaunchIdentity> {
  let identity: Identity | null | undefined;
  try {
    identity = await withTimeout<Identity | null | undefined>(
      loadIdentity(),
      IDENTITY_LOAD_TIMEOUT_MS,
      undefined,
    );
  } catch {
    return { kind: "unreadable" };
  }
  if (identity === undefined) return { kind: "unreadable" };
  if (identity === null) return { kind: "absent", keysRemain: false };
  if (!isIdentityCondemned()) return { kind: "present", identity };

  const deleted = await withTimeout(
    deleteSecret(KEYCHAIN_ITEMS.identity).then(() => true),
    IDENTITY_LOAD_TIMEOUT_MS,
    false,
  ).catch(() => false);
  if (deleted) clearCondemnedIdentity();
  return { kind: "absent", keysRemain: !deleted };
}
