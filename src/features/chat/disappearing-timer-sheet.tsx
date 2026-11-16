// The picker for one private chat's disappearing timer, opened from the chat's
// info sheet and from the timer beside the name in the thread header. The
// same four choices as the default in General. A choice applies to messages
// sent from then on, so nothing here asks for confirmation: turning it on
// deletes nothing, and turning it off brings nothing back.

import { useT, useTPlural } from "@i18n";
import { Feather } from "@react-native-vector-icons/feather/static";
import { getMeshService } from "@services/mesh-service";
import { defaultDmTimerMs, useChatStore } from "@store/chat-store";
import {
  MESSAGE_RETENTION_DAY_OPTIONS,
  useSettingsStore,
} from "@store/settings-store";
import BottomSheet from "@ui/components/bottom-sheet";
import { useThemeColors } from "@ui/theme";
import { timerDays } from "@utils/disappearing-timer";
import { messageRetentionWindowMs } from "@utils/message-expiry";
import { resolveDisplayName } from "@utils/peer-display-name";
import React from "react";
import { Pressable, Text, View } from "react-native";
import {
  MESSAGE_RETENTION_DESCRIPTION,
  messageRetentionLabel,
} from "../settings/message-retention-labels";
import { GroupDivider, useSharedStyles } from "../settings/settings-primitives";

// The chat's timer in days, following a change made on either phone.
export function useDmTimerDays(channel: string | null): number {
  // Read so a chat still on the default follows a change to it.
  useSettingsStore((s) => s.messageRetentionDays);
  const ms = useChatStore((s) =>
    channel === null ? undefined : s.dmTimers[channel]?.ms,
  );
  return timerDays(ms ?? defaultDmTimerMs());
}

interface Props {
  // The chat's peer, or null when closed.
  peerID: string | null;
  onClose: () => void;
}

export default function DisappearingTimerSheet({
  peerID,
  onClose,
}: Props): React.JSX.Element {
  const T = useT();
  const TP = useTPlural();
  const Colors = useThemeColors();
  const styles = useSharedStyles();
  const channel = peerID === null ? null : `dm:${peerID}`;
  const days = useDmTimerDays(channel);
  // Our change the other phone has not acknowledged yet.
  const pending = useChatStore((s) => {
    const timer = channel === null ? undefined : s.dmTimers[channel];
    return timer?.unshared === true && timer.setBy === getMeshService()?.peerID;
  });
  const sharing =
    peerID === null
      ? "unknown"
      : (getMeshService()?.timerSharing(peerID) ?? "unknown");
  const name = peerID === null ? "" : resolveDisplayName(peerID);

  return (
    <BottomSheet
      visible={peerID !== null}
      onClose={onClose}
      sheetStyle={styles.sheet}
    >
      <Text style={styles.sheetTitle}>
        {T("settings.general.message_retention")}
      </Text>
      <Text style={styles.sheetSubtitle}>
        {sharing === "shared"
          ? pending
            ? T("chat.timer.sheet_pending", { name })
            : T("chat.timer.sheet_shared")
          : sharing === "unsupported"
            ? T("chat.timer.sheet_bitchat", { name })
            : T("chat.timer.sheet_local", { name })}
      </Text>
      <View style={styles.optionGroup}>
        {MESSAGE_RETENTION_DAY_OPTIONS.map((option, i) => {
          const selected = option === days;
          const label = messageRetentionLabel(T, TP, option);
          return (
            <React.Fragment key={option}>
              {i > 0 && <GroupDivider />}
              <Pressable
                style={({ pressed }) => [
                  styles.optionRowGrouped,
                  pressed && styles.rowPressed,
                ]}
                onPress={() => {
                  if (peerID !== null) {
                    getMeshService()?.setDisappearingTimer(
                      peerID,
                      messageRetentionWindowMs(option),
                    );
                  }
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
              >
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>{label}</Text>
                  <Text style={styles.optionDescription}>
                    {T(MESSAGE_RETENTION_DESCRIPTION[option])}
                  </Text>
                </View>
                {selected && (
                  <Feather name="check" size={18} color={Colors.textPrimary} />
                )}
              </Pressable>
            </React.Fragment>
          );
        })}
      </View>
    </BottomSheet>
  );
}
