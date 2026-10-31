// The one bottom sheet in the app. It owns what must not differ between sheets:
// a scrim that tracks the sheet's position, a real drag that dismisses on a
// long pull or a fast flick, keyboard avoidance, back and scrim dismissal, and
// one sheet at a time through afterSheetsClose. Callers keep their `sheetStyle`.
//
// Off for this file only: Reanimated's shared values are written from
// callbacks by design, which the rule would flag as a mutation bug.
/* eslint-disable react-hooks/immutability */

import { crossedThreshold } from "@platform/haptics";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useKeyboardHeight } from "../hooks/use-keyboard";
import { Duration, Radius, Spacing, useThemeColors } from "../theme";
import AppModal from "./app-modal";

// A pull past a third of the sheet's height, or a flick faster than this
// (points per second), dismisses; the usual iOS and Material thresholds.
const DISMISS_DISTANCE_RATIO = 0.33;
const DISMISS_VELOCITY = 900;
// Minimum drag, so taps on rows inside the sheet stay taps. The scrim uses the
// same distance: a press there that travels further is a slide, not a tap.
const DRAG_SLOP = 10;

const OPEN_SPRING = { damping: 26, stiffness: 280, mass: 0.9 } as const;
const CLOSE_TIMING = {
  duration: Duration.slow,
  easing: Easing.out(Easing.cubic),
} as const;

// Unmounts the sheet even if the slide-out never reports finishing. The
// animation callback runs on the UI thread, which stops while the activity is
// paused (an OS permission dialog opened as a sheet closes), and a Modal left
// mounted is a transparent window that swallows every touch.
const CLOSE_FALLBACK_MS = CLOSE_TIMING.duration + 200;

let sheetsOnScreen = 0;
let waitingForClose: (() => void)[] = [];
let flushQueued = false;

// One frame past the last close, so the platform has removed that Modal first.
function queueFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    if (sheetsOnScreen > 0) return;
    const due = waitingForClose;
    waitingForClose = [];
    for (const run of due) run();
  });
}

// Runs `open` once no sheet is on screen. iOS drops a modal presented over one
// still sliding out. Returns a cancel.
export function afterSheetsClose(open: () => void): () => void {
  if (sheetsOnScreen === 0 && waitingForClose.length === 0) {
    open();
    return () => {};
  }
  waitingForClose.push(open);
  return () => {
    waitingForClose = waitingForClose.filter((w) => w !== open);
  };
}

interface Props {
  visible: boolean;
  // After the slide-out, and only for a dismissal the sheet made (drag, scrim,
  // back). A parent that set `visible` to false already knows.
  onClose: () => void;
  children: React.ReactNode;
  // Applied over the shared base, so anything it sets wins.
  sheetStyle?: StyleProp<ViewStyle>;
  // For sheets whose body scrolls: the drag moves to the handle alone.
  scrollable?: boolean;
  // For media review sheets, which need a darker scrim.
  scrimColor?: string;
}

export default function BottomSheet({
  visible,
  onClose,
  children,
  sheetStyle,
  scrollable = false,
  scrimColor,
}: Props): React.JSX.Element | null {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const { height: screenHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  // A Modal inherits none of the root SafeAreaProvider's padding.
  const insets = useSafeAreaInsets();

  // Stays mounted through the slide-out after `visible` goes false.
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (!mounted) return;
    sheetsOnScreen += 1;
    return () => {
      sheetsOnScreen -= 1;
      if (sheetsOnScreen === 0) queueFlush();
    };
  }, [mounted]);

  // 0 is fully open.
  const translateY = useSharedValue(screenHeight);
  const sheetHeight = useSharedValue(screenHeight);
  const dragStart = useSharedValue(0);
  // So the threshold haptic fires once per crossing.
  const pastThreshold = useSharedValue(false);

  const openedRef = useRef(false);
  const userDismissedRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Counts each request to show the sheet. A slide-out completes only the
  // presentation it began in, so a sheet reopened mid-close stays open. Not a
  // test of `visible`, which callers that mount the sheet conditionally keep
  // true for its whole life.
  const presentation = useRef(0);
  const closingPresentation = useRef(-1);
  // Whichever of the animation callback and the timer arrives second is a no-op.
  const closedRef = useRef(false);
  const scrimPressStart = useRef<{ x: number; y: number } | null>(null);
  // A sliding-out sheet takes no input, so a second tap cannot hit a row or
  // whatever is underneath.
  const [closing, setClosing] = useState(false);

  function clearCloseTimer(): void {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function finishClose(): void {
    clearCloseTimer();
    if (presentation.current !== closingPresentation.current) return;
    if (closedRef.current) return;
    closedRef.current = true;
    openedRef.current = false;
    translateY.value = screenHeight;
    setMounted(false);
    setClosing(false);
    // Several callers reset state in onClose, so it runs once.
    if (userDismissedRef.current) onClose();
  }

  function slideOut(byUser: boolean): void {
    // A second dismissal mid-close would restart the animation and stutter.
    if (closingPresentation.current === presentation.current) return;
    userDismissedRef.current = byUser;
    closingPresentation.current = presentation.current;
    setClosing(true);
    Keyboard.dismiss();
    translateY.value = withTiming(sheetHeight.value, CLOSE_TIMING, (done) => {
      if (done) scheduleOnRN(finishClose);
    });
    clearCloseTimer();
    closeTimer.current = setTimeout(finishClose, CLOSE_FALLBACK_MS);
  }

  function dismiss(): void {
    slideOut(true);
  }

  // Closes on a tap only. The scrim is a full-screen Pressable, which fires on
  // release however far the finger slid, even onto the sheet. A press with no
  // coordinates (a screen reader) reads as NaN and closes.
  function handleScrimPress(x: number, y: number): void {
    const start = scrimPressStart.current;
    scrimPressStart.current = null;
    const travelled = start === null ? 0 : Math.hypot(x - start.x, y - start.y);
    if (!(travelled > DRAG_SLOP)) dismiss();
  }

  useEffect(() => {
    if (visible) {
      clearCloseTimer();
      closedRef.current = false;
      presentation.current += 1;
      // Not derived state: the unmount waits for the slide-out.
      /* eslint-disable react-hooks/set-state-in-effect */
      setMounted(true);
      setClosing(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      // Reopened mid-close: layout will not fire again, so spring back here,
      // which also cancels the pending slide-out.
      if (openedRef.current) translateY.value = withSpring(0, OPEN_SPRING);
    } else if (mounted) {
      slideOut(false);
    }
    // Reacting to `mounted` would re-run this on the render it causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => clearCloseTimer, []);

  // Opens from the sheet's own height once measured, so a short sheet does not
  // fly in from the bottom of the screen.
  function handleLayout(height: number): void {
    if (height <= 0) return;
    sheetHeight.value = height;
    if (openedRef.current) return;
    openedRef.current = true;
    translateY.value = height;
    translateY.value = withSpring(0, OPEN_SPRING);
  }

  const pan = usePanGesture({
    activeOffsetY: DRAG_SLOP,
    failOffsetX: [-24, 24],
    onActivate: () => {
      dragStart.value = translateY.value;
      pastThreshold.value = false;
    },
    onUpdate: (e) => {
      // Anchored to the bottom, so an upward pull goes nowhere.
      translateY.value = Math.max(0, dragStart.value + e.translationY);
      // The scrim fades continuously, so a haptic marks the dismiss line.
      const past =
        translateY.value > sheetHeight.value * DISMISS_DISTANCE_RATIO;
      if (past !== pastThreshold.value) {
        pastThreshold.value = past;
        if (past) scheduleOnRN(crossedThreshold);
      }
    },
    onDeactivate: (e) => {
      const far = translateY.value > sheetHeight.value * DISMISS_DISTANCE_RATIO;
      if (far || e.velocityY > DISMISS_VELOCITY) {
        scheduleOnRN(dismiss);
      } else {
        translateY.value = withSpring(0, OPEN_SPRING);
      }
    },
  });

  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const scrimAnim = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateY.value,
      [0, sheetHeight.value],
      [1, 0],
      "clamp",
    ),
  }));

  if (!mounted) return null;

  const sheet = (
    <Animated.View
      style={[styles.sheet, sheetStyle, sheetAnim]}
      onLayout={(e) => handleLayout(e.nativeEvent.layout.height)}
    >
      {/* On a scrolling sheet the handle is the only drag surface, so it gets
          a padded hit area. */}
      {scrollable ? (
        <GestureDetector gesture={pan}>
          <View style={styles.grabZone}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>
      ) : (
        <View style={styles.handle} />
      )}
      {children}
    </Animated.View>
  );

  return (
    <AppModal
      visible
      transparent
      // The slide is ours; the Modal's own would fight the drag.
      animationType="none"
      onRequestClose={dismiss}
    >
      {/* A Modal is outside the app's gesture root, so the drag needs its own
          or Android never delivers it touches. */}
      <GestureHandlerRootView style={styles.flexFill}>
        {/* Padding by the keyboard keeps a text field in any sheet visible.
            The larger of the two, not the sum: the keyboard covers the
            navigation bar. */}
        <View
          style={[
            styles.root,
            { paddingBottom: Math.max(keyboardHeight, insets.bottom) },
          ]}
          pointerEvents={closing ? "none" : "auto"}
          // The scrim is no stop for a screen reader (below), so these are how
          // one closes the sheet without a Close button: VoiceOver's two-finger
          // scrub here, and TalkBack's back through the Modal's request.
          accessibilityViewIsModal
          onAccessibilityEscape={dismiss}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              styles.scrim,
              scrimColor !== undefined && { backgroundColor: scrimColor },
              scrimAnim,
            ]}
            pointerEvents="none"
          />
          <Pressable
            style={StyleSheet.absoluteFill}
            onPressIn={(e) => {
              scrimPressStart.current = {
                x: e.nativeEvent.pageX,
                y: e.nativeEvent.pageY,
              };
            }}
            onPress={(e) =>
              handleScrimPress(e.nativeEvent.pageX, e.nativeEvent.pageY)
            }
            // Full screen and first in the tree, so as an element it is where
            // VoiceOver lands when the sheet opens, ahead of the sheet itself.
            // A touch target only.
            accessible={false}
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
          {scrollable ? (
            sheet
          ) : (
            <GestureDetector gesture={pan}>{sheet}</GestureDetector>
          )}
        </View>
      </GestureHandlerRootView>
    </AppModal>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    flexFill: {
      flex: 1,
    },
    root: {
      flex: 1,
      justifyContent: "flex-end",
    },
    scrim: {
      backgroundColor: Colors.overlay,
    },
    sheet: {
      maxHeight: "100%",
      backgroundColor: Colors.surface,
      borderTopStartRadius: Radius["2xl"],
      borderTopEndRadius: Radius["2xl"],
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: Radius.xs,
      backgroundColor: Colors.borderStrong,
      alignSelf: "center",
      marginTop: Spacing.sm,
      marginBottom: Spacing.md,
    },
    grabZone: {
      paddingBottom: Spacing.xs,
    },
  });
}
