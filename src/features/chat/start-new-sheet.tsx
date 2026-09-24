// The Chats header "+" flow: pick what to start, then fill in that form.
// Mounted beside the Chats list, not inside channel-list, because the Direct
// sub-tab unmounts that list and the "+" must work on both; one mount means
// no second chooser to keep in sync. Channel and group sit side by side because
// both are private and encrypted, so their real difference (shareable link, no
// cap vs a fixed signed roster on Bluetooth) is stated at the choice.

import { generateChannelKey } from "@core/mesh/rooms/channel-crypto";
import { Feather } from "@expo/vector-icons";
import { useT } from "@i18n";
import { useChatStore } from "@store/chat-store";
import BottomSheet from "@ui/components/bottom-sheet";
import ChoiceList from "@ui/components/choice-list";
import {
  BUTTON_HEIGHT,
  DISABLED_OPACITY,
  FontSize,
  FontWeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { GeohashJumpSheet } from "./geohash-jump-sheet";
import { JoinLinkSheet } from "./join-link-sheet";
import { NewGroupSheet } from "./new-group-sheet";

interface Props {
  // Increment to open the chooser. A counter avoids an open/close flag's
  // edge cases.
  trigger: number;
  // Open a channel once it has been created or joined.
  onOpenChannel: (channel: string) => void;
}

export function StartNewSheet({
  trigger,
  onOpenChannel,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const channels = useChatStore((s) => s.channels);
  const joinPrivateChannel = useChatStore((s) => s.joinPrivateChannel);

  const [showChooser, setShowChooser] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showGeohash, setShowGeohash] = useState(false);
  const [showJoinLink, setShowJoinLink] = useState(false);
  const [newChannel, setNewChannel] = useState("");
  // Defaults to Bluetooth only, the most private reach.
  const [newChannelOverNostr, setNewChannelOverNostr] = useState(false);

  // Seeded with the current value so a remount (back from a thread) does not
  // reopen the chooser.
  const prevTrigger = useRef(trigger);
  useEffect(() => {
    if (trigger > prevTrigger.current) {
      prevTrigger.current = trigger;
      setShowChooser(true);
    }
  }, [trigger]);

  // Groups and DMs are keyed by prefix, so only #channels can collide.
  const normalizedInput = newChannel.trim().replace(/^#*/, "#").toLowerCase();
  const nameAlreadyExists =
    normalizedInput.length > 1 &&
    channels.some(
      (c) =>
        !c.startsWith("dm:") &&
        !c.startsWith("group:") &&
        c.toLowerCase() === normalizedInput,
    );
  // At least one character after the "#". Both unusable-name reasons disable
  // Create and say why, so the button is never live yet inert.
  const nameTooShort = normalizedInput.length < 2;
  const canCreate = !nameTooShort && !nameAlreadyExists;

  // `backToChooser` reopens the chooser, since the user may have picked the
  // wrong option. Backdrop or system back leaves entirely.
  function resetJoinModal(backToChooser = false): void {
    setNewChannel("");
    setNewChannelOverNostr(false);
    setShowJoinModal(false);
    if (backToChooser) setShowChooser(true);
  }

  function handleAdd(): void {
    const name = newChannel.trim().replace(/^#*/, "#");
    if (!canCreate) return;
    // Every custom channel is end-to-end encrypted under a fresh key, shared
    // only through its invite link.
    joinPrivateChannel(name, generateChannelKey(), newChannelOverNostr);
    resetJoinModal();
    // Without this, a channel started from the Direct sub-tab appears on the
    // other one and reads as nothing having happened.
    onOpenChannel(name);
  }

  return (
    <>
      {/* Step 1: what are we starting? */}
      <BottomSheet
        visible={showChooser}
        onClose={() => setShowChooser(false)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("chat.new.title")}</Text>

        <ChoiceList
          choices={[
            {
              key: "channel",
              icon: "hash",
              title: T("chat.new.channel_label"),
              detail: T("chat.new.channel_desc"),
              a11yLabel: T("chat.new.channel"),
              onPress: () => {
                setShowChooser(false);
                setShowJoinModal(true);
              },
            },
            {
              key: "group",
              icon: "users",
              title: T("chat.new.group_label"),
              detail: T("chat.new.group_desc"),
              a11yLabel: T("chat.new.group"),
              onPress: () => {
                setShowChooser(false);
                setShowNewGroup(true);
              },
            },
            {
              key: "place",
              icon: "map-pin",
              title: T("chat.new.place_label"),
              detail: T("chat.new.place_desc"),
              a11yLabel: T("chat.new.place"),
              onPress: () => {
                setShowChooser(false);
                setShowGeohash(true);
              },
            },
          ]}
        />

        <Pressable
          style={styles.modalCancel}
          onPress={() => setShowChooser(false)}
          accessibilityRole="button"
          accessibilityLabel={T("common.cancel")}
        >
          <Text style={styles.modalCancelText}>{T("common.cancel")}</Text>
        </Pressable>
      </BottomSheet>

      {/* Step 2a: the private channel form. */}
      <BottomSheet
        visible={showJoinModal}
        onClose={() => resetJoinModal()}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("chat.new.channel")}</Text>
        <View style={styles.privacyNote}>
          <View style={styles.privacyNoteRow}>
            <Feather name="lock" size={14} color={Colors.e2ee} />
            <Text style={styles.privacyNoteText}>{T("chat.new.e2ee")}</Text>
          </View>
          <View style={styles.privacyNoteRow}>
            <Feather name="link" size={14} color={Colors.textMuted} />
            <Text style={styles.privacyNoteText}>
              {T("chat.new.invite_only")}
            </Text>
          </View>
          <View style={styles.privacyNoteRow}>
            <Feather
              name={newChannelOverNostr ? "globe" : "bluetooth"}
              size={14}
              color={Colors.textMuted}
            />
            <Text style={styles.privacyNoteText}>
              {newChannelOverNostr
                ? T("chat.new.reach_internet")
                : T("chat.new.reach_mesh")}
            </Text>
          </View>
        </View>
        <View>
          <TextInput
            style={[
              styles.modalInput,
              nameAlreadyExists && styles.modalInputError,
            ]}
            value={newChannel}
            onChangeText={setNewChannel}
            placeholder="#channel-name"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="none"
            autoFocus
            onSubmitEditing={handleAdd}
            returnKeyType="done"
            selectionColor={Colors.selection}
          />
          {nameAlreadyExists && (
            <Text style={styles.inputError} accessibilityLiveRegion="polite">
              {T("chat.new.name_exists")}
            </Text>
          )}
        </View>

        {/* Encryption is always on; this picks the send path: mesh only, or
            also sealed over Nostr for members out of range. */}
        <View style={styles.optionGroup}>
          <Text style={styles.optionLabel}>{T("chat.new.reach")}</Text>
          <View style={styles.optionRow}>
            <Pressable
              style={[
                styles.optionChip,
                !newChannelOverNostr && styles.optionChipActive,
              ]}
              onPress={() => setNewChannelOverNostr(false)}
              accessibilityRole="button"
              accessibilityState={{ selected: !newChannelOverNostr }}
            >
              <Feather
                name="bluetooth"
                size={13}
                color={
                  newChannelOverNostr ? Colors.textMuted : Colors.textPrimary
                }
              />
              <Text
                style={
                  newChannelOverNostr
                    ? styles.optionChipText
                    : styles.optionChipTextActive
                }
              >
                {T("chat.new.reach_bluetooth_chip")}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.optionChip,
                newChannelOverNostr && styles.optionChipActive,
              ]}
              onPress={() => setNewChannelOverNostr(true)}
              accessibilityRole="button"
              accessibilityState={{ selected: newChannelOverNostr }}
            >
              <Feather
                name="globe"
                size={13}
                color={
                  newChannelOverNostr ? Colors.textPrimary : Colors.textMuted
                }
              />
              <Text
                style={
                  newChannelOverNostr
                    ? styles.optionChipTextActive
                    : styles.optionChipText
                }
              >
                {T("chat.new.reach_internet_chip")}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.reachHint}>
            {newChannelOverNostr
              ? T("chat.new.reach_internet_desc")
              : T("chat.new.reach_mesh_desc")}
          </Text>
        </View>

        {/* Creating and joining are one decision, so joining sits here, below
            the form since creating is the common case. The typed name is kept,
            so Back lands where it left. */}
        <Pressable
          style={styles.joinLinkRow}
          onPress={() => {
            setShowJoinModal(false);
            setShowJoinLink(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={T("chat.new.join_link")}
        >
          <Feather name="link" size={14} color={Colors.accent} />
          <Text style={styles.joinLinkText}>{T("chat.new.have_link")}</Text>
        </Pressable>

        <View style={styles.modalActions}>
          <Pressable
            style={styles.modalCancel}
            onPress={() => resetJoinModal(true)}
            accessibilityRole="button"
            accessibilityLabel={T("chat.new.back_to_chooser")}
          >
            <Text style={styles.modalCancelText}>{T("common.back")}</Text>
          </Pressable>
          <Pressable
            style={[
              styles.modalConfirm,
              !canCreate && styles.modalConfirmDisabled,
            ]}
            onPress={handleAdd}
            disabled={!canCreate}
            accessibilityRole="button"
            accessibilityLabel={T("chat.new.create_channel")}
            accessibilityState={{ disabled: !canCreate }}
            accessibilityHint={
              nameTooShort
                ? T("chat.new.name_required")
                : nameAlreadyExists
                  ? T("chat.new.name_taken")
                  : undefined
            }
          >
            <Text style={styles.modalConfirmText}>{T("chat.new.create")}</Text>
          </Pressable>
        </View>
      </BottomSheet>

      {/* Step 2b and 2c: the group roster and the geohash jump. */}
      <NewGroupSheet
        visible={showNewGroup}
        onClose={() => setShowNewGroup(false)}
        onBack={() => {
          setShowNewGroup(false);
          setShowChooser(true);
        }}
        onCreated={(channel) => {
          setShowNewGroup(false);
          onOpenChannel(channel);
        }}
      />

      <GeohashJumpSheet
        visible={showGeohash}
        onClose={() => setShowGeohash(false)}
        onBack={() => {
          setShowGeohash(false);
          setShowChooser(true);
        }}
        onJoined={(channel) => {
          setShowGeohash(false);
          onOpenChannel(channel);
        }}
      />

      {/* Step 3: paste an invite. Back returns to the channel form. The link
          may open a channel, a DM or a card. */}
      <JoinLinkSheet
        visible={showJoinLink}
        onClose={() => setShowJoinLink(false)}
        onBack={() => {
          setShowJoinLink(false);
          setShowJoinModal(true);
        }}
        onJoined={(channel) => {
          setShowJoinLink(false);
          resetJoinModal();
          onOpenChannel(channel);
        }}
      />
    </>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    modalSheet: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.xl,
      gap: Spacing.base,
    },
    modalTitle: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    privacyNote: {
      gap: Spacing.sm,
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      padding: Spacing.md,
    },
    privacyNoteRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
    },
    privacyNoteText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: 19,
    },
    modalInput: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.xl,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      color: Colors.textPrimary,
      fontSize: FontSize.base,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    modalInputError: {
      borderColor: Colors.danger,
    },
    inputError: {
      fontSize: FontSize.xs,
      color: Colors.danger,
      marginTop: 4,
    },
    optionGroup: {
      gap: Spacing.xs,
    },
    optionLabel: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    optionRow: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    optionChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: Spacing.md,
      paddingVertical: 9,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.bg,
    },
    optionChipActive: {
      borderColor: Colors.accent,
      backgroundColor: Colors.surface,
    },
    optionChipText: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      fontWeight: FontWeight.medium,
    },
    optionChipTextActive: {
      fontSize: FontSize.sm,
      color: Colors.textPrimary,
      fontWeight: FontWeight.semibold,
    },
    reachHint: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      lineHeight: 17,
    },
    joinLinkRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.xs,
    },
    joinLinkText: {
      fontSize: FontSize.sm,
      color: Colors.accent,
      fontWeight: FontWeight.medium,
    },
    modalActions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    modalCancel: {
      flex: 1,
      minHeight: BUTTON_HEIGHT,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
      borderRadius: Radius.full,
      paddingVertical: Spacing.md,
      alignItems: "center",
      justifyContent: "center",
    },
    modalCancelText: {
      fontSize: FontSize.base,
      color: Colors.textPrimary,
      fontWeight: FontWeight.semibold,
    },
    modalConfirm: {
      flex: 1,
      minHeight: BUTTON_HEIGHT,
      backgroundColor: Colors.accent,
      borderRadius: Radius.full,
      paddingVertical: Spacing.md,
      alignItems: "center",
      justifyContent: "center",
    },
    modalConfirmDisabled: {
      opacity: DISABLED_OPACITY,
    },
    modalConfirmText: {
      fontSize: FontSize.base,
      color: Colors.textInverse,
      fontWeight: FontWeight.semibold,
    },
  });
}
