// What a group invite shows in place of the composer: Join or Decline. Nothing
// is read or sent in a group until the user joins it.

import { useT } from "@i18n";
import { useChatStore } from "@store/chat-store";
import { useGroupStore } from "@store/group-store";
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
      {/* Declining is leaving: the creator's next rotation does not ask again. */}
      <PrimaryButton
        label={T("chat.group.decline")}
        variant="outline"
        onPress={() => {
          leaveConversation(channel);
          onDeclined();
        }}
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
