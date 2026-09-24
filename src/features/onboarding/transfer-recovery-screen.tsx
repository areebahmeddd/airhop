// Shown at launch, before the mesh starts, when a transfer was left unresolved
// (see services/move-marker):
//
//   sender     sent everything, heard nothing back. The person checks the new
//              phone and chooses.
//   receiver   installed, never released. Shows whose identity it holds, which
//              is what the old phone tells the person to look for.

import { loadIdentity } from "@core/crypto/identity";
import Feather from "@expo/vector-icons/Feather";
import { useT } from "@i18n";
import Avatar from "@ui/components/avatar";
import PrimaryButton from "@ui/components/primary-button";
import TextButton from "@ui/components/text-button";
import {
  BUTTON_HEIGHT,
  FontSize,
  FontWeight,
  LineHeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { peerIDToUsername } from "@utils/username";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const AVATAR_SIZE = 72;

type Props =
  | { role: "sender"; onErase: () => void; onKeep: () => void }
  | { role: "receiver"; onContinue: () => void };

export default function TransferRecoveryScreen(
  props: Props,
): React.JSX.Element {
  const Colors = useThemeColors();
  const T = useT();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const sender = props.role === "sender";
  // One answer per launch, however fast the taps: each starts a wipe or a boot.
  const acted = useRef(false);
  const once =
    (action: () => void): (() => void) =>
    () => {
      if (acted.current) return;
      acted.current = true;
      action();
    };
  const [peerID, setPeerID] = useState<string | null>(null);

  useEffect(() => {
    if (sender) return;
    let live = true;
    loadIdentity()
      .then((id) => {
        if (live && id !== null) setPeerID(id.peerID);
      })
      .catch(() => {
        // The question stands without the name.
      });
    return () => {
      live = false;
    };
  }, [sender]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body} accessibilityLiveRegion="polite">
        {peerID !== null ? (
          <View style={styles.identity}>
            <Avatar
              username={peerIDToUsername(peerID)}
              peerID={peerID}
              size={AVATAR_SIZE}
            />
            <Text style={styles.name}>{peerIDToUsername(peerID)}</Text>
          </View>
        ) : (
          <View style={styles.icon}>
            <Feather
              name={sender ? "help-circle" : "smartphone"}
              size={26}
              color={Colors.textPrimary}
            />
          </View>
        )}
        <Text style={styles.title} accessibilityRole="header">
          {T(
            sender
              ? "settings.transfer.unconfirmed_title"
              : "onboarding.transfer.check_title",
          )}
        </Text>
        <Text style={styles.text}>
          {T(
            sender
              ? "settings.transfer.unconfirmed_body"
              : "onboarding.transfer.check_body",
          )}
        </Text>
      </View>
      <View style={styles.actions}>
        {props.role === "sender" ? (
          <>
            <Pressable
              style={({ pressed }) => [
                styles.dangerBtn,
                pressed && styles.dangerPressed,
              ]}
              onPress={once(props.onErase)}
              accessibilityRole="button"
            >
              <Text style={styles.dangerLabel}>
                {T("settings.transfer.erase_cta")}
              </Text>
            </Pressable>
            <TextButton
              label={T("settings.transfer.keep_cta")}
              onPress={once(props.onKeep)}
            />
          </>
        ) : (
          <PrimaryButton
            label={T("common.continue")}
            onPress={once(props.onContinue)}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    body: {
      flex: 1,
      paddingHorizontal: Spacing.xl,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    icon: {
      width: 56,
      height: 56,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    identity: {
      alignItems: "center",
      gap: Spacing.sm,
      marginBottom: Spacing.sm,
    },
    // A username is user content in any script, so prose, not mono.
    name: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
    },
    title: {
      fontSize: FontSize.lg,
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
      textAlign: "center",
    },
    text: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
      lineHeight: LineHeight.sm,
    },
    actions: {
      paddingHorizontal: Spacing.base,
      paddingBottom: Spacing.md,
      gap: Spacing.sm,
    },
    dangerBtn: {
      minHeight: BUTTON_HEIGHT,
      borderRadius: Radius.full,
      // The outlined pill of a second action; destructive reads in the label.
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.borderStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    dangerPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    dangerLabel: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.danger,
    },
  });
}
