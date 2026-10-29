// A stream someone is sending, drawn live in their bubble: the picture, a red
// LIVE badge with how long it has run, and a sound button. Tapping the picture
// opens the full-screen viewer with sound, as a video opens in any messenger;
// the button turns the sound on or off in place. Silent until asked, as a
// video note is, and a stream sent without sound has no button.
//
// The picture comes from the native surface the receiver decodes onto; this
// only mounts it and says what state the stream is in. It keeps playing under
// the viewer, which draws the same stream on a surface of its own. Once the
// stream ends the row carries the recording and draws as an ordinary video.

import { AirhopVideoSurface } from "@bridge/NativeAirhopVideoViews";
import { useT } from "@i18n";
import { Feather } from "@react-native-vector-icons/feather/static";
import { getMeshService } from "@services/mesh-service";
import type { ChatMessage } from "@store/chat-store";
import {
  FontSize,
  FontWeight,
  hitSlopFor,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatDuration } from "@utils/format";
import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import LiveBadge from "./live-badge";

// MEDIA_BUBBLE_WIDTH in message-thread.tsx, the width of every media bubble.
const WIDTH = 220;
const SOUND_BADGE = 32;

const noop = (): (() => void) => () => undefined;

// Whether this stream's row has the sound, and the switch for it. One stream
// is heard at a time, so turning this one on takes the sound from any other.
export function useLiveVideoSound(rowID: string): {
  withSound: boolean;
  toggleSound: () => void;
} {
  const receiver = getMeshService()?.liveVideoReceiver ?? null;
  const subscribe = useMemo(
    () => (receiver === null ? noop : receiver.subscribe.bind(receiver)),
    [receiver],
  );
  const audible = useSyncExternalStore(
    subscribe,
    () => receiver?.audible ?? null,
  );
  const withSound = audible === rowID;
  return {
    withSound,
    toggleSound: () => receiver?.setAudible(withSound ? null : rowID),
  };
}

export default function LiveVideoBubble({
  message,
  onOpen,
}: {
  message: ChatMessage;
  // Absent while the thread is selecting rows: a tap then selects this one.
  onOpen?: (message: ChatMessage) => void;
}): React.JSX.Element | null {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const { withSound, toggleSound } = useLiveVideoSound(message.id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const live = message.liveVideo;
  if (live === undefined) return null;
  const reconnecting = live.state === "reconnecting";
  const elapsed = Math.max(0, Math.floor((now - live.startedAtMs) / 1000));

  return (
    // Two controls side by side, never one inside the other: a screen reader
    // reads an accessible element as one node and would hide the inner one.
    <View
      style={[styles.frame, { aspectRatio: live.width / live.height }]}
      pointerEvents={onOpen === undefined ? "none" : "box-none"}
    >
      <Pressable
        onPress={() => onOpen?.(message)}
        accessibilityRole="button"
        accessibilityLabel={T("chat.live_video.a11y", {
          name: message.senderNickname,
        })}
        style={({ pressed }) => [styles.picture, pressed && styles.pressed]}
      >
        <AirhopVideoSurface
          style={StyleSheet.absoluteFill}
          surfaceKey={`${message.senderID}:${live.streamID}`}
        />
        <View style={styles.topRow} pointerEvents="none">
          <LiveBadge />
          <Text style={styles.timer}>{formatDuration(elapsed)}</Text>
        </View>
        {reconnecting && (
          <View style={styles.reconnecting} pointerEvents="none">
            <Text style={styles.reconnectingText}>
              {T("chat.live_video.reconnecting")}
            </Text>
          </View>
        )}
      </Pressable>
      {live.hasAudio && (
        <Pressable
          onPress={toggleSound}
          hitSlop={hitSlopFor(SOUND_BADGE)}
          accessibilityRole="switch"
          accessibilityLabel={T("chat.live_video.sound")}
          accessibilityState={{ checked: withSound }}
          style={({ pressed }) => [styles.sound, pressed && styles.pressed]}
        >
          <Feather
            name={withSound ? "volume-2" : "volume-x"}
            size={16}
            color={Colors.onStatus}
          />
        </Pressable>
      )}
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    frame: {
      width: WIDTH,
      borderRadius: Radius.md,
      overflow: "hidden",
      // The picture's own ground until the first keyframe paints it.
      backgroundColor: Colors.surfaceRaised,
    },
    picture: {
      flex: 1,
    },
    // A picture has no fill of its own to darken.
    pressed: {
      opacity: PRESSED_OPACITY,
    },
    topRow: {
      position: "absolute",
      top: Spacing.sm,
      start: Spacing.sm,
      end: Spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    // On a scrim, so it reads on any picture in either theme. The LIVE pill's
    // padding, so the two read as one row.
    timer: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.onStatus,
      fontVariant: ["tabular-nums"],
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing["2xs"],
      borderRadius: Radius.full,
      backgroundColor: Colors.mediaScrim,
      overflow: "hidden",
    },
    reconnecting: {
      position: "absolute",
      top: 0,
      bottom: 0,
      start: 0,
      end: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.mediaScrim,
    },
    reconnectingText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.onStatus,
    },
    // 32pt on screen, 44pt to a thumb through its slop, which stays inside the
    // frame and clear of the LIVE row at the top.
    sound: {
      position: "absolute",
      bottom: Spacing.sm,
      end: Spacing.sm,
      width: SOUND_BADGE,
      height: SOUND_BADGE,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.mediaScrim,
    },
  });
}
