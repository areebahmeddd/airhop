// Camera sheet that reads a Cashu token, Lightning invoice or (for "any") npub
// QR. One screen for every target, since only the validator and wording differ.
// No manual entry or confirm step: pasting has its own field and the wallet
// service validates on claim. Two rules shared with the contact scanner:
//   * Permission is settled BEFORE `CameraView` mounts. Mounted under the OS
//     prompt it gets a camera it cannot open, and expo-camera does not
//     re-acquire the device once access is granted, so the preview stays black.
//   * `onBarcodeScanned` fires repeatedly while a code is in frame, so a latch
//     stops duplicate reads.

import { readScan, type ScanTarget } from "@core/payments/scan";
import { Feather } from "@expo/vector-icons";
import { t, useT } from "@i18n";
import { succeeded } from "@platform/haptics";
import { ensurePermission } from "@platform/permissions";
import BottomSheet from "@ui/components/bottom-sheet";
import ChoiceList from "@ui/components/choice-list";
import {
  BUTTON_HEIGHT,
  FontSize,
  FontWeight,
  HIT_SLOP,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import {
  CameraView,
  scanFromURLAsync,
  useCameraPermissions,
} from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import React, { useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Rules live in core/payments/scan.ts; re-exported so callers import one thing.
export type { ScanTarget };

interface Props {
  visible: boolean;
  target: ScanTarget;
  onClose: () => void;
  // Receives the validated value. Nothing is claimed or paid here.
  onScanned: (value: string) => void;
}

export default function TokenScanSheet({
  visible,
  target,
  onClose,
  onScanned,
}: Props): React.JSX.Element | null {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  // True only once permission is granted; gates the camera mount.
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, requestCameraPermission, getCameraPermission] =
    useCameraPermissions();
  const hasScannedRef = useRef(false);

  function reset(): void {
    setCameraReady(false);
    setError(null);
    hasScannedRef.current = false;
  }

  function finish(value: string): void {
    // The phone is held up at another screen, so the buzz is the confirmation.
    succeeded();
    reset();
    onScanned(value);
  }

  function dismiss(): void {
    reset();
    onClose();
  }

  async function handleUseCamera(): Promise<void> {
    setError(null);
    const granted = await ensurePermission(
      getCameraPermission,
      requestCameraPermission,
      {
        label: t("wallet.scan.camera_label"),
        purpose: t("wallet.scan.camera_purpose"),
      },
    );
    if (!granted) return;
    hasScannedRef.current = false;
    setCameraReady(true);
  }

  // A token often arrives as a screenshot in another chat app, and a phone
  // cannot photograph its own screen.
  async function handleUseImage(): Promise<void> {
    setError(null);
    const granted = await ensurePermission(
      () => ImagePicker.getMediaLibraryPermissionsAsync(),
      () => ImagePicker.requestMediaLibraryPermissionsAsync(),
      {
        label: t("wallet.scan.photo_label"),
        purpose: t("wallet.scan.photo_purpose"),
      },
    );
    if (!granted) return;

    // The launch can reject, and this runs as a bare async onPress, so it must
    // sit inside the try or the rejection goes unhandled.
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      if (picked.canceled || !picked.assets[0]) return;

      const scans = await scanFromURLAsync(picked.assets[0].uri, ["qr"]);
      const value = readScan(scans[0]?.data, target);
      if (value === null) {
        setError(
          t(
            target === "token"
              ? "wallet.scan.no_token"
              : target === "invoice"
                ? "wallet.scan.no_invoice"
                : "wallet.scan.no_any",
          ),
        );
        return;
      }
      finish(value);
    } catch {
      setError(t("wallet.scan.unreadable"));
    }
  }

  function handleBarcodeScanned(raw: string): void {
    if (hasScannedRef.current) return;
    const value = readScan(raw, target);
    // No latch on a miss: an unrelated QR keeps the camera scanning.
    if (value === null) return;
    hasScannedRef.current = true;
    finish(value);
  }

  function handleCameraMountError(): void {
    setError(t("wallet.scan.camera_failed"));
    setCameraReady(false);
  }

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={dismiss}>
      {cameraReady ? (
        <View style={styles.cameraRoot}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => handleBarcodeScanned(result.data)}
            onMountError={handleCameraMountError}
          />
          <SafeAreaView style={styles.cameraChrome}>
            <View style={styles.cameraTopBar}>
              <Pressable
                onPress={dismiss}
                style={styles.cameraIconBtn}
                hitSlop={HIT_SLOP}
                accessibilityRole="button"
                accessibilityLabel={T("wallet.scan.close")}
              >
                <Feather name="x" size={20} color="#FFFFFF" />
              </Pressable>
            </View>
            <View style={styles.reticle} />
            <Text style={styles.cameraHint}>
              {T(
                target === "token"
                  ? "wallet.scan.aim_token"
                  : target === "invoice"
                    ? "wallet.scan.aim_invoice"
                    : "wallet.scan.aim_any",
              )}{" "}
              {T("wallet.scan.on_device")}
            </Text>
          </SafeAreaView>
        </View>
      ) : (
        <BottomSheet visible onClose={dismiss} sheetStyle={styles.sheet}>
          <Text style={styles.title}>
            {T(
              target === "token"
                ? "wallet.scan.title_token"
                : target === "invoice"
                  ? "wallet.scan.title_invoice"
                  : "wallet.scan.title_any",
            )}
          </Text>
          {error !== null && <Text style={styles.error}>{error}</Text>}
          <ChoiceList
            choices={[
              {
                key: "camera",
                icon: "camera",
                title: T("wallet.scan.use_camera"),
                detail: T(
                  target === "token"
                    ? "wallet.scan.aim_token"
                    : target === "invoice"
                      ? "wallet.scan.aim_invoice"
                      : "wallet.scan.aim_any",
                ),
                a11yLabel: T("wallet.scan.use_camera_a11y"),
                onPress: () => void handleUseCamera(),
              },
              {
                key: "image",
                icon: "image",
                title: T("wallet.scan.pick_image"),
                detail: T("wallet.scan.pick_image_a11y"),
                onPress: () => void handleUseImage(),
              },
            ]}
          />
          <Pressable
            style={styles.cancel}
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel={T("common.cancel")}
          >
            <Text style={styles.cancelText}>{T("common.cancel")}</Text>
          </Pressable>
        </BottomSheet>
      )}
    </Modal>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    cameraRoot: {
      flex: 1,
      backgroundColor: "#000000",
    },
    cameraChrome: {
      flex: 1,
      justifyContent: "space-between",
      alignItems: "center",
    },
    cameraTopBar: {
      width: "100%",
      flexDirection: "row",
      justifyContent: "flex-end",
      padding: Spacing.base,
    },
    cameraIconBtn: {
      width: 36,
      height: 36,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    reticle: {
      width: 240,
      height: 240,
      borderRadius: Radius.xl,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.85)",
    },
    cameraHint: {
      color: "#FFFFFF",
      fontSize: FontSize.sm,
      textAlign: "center",
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.xl,
      lineHeight: FontSize.sm * 1.5,
    },
    sheet: {
      backgroundColor: Colors.surface,
      borderTopStartRadius: Radius["2xl"],
      borderTopEndRadius: Radius["2xl"],
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing["2xl"],
      gap: Spacing.md,
    },
    title: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    error: {
      fontSize: FontSize.sm,
      color: Colors.danger,
    },
    cancel: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    cancelText: {
      fontSize: FontSize.base,
      color: Colors.textPrimary,
      fontWeight: FontWeight.semibold,
    },
  });
}
