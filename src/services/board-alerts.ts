// Urgent board notices as a line in the chat they belong to, so someone who
// never opens Notices still sees one. The bell already logs every notice; this
// is the louder path, reserved for the urgent flag, matching bitchat's board
// alerts.
//
// A burst is one line, not one per post: arrivals wait a few seconds and are
// then written together, a single notice with its author and text or a count
// pointing at Notices. The mesh and Nostr ingest paths call in after their own
// own-post and recency gates; the handled set covers a resubscribe replaying a
// note that is still inside that window.

import { useChatStore } from "@store/chat-store";
import { BoundedIdSet } from "@utils/bounded-id-set";
import { systemRow } from "@utils/message-text";
import { truncateToCodePoints } from "@utils/utf8-budget";

export interface UrgentNotice {
  postID: string;
  channel: string;
  authorNickname: string;
  content: string;
}

const COLLAPSE_MS = 4_000;
const CONTENT_MAX_CHARS = 120;

// The post IDs are relay and mesh data, so the set is bounded, at the same size
// as bridge-service's ID sets. Evicting the oldest re-announces a post only if
// it is replayed after 2,000 newer ones and is still inside the ingest recency
// window, and then the cost is one repeated line.
const MAX_HANDLED = 2_000;

const handled = new BoundedIdSet(MAX_HANDLED);
const pending = new Map<string, UrgentNotice[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function noteUrgentNotice(notice: UrgentNotice): void {
  if (handled.has(notice.postID)) return;
  handled.add(notice.postID);
  const list = pending.get(notice.channel) ?? [];
  list.push(notice);
  pending.set(notice.channel, list);
  flushTimer ??= setTimeout(flush, COLLAPSE_MS);
}

function flush(): void {
  flushTimer = null;
  const chat = useChatStore.getState();
  const now = Date.now();
  for (const [channel, notices] of pending) {
    // A cell heard over the mesh but not joined has no chat to write into.
    if (!chat.channels.includes(channel)) continue;
    const single = notices.length === 1 ? notices[0] : null;
    chat.addMessage({
      id: `sys-urgent-${single?.postID ?? String(now)}-${channel}`,
      channel,
      senderID: "",
      senderNickname: "",
      // An author-less notice takes its own sentence rather than a stand-in
      // name, which would be stored in the language of the day it arrived.
      ...(single === null
        ? systemRow("chat.board.urgent_many", { count: notices.length })
        : single.authorNickname.length > 0
          ? systemRow("chat.board.urgent_one", {
              author: single.authorNickname,
              content: clip(single.content),
            })
          : systemRow("chat.board.urgent_one_anon", {
              content: clip(single.content),
            })),
      timestampMs: now,
      isMine: false,
      isSystem: true,
    });
  }
  pending.clear();
}

// The line is a pointer, not the post; Notices has the rest.
function clip(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const cut = truncateToCodePoints(flat, CONTENT_MAX_CHARS);
  return cut === flat ? flat : `${cut}…`;
}

export function resetBoardAlerts(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pending.clear();
  handled.clear();
}
