// What the full-screen live viewer shows, read off the chat rather than the
// receiver. The rows are the one record of a stream that outlives it: live,
// then reconnecting, then its recording, or gone when the stream was canceled
// or left nothing to keep.

import { liveVideoStreamOf } from "@core/mesh/wire/file-packet";
import type { ChatAttachment, ChatMessage } from "@store/chat-store";

// The row the viewer was opened on, and the stream behind it.
export interface LiveVideoViewerTarget {
  channel: string;
  rowID: string;
  senderID: string;
  streamID: string;
}

export type LiveVideoViewerState =
  | { kind: "live"; rowID: string; live: NonNullable<ChatMessage["liveVideo"]> }
  // `replay` is null when there is nothing left to play.
  | { kind: "ended"; replay: ChatAttachment | null };

export function liveVideoViewerState(
  rows: readonly ChatMessage[] | undefined,
  target: LiveVideoViewerTarget,
): LiveVideoViewerState {
  // A stream has one live row at a time. After a silence long enough to close
  // it, its packets open a new row for the next segment, and the viewer
  // follows the stream there rather than staying on the closed one.
  const live = rows?.find(
    (m) =>
      m.senderID === target.senderID &&
      m.liveVideo?.streamID === target.streamID,
  );
  if (live?.liveVideo !== undefined) {
    return { kind: "live", rowID: live.id, live: live.liveVideo };
  }
  const own = rows?.find((m) => m.id === target.rowID);
  // The sender's file takes over a stream's first row and drops the rows of
  // the segments after a dropout, so a viewer opened on one of those finds
  // its recording by the stream it names.
  const replay =
    own?.attachment ??
    rows?.find(
      (m) =>
        m.senderID === target.senderID &&
        m.attachment?.type === "video" &&
        liveVideoStreamOf(m.attachment.name) === target.streamID,
    )?.attachment;
  return {
    kind: "ended",
    replay: replay?.type === "video" ? replay : null,
  };
}
