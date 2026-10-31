// The trimmer in the caption sheet: a preview above a filmstrip, with a handle
// at each end of the part that will be sent. Drag a handle to move that end,
// or the part between them to slide it along a long video; the preview shows
// the frame under the finger and plays the chosen part on a loop.
//
// The handles move on the UI thread and report the range to the sheet only
// when let go, so dragging never re-renders the thread behind it.

import type { TranscodeRange } from "@core/mesh/video/transcode-plan";
import { useT } from "@i18n";
import { reachedLimit } from "@platform/haptics";
import { Feather } from "@react-native-vector-icons/feather/static";
import { filmstripFrames } from "@services/video-prepare";
import {
  FontSize,
  MIN_TOUCH,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatDuration } from "@utils/format";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Image,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import {
  GestureDetector,
  usePanGesture,
  type PanGestureConfig,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useExclusivePlayback } from "./use-exclusive-playback";
import { slideTrim, trimEndTo, trimStartTo } from "./video-trim";

const PREVIEW_HEIGHT = 240;
// Tall enough to be the touch target for the handles inside it.
const STRIP_HEIGHT = 48;
const HANDLE_WIDTH = 20;
const HANDLE_SLOP = (MIN_TOUCH - HANDLE_WIDTH) / 2;
const FRAME_BORDER = 2;
// A portrait-ish cell per still, about as many as fit without squeezing.
const FRAME_CELL_WIDTH = 36;
// Seeking on every frame of a drag outruns the decoder; a few times a second
// keeps the preview on the finger.
const SCRUB_INTERVAL_MS = 80;
// A screen reader moves a handle a second at a time.
const STEP_MS = 1_000;

type Edge = "start" | "end" | "slide";

interface Props {
  uri: string;
  durationMs: number;
  // Where the handles start; later moves are reported through onChange.
  initialRange: TranscodeRange;
  onChange: (range: TranscodeRange) => void;
  // Whether the preview holds the thread's one sound, and how it takes it.
  previewPlaying: boolean;
  onPreviewPlay: () => void;
}

export default function VideoTrimmer({
  uri,
  durationMs,
  initialRange,
  onChange,
  previewPlaying,
  onPreviewPlay,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  const [range, setRange] = useState(initialRange);
  const [playing, setPlaying] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [frames, setFrames] = useState<string[]>([]);
  const rangeRef = useRef(initialRange);
  const lastScrubRef = useRef(0);

  const startMs = useSharedValue(initialRange.startMs);
  const endMs = useSharedValue(initialRange.endMs);
  // Per gesture, so two fingers on the two handles share nothing: where its
  // edge was when the finger landed, and whether it is held against a stop.
  const startOrigin = useSharedValue(0);
  const endOrigin = useSharedValue(0);
  const slideOrigin = useSharedValue(0);
  const startPinned = useSharedValue(false);
  const endPinned = useSharedValue(false);
  const slidePinned = useSharedValue(false);
  const trackPoints = useSharedValue(0);

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
  });
  useExclusivePlayback(player, previewPlaying, onPreviewPlay);

  // The chosen part plays on a loop, including one that runs to the video's
  // own end, where the player stops rather than passing the end handle.
  useEffect(() => {
    const time = player.addListener("timeUpdate", ({ currentTime }) => {
      if (currentTime * 1000 < rangeRef.current.endMs) return;
      seek(player, rangeRef.current.startMs);
    });
    const ended = player.addListener("playToEnd", () => {
      seek(player, rangeRef.current.startMs);
      player.play();
    });
    const play = player.addListener("playingChange", ({ isPlaying }) => {
      setPlaying(isPlaying);
    });
    return () => {
      time.remove();
      ended.remove();
      play.remove();
    };
  }, [player]);

  // Stills sized to the strip, freed when the sheet closes.
  const frameCount =
    trackWidth > 0 ? Math.max(1, Math.round(trackWidth / FRAME_CELL_WIDTH)) : 0;
  useEffect(() => {
    if (frameCount === 0) return;
    let discard: (() => void) | null = null;
    let closed = false;
    void filmstripFrames(
      uri,
      durationMs,
      frameCount,
      Math.round(STRIP_HEIGHT * PixelRatio.get()),
    ).then((strip) => {
      if (closed) {
        strip.discard();
        return;
      }
      discard = strip.discard;
      setFrames(strip.frames);
    });
    return () => {
      closed = true;
      discard?.();
    };
  }, [uri, durationMs, frameCount]);

  const scrub = useCallback(
    (ms: number) => {
      const now = Date.now();
      if (now - lastScrubRef.current < SCRUB_INTERVAL_MS) return;
      lastScrubRef.current = now;
      player.pause();
      seek(player, ms);
    },
    [player],
  );

  const move = useCallback((next: TranscodeRange) => {
    rangeRef.current = next;
    setRange(next);
  }, []);

  const commit = useCallback(
    (next: TranscodeRange) => {
      move(next);
      seek(player, next.startMs);
      onChange(next);
    },
    [move, onChange, player],
  );

  function togglePlay(): void {
    if (playing) {
      player.pause();
      return;
    }
    const at = player.currentTime * 1000;
    if (at < range.startMs || at >= range.endMs) {
      seek(player, range.startMs);
    }
    player.play();
  }

  // One gesture per edge, and one for the part between them. Each starts from
  // where its edge was when the finger landed, so a drag is relative, never a
  // jump to the touch point. The handles' targets grow outward only, so the two
  // never overlap when the part between them is a sliver of a long video.
  const configs = useMemo(() => {
    const config = (
      edge: Edge,
      originMs: SharedValue<number>,
      pinned: SharedValue<boolean>,
      hitSlop?: PanGestureConfig["hitSlop"],
    ): PanGestureConfig => ({
      minDistance: 0,
      shouldCancelWhenOutside: false,
      hitSlop,
      onBegin: () => {
        "worklet";
        originMs.set(edge === "end" ? endMs.get() : startMs.get());
        pinned.set(false);
      },
      onUpdate: (e) => {
        "worklet";
        const track = trackPoints.get();
        const target =
          originMs.get() +
          (track > 0 ? (e.translationX * durationMs) / track : 0);
        const current = { startMs: startMs.get(), endMs: endMs.get() };
        const next =
          edge === "start"
            ? trimStartTo(current, target)
            : edge === "end"
              ? trimEndTo(current, target, durationMs)
              : slideTrim(current, target, durationMs);
        // The moved edge landed short of where the finger asked: a stop.
        const landed = edge === "end" ? next.endMs : next.startMs;
        const stopped = Math.abs(landed - target) > 1;
        if (stopped && !pinned.get()) scheduleOnRN(reachedLimit);
        pinned.set(stopped);
        startMs.set(next.startMs);
        endMs.set(next.endMs);
        scheduleOnRN(move, next);
        scheduleOnRN(scrub, edge === "end" ? next.endMs : next.startMs);
      },
      onFinalize: () => {
        "worklet";
        scheduleOnRN(commit, { startMs: startMs.get(), endMs: endMs.get() });
      },
    });
    const vertical = { top: Spacing.sm, bottom: Spacing.sm };
    return {
      start: config("start", startOrigin, startPinned, {
        ...vertical,
        left: HANDLE_SLOP,
      }),
      end: config("end", endOrigin, endPinned, {
        ...vertical,
        right: HANDLE_SLOP,
      }),
      slide: config("slide", slideOrigin, slidePinned),
    };
  }, [
    durationMs,
    startOrigin,
    endOrigin,
    slideOrigin,
    startPinned,
    endPinned,
    slidePinned,
    startMs,
    endMs,
    trackPoints,
    move,
    scrub,
    commit,
  ]);
  const startGesture = usePanGesture(configs.start);
  const endGesture = usePanGesture(configs.end);
  const slideGesture = usePanGesture(configs.slide);

  const xFor = (ms: number, track: number): number => {
    "worklet";
    return (ms / durationMs) * track;
  };
  const selectionStyle = useAnimatedStyle(() => {
    const x = xFor(startMs.get(), trackPoints.get());
    return {
      start: HANDLE_WIDTH + x,
      width: xFor(endMs.get(), trackPoints.get()) - x,
    };
  });
  const startHandleStyle = useAnimatedStyle(() => ({
    start: xFor(startMs.get(), trackPoints.get()),
  }));
  const endHandleStyle = useAnimatedStyle(() => ({
    start: HANDLE_WIDTH + xFor(endMs.get(), trackPoints.get()),
  }));
  const beforeStyle = useAnimatedStyle(() => ({
    width: xFor(startMs.get(), trackPoints.get()),
  }));
  const afterStyle = useAnimatedStyle(() => ({
    start: HANDLE_WIDTH + xFor(endMs.get(), trackPoints.get()),
  }));

  function onTrackLayout(e: LayoutChangeEvent): void {
    const track = Math.max(0, e.nativeEvent.layout.width - HANDLE_WIDTH * 2);
    trackPoints.set(track);
    setTrackWidth(track);
  }

  // Increment and decrement, a second at a time, for a screen reader.
  function step(edge: "start" | "end", e: AccessibilityActionEvent): void {
    const by = e.nativeEvent.actionName === "increment" ? STEP_MS : -STEP_MS;
    const current = rangeRef.current;
    const next =
      edge === "start"
        ? trimStartTo(current, current.startMs + by)
        : trimEndTo(current, current.endMs + by, durationMs);
    startMs.set(next.startMs);
    endMs.set(next.endMs);
    commit(next);
  }

  const adjustable = {
    accessible: true,
    accessibilityRole: "adjustable" as const,
    accessibilityActions: [{ name: "increment" }, { name: "decrement" }],
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.preview}>
        <VideoView
          style={StyleSheet.absoluteFill}
          player={player}
          contentFit="contain"
          nativeControls={false}
        />
        <Pressable
          style={({ pressed }) => [
            styles.playButton,
            { backgroundColor: Colors.mediaScrim },
            pressed && styles.pressed,
          ]}
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={
            playing ? T("chat.trim.pause") : T("chat.trim.play")
          }
        >
          <Feather
            name={playing ? "pause" : "play"}
            size={20}
            color={Colors.onStatus}
          />
        </Pressable>
      </View>

      {/* A timeline runs left to right in every language, as media scrubbers
          do on both platforms, so it is not mirrored. */}
      <View style={styles.strip} onLayout={onTrackLayout}>
        <View style={styles.frames}>
          {frames.map((frame, i) =>
            frame === "" ? (
              <View key={i} style={styles.frame} />
            ) : (
              <Image key={i} source={{ uri: frame }} style={styles.frame} />
            ),
          )}
        </View>
        <Animated.View
          style={[styles.dim, styles.before, beforeStyle]}
          pointerEvents="none"
        />
        <Animated.View
          style={[styles.dim, styles.after, afterStyle]}
          pointerEvents="none"
        />
        <GestureDetector gesture={slideGesture}>
          <Animated.View style={[styles.selection, selectionStyle]} />
        </GestureDetector>
        <GestureDetector gesture={startGesture}>
          <Animated.View
            style={[styles.handle, styles.startHandle, startHandleStyle]}
            {...adjustable}
            accessibilityLabel={T("chat.trim.start")}
            accessibilityValue={{ text: formatDuration(range.startMs / 1000) }}
            onAccessibilityAction={(e) => step("start", e)}
          >
            <View style={styles.grip} />
          </Animated.View>
        </GestureDetector>
        <GestureDetector gesture={endGesture}>
          <Animated.View
            style={[styles.handle, styles.endHandle, endHandleStyle]}
            {...adjustable}
            accessibilityLabel={T("chat.trim.end")}
            accessibilityValue={{ text: formatDuration(range.endMs / 1000) }}
            onAccessibilityAction={(e) => step("end", e)}
          >
            <View style={styles.grip} />
          </Animated.View>
        </GestureDetector>
      </View>

      <Text style={styles.length}>
        {formatDuration((range.endMs - range.startMs) / 1000)}
      </Text>
    </View>
  );
}

// The player is a native handle whose properties are its API; there is no
// setter method to call instead.
function seek(player: VideoPlayer, ms: number): void {
  player.currentTime = ms / 1000;
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    wrap: { gap: Spacing.sm },
    preview: {
      width: "100%",
      height: PREVIEW_HEIGHT,
      borderRadius: Radius.md,
      overflow: "hidden",
      backgroundColor: Colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    playButton: {
      width: MIN_TOUCH,
      height: MIN_TOUCH,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: { opacity: PRESSED_OPACITY },
    strip: {
      height: STRIP_HEIGHT,
      direction: "ltr",
    },
    frames: {
      position: "absolute",
      top: 0,
      bottom: 0,
      start: HANDLE_WIDTH,
      end: HANDLE_WIDTH,
      flexDirection: "row",
      borderRadius: Radius.sm,
      overflow: "hidden",
      backgroundColor: Colors.surfaceRaised,
    },
    frame: { flex: 1, height: STRIP_HEIGHT },
    dim: {
      position: "absolute",
      top: 0,
      bottom: 0,
      backgroundColor: Colors.mediaScrim,
    },
    before: { start: HANDLE_WIDTH },
    after: { end: HANDLE_WIDTH },
    selection: {
      position: "absolute",
      top: 0,
      bottom: 0,
      borderTopWidth: FRAME_BORDER,
      borderBottomWidth: FRAME_BORDER,
      borderColor: Colors.accent,
    },
    handle: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: HANDLE_WIDTH,
      backgroundColor: Colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    startHandle: {
      borderTopStartRadius: Radius.sm,
      borderBottomStartRadius: Radius.sm,
    },
    endHandle: {
      borderTopEndRadius: Radius.sm,
      borderBottomEndRadius: Radius.sm,
    },
    grip: {
      width: FRAME_BORDER,
      height: Spacing.base,
      borderRadius: Radius.xs,
      backgroundColor: Colors.textInverse,
    },
    length: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
  });
}
