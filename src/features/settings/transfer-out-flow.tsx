// Transfer to a new phone, from the old phone: a sheet saying what moves, the
// owner check, a full-screen scanner, one confirmation, then the transfer.
//
// Once the mesh has stopped the modal cannot be backed out of. Cancel lasts
// until the last byte is sent; after that only move-sender's answers remain.

import { decodeQRContent } from "@core/crypto/contact-exchange";
import {
  decodeMoveInvite,
  isMoveInvite,
  type MoveInvite,
} from "@core/move/move-invite";
import Feather from "@expo/vector-icons/Feather";
import { useT, type TranslationKey } from "@i18n";
import { confirmDeviceOwner } from "@platform/device-auth";
import { rejected, succeeded } from "@platform/haptics";
import { clearMoveMarker } from "@services/move-marker";
import {
  MoveSender,
  type SenderFailure,
  type SenderState,
} from "@services/move-sender";
import { panicWipe } from "@services/panic-wipe";
import BottomSheet from "@ui/components/bottom-sheet";
import PrimaryButton from "@ui/components/primary-button";
import TextButton from "@ui/components/text-button";
import {
  BUTTON_HEIGHT,
  FontSize,
  FontWeight,
  HIT_SLOP,
  LineHeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatNumber } from "@utils/format";
import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  GroupDivider,
  SettingRow,
  SettingSwitch,
  useSharedStyles,
} from "./settings-primitives";

// A sheet's slide-out. Presenting before it has gone stacks two modals, which
// iOS refuses.
const SHEET_EXIT_MS = 260;

// Past this, an iOS dial is most likely waiting on the local network prompt.
const PERMISSION_HINT_MS = 3_000;

const FAILURE_BODY: Record<SenderFailure, TranslationKey> = {
  unreachable: "settings.transfer.failed_unreachable",
  permission: "settings.transfer.failed_permission",
  "wrong-phone": "settings.transfer.failed_wrong_phone",
  incompatible: "settings.transfer.failed_incompatible",
  cancelled: "settings.transfer.failed_cancelled",
  storage: "settings.transfer.failed_storage",
  interrupted: "settings.transfer.failed_interrupted",
};

type Stage =
  | { kind: "scan" }
  | { kind: "confirm"; invite: MoveInvite }
  | { kind: "run"; state: SenderState }
  | { kind: "erasing" };

interface Props {
  visible: boolean;
  onClose: () => void;
  onResumeMesh: () => void;
  onErased: (keysDestroyed: boolean) => void;
}

export default function TransferOutFlow({
  visible,
  onClose,
  onResumeMesh,
  onErased,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const T = useT();
  const shared = useSharedStyles();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const [permission, requestPermission] = useCameraPermissions();
  const [history, setHistory] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "scan" });
  const [wrongCode, setWrongCode] = useState(false);
  const [showPermissionHint, setShowPermissionHint] = useState(false);
  const scannedRef = useRef(false);
  const senderRef = useRef<MoveSender | null>(null);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authInFlight = useRef(false);

  useEffect(() => {
    return () => {
      if (handoffTimer.current !== null) clearTimeout(handoffTimer.current);
    };
  }, []);

  // iOS only: the one platform with a local network prompt.
  const connecting = stage.kind === "run" && stage.state.phase === "connecting";
  useEffect(() => {
    if (!connecting || Platform.OS !== "ios") return;
    const timer = setTimeout(
      () => setShowPermissionHint(true),
      PERMISSION_HINT_MS,
    );
    return () => {
      clearTimeout(timer);
      setShowPermissionHint(false);
    };
  }, [connecting]);

  function resetScan(): void {
    scannedRef.current = false;
    setWrongCode(false);
    setStage({ kind: "scan" });
  }

  async function handleContinue(): Promise<void> {
    if (authInFlight.current) return;
    authInFlight.current = true;
    try {
      const result = await confirmDeviceOwner({
        prompt: T("settings.transfer.auth_prompt"),
        cancelLabel: T("common.cancel"),
      });
      // With no lock there is no owner to ask; the confirmation still stands.
      if (result === "refused") return;
    } finally {
      authInFlight.current = false;
    }
    resetScan();
    onClose();
    handoffTimer.current = setTimeout(() => {
      setModalOpen(true);
      if (!permission?.granted && permission?.canAskAgain !== false) {
        void requestPermission();
      }
    }, SHEET_EXIT_MS);
  }

  function closeModal(): void {
    senderRef.current = null;
    setModalOpen(false);
  }

  function handleScanned(data: string): void {
    if (scannedRef.current || stage.kind !== "scan") return;
    const text = data.trim();
    const invite = decodeMoveInvite(text);
    if (invite === null) {
      // A contact code is the likeliest mistake, and it gets a word.
      if (!isMoveInvite(text) && decodeQRContent(text) !== null) {
        setWrongCode(true);
      }
      return;
    }
    scannedRef.current = true;
    succeeded();
    setStage({ kind: "confirm", invite });
  }

  function handleTransfer(invite: MoveInvite): void {
    const sender = new MoveSender(invite, history, {
      onChange: (state) => {
        if (senderRef.current !== sender) return;
        if (state.phase === "failed" || state.phase === "unconfirmed") {
          rejected();
        } else if (state.phase === "done") {
          succeeded();
        }
        setStage({ kind: "run", state });
      },
      onResume: onResumeMesh,
    });
    senderRef.current = sender;
    setStage({ kind: "run", state: { phase: "connecting" } });
    void sender.start();
  }

  function handleCancelTransfer(): void {
    senderRef.current?.cancel();
    closeModal();
  }

  async function handleEraseUnconfirmed(): Promise<void> {
    setStage({ kind: "erasing" });
    let keysDestroyed = false;
    try {
      ({ keysDestroyed } = await panicWipe());
    } catch {
      // The wipe marker survives, so the next launch finishes it.
    }
    closeModal();
    onErased(keysDestroyed);
  }

  function handleKeepUnconfirmed(): void {
    clearMoveMarker();
    onResumeMesh();
    closeModal();
  }

  // Android back never leaves a transfer in flight; it has its own Cancel.
  function handleRequestClose(): void {
    if (stage.kind === "scan" || stage.kind === "confirm") {
      closeModal();
      return;
    }
    if (stage.kind !== "run") return;
    const { state } = stage;
    if (state.phase === "failed") {
      closeModal();
    } else if (state.phase === "done") {
      closeModal();
      onErased(state.keysDestroyed);
    }
  }

  const cameraGranted = permission?.granted === true;
  // Refused, not merely unanswered: "undetermined" is the prompt still showing.
  const cameraDenied = permission?.status === "denied";
  const scanning = stage.kind === "scan" && cameraGranted;

  function renderSheet(): React.JSX.Element {
    return (
      <BottomSheet
        visible={visible}
        onClose={onClose}
        sheetStyle={shared.sheet}
      >
        <Text style={shared.sheetTitle}>{T("settings.transfer.title")}</Text>
        <Text style={shared.sheetSubtitle}>{T("settings.transfer.intro")}</Text>
        <View style={[shared.settingsGroup, styles.group]}>
          <SettingRow
            icon="key"
            label={T("settings.transfer.identity")}
            description={T("settings.transfer.identity_desc")}
          />
          <GroupDivider />
          <SettingRow
            icon="message-square"
            label={T("settings.transfer.chats")}
            description={T(
              history
                ? "settings.transfer.chats_desc"
                : "settings.transfer.chats_without",
            )}
            control={
              <SettingSwitch
                value={history}
                onValueChange={setHistory}
                accessibilityLabel={T("settings.transfer.chats")}
              />
            }
          />
          <GroupDivider />
          <SettingRow
            icon="credit-card"
            label={T("settings.transfer.wallet")}
            description={T("settings.transfer.wallet_desc")}
          />
        </View>
        <View style={styles.note}>
          <Feather name="info" size={14} color={Colors.textMuted} />
          <Text style={styles.noteText}>
            {T("settings.transfer.erase_note")}
          </Text>
        </View>
        <View style={shared.sheetActions}>
          <Pressable
            style={({ pressed }) => [
              shared.sheetBtnPrimary,
              pressed && shared.sheetBtnPrimaryPressed,
            ]}
            onPress={() => void handleContinue()}
            accessibilityRole="button"
          >
            <Text style={shared.sheetBtnTextPrimary}>
              {T("common.continue")}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              shared.sheetBtn,
              pressed && shared.sheetBtnPressed,
            ]}
            onPress={onClose}
            accessibilityRole="button"
          >
            <Text style={shared.sheetBtnText}>{T("common.cancel")}</Text>
          </Pressable>
        </View>
      </BottomSheet>
    );
  }

  // Every non-camera state: glyph, heading, body, actions at the thumb.
  function renderPanel(params: {
    icon?: keyof typeof Feather.glyphMap;
    danger?: boolean;
    busy?: boolean;
    title: string;
    body?: string;
    footnote?: string;
    progress?: number;
    actions?: React.ReactNode;
  }): React.JSX.Element {
    return (
      <SafeAreaView style={styles.panelRoot}>
        {/* Scrolls only when the text is too large to fit. */}
        <ScrollView
          contentContainerStyle={styles.panelBody}
          showsVerticalScrollIndicator={false}
          bounces={false}
          accessibilityLiveRegion="polite"
        >
          {params.busy ? (
            <ActivityIndicator size="large" color={Colors.textMuted} />
          ) : params.icon ? (
            <View
              style={[
                styles.panelIcon,
                params.danger && styles.panelIconDanger,
              ]}
            >
              <Feather
                name={params.icon}
                size={26}
                color={params.danger ? Colors.danger : Colors.textPrimary}
              />
            </View>
          ) : null}
          <Text style={styles.panelTitle} accessibilityRole="header">
            {params.title}
          </Text>
          {params.progress !== undefined ? (
            <View
              style={styles.progressTrack}
              accessibilityRole="progressbar"
              accessibilityValue={{
                now: Math.round(params.progress * 100),
                min: 0,
                max: 100,
              }}
            >
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(params.progress * 100)}%` },
                ]}
              />
            </View>
          ) : null}
          {params.body ? (
            <Text style={styles.panelText}>{params.body}</Text>
          ) : null}
          {params.footnote ? (
            <Text style={styles.panelFootnote}>{params.footnote}</Text>
          ) : null}
        </ScrollView>
        {params.actions ? (
          <View style={styles.panelActions}>{params.actions}</View>
        ) : null}
      </SafeAreaView>
    );
  }

  function renderRun(state: SenderState): React.JSX.Element {
    switch (state.phase) {
      case "connecting":
        return renderPanel({
          busy: true,
          title: T("settings.transfer.connecting"),
          body: showPermissionHint
            ? T("settings.transfer.connecting_hint")
            : undefined,
          actions: (
            <TextButton
              label={T("common.cancel")}
              onPress={handleCancelTransfer}
            />
          ),
        });
      case "sending":
        return renderPanel({
          icon: "smartphone",
          title: T("settings.transfer.sending", {
            percent: formatNumber(Math.floor(state.progress * 100)),
          }),
          progress: state.progress,
          body: T("settings.transfer.keep_open"),
          actions: (
            <TextButton
              label={T("common.cancel")}
              onPress={handleCancelTransfer}
            />
          ),
        });
      case "finishing":
        return renderPanel({
          busy: true,
          title: T("settings.transfer.finishing"),
          body: T("settings.transfer.keep_open"),
        });
      case "erasing":
        return renderPanel({
          busy: true,
          title: T("settings.transfer.erasing"),
        });
      case "done":
        return renderPanel({
          icon: "check",
          title: T("settings.transfer.done_title"),
          body: T("settings.transfer.done_body"),
          actions: (
            <PrimaryButton
              label={T("common.done")}
              onPress={() => {
                closeModal();
                onErased(state.keysDestroyed);
              }}
            />
          ),
        });
      case "unconfirmed":
        return renderPanel({
          icon: "help-circle",
          title: T("settings.transfer.unconfirmed_title"),
          body: T("settings.transfer.unconfirmed_body"),
          actions: (
            <>
              <Pressable
                style={({ pressed }) => [
                  styles.dangerBtn,
                  pressed && styles.dangerBtnPressed,
                ]}
                onPress={() => void handleEraseUnconfirmed()}
                accessibilityRole="button"
              >
                <Text style={styles.dangerBtnLabel}>
                  {T("settings.transfer.erase_cta")}
                </Text>
              </Pressable>
              <TextButton
                label={T("settings.transfer.keep_cta")}
                onPress={handleKeepUnconfirmed}
              />
            </>
          ),
        });
      case "failed":
        return renderPanel({
          icon: "alert-triangle",
          danger: true,
          title: T("settings.transfer.failed_title"),
          body: T(FAILURE_BODY[state.reason]),
          footnote:
            state.reason === "cancelled"
              ? undefined
              : T("settings.transfer.unchanged"),
          actions: (
            <>
              {/* Fixed in Settings, then retried. */}
              {state.reason === "permission" ? (
                <>
                  <PrimaryButton
                    label={T("permission.open_settings")}
                    onPress={() => void Linking.openSettings()}
                  />
                  <TextButton
                    label={T("common.try_again")}
                    onPress={resetScan}
                  />
                </>
              ) : (
                <PrimaryButton
                  label={T("common.try_again")}
                  onPress={resetScan}
                />
              )}
              <TextButton label={T("common.close")} onPress={closeModal} />
            </>
          ),
        });
    }
  }

  function renderModalBody(): React.JSX.Element {
    if (stage.kind === "erasing") {
      return renderPanel({ busy: true, title: T("settings.transfer.erasing") });
    }
    if (stage.kind === "run") return renderRun(stage.state);
    if (stage.kind === "confirm") {
      const { invite } = stage;
      return renderPanel({
        icon: "smartphone",
        title: T("settings.transfer.confirm_title"),
        body: T("settings.transfer.confirm_body"),
        actions: (
          <>
            <PrimaryButton
              label={T("settings.transfer.confirm_cta")}
              onPress={() => handleTransfer(invite)}
            />
            <TextButton label={T("common.cancel")} onPress={closeModal} />
          </>
        ),
      });
    }
    if (cameraDenied) {
      return renderPanel({
        icon: "camera-off",
        title: T("contacts.verify.camera_off"),
        body: T("settings.transfer.camera_off_body"),
        actions: (
          <>
            {/* Android can ask again until "Don't ask again"; iOS only in Settings. */}
            {permission?.canAskAgain === true ? (
              <PrimaryButton
                label={T("mesh.banner.action.allow")}
                onPress={() => void requestPermission()}
              />
            ) : (
              <PrimaryButton
                label={T("permission.open_settings")}
                onPress={() => void Linking.openSettings()}
              />
            )}
            <TextButton label={T("common.close")} onPress={closeModal} />
          </>
        ),
      });
    }
    if (!cameraGranted) {
      return renderPanel({
        busy: true,
        title: T("contacts.verify.waiting_camera"),
        actions: <TextButton label={T("common.close")} onPress={closeModal} />,
      });
    }
    // White on a dark scrim over the camera in either theme, like every scanner.
    return (
      <SafeAreaView style={styles.scanChrome}>
        <View style={styles.scanTopBar}>
          <Pressable
            onPress={closeModal}
            style={styles.scanIconBtn}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={T("common.close")}
          >
            <Feather name="x" size={22} color={SCAN_CHROME} />
          </Pressable>
          <Text style={styles.scanTitle} accessibilityRole="header">
            {T("settings.transfer.scan_title")}
          </Text>
          <View style={styles.scanIconBtn} />
        </View>
        <View style={styles.scanFrameWrap} pointerEvents="none">
          <View style={styles.scanFrame} />
          <Text style={styles.scanHint} accessibilityLiveRegion="polite">
            {T(
              wrongCode
                ? "settings.transfer.wrong_code"
                : "settings.transfer.aim",
            )}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      {renderSheet()}
      <Modal
        visible={modalOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={handleRequestClose}
      >
        <View style={[styles.modalRoot, scanning && styles.modalRootScanning]}>
          {scanning ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(r) => handleScanned(r.data)}
            />
          ) : null}
          {renderModalBody()}
        </View>
      </Modal>
    </>
  );
}

// Over a live camera image, whatever the theme. The contact scanners' values.
const SCAN_CHROME = "#FFFFFF";
const SCAN_SCRIM = "rgba(0,0,0,0.4)";
const SCAN_FRAME_SIZE = 240;

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    group: {
      alignSelf: "stretch",
    },
    note: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      alignSelf: "stretch",
      padding: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    noteText: {
      flex: 1,
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      lineHeight: LineHeight.xs,
    },
    modalRoot: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    // Black under the camera, so the frame before the preview arrives is not a
    // flash of the theme's background.
    modalRootScanning: {
      backgroundColor: "#000000",
    },
    panelRoot: {
      flex: 1,
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.base,
    },
    panelBody: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    panelIcon: {
      width: 56,
      height: 56,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    panelIconDanger: {
      borderColor: Colors.danger,
    },
    panelTitle: {
      fontSize: FontSize.lg,
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
      textAlign: "center",
    },
    panelText: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
      lineHeight: LineHeight.sm,
    },
    panelFootnote: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      textAlign: "center",
      lineHeight: LineHeight.xs,
    },
    panelActions: {
      gap: Spacing.sm,
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
    dangerBtn: {
      minHeight: BUTTON_HEIGHT,
      borderRadius: Radius.full,
      // The panic wipe's shape: destructive reads in the label, not the fill.
      backgroundColor: Colors.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    dangerBtnPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    dangerBtnLabel: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.danger,
    },
    scanChrome: {
      flex: 1,
    },
    scanTopBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.base,
      paddingTop: Spacing.sm,
    },
    scanIconBtn: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      backgroundColor: SCAN_SCRIM,
      alignItems: "center",
      justifyContent: "center",
    },
    scanTitle: {
      flex: 1,
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: SCAN_CHROME,
      textAlign: "center",
    },
    scanFrameWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.lg,
      paddingHorizontal: Spacing.xl,
    },
    scanFrame: {
      width: SCAN_FRAME_SIZE,
      height: SCAN_FRAME_SIZE,
      borderRadius: Radius.xl,
      borderWidth: 2,
      borderColor: SCAN_CHROME,
    },
    scanHint: {
      fontSize: FontSize.sm,
      color: SCAN_CHROME,
      textAlign: "center",
    },
  });
}
