// What launch finds in the keychain: an identity, none, or no answer.
//
// The three must stay apart. A read that throws or never answers, read as "no
// identity", sends a returning user to onboarding, sweeps the wallet secrets on
// the way, and lets onboarding write over the identity once the keychain wakes.
// iOS gives exactly that answer to a background relaunch before first unlock.
// So "unreadable" is its own outcome, and the launch waits for the person.
//
// Two identities never boot. One a panic wipe could not delete (./wipe-marker)
// is deleted again here, with its prekeys. One a deleted install left behind
// (./install-marker) is deleted with every other secret. If the keychain still
// refuses, launch treats it as absent with the keys reported as surviving.

import { type Identity, loadIdentity } from "@core/crypto/identity";
import {
  deleteSecret,
  KEYCHAIN_ITEMS,
  wipeAllSecrets,
} from "@core/crypto/keychain";
import { withTimeout } from "@utils/with-timeout";
import { isLeftoverIdentity, markInstallHadIdentity } from "./install-marker";
import { clearCondemnedIdentity, isIdentityCondemned } from "./wipe-marker";

export type LaunchIdentity =
  | { kind: "present"; identity: Identity }
  // `keysRemain`: the keychain refused to delete a condemned or leftover
  // identity.
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
  if (identity !== null && isLeftoverIdentity()) {
    return { kind: "absent", keysRemain: !(await wipeLeftoverSecrets()) };
  }
  if (!isIdentityCondemned()) {
    if (identity === null) return { kind: "absent", keysRemain: false };
    markInstallHadIdentity();
    return { kind: "present", identity };
  }

  // The one-time prekeys go with it, here and not in the launch sweep: this
  // runs before any mesh can mint a batch, and a new identity must not publish
  // the old one's prekeys, which would link the two.
  const deleted = await withTimeout(
    Promise.all([
      deleteSecret(KEYCHAIN_ITEMS.identity),
      deleteSecret(KEYCHAIN_ITEMS.localPrekeys),
    ]).then(() => true),
    IDENTITY_LOAD_TIMEOUT_MS,
    false,
  ).catch(() => false);
  if (deleted) clearCondemnedIdentity();
  return { kind: "absent", keysRemain: !deleted };
}

// Every secret goes with a leftover identity, the wallet's keys and recovery
// phrase included, so a new identity never inherits them. True when the
// keychain let go of all of it.
async function wipeLeftoverSecrets(): Promise<boolean> {
  return withTimeout(
    wipeAllSecrets().then(() => true),
    IDENTITY_LOAD_TIMEOUT_MS,
    false,
  ).catch(() => false);
}

// What the launch does with that answer. Pure, so the branching app.tsx acts
// on is testable without rendering the app.
export type LaunchPlan =
  | { kind: "boot"; identity: Identity }
  // The keychain did not answer: the person is asked, and nothing onboards.
  | { kind: "ask" }
  // `sweep` only on a confirmed absence, since an unanswered read said nothing
  // about what the keychain holds. `wipeIncomplete`: the keychain refused to
  // delete a condemned or leftover identity.
  | { kind: "welcome"; sweep: boolean; wipeIncomplete: boolean };

// `justWiped`: the person just chose Erase, and asking again could reload an
// identity the wipe failed to delete, so an unanswered read goes to welcome.
export function planLaunch(
  found: LaunchIdentity,
  justWiped: boolean,
): LaunchPlan {
  switch (found.kind) {
    case "present":
      return { kind: "boot", identity: found.identity };
    case "unreadable":
      return justWiped
        ? { kind: "welcome", sweep: false, wipeIncomplete: false }
        : { kind: "ask" };
    case "absent":
      return { kind: "welcome", sweep: true, wipeIncomplete: found.keysRemain };
  }
}
