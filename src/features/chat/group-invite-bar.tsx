// What a group invite shows in place of the composer: Join or Decline. Nothing
// is read or sent in a group until the user joins it.

import { t, useT } from "@i18n";
import { getMeshService } from "@services/mesh-service";
import { showAlert } from "@store/alert-store";
import { useBlockedStore } from "@store/blocked-store";
import { useChatStore } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { groupChannel, useGroupStore } from "@store/group-store";
import PrimaryButton from "@ui/components/primary-button";
import { Spacing, useThemeColors } from "@ui/theme";
import { systemRow } from "@utils/message-text";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { leaveConversation } from "./leave-conversation";

export function joinGroupInvite(channel: string): void {
  const groupIDHex = channel.slice("group:".length);
  const groups = useGroupStore.getState();
  const name = groups.invite(groupIDHex)?.name;
  if (name === undefined || !groups.acceptInvite(groupIDHex)) return;
  useChatStore.getState().addMessage({
    id: `sys-group-join-${groupIDHex}`,
    channel,
    senderID: "",
    senderNickname: "",
    ...systemRow("chat.group.you_were_added", { name }),
    timestampMs: Date.now(),
    isMine: false,
    isSystem: true,
  });
}

// Declining is leaving, so the creator's next rotation does not ask again. An
// invite from someone who is not a contact also offers to block them, which is
// what ends a stranger re-inviting: their pending invites go with the block.
function declineGroupInvite(channel: string, onDeclined: () => void): void {
  const invite = useGroupStore
    .getState()
    .invite(channel.slice("group:".length));
  const creator = invite?.members.find(
    (m) => m.fingerprint === invite.creatorFingerprint,
  );
  const decline = (): void => {
    leaveConversation(channel);
    onDeclined();
  };
  if (invite === undefined || creator === undefined) {
    decline();
    return;
  }
  const creatorID = creator.fingerprint.slice(0, 16);
  if (useContactsStore.getState().getContact(creatorID) !== undefined) {
    decline();
    return;
  }
  showAlert(
    t("chat.group.decline_title", { name: invite.name }),
    t("chat.group.decline_body", { name: creator.nickname }),
    [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("chat.group.decline"), onPress: decline },
      {
        text: t("chat.group.decline_block"),
        style: "destructive",
        onPress: () => {
          useBlockedStore.getState().blockPeer(creatorID);
          getMeshService()?.forgetPeer(creatorID);
          for (const pending of useGroupStore.getState().invites) {
            if (pending.creatorFingerprint === creator.fingerprint) {
              leaveConversation(groupChannel(pending.groupID));
            }
          }
          onDeclined();
        },
      },
    ],
  );
}

// Stacked like every other pair of actions: the filled one first.
export default function GroupInviteBar({
  channel,
  onDeclined,
}: {
  channel: string;
  onDeclined: () => void;
}): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <View style={styles.bar}>
      <PrimaryButton
        label={T("chat.join.join")}
        onPress={() => joinGroupInvite(channel)}
      />
      <PrimaryButton
        label={T("chat.group.decline")}
        variant="outline"
        onPress={() => declineGroupInvite(channel, onDeclined)}
      />
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    // The compose bar's edge and padding, so the swap reads as the same strip.
    bar: {
      gap: Spacing.sm,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: Colors.border,
      backgroundColor: Colors.bg,
    },
  });
}
