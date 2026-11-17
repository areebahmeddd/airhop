// What a message card's Reply and Mark as read do, once the tray hands them
// over. A reply is sent the way the thread sends one, with no undo window, since
// there is no screen to undo from. Both read the conversation as answered.
//
// The card was posted under settings that may have changed since, so both ask
// the policy again: a card left in the shade must not reply past an app lock
// switched on afterwards, into a group or channel since left, or to a peer
// since blocked.

import { PRIVATE_MESSAGE_MAX_CONTENT_BYTES } from "@core/mesh/wire/noise-payload";
import { newMessageId } from "@core/router/message-router";
import { useBlockedStore } from "@store/blocked-store";
import { useChatStore, type ChatMessage } from "@store/chat-store";
import { groupChannel, useGroupStore } from "@store/group-store";
import type { QuickAction } from "@store/held-quick-actions";
import { useSettingsStore } from "@store/settings-store";
import { expandEmote } from "@utils/emote";
import { peerIDToUsername } from "@utils/username";
import { truncateToUtf8Bytes, utf8ByteLength } from "@utils/utf8-budget";
import { getMeshService } from "./mesh-service";
import { transmitMessage } from "./message-send";
import { offersQuickActions } from "./notification-policy";
import { notifyReply } from "./notification-service";

// About 2 KiB of reply, eight DMs.
const MAX_DM_PARTS = 8;

export function handleQuickAction(action: QuickAction): void {
  const channel = useChatStore.getState().resolveChannel(action.channel);
  if (!mayAnswer(channel) || blockedDm(action.channel)) {
    // Typed in good faith on a card shown before the change: say it did not go.
    if (action.kind === "reply" && action.text.trim().length > 0) {
      void notifyReply(action.channel, "failed");
    }
    return;
  }
  if (action.kind === "reply") sendReply(channel, action.text);
  markRead(channel);
}

function mayAnswer(channel: string): boolean {
  const chat = useChatStore.getState();
  const settings = useSettingsStore.getState();
  if (
    !offersQuickActions({
      channel,
      hasChannelKey: chat.channelKeys[channel] !== undefined,
      hidePreviews: settings.hideNotificationPreviews,
      appLockEnabled: settings.appLockEnabled,
    })
  ) {
    return false;
  }
  if (blockedDm(channel)) return false;
  if (!channel.startsWith("group:")) return true;
  return useGroupStore
    .getState()
    .groups.some((g) => groupChannel(g.groupID) === channel);
}

// The card's own channel is checked as well as the thread it now folds into: a
// room sender blocked by their `nostr_` key may since have been folded into a
// peer the block does not name.
function blockedDm(channel: string): boolean {
  return (
    channel.startsWith("dm:") &&
    useBlockedStore.getState().isBlocked(channel.slice(3))
  );
}

// Stamped when it is sent, as the wire copy is: a reply held over a restart
// lands where its recipient will see it, and after any clear of the thread.
function sendReply(channel: string, typed: string): void {
  const mesh = getMeshService();
  const text = typed.trim();
  if (mesh === null || text.length === 0) return;
  const nickname = peerIDToUsername(mesh.peerID);
  const isDM = channel.startsWith("dm:");
  const emote = expandEmote(text, nickname, isDM);
  // A channel emote with no @name goes as typed: the words are the user's, and
  // there is no composer to hand them back to. An emote is clamped as the
  // thread clamps it, since split in two it is no longer an action line.
  const body =
    emote.kind !== "emote"
      ? text
      : isDM
        ? truncateToUtf8Bytes(emote.text, PRIVATE_MESSAGE_MAX_CONTENT_BYTES)
        : emote.text;
  const chat = useChatStore.getState();
  chat.addChannel(channel);
  let failed = false;
  const { parts, cut } = dmParts(body, isDM);
  if (cut) void notifyReply(channel, "cut");
  for (const part of parts) {
    const msg: ChatMessage = {
      id: newMessageId(),
      channel,
      senderID: mesh.peerID,
      senderNickname: nickname,
      text: part,
      timestampMs: Date.now(),
      isMine: true,
      status: "sending",
    };
    chat.addMessage(msg);
    transmitMessage(msg, {
      // Once per reply, however many parts fail or however late.
      failed: () => {
        if (failed) return;
        failed = true;
        void notifyReply(channel, "failed");
      },
    });
  }
}

// A DM carries at most 255 bytes, a cap the thread's composer stops typing at.
// A card's text field has no such stop, so a longer reply goes as consecutive
// messages rather than losing its end, up to a bound that keeps a paste from
// flooding the peer: past MAX_DM_PARTS the rest is dropped, and a card says so.
function dmParts(
  text: string,
  isDM: boolean,
): { parts: string[]; cut: boolean } {
  if (!isDM) return { parts: [text], cut: false };
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0 && parts.length < MAX_DM_PARTS) {
    let part = truncateToUtf8Bytes(rest, PRIVATE_MESSAGE_MAX_CONTENT_BYTES);
    // Only a base under more marks than fit the budget (Zalgo text) leaves no
    // clean cut. Cut through them rather than loop on an empty part.
    if (part.length === 0) part = rawCut(rest);
    parts.push(part);
    rest = rest.slice(part.length).trimStart();
  }
  return { parts, cut: rest.length > 0 };
}

function rawCut(text: string): string {
  let out = "";
  for (const codePoint of text) {
    const next = out + codePoint;
    if (utf8ByteLength(next) > PRIVATE_MESSAGE_MAX_CONTENT_BYTES) break;
    out = next;
  }
  return out;
}

// What opening the thread does: receipts and rings go together, as everywhere.
function markRead(channel: string): void {
  useChatStore.getState().markChannelRead(channel);
  if (!channel.startsWith("dm:")) return;
  const peerID = channel.slice(3);
  getMeshService()?.sendReadReceipts(peerID);
  getMeshService()?.acknowledgeRingsIn(channel, peerID);
}
