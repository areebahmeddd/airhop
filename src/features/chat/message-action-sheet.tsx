// Long-press context menu for a message: info, save, forward, copy and select.
// It shares the bottom-sheet chrome of the attachment picker and the channel
// info sheet.

import { useT } from "@i18n";
import {
  Feather,
  type FeatherIconName,
} from "@react-native-vector-icons/feather/static";
import type { ChatMessage } from "@store/chat-store";
import BottomSheet from "@ui/components/bottom-sheet";
import {
  FontSize,
  FontWeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface Props {
  message: ChatMessage | null;
  onClose: () => void;
  onForward: () => void;
  onCopy: () => void;
  onInfo: () => void;
  // Get an attachment out of the app. Received files live in Airhop's private
  // cache, so without this a photo or a document dies with the cache.
  onSave: () => void;
  // Enter selection mode with this message picked, for forwarding several at
  // once. Same place WhatsApp and Signal put it: the long-press menu.
  onSelect: () => void;
}

export default function MessageActionSheet({
  message,
  onClose,
  onForward,
  onCopy,
  onInfo,
  onSave,
  onSelect,
}: Props): React.JSX.Element | null {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  if (!message) return null;

  function act(action: () => void): void {
    action();
    onClose();
  }

  // Delivery info is only meaningful for your own outgoing messages.
  const canShowInfo =
    message.isMine && !message.isSystem && message.status !== undefined;

  // A row Airhop wrote is not forwarded (see forwardMessage), so it is not
  // offered. A place is, and explains why not when tapped: someone looking for
  // how to pass a location on is told, rather than finding nothing.
  const canForward =
    message.systemKey === undefined || message.locationPin !== undefined;

  // Photos and videos have somewhere to go (the system gallery); everything
  // else goes out through the share sheet, so the row says what will happen.
  const isGallery =
    message.attachment?.type === "image" ||
    message.attachment?.type === "video";

  return (
    <BottomSheet visible onClose={onClose} sheetStyle={styles.sheet}>
      {/* One card of rows, matching the channel "more" sheet. */}
      <View style={styles.actionGroup}>
        {canShowInfo && (
          <ActionRow
            icon="info"
            label={T("chat.action.info")}
            onPress={() => act(onInfo)}
            color={Colors.textPrimary}
          />
        )}
        {message.attachment && (
          <>
            {canShowInfo && <View style={styles.divider} />}
            <ActionRow
              icon={isGallery ? "download" : "share"}
              label={
                isGallery
                  ? T("chat.action.save_photos")
                  : T("chat.action.save_copy")
              }
              onPress={() => act(onSave)}
              color={Colors.textPrimary}
            />
          </>
        )}
        {canForward && (
          <>
            {(canShowInfo || message.attachment) && (
              <View style={styles.divider} />
            )}
            <ActionRow
              icon="corner-up-right"
              label={T("chat.action.forward")}
              onPress={() => act(onForward)}
              color={Colors.textPrimary}
            />
          </>
        )}
        {message.text.length > 0 && (
          <>
            {(canShowInfo || message.attachment || canForward) && (
              <View style={styles.divider} />
            )}
            <ActionRow
              icon="copy"
              label={T("common.copy")}
              onPress={() => act(onCopy)}
              color={Colors.textPrimary}
            />
          </>
        )}
        <View style={styles.divider} />
        <ActionRow
          icon="check-circle"
          label={T("chat.action.select")}
          onPress={() => act(onSelect)}
          color={Colors.textPrimary}
        />
      </View>
    </BottomSheet>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
  color,
}: {
  icon: FeatherIconName;
  label: string;
  onPress: () => void;
  color: string;
}): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <Pressable
      style={styles.actionRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={17} color={color} />
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    sheet: {
      paddingHorizontal: Spacing.base,
      paddingBottom: Spacing["2xl"],
    },
    // One raised card owns the background and rounded corners; the rows sit
    // transparent inside it, clipped to the radius by overflow.
    actionGroup: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      overflow: "hidden",
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.base,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.base,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
      marginStart: Spacing.base,
    },
    actionLabel: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
    },
  });
}
