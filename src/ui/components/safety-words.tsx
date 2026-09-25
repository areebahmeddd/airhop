// Six words two phones show side by side, for a person to compare.
//
// Used by Compare a code and by the transfer between phones. The words come
// from `safetyNumberWords` and are never translated, so two phones in different
// languages still agree.

import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FontFamily, FontSize, Spacing, useThemeColors } from "../theme";

interface Props {
  words: string[];
  // The camera screens draw white over a scrim whatever the theme.
  color?: string;
}

export default function SafetyWords({
  words,
  color,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(
    () => createStyles(color ?? Colors.textPrimary),
    [color, Colors],
  );
  // Two rows of three. One line wraps unpredictably across font scales, and a
  // reader needs the same shape on both phones to keep their place.
  return (
    <View style={styles.grid} accessible accessibilityLabel={words.join(" ")}>
      {words.map((word, index) => (
        <Text key={`${index}-${word}`} style={styles.word}>
          {word}
        </Text>
      ))}
    </View>
  );
}

function createStyles(color: string) {
  return StyleSheet.create({
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      rowGap: Spacing.sm,
      columnGap: Spacing.md,
      marginVertical: Spacing.sm,
    },
    word: {
      width: "30%",
      textAlign: "center",
      fontFamily: FontFamily.mono,
      fontSize: FontSize.lg,
      color,
      letterSpacing: 0.5,
    },
  });
}
