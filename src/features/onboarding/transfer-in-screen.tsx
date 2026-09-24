// Onboarding's other way in: receive the identity from the old phone.
//
// One thing at a time, in the order the person needs it: where to scan, whose
// identity is arriving, and whether the old phone let go of it.

import Feather from "@expo/vector-icons/Feather";
import { useT, type TranslationKey } from "@i18n";
import { chevronBack } from "@i18n/layout";
import { rejected, succeeded } from "@platform/haptics";
import { clearMoveMarker } from "@services/move-marker";
import {
  MoveReceiver,
  type ReceiverFailure,
  type ReceiverState,
} from "@services/move-receiver";
import Avatar from "@ui/components/avatar";
import PrimaryButton from "@ui/components/primary-button";
import TextButton from "@ui/components/text-button";
import {
  FontSize,
  FontWeight,
  HIT_SLOP,
  LineHeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatNumber } from "@utils/format";
import { peerIDToUsername } from "@utils/username";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";

const QR_SIZE = 220;
const AVATAR_SIZE = 72;

const FAILURE_BODY: Record<ReceiverFailure, TranslationKey> = {
  incompatible: "onboarding.transfer.failed_incompatible",
  cancelled: "onboarding.transfer.failed_cancelled",
  interrupted: "onboarding.transfer.failed_interrupted",
  storage: "onboarding.transfer.failed_storage",
  unavailable: "onboarding.transfer.failed_unavailable",
};

interface Props {
  onCancel: () => void;
  onComplete: (peerID: string) => void;
}

export default function TransferInScreen({
  onCancel,
  onComplete,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const T = useT();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const [state, setState] = useState<ReceiverState>({ phase: "preparing" });
  const receiver = useRef<MoveReceiver | null>(null);
  const completed = useRef(false);
  // Try again starts a fresh receiver with a new key, token and code.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const next = new MoveReceiver((s) => {
      if (s.phase === "failed") rejected();
      else if (s.phase === "done") succeeded();
      setState(s);
    });
    receiver.current = next;
    void next.start();
    return () => next.dispose();
  }, [attempt]);

  // Released: the old phone is erased, so there is nothing left to ask.
  useEffect(() => {
    if (state.phase !== "done" || !state.released || completed.current) return;
    completed.current = true;
    onComplete(state.peerID);
  }, [state, onComplete]);

  // Leaving is not offered once the install has started.
  const busy =
    state.phase === "saving" ||
    state.phase === "releasing" ||
    (state.phase === "done" && state.released);
  function leave(): void {
    if (busy) return;
    receiver.current?.cancel();
    onCancel();
  }

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!busy && state.phase !== "done") {
        receiver.current?.cancel();
        onCancel();
      }
      return true;
    });
    return () => sub.remove();
  }, [busy, state.phase, onCancel]);

  function busyPanel(title: string, peerID?: string): React.JSX.Element {
    return (
      <View style={styles.center} accessibilityLiveRegion="polite">
        {peerID !== undefined ? (
          <Identity peerID={peerID} styles={styles} />
        ) : null}
        <ActivityIndicator size="large" color={Colors.textMuted} />
        <Text style={styles.heading} accessibilityRole="header">
          {title}
        </Text>
        {peerID !== undefined ? (
          <Text style={styles.body}>{T("onboarding.transfer.keep_open")}</Text>
        ) : null}
      </View>
    );
  }

  function renderBody(): React.JSX.Element {
    switch (state.phase) {
      case "preparing":
        return busyPanel(T("onboarding.transfer.preparing"));
      case "offline":
        return (
          <View style={styles.center} accessibilityLiveRegion="polite">
            <View style={styles.icon}>
              <Feather name="wifi-off" size={26} color={Colors.textPrimary} />
            </View>
            <Text style={styles.heading} accessibilityRole="header">
              {T("onboarding.transfer.offline_title")}
            </Text>
            <Text style={styles.body}>
              {T("onboarding.transfer.offline_body")}
            </Text>
          </View>
        );
      case "waiting":
        return (
          <View style={styles.waiting}>
            <Text style={styles.heading} accessibilityRole="header">
              {T("onboarding.transfer.scan_heading")}
            </Text>
            <View
              style={styles.qrCard}
              accessible
              accessibilityRole="image"
              accessibilityLabel={T("onboarding.transfer.qr_a11y")}
            >
              <QRCode
                value={state.code}
                size={QR_SIZE}
                ecl="M"
                color={Colors.textPrimary}
                backgroundColor={Colors.surface}
              />
            </View>
            <View style={styles.steps}>
              {[
                T("onboarding.transfer.step_open"),
                T("onboarding.transfer.step_go", {
                  tab: T("nav.tab.profile"),
                  row: T("settings.transfer.title"),
                }),
                T("onboarding.transfer.step_scan"),
              ].map((step, i) => (
                <View key={step} style={styles.step}>
                  <View style={styles.stepNumber}>
                    <Text style={styles.stepNumberText}>
                      {formatNumber(i + 1)}
                    </Text>
                  </View>
                  <Text style={styles.stepText}>{step}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.note}>
              {T("onboarding.transfer.network_note")}
            </Text>
          </View>
        );
      case "receiving":
        return (
          <View style={styles.center} accessibilityLiveRegion="polite">
            <Identity peerID={state.peerID} styles={styles} />
            <Text style={styles.heading} accessibilityRole="header">
              {T("onboarding.transfer.receiving", {
                percent: formatNumber(Math.floor(state.progress * 100)),
              })}
            </Text>
            <View
              style={styles.progressTrack}
              accessibilityRole="progressbar"
              accessibilityValue={{
                now: Math.round(state.progress * 100),
                min: 0,
                max: 100,
              }}
            >
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(state.progress * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.body}>
              {T("onboarding.transfer.keep_open")}
            </Text>
          </View>
        );
      case "saving":
        return busyPanel(T("onboarding.transfer.saving"), state.peerID);
      case "releasing":
        return busyPanel(T("onboarding.transfer.releasing"), state.peerID);
      case "done":
        return state.released ? (
          busyPanel(T("onboarding.transfer.releasing"), state.peerID)
        ) : (
          <View style={styles.center} accessibilityLiveRegion="polite">
            <Identity peerID={state.peerID} styles={styles} />
            <Text style={styles.heading} accessibilityRole="header">
              {T("onboarding.transfer.check_title")}
            </Text>
            <Text style={styles.body}>
              {T("onboarding.transfer.check_body")}
            </Text>
          </View>
        );
      case "failed":
        return (
          <View style={styles.center} accessibilityLiveRegion="assertive">
            <View style={[styles.icon, styles.iconDanger]}>
              <Feather name="alert-triangle" size={26} color={Colors.danger} />
            </View>
            <Text style={styles.heading} accessibilityRole="header">
              {T("onboarding.transfer.failed_title")}
            </Text>
            <Text style={styles.body}>{T(FAILURE_BODY[state.reason])}</Text>
          </View>
        );
    }
  }

  function renderActions(): React.JSX.Element | null {
    if (state.phase === "failed") {
      return (
        <>
          {state.reason !== "unavailable" ? (
            <PrimaryButton
              label={T("common.try_again")}
              onPress={() => setAttempt((n) => n + 1)}
            />
          ) : null}
          <TextButton label={T("common.back")} onPress={onCancel} />
        </>
      );
    }
    if (state.phase === "done" && !state.released) {
      const { peerID } = state;
      return (
        <PrimaryButton
          label={T("common.continue")}
          onPress={() => {
            clearMoveMarker();
            onComplete(peerID);
          }}
        />
      );
    }
    if (state.phase === "receiving") {
      return <TextButton label={T("common.cancel")} onPress={leave} />;
    }
    return null;
  }

  const actions = renderActions();
  const showBack =
    state.phase === "preparing" ||
    state.phase === "offline" ||
    state.phase === "waiting";

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        {showBack ? (
          <Pressable
            onPress={leave}
            style={styles.backBtn}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={T("common.back")}
          >
            <Feather name={chevronBack} size={24} color={Colors.textPrimary} />
          </Pressable>
        ) : (
          <View style={styles.backBtn} />
        )}
        <Text style={styles.headerTitle} numberOfLines={1}>
          {T("onboarding.transfer.title")}
        </Text>
        <View style={styles.backBtn} />
      </View>
      {/* Scrolls only when the text is too large to fit. */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {renderBody()}
      </ScrollView>
      {actions !== null ? <View style={styles.actions}>{actions}</View> : null}
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof createStyles>;

// Whose identity is arriving, so the person can tell it is theirs.
function Identity({
  peerID,
  styles,
}: {
  peerID: string;
  styles: Styles;
}): React.JSX.Element {
  const T = useT();
  const username = peerIDToUsername(peerID);
  return (
    <View style={styles.identity}>
      <Avatar username={username} peerID={peerID} size={AVATAR_SIZE} />
      <Text style={styles.incoming}>
        {T("onboarding.transfer.incoming", { name: username })}
      </Text>
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.base,
      minHeight: 56,
    },
    backBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      flexGrow: 1,
      fontSize: FontSize.md,
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
      textAlign: "center",
    },
    scroll: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.lg,
    },
    center: {
      alignItems: "center",
      gap: Spacing.md,
    },
    waiting: {
      alignItems: "center",
      gap: Spacing.lg,
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
    iconDanger: {
      borderColor: Colors.danger,
    },
    heading: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      textAlign: "center",
    },
    body: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
      lineHeight: LineHeight.sm,
    },
    // The same card as the contact QR.
    qrCard: {
      padding: Spacing.xl,
      backgroundColor: Colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    steps: {
      alignSelf: "stretch",
      gap: Spacing.md,
    },
    step: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
    },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    // A digit centred in a circle: Android's font padding would sit it low.
    stepNumberText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      includeFontPadding: false,
    },
    stepText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textPrimary,
      lineHeight: LineHeight.sm,
    },
    note: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      textAlign: "center",
      lineHeight: LineHeight.xs,
    },
    identity: {
      alignItems: "center",
      gap: Spacing.sm,
      marginBottom: Spacing.sm,
    },
    incoming: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
      textAlign: "center",
    },
    progressTrack: {
      height: Spacing.xs,
      alignSelf: "stretch",
      backgroundColor: Colors.border,
      borderRadius: Radius.xs,
      overflow: "hidden",
    },
    progressFill: {
      height: "100%",
      backgroundColor: Colors.textPrimary,
      borderRadius: Radius.xs,
    },
    actions: {
      paddingHorizontal: Spacing.base,
      paddingBottom: Spacing.md,
      gap: Spacing.sm,
    },
  });
}
