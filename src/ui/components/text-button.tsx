// TextButton component.
// The quiet counterpart to PrimaryButton: a label with no fill, for the way out
// under a primary action (Cancel, Close, Back).

import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import {
  FontSize,
  FontWeight,
  MIN_TOUCH,
  PRESSED_OPACITY,
  useThemeColors,
} from "../theme";

interface Props {
  label: string;
  onPress: () => void;
}

export default function TextButton({
  label,
  onPress,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    button: {
      minHeight: MIN_TOUCH,
      alignItems: "center",
      justifyContent: "center",
    },
    // No fill to darken, so it dims.
    pressed: {
      opacity: PRESSED_OPACITY,
    },
    label: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
      textAlign: "center",
    },
  });
}
