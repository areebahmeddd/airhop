// Foreground Ring alert, mounted once at the app root like AlertModal.
// A backgrounded ring goes through raiseRingNotification instead; see
// app.tsx's subscribeInboundRings wiring.
//
// A haptic pulse loops while this is on screen, for up to
// RING_ALERT_DURATION_MS. Backdrop dismiss and the timeout send no
// acknowledgement; only Open or Snooze do.

import { useT } from "@i18n";
import { ringPulse } from "@platform/haptics";
import { getMeshService } from "@services/mesh-service";
import { openConversation } from "@services/notification-service";
import { useIncomingRingStore } from "@store/incoming-ring-store";
import {
  RING_ALERT_DURATION_MS,
  RING_SNOOZE_1H_MS,
  useRingStore,
} from "@store/ring-store";
import React, { useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BUTTON_HEIGHT,
  FontSize,
  FontWeight,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  useThemeColors,
} from "../theme";
import BottomSheet from "./bottom-sheet";

const PULSE_INTERVAL_MS = 900;

export default function RingAlertSheet(): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const insets = useSafeAreaInsets();
  const ring = useIncomingRingStore((s) => s.current);
  const clear = useIncomingRingStore((s) => s.clear);
  const visible = ring !== null;
  // Ref so the interval, timeout and handlers read the latest ring without
  // retriggering on every update. Set in an effect, never during render.
  const ringRef = useRef(ring);
  useEffect(() => {
    ringRef.current = ring;
  }, [ring]);

  useEffect(() => {
    if (!visible) return;
    ringPulse();
    const pulse = setInterval(ringPulse, PULSE_INTERVAL_MS);
    const timeout = setTimeout(() => {
      // No close animation: it just stops asking.
      useIncomingRingStore.getState().clear();
    }, RING_ALERT_DURATION_MS);
    return () => {
      clearInterval(pulse);
      clearTimeout(timeout);
    };
  }, [visible, ring?.ringID]);

  function handleOpen(): void {
    const current = ringRef.current;
    if (current === null) return;
    clear();
    openConversation(`dm:${current.peerID}`);
    // Ack now, so the sender sees it before navigation settles.
    getMeshService()?.acknowledgeRingsIn(
      `dm:${current.peerID}`,
      current.peerID,
    );
  }

  function handleSnooze(): void {
    const current = ringRef.current;
    if (current === null) return;
    clear();
    useRingStore
      .getState()
      .snooze(current.peerID, Date.now() + RING_SNOOZE_1H_MS);
    // A snooze is still a response; ack it so the sender isn't stuck on "Ringing...".
    getMeshService()?.acknowledgeRingsIn(
      `dm:${current.peerID}`,
      current.peerID,
    );
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={clear}
      sheetStyle={[styles.sheet, { paddingBottom: Spacing.xl + insets.bottom }]}
    >
      <View style={styles.bellRow}>
        <Text style={styles.bell}>🔔</Text>
      </View>
      <Text style={styles.title}>
        {ring ? T("chat.ring.alert.title", { sender: ring.senderName }) : ""}
      </Text>
      <Text style={styles.body}>{T("chat.ring.alert.body")}</Text>
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [
            styles.btnDefault,
            pressed && styles.btnPressed,
          ]}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={T("chat.ring.alert.open")}
        >
          <Text style={styles.btnDefaultText}>{T("chat.ring.alert.open")}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.btnOutline,
            pressed && styles.btnOutlinePressed,
          ]}
          onPress={handleSnooze}
          accessibilityRole="button"
          accessibilityLabel={T("chat.ring.alert.snooze")}
        >
          <Text style={styles.btnOutlineText}>
            {T("chat.ring.alert.snooze")}
          </Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    sheet: {
      paddingHorizontal: Spacing.xl,
      gap: Spacing.sm,
      alignItems: "center",
    },
    bellRow: {
      marginBottom: Spacing.xs,
    },
    bell: {
      fontSize: 40,
    },
    title: {
      fontSize: FontSize.lg,
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
      textAlign: "center",
    },
    body: {
      fontSize: FontSize.base,
      color: Colors.textSecondary,
      textAlign: "center",
      marginBottom: Spacing.sm,
    },
    actions: {
      width: "100%",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    btnDefault: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      borderRadius: Radius.full,
      backgroundColor: Colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    btnDefaultText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.bold,
      color: Colors.textInverse,
    },
    btnOutline: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    btnOutlineText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    btnPressed: {
      opacity: PRESSED_OPACITY,
    },
    btnOutlinePressed: {
      backgroundColor: Colors.surfacePressed,
    },
  });
}
