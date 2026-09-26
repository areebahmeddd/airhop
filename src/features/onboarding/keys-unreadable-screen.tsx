// Shown at launch when the keychain did not answer (see
// services/launch-identity). Onboarding here would write over an identity the
// keychain may still hold, so the person is asked instead: unlock and try
// again, or deliberately start over. A key that stays corrupt would otherwise
// trap them, which is what the second way out is for.

import { useT } from "@i18n";
import { showAlert } from "@store/alert-store";
import EmptyState from "@ui/components/empty-state";
import PrimaryButton from "@ui/components/primary-button";
import TextButton from "@ui/components/text-button";
import { Spacing, useThemeColors } from "@ui/theme";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  // A read is in flight, so another tap would only queue a second one.
  checking: boolean;
  onRetry: () => void;
  onStartOver: () => void;
}

export default function KeysUnreadableScreen({
  checking,
  onRetry,
  onStartOver,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const T = useT();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  function confirmStartOver(): void {
    showAlert(
      T("launch.start_over_confirm_title"),
      T("launch.start_over_confirm_body"),
      [
        { text: T("common.cancel"), style: "cancel" },
        {
          text: T("launch.start_over"),
          style: "destructive",
          onPress: onStartOver,
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <EmptyState
        icon="lock"
        title={T("launch.keys_unreadable_title")}
        subtitle={T("launch.keys_unreadable_body")}
      />
      <View style={styles.actions}>
        <PrimaryButton
          label={T("common.try_again")}
          onPress={onRetry}
          disabled={checking}
        />
        <TextButton label={T("launch.start_over")} onPress={confirmStartOver} />
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
    actions: {
      paddingHorizontal: Spacing.base,
      paddingBottom: Spacing.md,
      gap: Spacing.sm,
    },
  });
}
