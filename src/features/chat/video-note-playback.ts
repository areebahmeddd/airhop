// Which video notes in a thread hold a player, and which of those move. Each
// player holds a hardware decoder, of which a low-end Android phone has only a
// handful, and the list keeps rows mounted well past the screen, so a thread
// of notes would otherwise exhaust them: black circles, stutter and battery
// drain.

import { isVideoNoteName } from "@core/mesh/wire/file-packet";
import type { ChatMessage } from "@store/chat-store";

// Decoding costs battery even muted. The newest notes on screen move; the
// others hold still.
const MAX_LOOPING_NOTES = 2;

type VideoNotePlayback = "none" | "still" | "loop";

// The video notes among the rows on screen, in list order (oldest first).
export function videoNoteIds(rows: readonly ChatMessage[]): string[] {
  return rows.flatMap((row) =>
    row.attachment?.type === "video" && isVideoNoteName(row.attachment.name)
      ? [row.id]
      : [],
  );
}

// "none" off screen, unless it is the one being heard, which keeps its player
// as it scrolls away. `canLoop` is false while the camera or a live stream
// holds the screen: that work needs the codecs, and the notes behind it are
// out of sight.
export function videoNotePlayback(
  id: string,
  onScreen: readonly string[],
  heardId: string | null,
  canLoop = true,
): VideoNotePlayback {
  const index = onScreen.indexOf(id);
  if (index < 0) return id === heardId ? "still" : "none";
  return canLoop && index >= onScreen.length - MAX_LOOPING_NOTES
    ? "loop"
    : "still";
}
