// The red LIVE pill, one object wherever a stream is live: the bubble in the
// thread, the studio sending it and the full-screen viewer watching it.

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

export default function LiveBadge({
  style,
  ...props
}: ViewProps): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <View {...props} style={[styles.badge, style]}>
      <View style={styles.dot} />
      <UpperText style={styles.text}>{T("chat.live_video.badge")}</UpperText>
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
  });
}
