// A circular badge showing the first two characters of a username,
// with a background color deterministically derived from the peer ID.

import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { avatarColor, FontWeight, useThemeColors, withAlpha } from "../theme";
import PresenceBadge from "./presence-badge";

// How strongly the peer's hashed color tints the circle behind its initials.
// Low, so the initials stay the contrasting element and a wall of avatars in a
// list does not read as a wall of color.
const TINT_ALPHA = 0.13;

// So a pair like "IL" does not read as one glyph at the sizes drawn here.
const INITIALS_TRACKING = 0.5;

interface Props {
  username: string;
  peerID: string;
  size?: number;
  // When set, the avatar acts as a tab icon: dimmed like an inactive icon
  // and ringed with the accent color like an active one, instead of always
  // showing its full peer color.
  active?: boolean;
  // Presence dot overlaid at the bottom-right, shown only when the peer is
  // reachable. "offline" draws nothing: absence already says it, and a gray
  // dot on every offline avatar is noise. Omit for no dot. `ringColor` should
  // match the background the avatar sits on so the dot reads as a badge;
  // defaults to the base background.
  presence?: "online" | "offline";
  ringColor?: string;
}

export default function Avatar({
  username,
  peerID,
  size = 40,
  active,
  presence,
  ringColor,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const initials = username.slice(0, 2).toUpperCase();
  const bg = avatarColor(peerID);
  const fontSize = size * 0.36;
  const borderColor =
    active === undefined
      ? Colors.border
      : active
        ? Colors.accent
        : Colors.border;

  return (
    <View
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: withAlpha(bg, TINT_ALPHA),
          borderColor,
          borderWidth: active ? 1.5 : 1,
        },
        active === false && styles.inactive,
      ]}
    >
      <Text style={[styles.initials, { fontSize, color: bg }]}>{initials}</Text>
      {presence === "online" && (
        <PresenceBadge circleSize={size} ringColor={ringColor} />
      )}
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    circle: {
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: Colors.border,
    },
    inactive: {
      opacity: 0.6,
    },
    initials: {
      fontWeight: FontWeight.semibold,
      letterSpacing: INITIALS_TRACKING,
      // Tracking is applied after the last glyph too, so the text box measures
      // wider than it draws and centering it leaves the glyphs half a track
      // short. Canceling the trailing space puts them back on center.
      marginEnd: -INITIALS_TRACKING,
    },
  });
}
