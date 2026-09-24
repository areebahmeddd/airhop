// Leaving a conversation, shared by every surface that offers it: the chat
// list's More sheet, the channel info sheet, and the DM list's delete, block
// and remove contact. The first two confirm through confirmLeaveConversation;
// the DM list asks its own questions.
//
// One path so no surface does less than the others. A group also drops its
// epoch key and is remembered as left, so a later roster cannot re-add it and no
// key material outlives the room. The delivered notification goes too: tapping
// one for a conversation that no longer exists opens an empty thread under its
// name. So does any unsent draft.

import { t } from "@i18n";
import { getMeshService } from "@services/mesh-service";
import { dismissNotificationsFor } from "@services/notification-service";
import { showAlert } from "@store/alert-store";
import { useChatStore } from "@store/chat-store";
import { saveDraft } from "@store/composer-drafts";
import { useGroupStore } from "@store/group-store";

export function leaveConversation(channel: string): void {
  if (channel.startsWith("group:")) {
    useGroupStore.getState().leave(channel.slice("group:".length));
  }
  useChatStore.getState().removeChannel(channel);
  saveDraft(channel, "");
  void dismissNotificationsFor(channel);
}

// Asks first, since leaving deletes the history on this device. Only a group's
// creator can change its roster and there is no handover (bitchat has none
// either), so the creator is told nobody can manage the group once they leave.
export function confirmLeaveConversation(
  channel: string,
  name: string,
  onLeft?: () => void,
): void {
  const groupID = channel.startsWith("group:")
    ? channel.slice("group:".length)
    : null;
  const isCreator =
    groupID !== null && getMeshService()?.isGroupCreator(groupID) === true;
  const body = isCreator
    ? "chat.group.leave_creator_body"
    : "chat.channels.leave_body";
  showAlert(
    t(groupID !== null ? "chat.info.leave_group" : "chat.channels.leave"),
    t(body, { name }),
    [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("chat.channels.leave_confirm"),
        style: "destructive",
        onPress: () => {
          leaveConversation(channel);
          onLeft?.();
        },
      },
    ],
  );
}
