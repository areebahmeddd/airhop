// The record that a panic wipe is in progress.
//
// panicWipe is a sequence of destructive steps, not an atomic one, and a process
// that dies partway through leaves the keys gone and the message stores intact.
// That presents as a clean install over live data, which is the one way this
// gesture must never fail. So the intent is written before the first step and
// cleared after the last, and any launch that finds it set replays the wipe.
// Every step is a delete or a clear, so a replay is idempotent.
//
// One marker, where bitchat-ios keeps two (PanicRecoveryOperations): its second
// covers UserDefaults.synchronize() reporting a write that never landed. MMKV
// writes reach a kernel-owned mmap that a force-stop cannot lose.
//
// The partition is deliberately absent from MMKV_STORE_IDS, since a wipe that
// clears its own marker destroys the only thing that could finish the job.
//
// A completed wipe still leaves no trace of having been attempted: the flag
// survives only an interrupted one, which has left the message store behind
// anyway. The exception is a wipe the keychain refused, which leaves the
// condemned-identity flag below until a new identity replaces the old one.

import { getStorage } from "@store/mmkv";

const STORAGE_ID = "panic-wipe-marker";
const PENDING_KEY = "pending";
const CONDEMNED_KEY = "identityCondemned";

// Call before the first destructive step.
//
// A failure costs the ability to RESUME the wipe, not the wipe itself, so it is
// swallowed rather than thrown. Refusing to destroy anything because the
// bookkeeping failed is the wrong trade under duress; bitchat agrees.
export function beginPanicWipe(): void {
  try {
    getStorage(STORAGE_ID).set(PENDING_KEY, true);
  } catch {
    // No writable storage. The wipe runs unresumably rather than not at all.
  }
}

// Call once the sequence has finished.
//
// Unconditional, including when the keychain refused the keys. This marks "the
// sequence did not finish", not "the keys are gone": surviving keys retry
// through sweepOrphanedSecrets, which is safe beside re-onboarding because it
// never touches the identity item. Holding the marker for them would replay the
// wipe over the identity the user creates next and destroy it.
export function endPanicWipe(): void {
  try {
    getStorage(STORAGE_ID).remove(PENDING_KEY);
  } catch {
    // The next launch replays a wipe that already ran. Idempotent.
  }
}

// Fails CLOSED: a read that throws is answered "replay it".
//
// A false positive re-wipes an app whose storage is already unreadable; a false
// negative leaves a full message store on a device whose owner believes it is
// empty. Only the first is survivable for the person holding the phone.
export function isPanicWipePending(): boolean {
  try {
    return getStorage(STORAGE_ID).getBoolean(PENDING_KEY) === true;
  } catch {
    return true;
  }
}

// The identity a wipe could not delete, recorded until another replaces it.
//
// A separate flag from the one above because it outlives the wipe: the marker
// must clear when the sequence ends (or the wipe replays over the next
// identity), but a surviving identity must never boot again. Launch deletes it
// once more and, failing that, goes to welcome, where onboarding overwrites it.
// It names the old identity's condition rather than a pending wipe, so writing
// a new identity is what clears it.
export function condemnIdentity(): void {
  try {
    getStorage(STORAGE_ID).set(CONDEMNED_KEY, true);
  } catch {
    // Unwritable storage: the wipe already reports the keys as not destroyed.
  }
}

// Call once a new identity is written over the condemned one.
export function clearCondemnedIdentity(): void {
  try {
    getStorage(STORAGE_ID).remove(CONDEMNED_KEY);
  } catch {
    // No writable storage; there is nothing else to record it in.
  }
}

// Fails closed, like isPanicWipePending, and for the same reason.
export function isIdentityCondemned(): boolean {
  try {
    return getStorage(STORAGE_ID).getBoolean(CONDEMNED_KEY) === true;
  } catch {
    return true;
  }
}
