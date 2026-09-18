// The Ring alert: the overlay that owns the ringing.
//
// Mounted once at the app root like AlertModal, and shown for every ring not
// arriving in the thread on screen, in front or not, so somebody who opens
// the app mid-ring finds it waiting. Out of the foreground the system tray
// carries the same ring (raiseRingNotification); rings from other people
// wait in incoming-ring-store's queue.
//
// Rings for RING_ALERT_DURATION_MS from arrival: Android's ringtone loop, or
// a haptic pulse where the loop cannot start (iOS, silent mode, Do Not
// Disturb). Only Open and Snooze answer the sender. Closing the sheet
// silences it and sends nothing, as swiping a call banner away does; the
// bell row and tray card stay as the record.
import { useT } from "@i18n";
import { ringPulse } from "@platform/haptics";
import { startRingAlert, stopRingAlert } from "@platform/ring-alert";
import { getMeshService } from "@services/mesh-service";
import {
  endRingAlertFor,
  openConversation,
} from "@services/notification-service";
import {
  type IncomingRing,
  useIncomingRingStore,
} from "@store/incoming-ring-store";
import {
  RING_ALERT_DURATION_MS,
  RING_SNOOZE_1H_MS,
  useRingStore,
} from "@store/ring-store";
import React, { useEffect, useMemo, useRef } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
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
  const visible = ring !== null;
  // Ref so the handlers read the latest ring without retriggering on every
  // update.
  const ringRef = useRef(ring);
  useEffect(() => {
    ringRef.current = ring;
  }, [ring]);

  useEffect(() => {
    if (ring === null) return;
    // Measured from arrival, not from this effect. iOS suspends JS shortly
    // after the app leaves the screen, so a timer can fire late, on a resume
    // minutes later, and flash the overlay for a ring long over. The resume
    // check below covers a suspension that began inside the window.
    const remainingMs = ring.receivedAtMs + RING_ALERT_DURATION_MS - Date.now();
    if (remainingMs <= 0) {
      useIncomingRingStore.getState().dismiss();
      return;
    }
    let pulse: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    // Haptics only where the loop could not start, so a phone in silent mode
    // still says something under the thumb.
    void startRingAlert(remainingMs).then((ringing) => {
      if (ringing || cancelled) return;
      ringPulse();
      pulse = setInterval(ringPulse, PULSE_INTERVAL_MS);
    });
    const expire = (): void => {
      useIncomingRingStore.getState().dismiss();
    };
    const timeout = setTimeout(expire, remainingMs);
    const resumed = AppState.addEventListener("change", (next) => {
      if (
        next === "active" &&
        Date.now() >= ring.receivedAtMs + RING_ALERT_DURATION_MS
      ) {
        expire();
      }
    });
    return () => {
      cancelled = true;
      if (pulse !== null) clearInterval(pulse);
      clearTimeout(timeout);
      resumed.remove();
      void stopRingAlert();
    };
  }, [ring]);

  // endRingAlertFor takes this ring out of the store before its first await,
  // which moves the overlay on and stops the loop through the effect cleanup.
  function answer(current: IncomingRing): void {
    void endRingAlertFor(`dm:${current.peerID}`);
    getMeshService()?.acknowledgeRingsIn(
      `dm:${current.peerID}`,
      current.peerID,
    );
  }

  function handleOpen(): void {
    const current = ringRef.current;
    if (current === null) return;
    answer(current);
    openConversation(`dm:${current.peerID}`);
  }

  function handleSnooze(): void {
    const current = ringRef.current;
    if (current === null) return;
    useRingStore
      .getState()
      .snooze(current.peerID, Date.now() + RING_SNOOZE_1H_MS);
    answer(current);
  }

  function handleDismiss(): void {
    useIncomingRingStore.getState().dismiss();
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={handleDismiss}
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
