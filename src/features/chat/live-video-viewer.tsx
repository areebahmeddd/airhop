// One live stream full screen: the studio's layout seen from the other side,
// the same framed 3:4 picture the sender previews, with who is live above it
// and the sound below. Nothing covers the picture, so no control has to hide.
//
// The thread mounts it rather than the bubble, because the bubble goes when
// the stream ends and the viewer stays to say so. The thread gives the stream
// its sound on opening; closing leaves the sound as it is. The picture is a
// second surface on the stream's key, so the bubble keeps playing under this
// transparent Modal and is live the moment it closes.
//
// What it shows follows the stream's rows (live-video-viewer-state.ts): live,
// then reconnecting, then the recording in the same frame, or "Stream ended"
// with nothing to play once the sender canceled or nothing was kept.

import { AirhopVideoSurface } from "@bridge/NativeAirhopVideoViews";
import { useT } from "@i18n";
import { crossedThreshold } from "@platform/haptics";
import { Feather } from "@react-native-vector-icons/feather/static";
import { useChatStore } from "@store/chat-store";
import AppModal from "@ui/components/app-modal";
import RingAlertSheet from "@ui/components/ring-alert-sheet";
import { useReducedMotion } from "@ui/hooks/use-reduced-motion";
import {
  FontSize,
  FontWeight,
  MIN_TOUCH,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatDuration } from "@utils/format";
import { useKeepAwake } from "expo-keep-awake";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import LiveBadge from "./live-badge";
import { useLiveVideoSound } from "./live-video-bubble";
import {
  liveVideoViewerState,
  type LiveVideoViewerTarget,
} from "./live-video-viewer-state";

const CONTROL_SIZE = MIN_TOUCH;
// Every live video quality is 3:4; an ended stream keeps the frame it had.
const LIVE_ASPECT = 3 / 4;
// A pull past a quarter of the screen, or the bottom sheet's flick, closes.
// Downward only, past the sheet's slop, so a tap stays a tap.
const DISMISS_DISTANCE_RATIO = 0.25;
const DISMISS_VELOCITY = 900;
const DRAG_SLOP = 10;
// The sheet's spring, for the same motion.
const SNAP_BACK = { damping: 26, stiffness: 280, mass: 0.9 } as const;

interface Props {
  target: LiveVideoViewerTarget;
  // Taken when the viewer opened: the row, and its nickname, can go.
  senderName: string;
  onClose: () => void;
}

export default function LiveVideoViewer({
  target,
  senderName,
  onClose,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const reduceMotion = useReducedMotion();

  const rows = useChatStore((s) => s.messages[target.channel]);
  const state = liveVideoViewerState(rows, target);
  const live = state.kind === "live" ? state.live : null;

  const { withSound, toggleSound } = useLiveVideoSound(
    state.kind === "live" ? state.rowID : target.rowID,
  );

  const [now, setNow] = useState(() => Date.now());
  const ticking = live !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);

  // The end changes the screen without moving focus, so it is said aloud;
  // the timer is not, or it would be read out every second.
  const ended = state.kind === "ended";
  useEffect(() => {
    if (!ended) return;
    AccessibilityInfo.announceForAccessibility(T("chat.live_video.ended"));
  }, [T, ended]);

  const { height: screenHeight } = useWindowDimensions();
  const dismissDistance = screenHeight * DISMISS_DISTANCE_RATIO;
  const dragY = useSharedValue(0);
  // So the threshold haptic fires once per crossing.
  const pastThreshold = useSharedValue(false);
  const pan = usePanGesture({
    activeOffsetY: DRAG_SLOP,
    failOffsetX: [-24, 24],
    onActivate: () => {
      pastThreshold.value = false;
    },
    onUpdate: (e) => {
      dragY.value = Math.max(0, e.translationY);
      const past = dragY.value > dismissDistance;
      if (past !== pastThreshold.value) {
        pastThreshold.value = past;
        if (past) scheduleOnRN(crossedThreshold);
      }
    },
    onDeactivate: (e) => {
      if (dragY.value > dismissDistance || e.velocityY > DISMISS_VELOCITY) {
        scheduleOnRN(onClose);
      } else {
        dragY.value = withSpring(0, SNAP_BACK);
      }
    },
  });
  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY.value }],
  }));

  const elapsed =
    live === null
      ? 0
      : Math.max(0, Math.floor((now - live.startedAtMs) / 1000));

  return (
    <AppModal
      visible
      // Transparent, so the thread stays in its window under the viewer: its
      // bubble keeps its picture, and a pull down shows it.
      transparent
      animationType={reduceMotion ? "fade" : "slide"}
      onRequestClose={onClose}
    >
      <KeepScreenOn />
      {/* A Modal is outside the app's gesture root, so the pull needs its own
          or Android never delivers it touches. */}
      <GestureHandlerRootView style={styles.fill}>
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.fill, dragStyle]}>
            <SafeAreaView
              style={styles.root}
              edges={["top", "bottom"]}
              // VoiceOver's escape gesture, a two-finger scrub.
              onAccessibilityEscape={onClose}
            >
              <View style={styles.topBar}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [
                    styles.iconButton,
                    pressed && styles.dimmed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={T("common.close")}
                >
                  <Feather name="x" size={22} color={Colors.textPrimary} />
                </Pressable>
                <Text
                  style={styles.name}
                  numberOfLines={1}
                  accessibilityLabel={
                    live === null
                      ? undefined
                      : T("chat.live_video.live_from", { name: senderName })
                  }
                >
                  {senderName}
                </Text>
                {live === null ? (
                  <Text style={styles.ended}>{T("chat.live_video.ended")}</Text>
                ) : (
                  <View style={styles.liveRow}>
                    <LiveBadge />
                    <Text style={styles.timer}>{formatDuration(elapsed)}</Text>
                  </View>
                )}
              </View>

              <View style={styles.stage}>
                <View
                  style={[
                    styles.frame,
                    {
                      aspectRatio:
                        live === null ? LIVE_ASPECT : live.width / live.height,
                    },
                  ]}
                >
                  {state.kind === "live" ? (
                    <>
                      {/* Under the surface, which stays clear until a
                          keyframe paints over it, up to two seconds after
                          opening. */}
                      {state.live.state === "live" && (
                        <View style={styles.cover}>
                          <ActivityIndicator color={Colors.textMuted} />
                        </View>
                      )}
                      <AirhopVideoSurface
                        style={styles.fill}
                        surfaceKey={`${target.senderID}:${target.streamID}`}
                      />
                      {state.live.state === "reconnecting" && (
                        <View style={[styles.cover, styles.scrim]}>
                          <Text style={styles.reconnectingText}>
                            {T("chat.live_video.reconnecting")}
                          </Text>
                        </View>
                      )}
                    </>
                  ) : state.replay !== null ? (
                    <Replay uri={state.replay.uri} />
                  ) : (
                    <View style={styles.nothing}>
                      <Feather
                        name="video-off"
                        size={28}
                        color={Colors.textMuted}
                      />
                    </View>
                  )}
                </View>
              </View>

              <View style={styles.footer}>
                <View style={styles.controls}>
                  {live?.hasAudio === true && (
                    <Pressable
                      onPress={toggleSound}
                      style={({ pressed }) => [
                        styles.round,
                        !withSound && styles.roundOff,
                        pressed && styles.roundPressed,
                      ]}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: withSound }}
                      accessibilityLabel={T("chat.live_video.sound")}
                    >
                      <Feather
                        name={withSound ? "volume-2" : "volume-x"}
                        size={18}
                        color={
                          withSound ? Colors.textPrimary : Colors.textMuted
                        }
                      />
                    </Pressable>
                  )}
                  {live?.hasAudio === false && (
                    <Text style={styles.caption}>
                      {T("chat.live_video.no_sound")}
                    </Text>
                  )}
                </View>
              </View>
            </SafeAreaView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
      {/* A ring alert is another Modal; from here it would open behind. */}
      <RingAlertSheet />
    </AppModal>
  );
}

// Auto-lock would background the app, and a backgrounded app decodes nothing.
// Mounted inside the Modal, so it holds only while the viewer is on screen:
// the app lock hides the Modal, and the lock screen must be free to sleep.
function KeepScreenOn(): null {
  useKeepAwake();
  return null;
}

// The stream's recording, played where the picture was. Not started on its
// own: the stream ending is no reason to make a sound.
function Replay({ uri }: { uri: string }): React.JSX.Element {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <VideoView
      style={StyleSheet.absoluteFill}
      player={player}
      contentFit="contain"
      nativeControls
      // Android: a TextureView clips to the frame's corners and moves with the
      // pull down; the default SurfaceView does neither.
      surfaceType="textureView"
      // Already full screen; a second full-screen player over this Modal
      // would have nowhere to return to.
      fullscreenOptions={{ enable: false }}
      allowsPictureInPicture={false}
    />
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    fill: {
      flex: 1,
    },
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.xs,
    },
    iconButton: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    // Grows into the free space and gives way first to the badge and timer.
    name: {
      flexGrow: 1,
      flexShrink: 1,
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    liveRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    timer: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      fontVariant: ["tabular-nums"],
    },
    ended: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
    },
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.xl,
    },
    // The studio's frame, so the picture is the one the sender previewed.
    frame: {
      flex: 1,
      maxWidth: "100%",
      borderRadius: Radius.xl,
      overflow: "hidden",
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 2,
      borderColor: Colors.border,
    },
    cover: {
      position: "absolute",
      top: 0,
      bottom: 0,
      start: 0,
      end: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    // So "Reconnecting…" reads on any picture in either theme.
    scrim: {
      backgroundColor: Colors.mediaScrim,
    },
    reconnectingText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.onStatus,
    },
    nothing: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    footer: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.base,
      paddingTop: Spacing.md,
    },
    // Holds its height when the control goes, so the frame does not jump as
    // the stream ends.
    controls: {
      height: CONTROL_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    caption: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
    },
    round: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surfaceRaised,
    },
    roundOff: {
      backgroundColor: Colors.surface,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    roundPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    dimmed: {
      opacity: PRESSED_OPACITY,
    },
  });
}
