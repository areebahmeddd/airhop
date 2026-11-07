// The red LIVE pill, one object wherever something is live: the bubble in the
// thread, the studio sending a stream and the full-screen viewer watching it,
// and live voice, heard or sent. `ended` is the same pill once nothing more
// goes out (a burst past its ceiling): no dot and no red, since the red says
// "on air".

import { useT } from "@i18n";
import UpperText from "@ui/components/upper-text";
import {
  FontSize,
  FontWeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import React, { useMemo } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";

interface Props extends ViewProps {
  ended?: boolean;
}

export default function LiveBadge({
  ended = false,
  style,
  ...props
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <View {...props} style={[styles.badge, ended && styles.badgeEnded, style]}>
      {!ended && <View style={styles.dot} />}
      <UpperText style={[styles.text, ended && styles.textEnded]}>
        {ended ? T("chat.voice.live_ended") : T("chat.live_video.badge")}
      </UpperText>
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing["2xs"],
      borderRadius: Radius.full,
      backgroundColor: Colors.dangerFill,
    },
    badgeEnded: {
      backgroundColor: Colors.surfaceRaised,
    },
    dot: {
      width: Spacing["xs-sm"],
      height: Spacing["xs-sm"],
      borderRadius: Radius.full,
      backgroundColor: Colors.onStatus,
    },
    text: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.bold,
      color: Colors.onStatus,
    },
    textEnded: {
      color: Colors.textMuted,
    },
  });
}
