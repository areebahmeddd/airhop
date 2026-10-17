// Drawn over the app root while the app lock is engaged; Modals stand down
// through AppModal. The covered phase shows the same face without asking.
// Prompts once per lock, only in front: the OS refuses one from the background.

import { useT } from "@i18n";
import { promptIfDue, requestUnlock } from "@services/app-lock";
import { useAppLockStore } from "@store/app-lock-store";
import EmptyState from "@ui/components/empty-state";
import PrimaryButton from "@ui/components/primary-button";
import { Spacing, useThemeColors } from "@ui/theme";
import React, { useEffect, useMemo } from "react";
import { AppState, BackHandler, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function LockScreen(): React.JSX.Element | null {
  const Colors = useThemeColors();
  const T = useT();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const phase = useAppLockStore((s) => s.phase);
  const generation = useAppLockStore((s) => s.generation);
  const authenticating = useAppLockStore((s) => s.authenticating);

  // Runs per generation. The listener covers a cold start rendered before the
  // app reports active; promptIfDue asks once per generation either way.
  useEffect(() => {
    if (phase !== "locked") return;
    if (AppState.currentState === "active") promptIfDue();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") promptIfDue();
    });
    return () => sub.remove();
  }, [phase, generation]);

  // Back leaves the app rather than reaching the screens underneath.
  useEffect(() => {
    if (phase === "open") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, [phase]);

  if (phase === "open") return null;

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root]}
      accessibilityViewIsModal
    >
      <SafeAreaView style={styles.fill}>
        <EmptyState
          icon="lock"
          title={T("lock.title")}
          subtitle={T("lock.body")}
        />
        {phase === "locked" && (
          <View style={styles.actions}>
            <PrimaryButton
              label={T("lock.unlock")}
              onPress={() => void requestUnlock()}
              disabled={authenticating}
            />
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    root: {
      backgroundColor: Colors.bg,
    },
    fill: {
      flex: 1,
    },
    actions: {
      paddingHorizontal: Spacing.base,
      paddingBottom: Spacing.md,
    },
  });
}
