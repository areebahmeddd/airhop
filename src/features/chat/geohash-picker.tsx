// Choosing a location channel by looking at the world instead of typing a
// geohash: bitchat-ios's globe picker, in Airhop's chrome.
//
// The cell under the crosshair is the selection, and zoom sets its size. The
// picker hands back a geohash and decides nothing: the jump sheet that opened
// it still chooses between the user's own named channel and a teleport, so
// that rule lives in one place.
//
// Nothing here touches the network. The world is bundled Natural Earth
// geometry, and no place name is looked up for where the globe points: the OS
// geocoder would send that position to Apple or Google, which is exactly what
// browsing a map should not do. The globe's city names are the orientation.

import { useT } from "@i18n";
import { Feather } from "@react-native-vector-icons/feather/static";
import {
  geohashLevelName,
  isValidGeohash,
} from "@services/geohash-channel-service";
import { getMeshService } from "@services/mesh-service";
import AppModal from "@ui/components/app-modal";
import PrimaryButton from "@ui/components/primary-button";
import RingAlertSheet from "@ui/components/ring-alert-sheet";
import { useReducedMotion } from "@ui/hooks/use-reduced-motion";
import {
  BUTTON_HEIGHT,
  DISABLED_OPACITY,
  Duration,
  FontFamily,
  FontSize,
  FontWeight,
  LineHeight,
  MIN_TOUCH,
  Radius,
  Shadow,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatCellSize } from "@utils/format";
import { startTarget } from "@utils/globe-camera";
import { MAX_PRECISION, cellCoverageMeters } from "@utils/globe-math";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  FadeOut,
  useAnimatedReaction,
  useSharedValue,
  useReducedMotion as useStartupReducedMotion,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { Skia } from "react-native-skia";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { makeEngine, setStill, stepPrecision, stop } from "./globe-engine";
import { GlobeView } from "./globe-view";

// Skia draws with Vulkan on Android and Metal on iOS. A phone with neither
// still installs Airhop (the manifest drops Skia's Vulkan requirement) but
// would show a blank canvas, so the globe is offered only where it draws and
// typing a geohash covers the rest.
export function globeAvailable(): boolean {
  try {
    return Skia.gpu.isAvailable;
  } catch {
    return false;
  }
}

interface Props {
  visible: boolean;
  // False to close without sliding away (see the jump sheet's Go).
  animated: boolean;
  // A valid geohash to open on (the one typed into the sheet), or null.
  initialGeohash: string | null;
  // The cells this phone is standing in; the coarsest is the fallback start.
  nearby: readonly string[];
  onSelect: (geohash: string) => void;
  onClose: () => void;
}

// Mounted with the sheet and shown by `visible`; its content mounts fresh on
// every open, since a Modal renders nothing while hidden.
export function GeohashPicker({
  visible,
  animated,
  initialGeohash,
  nearby,
  onSelect,
  onClose,
}: Props): React.JSX.Element {
  // The live switch resolves after mount; Reanimated's value is read at app
  // start and is there on the first render, when the modal and the opening
  // flight need it. Turning the setting off mid-session therefore waits for a
  // restart; turning it on applies at once, the direction that matters.
  const live = useReducedMotion();
  const startup = useStartupReducedMotion();
  const still = live || startup;
  return (
    <AppModal
      visible={visible}
      animationType={still || !animated ? "none" : "slide"}
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {/* A Modal is outside the app's gesture root, so the globe needs its
          own or Android never delivers it touches. */}
      <GestureHandlerRootView style={styles.fill}>
        <PickerBody
          initialGeohash={initialGeohash}
          nearby={nearby}
          onSelect={onSelect}
          onClose={onClose}
          still={still}
        />
      </GestureHandlerRootView>
      {/* A ring would otherwise sound under this modal, unseen (see
          ring-alert-sheet.tsx). */}
      <RingAlertSheet />
    </AppModal>
  );
}

function PickerBody({
  initialGeohash,
  nearby,
  onSelect,
  onClose,
  still,
}: Omit<Props, "visible" | "animated"> & { still: boolean }) {
  const T = useT();
  const Colors = useThemeColors();
  const themed = useMemo(() => createStyles(Colors), [Colors]);

  // Read once: the picker opens where it was asked to and then belongs to the
  // user's fingers.
  const [initial] = useState(() =>
    makeEngine(startTarget(initialGeohash, nearby), still),
  );
  const engine = useSharedValue(initial);
  useEffect(() => {
    scheduleOnUI(setStill, engine, still);
  }, [engine, still]);
  // A finger can still be down when the picker goes (Go or back with the other
  // hand), and its cancel never arrives once the view is gone.
  useEffect(() => () => scheduleOnUI(stop, engine), [engine]);

  const [cell, setCell] = useState("");
  useAnimatedReaction(
    () => engine.value.camera.selected,
    (current, previous) => {
      if (current !== previous) scheduleOnRN(setCell, current);
    },
  );

  // The gesture hint goes once the user has used a gesture.
  const [touched, setTouched] = useState(false);
  const onFirstTouch = useCallback(() => setTouched(true), []);
  const onAdjust = useCallback(
    (delta: number) => scheduleOnUI(stepPrecision, engine, delta),
    [engine],
  );

  const precision = cell.length;
  const canGo = isValidGeohash(cell);
  const coverage = canGo
    ? T("chat.globe.coverage", {
        level: geohashLevelName(cell),
        size: formatCellSize(cellCoverageMeters(precision)),
      })
    : "";
  // Going to a cell the phone is already in opens that channel, not a
  // teleport. Said here so the outcome is known before the tap.
  const localChannel = canGo
    ? (getMeshService()?.localGeoChannelFor(cell) ?? null)
    : null;

  return (
    <View style={themed.root}>
      <GlobeView
        engine={engine}
        onFirstTouch={onFirstTouch}
        onAdjust={onAdjust}
        accessibilityLabel={T("chat.globe.label", { cell })}
        accessibilityValue={coverage}
        accessibilityHint={T("chat.globe.adjust")}
      />
      <SafeAreaView
        style={themed.chrome}
        edges={["top", "bottom"]}
        pointerEvents="box-none"
      >
        <View style={themed.topBar} pointerEvents="box-none">
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              themed.floating,
              themed.round,
              themed.close,
              pressed && themed.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={T("common.close")}
          >
            <Feather name="x" size={20} color={Colors.textPrimary} />
          </Pressable>
          {!touched && (
            <Animated.View
              style={[themed.floating, themed.hint]}
              exiting={FadeOut.duration(Duration.base)}
              pointerEvents="none"
            >
              <Text style={themed.hintText}>{T("chat.globe.hint")}</Text>
            </Animated.View>
          )}
        </View>

        <View style={themed.bottom} pointerEvents="box-none">
          {/* Not a live region: it changes with every cell a spin crosses,
              and the globe's own adjustable value already speaks the cell
              to a screen reader. Empty until the first layout selects. */}
          {cell.length > 0 && (
            <View style={[themed.floating, themed.readout]}>
              {canGo ? (
                <>
                  <Text style={themed.cell} numberOfLines={1}>
                    #{cell}
                  </Text>
                  <Text style={themed.coverage} numberOfLines={1}>
                    {coverage}
                  </Text>
                  {localChannel !== null && (
                    <Text style={themed.here}>
                      {T("chat.jump.already_here", { name: localChannel })}
                    </Text>
                  )}
                </>
              ) : (
                <Text style={themed.coverage}>{T("chat.globe.zoom_in")}</Text>
              )}
            </View>
          )}

          <View style={themed.controls}>
            <StepButton
              icon="minus"
              label={T("chat.globe.larger")}
              disabled={precision <= 1}
              onPress={() => onAdjust(-1)}
              styles={themed}
              color={Colors.textPrimary}
            />
            <StepButton
              icon="plus"
              label={T("chat.globe.smaller")}
              disabled={precision >= MAX_PRECISION}
              onPress={() => onAdjust(1)}
              styles={themed}
              color={Colors.textPrimary}
            />
            <PrimaryButton
              label={T("chat.jump.go")}
              accessibilityLabel={
                canGo ? T("chat.globe.go_to", { cell }) : undefined
              }
              accessibilityHint={canGo ? undefined : T("chat.globe.zoom_in")}
              disabled={!canGo}
              onPress={() => {
                if (canGo) onSelect(cell);
              }}
              style={themed.go}
            />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

function StepButton({
  icon,
  label,
  disabled,
  onPress,
  styles,
  color,
}: {
  icon: "minus" | "plus";
  label: string;
  disabled: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  color: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.floating,
        styles.round,
        styles.step,
        disabled && styles.disabled,
        !disabled && pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <Feather name={icon} size={20} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    chrome: {
      position: "absolute",
      top: 0,
      bottom: 0,
      start: 0,
      end: 0,
      justifyContent: "space-between",
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.sm,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    // Floating over the globe, so styled as the app's other floating pills
    // (the jump-to-latest button): a surface, a hairline for the dark canvas
    // that swallows the shadow, and the shadow for the light one.
    floating: {
      backgroundColor: Colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: Colors.border,
      ...Shadow.medium,
    },
    round: {
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.full,
    },
    close: {
      width: MIN_TOUCH,
      height: MIN_TOUCH,
    },
    pressed: {
      backgroundColor: Colors.surfacePressed,
    },
    disabled: {
      opacity: DISABLED_OPACITY,
    },
    hint: {
      flex: 1,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.lg,
    },
    hintText: {
      fontSize: FontSize.xs,
      lineHeight: LineHeight.xs,
      color: Colors.textSecondary,
      textAlign: "center",
    },
    bottom: {
      gap: Spacing.sm,
    },
    readout: {
      alignItems: "center",
      gap: Spacing["2xs"],
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.base,
      borderRadius: Radius.lg,
    },
    cell: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      fontFamily: FontFamily.mono,
      color: Colors.textPrimary,
    },
    coverage: {
      fontSize: FontSize.xs,
      lineHeight: LineHeight.xs,
      color: Colors.textSecondary,
      textAlign: "center",
    },
    here: {
      fontSize: FontSize.xs,
      lineHeight: LineHeight.xs,
      color: Colors.textMuted,
      textAlign: "center",
    },
    controls: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    step: {
      width: BUTTON_HEIGHT,
      height: BUTTON_HEIGHT,
    },
    go: {
      flex: 1,
    },
  });
}
