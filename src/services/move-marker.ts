// Where a transfer stands on this phone, so a launch after a crash lands
// somewhere true.
//
//   sending     Old phone, stream unfinished. The new phone cannot commit
//               without the end of it, so nothing moved: launch clears it.
//   sent        Old phone, stream finished, no commit heard. The new phone may
//               hold the identity, so this one must not rejoin the mesh on its
//               own. The person is asked.
//   receiving   New phone, install unfinished. Launch wipes the partial write.
//   committed   New phone, installed, release not heard. The person confirms
//               the old phone is erased before this one joins the mesh.
//
// In MMKV_STORE_IDS, so a panic wipe clears it.

import { getStorage } from "@store/mmkv";

export type MoveMarker = "sending" | "sent" | "receiving" | "committed";

export const MOVE_MARKER_STORAGE_ID = "move-marker";
const KEY = "state";

export function setMoveMarker(state: MoveMarker): void {
  getStorage(MOVE_MARKER_STORAGE_ID).set(KEY, state);
}

export function clearMoveMarker(): void {
  try {
    getStorage(MOVE_MARKER_STORAGE_ID).remove(KEY);
  } catch {
    // Unwritable storage. The next launch asks again, which is the safe side.
  }
}

// Unreadable reads as none. Unlike the wipe marker there is no safe direction:
// "sent" strands a working phone, "receiving" wipes one.
export function readMoveMarker(): MoveMarker | null {
  try {
    const value = getStorage(MOVE_MARKER_STORAGE_ID).getString(KEY);
    return value === "sending" ||
      value === "sent" ||
      value === "receiving" ||
      value === "committed"
      ? value
      : null;
  } catch {
    return null;
  }
}
