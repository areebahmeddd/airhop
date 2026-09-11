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

import { t } from "@i18n";
import { useChatStore } from "@store/chat-store";
import { systemRow } from "@utils/message-text";

export interface UrgentNotice {
  postID: string;
  channel: string;
  authorNickname: string;
  content: string;
}

const COLLAPSE_MS = 4_000;
const CONTENT_MAX_CHARS = 120;

const handled = new Set<string>();
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
      ...(single !== null
        ? systemRow("chat.board.urgent_one", {
            author: single.authorNickname || t("notif.someone"),
            content: clip(single.content),
          })
        : systemRow("chat.board.urgent_many", { count: notices.length })),
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
  const chars = Array.from(flat);
  return chars.length > CONTENT_MAX_CHARS
    ? chars.slice(0, CONTENT_MAX_CHARS).join("") + "…"
    : flat;
}

export function resetBoardAlerts(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pending.clear();
  handled.clear();
}
