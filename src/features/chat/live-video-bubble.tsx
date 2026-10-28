// A stream someone is sending, drawn live in their bubble: the picture, a red
// LIVE badge with how long it has run, and a sound toggle. Silent until tapped,
// as a video note is, and only one stream is heard at a time.
//
// The picture comes from the native surface the receiver decodes onto; this
// only mounts it and says what state the stream is in. Once the stream ends
// the row carries the recording instead and draws as an ordinary video.

import { AirhopVideoSurface } from "@bridge/NativeAirhopVideoViews";
import { useT } from "@i18n";
import { Feather } from "@react-native-vector-icons/feather/static";
import { getMeshService } from "@services/mesh-service";
import type { ChatMessage } from "@store/chat-store";
import UpperText from "@ui/components/upper-text";
import {
  FontSize,
  FontWeight,
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

// MEDIA_BUBBLE_WIDTH in message-thread.tsx, the width of every media bubble.
const WIDTH = 220;
const SOUND_BADGE = 32;

const noop = (): (() => void) => () => undefined;

export default function LiveVideoBubble({
  message,
}: {
  message: ChatMessage;
}): React.JSX.Element | null {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const receiver = getMeshService()?.liveVideoReceiver ?? null;
  const subscribe = useMemo(
    () => (receiver === null ? noop : receiver.subscribe.bind(receiver)),
    [receiver],
  );
  const audible = useSyncExternalStore(
    subscribe,
    () => receiver?.audible ?? null,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const live = message.liveVideo;
  if (live === undefined) return null;
  const withSound = audible === message.id;
  const reconnecting = live.state === "reconnecting";
  const elapsed = Math.max(0, Math.floor((now - live.startedAtMs) / 1000));

  function toggleSound(): void {
    receiver?.setAudible(withSound ? null : message.id);
  }

  return (
    <Pressable
      onPress={toggleSound}
      accessibilityRole="button"
      accessibilityLabel={T("chat.live_video.a11y", {
        name: message.senderNickname,
      })}
      accessibilityState={{ checked: withSound }}
      style={[styles.frame, { aspectRatio: live.width / live.height }]}
    >
      <AirhopVideoSurface
        style={StyleSheet.absoluteFill}
        surfaceKey={`${message.senderID}:${live.streamID}`}
      />
      <View style={styles.topRow} pointerEvents="none">
        <View style={styles.badge}>
          <View style={styles.dot} />
          <UpperText style={styles.badgeText}>
            {T("chat.live_video.badge")}
          </UpperText>
        </View>
        <Text style={styles.timer}>{formatDuration(elapsed)}</Text>
      </View>
      {reconnecting && (
        <View style={styles.reconnecting} pointerEvents="none">
          <Text style={styles.reconnectingText}>
            {T("chat.live_video.reconnecting")}
          </Text>
        </View>
      )}
      <View style={styles.sound} pointerEvents="none">
        <Feather
          name={withSound ? "volume-2" : "volume-x"}
          size={16}
          color={Colors.onStatus}
        />
      </View>
    </Pressable>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    frame: {
      width: WIDTH,
      borderRadius: Radius.lg,
      overflow: "hidden",
      // The picture's own ground until the first keyframe paints it.
      backgroundColor: Colors.surfaceRaised,
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
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing["xs-sm"],
      paddingVertical: Spacing["2xs"],
      borderRadius: Radius.full,
      backgroundColor: Colors.danger,
    },
    dot: {
      width: Spacing["xs-sm"],
      height: Spacing["xs-sm"],
      borderRadius: Radius.full,
      backgroundColor: Colors.onStatus,
    },
    badgeText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.bold,
      color: Colors.onStatus,
    },
    // On a scrim, so it reads on any picture in either theme.
    timer: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.onStatus,
      fontVariant: ["tabular-nums"],
      paddingHorizontal: Spacing["xs-sm"],
      paddingVertical: Spacing["2xs"],
      borderRadius: Radius.full,
      backgroundColor: Colors.overlay,
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
      backgroundColor: Colors.overlay,
    },
    reconnectingText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.onStatus,
    },
    sound: {
      position: "absolute",
      bottom: Spacing.sm,
      end: Spacing.sm,
      width: SOUND_BADGE,
      height: SOUND_BADGE,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.overlay,
    },
  });
}
