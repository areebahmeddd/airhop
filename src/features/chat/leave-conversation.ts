// Leaving a conversation, shared by every surface that offers it: the chat
// list's row menu, the channel info sheet, and the DM list's delete, block and
// remove contact.
//
// One path so no surface does less than the others. A group also drops its
// epoch key and is remembered as left, so a later roster cannot re-add it and no
// key material outlives the room. The delivered notification goes too: tapping
// one for a conversation that no longer exists opens an empty thread under its
// name.

import { dismissNotificationsFor } from "@services/notification-service";
import { useChatStore } from "@store/chat-store";
import { useGroupStore } from "@store/group-store";

export function leaveConversation(channel: string): void {
  if (channel.startsWith("group:")) {
    useGroupStore.getState().leave(channel.slice("group:".length));
  }
  useChatStore.getState().removeChannel(channel);
  void dismissNotificationsFor(channel);
}
