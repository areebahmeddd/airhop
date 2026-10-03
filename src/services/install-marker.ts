// Whether this install has had an identity before, so a reinstall does not boot
// the last one.
//
// iOS keeps Keychain items when an app is deleted, while the app's own storage
// goes with it. Left alone, a reinstall would boot the old identity with none of
// its history, where deleting the app promises to erase it (as it does on
// Android, which removes the Keystore keys with the app). So an identity found by
// an install with no record of one is a leftover, wiped before anything reads it.
//
// The record is set when an identity is created, moved in, or booted. An install
// from a build before it existed looks the same as a reinstall, so the stores an
// install fills as it is used stand in for it: a reinstall starts with them
// empty. Prekeys and board posts fill as soon as the mesh meets anyone, and the
// transfer marker covers a transfer caught partway. settings-store is not among
// them, since i18n writes it at every launch.
//
// Absent from MMKV_STORE_IDS: a panic wipe deletes the identity itself, and the
// record surviving it only says this install once had one.

import { getStorage } from "@store/mmkv";
import { MOVE_MARKER_STORAGE_ID } from "./move-marker";

const STORAGE_ID = "install-marker";
const HAD_IDENTITY_KEY = "hadIdentity";
const EVIDENCE_STORE_IDS = [
  "chat-store",
  "contacts-store",
  "activity-store",
  "outbox-store",
  "prekey-store",
  "board-store",
  MOVE_MARKER_STORAGE_ID,
];

export function markInstallHadIdentity(): void {
  try {
    getStorage(STORAGE_ID).set(HAD_IDENTITY_KEY, true);
  } catch {
    // No writable storage: the next launch reads the stores instead.
  }
}

// Called only with an identity read from a keychain that answered, so the
// phone is unlocked and this storage is readable: iOS makes both available at
// the same first unlock. A storage read that fails says nothing either way, so
// it keeps the identity: wiping on a doubt would destroy a real one.
export function isLeftoverIdentity(): boolean {
  try {
    if (getStorage(STORAGE_ID).getBoolean(HAD_IDENTITY_KEY) === true) {
      return false;
    }
    const used = EVIDENCE_STORE_IDS.some(
      (id) => getStorage(id).getAllKeys().length > 0,
    );
    if (used) markInstallHadIdentity();
    return !used;
  } catch {
    return false;
  }
}
