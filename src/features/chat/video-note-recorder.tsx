// Hold-to-record round video notes, the camera's twin of the voice-note mic.
//
// Hold the button to record from the front camera into a round preview, let go
// to send, slide toward the start of the row to cancel, or lift to lock and
// finish hands-free. A ring fills as the note runs out, and it sends itself
// when the ring closes. The finished clip goes out as an ordinary video file
// (see videoNoteName), so nothing on the wire changes.
//
// Self-contained on purpose: the mic's state machine also drives live voice,
// and a second recorder threaded through it would put both at risk. The thread
// renders the button and the overlay and is handed a finished file.

import { MIN_BURST_KEEP_MS } from "@core/mesh/voice/voice-capture";
import { MAX_FILE_BYTES, MAX_VIDEO_SECONDS } from "@core/mesh/wire/file-packet";
import { t, useT } from "@i18n";
import { chevronBack, isRTLLayout } from "@i18n/layout";
import { acknowledged, armed, held, released } from "@platform/haptics";
import { ensurePermission } from "@platform/permissions";
import { Feather } from "@react-native-vector-icons/feather/static";
import {
  FontSize,
  FontWeight,
  hitSlopFor,
  MIN_TOUCH,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatDuration } from "@utils/format";
import { Camera, CameraView } from "expo-camera";
import * as FileSystem from "expo-file-system";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  GestureDetector,
  usePanGesture,
  type PanGestureConfig,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import {
  CANCEL_SLIDE_DISARM,
  CANCEL_SLIDE_DISTANCE,
  LOCK_SLIDE_DISTANCE,
} from "./hold-gesture";

// The bitrate the camera is asked for. With the platform's own AAC track on
// top, a full-length note lands near 700 KB, inside the 1 MiB file ceiling;
// the file-size stop below is the backstop for a device that overshoots.
const VIDEO_BITRATE = 250_000;

// Preview and ring geometry, in points.
const PREVIEW_SIZE = 220;
const RING_WIDTH = 4;
const RING_SIZE = PREVIEW_SIZE + RING_WIDTH * 4;
const RING_RADIUS = (RING_SIZE - RING_WIDTH) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

// Matches the compose row's 40 pt buttons.
const BUTTON_SIZE = 40;

// How often the recorder reports progress. Fine enough for a smooth ring.
const PROGRESS_INTERVAL_S = 0.1;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface RecordedVideoNote {
  uri: string;
  durationMs: number;
  sizeBytes: number | undefined;
  // True when the ring closed rather than the user letting go.
  atLimit: boolean;
}

type Phase = "idle" | "opening" | "recording" | "locked";

// How a recording ends, decided before the recorder's promise settles.
type Outcome = "send" | "cancel";

interface Options {
  enabled: boolean;
  // The compose row's height: the overlay stops above it, so the button under
  // the finger stays in view as it slides.
  bottomInset: number;
  onRecorded: (note: RecordedVideoNote) => void;
  onToast: (message: string) => void;
}

export function useVideoNoteRecorder({
  enabled,
  bottomInset,
  onRecorded,
  onToast,
}: Options): {
  button: React.JSX.Element;
  overlay: React.JSX.Element | null;
  active: boolean;
} {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [cancelArmed, setCancelArmed] = useState(false);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  const cameraRef = useRef<CameraView | null>(null);
  // Every press takes a number; anything that resolves for an older one is
  // stale. A permission prompt or a slow camera can outlast a quick tap.
  const holdSeq = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const outcomeRef = useRef<Outcome | null>(null);
  const startedAtRef = useRef(0);
  // Started from a screen reader, which has no hold: record straight into the
  // hands-free state.
  const startLockedRef = useRef(false);
  const lastSizeRef = useRef<number | undefined>(undefined);
  const onRecordedRef = useRef(onRecorded);
  const onToastRef = useRef(onToast);
  useEffect(() => {
    onRecordedRef.current = onRecorded;
    onToastRef.current = onToast;
  });

  const slide = useSharedValue(0);
  const cancelArmedShared = useSharedValue(false);
  const lockedShared = useSharedValue(false);
  const lockAvailable = useSharedValue(false);
  const progress = useSharedValue(0);

  const setPhaseBoth = useCallback((next: Phase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const reset = useCallback((): void => {
    setPhaseBoth("idle");
    setCancelArmed(false);
    setElapsedSecs(0);
    progress.set(0);
    lockAvailable.set(false);
    lockedShared.set(false);
    outcomeRef.current = null;
    lastSizeRef.current = undefined;
    startLockedRef.current = false;
  }, [setPhaseBoth, progress, lockAvailable, lockedShared]);

  const begin = useCallback(async (): Promise<void> => {
    if (!enabled || phaseRef.current !== "idle") return;
    held();
    const hold = ++holdSeq.current;
    const purpose = { purpose: t("chat.perm.video_note_purpose") };
    const camera = await ensurePermission(
      Camera.getCameraPermissionsAsync,
      Camera.requestCameraPermissionsAsync,
      { label: t("chat.perm.camera_label"), ...purpose },
    );
    if (!camera || hold !== holdSeq.current) return;
    const mic = await ensurePermission(
      Camera.getMicrophonePermissionsAsync,
      Camera.requestMicrophonePermissionsAsync,
      { label: t("chat.perm.mic_label"), ...purpose },
    );
    if (!mic || hold !== holdSeq.current) return;
    // The camera opens on mount; recording starts once it reports ready.
    setPhaseBoth("opening");
  }, [enabled, setPhaseBoth]);

  // A release, a cancel or the ring closing all end here, by stopping the
  // recorder; its promise then settles in startRecording below.
  const finish = useCallback(
    (outcome: Outcome): void => {
      holdSeq.current += 1;
      const current = phaseRef.current;
      if (current === "idle") return;
      if (current === "opening") {
        // Let go before the camera was ready: a tap, not a note.
        reset();
        if (outcome === "send") onToastRef.current(t("chat.video_note.hold"));
        return;
      }
      const tooShort = Date.now() - startedAtRef.current < MIN_BURST_KEEP_MS;
      outcomeRef.current = tooShort ? "cancel" : outcome;
      if (tooShort && outcome === "send") {
        onToastRef.current(t("chat.video_note.hold"));
      }
      cameraRef.current?.stopRecording();
    },
    [reset],
  );

  const startRecording = useCallback(async (): Promise<void> => {
    const camera = cameraRef.current;
    if (camera === null || phaseRef.current !== "opening") return;
    if (startLockedRef.current) {
      lockedShared.set(true);
      setPhaseBoth("locked");
    } else {
      setPhaseBoth("recording");
      lockAvailable.set(true);
    }
    startedAtRef.current = Date.now();
    let uri: string | undefined;
    try {
      const result = await camera.recordAsync({
        maxDuration: MAX_VIDEO_SECONDS,
        maxFileSize: MAX_FILE_BYTES,
        progressUpdateInterval: PROGRESS_INTERVAL_S,
        // iOS honours videoBitrate only with an explicit codec.
        ...(Platform.OS === "ios" ? { codec: "avc1" as const } : {}),
      });
      uri = result?.uri;
    } catch {
      uri = undefined;
    }
    const durationMs = Date.now() - startedAtRef.current;
    // Null outcome: the recorder stopped on its own, at a limit or because the
    // camera went away (the app backgrounded). Either way the note was meant.
    const outcome = outcomeRef.current ?? "send";
    const atLimit = outcomeRef.current === null;
    const sizeBytes = lastSizeRef.current;
    reset();
    if (uri === undefined) {
      if (outcome === "send") {
        onToastRef.current(t("chat.video_note.not_recorded"));
      }
      return;
    }
    if (outcome === "cancel" || durationMs < MIN_BURST_KEEP_MS) {
      discard(uri);
      return;
    }
    const file = new FileSystem.File(uri);
    onRecordedRef.current({
      uri,
      durationMs,
      sizeBytes: file.exists ? file.size : sizeBytes,
      atLimit,
    });
  }, [setPhaseBoth, lockAvailable, lockedShared, reset]);

  const lock = useCallback((): void => {
    held();
    setCancelArmed(false);
    setPhaseBoth("locked");
  }, [setPhaseBoth]);

  const reportCancelArmed = useCallback((isArmed: boolean): void => {
    setCancelArmed(isArmed);
    if (isArmed) armed();
    else released();
  }, []);

  const release = useCallback(
    (cancelled: boolean): void => {
      setCancelArmed(false);
      released();
      finish(cancelled ? "cancel" : "send");
    },
    [finish],
  );

  const beginFromGesture = useCallback((): void => {
    void begin();
  }, [begin]);

  // Same shape as the mic's hold: a Pan with no minimum distance, ended on
  // every finalize (release, system cancellation, a call), on the UI thread.
  const config = useMemo<PanGestureConfig>(
    () => ({
      minDistance: 0,
      shouldCancelWhenOutside: false,
      onBegin: () => {
        "worklet";
        slide.set(0);
        cancelArmedShared.set(false);
        lockedShared.set(false);
        scheduleOnRN(beginFromGesture);
      },
      onUpdate: (e) => {
        "worklet";
        if (lockedShared.get()) return;
        if (
          lockAvailable.get() &&
          slide.get() === 0 &&
          -e.translationY >= LOCK_SLIDE_DISTANCE
        ) {
          lockedShared.set(true);
          slide.set(withTiming(0));
          scheduleOnRN(lock);
          return;
        }
        const travel = isRTLLayout ? e.translationX : -e.translationX;
        const slid = Math.min(Math.max(travel, 0), CANCEL_SLIDE_DISTANCE);
        slide.set(slid);
        const next = cancelArmedShared.get()
          ? slid > CANCEL_SLIDE_DISARM
          : slid >= CANCEL_SLIDE_DISTANCE;
        if (next === cancelArmedShared.get()) return;
        cancelArmedShared.set(next);
        scheduleOnRN(reportCancelArmed, next);
      },
      onFinalize: () => {
        "worklet";
        // A locked note belongs to the overlay's buttons now.
        if (lockedShared.get()) return;
        const cancelled = cancelArmedShared.get();
        cancelArmedShared.set(false);
        slide.set(withTiming(0));
        scheduleOnRN(release, cancelled);
      },
    }),
    [
      slide,
      cancelArmedShared,
      lockedShared,
      lockAvailable,
      beginFromGesture,
      lock,
      reportCancelArmed,
      release,
    ],
  );
  const gesture = usePanGesture(config);

  // Leaving the app ends the note as a release would, the same ending a voice
  // note gets. Leaving the thread unmounts the camera, which settles the
  // recorder the same way.
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      // Background, not inactive: iOS reports inactive for Control Center,
      // which leaves the camera recording.
      if (state === "background") finishRef.current("send");
    });
    return () => sub.remove();
  }, []);

  const buttonSlideStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (isRTLLayout ? 1 : -1) * slide.get() },
      { scale: 1 - 0.15 * (slide.get() / CANCEL_SLIDE_DISTANCE) },
    ],
  }));

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_LENGTH * (1 - progress.get()),
  }));

  const active = phase !== "idle";

  const button = (
    <GestureDetector gesture={gesture}>
      {/* A padded wrapper, as the mic has: gesture handlers ignore hitSlop. */}
      <View
        style={styles.target}
        pointerEvents={phase === "locked" ? "none" : "auto"}
        accessible
        accessibilityRole="button"
        accessibilityLabel={T("chat.video_note.hold")}
        accessibilityHint={T("chat.video_note.a11y_toggle")}
        // A hold-and-slide has no screen-reader form, so it is a toggle there,
        // straight into the hands-free state.
        onAccessibilityTap={() => {
          if (phaseRef.current === "idle") {
            startLockedRef.current = true;
            void begin();
          } else {
            finish("send");
          }
        }}
      >
        <Animated.View
          style={[
            styles.button,
            active && styles.buttonActive,
            cancelArmed && styles.buttonActive,
            buttonSlideStyle,
          ]}
        >
          <Feather
            name={cancelArmed ? "trash-2" : "video"}
            size={16}
            color={active ? Colors.danger : Colors.textMuted}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );

  const overlay = active ? (
    <View
      style={[styles.overlay, { bottom: bottomInset }]}
      // Held, the finger is on the button below and must stay there; locked,
      // the overlay's own buttons take over.
      pointerEvents={phase === "locked" ? "auto" : "box-none"}
    >
      <View style={styles.ringBox} pointerEvents="none">
        <View style={styles.preview}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="front"
            mode="video"
            mirror
            videoQuality="480p"
            videoBitrate={VIDEO_BITRATE}
            onCameraReady={() => void startRecording()}
            onRecordingProgress={({ duration, fileSize }) => {
              lastSizeRef.current = fileSize;
              setElapsedSecs(Math.floor(duration));
              // Whichever runs out first, time or the file ceiling.
              progress.set(
                withTiming(
                  Math.min(
                    1,
                    Math.max(
                      duration / MAX_VIDEO_SECONDS,
                      fileSize / MAX_FILE_BYTES,
                    ),
                  ),
                  {
                    duration: PROGRESS_INTERVAL_S * 1000,
                    easing: Easing.linear,
                  },
                ),
              );
            }}
            onMountError={() => {
              reset();
              onToastRef.current(t("chat.video_note.not_recorded"));
            }}
          />
        </View>
        <Svg
          width={RING_SIZE}
          height={RING_SIZE}
          style={StyleSheet.absoluteFill}
        >
          <AnimatedCircle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            stroke={Colors.danger}
            strokeWidth={RING_WIDTH}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={RING_LENGTH}
            animatedProps={ringProps}
            // Starts at twelve o'clock, as a clock hand would.
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </Svg>
      </View>

      <View style={styles.footer}>
        <Text style={styles.timer} accessibilityLiveRegion="polite">
          {formatDuration(elapsedSecs)}
        </Text>
        {phase === "locked" ? (
          <View style={styles.lockedActions}>
            <Pressable
              style={styles.roundAction}
              onPress={() => finish("cancel")}
              hitSlop={hitSlopFor(BUTTON_SIZE)}
              accessibilityRole="button"
              accessibilityLabel={T("chat.voice.cancel_recording")}
            >
              <Feather name="x" size={18} color={Colors.textPrimary} />
            </Pressable>
            <Pressable
              style={[styles.roundAction, styles.sendAction]}
              onPress={() => {
                acknowledged();
                finish("send");
              }}
              hitSlop={hitSlopFor(BUTTON_SIZE)}
              accessibilityRole="button"
              accessibilityLabel={T("chat.voice.stop_send")}
            >
              <Feather name="arrow-up" size={18} color={Colors.textInverse} />
            </Pressable>
          </View>
        ) : (
          <View style={styles.hintRow}>
            <Feather
              name={cancelArmed ? "trash-2" : chevronBack}
              size={14}
              color={cancelArmed ? Colors.danger : Colors.textMuted}
            />
            <Text
              style={[styles.hint, cancelArmed && styles.hintArmed]}
              numberOfLines={1}
            >
              {cancelArmed
                ? T("chat.voice.release_cancel")
                : T("chat.voice.slide_cancel")}
            </Text>
            {!cancelArmed && (
              <View
                style={styles.lockHint}
                accessible
                accessibilityLabel={T("chat.voice.lift_lock")}
              >
                <Feather name="chevron-up" size={12} color={Colors.textMuted} />
                <Feather name="lock" size={13} color={Colors.textMuted} />
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  ) : null;

  return { button, overlay, active };
}

// The recorder writes to the camera's own cache; a discarded note goes now
// rather than waiting for the retention sweep, which never sees that folder.
function discard(uri: string): void {
  try {
    const file = new FileSystem.File(uri);
    if (file.exists) file.delete();
  } catch {
    return;
  }
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    target: {
      padding: (MIN_TOUCH - BUTTON_SIZE) / 2,
      margin: -(MIN_TOUCH - BUTTON_SIZE) / 2,
      flexShrink: 0,
    },
    button: {
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: Colors.borderStrong,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 1,
    },
    buttonActive: {
      backgroundColor: Colors.dangerDim,
      borderColor: Colors.danger,
    },
    overlay: {
      position: "absolute",
      top: 0,
      start: 0,
      end: 0,
      backgroundColor: Colors.overlay,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.lg,
    },
    ringBox: {
      width: RING_SIZE,
      height: RING_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    preview: {
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      borderRadius: Radius.full,
      overflow: "hidden",
      backgroundColor: "#000",
    },
    // A surface pill, so the text reads in both themes over the dimmed chat.
    footer: {
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.lg,
      borderRadius: Radius.xl,
      backgroundColor: Colors.surface,
    },
    timer: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      fontVariant: ["tabular-nums"],
    },
    hintRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    hint: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    hintArmed: {
      color: Colors.danger,
    },
    lockHint: {
      flexDirection: "row",
      alignItems: "center",
      marginStart: Spacing.md,
    },
    lockedActions: {
      flexDirection: "row",
      gap: Spacing["2xl"],
    },
    roundAction: {
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surfaceRaised,
    },
    sendAction: {
      backgroundColor: Colors.accent,
    },
  });
}
