// TextButton component.
// The quiet counterpart to PrimaryButton: a label with no fill, for the second
// way out under a primary action (Cancel, Close, Back) or a lesser way in.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import {
  DISABLED_OPACITY,
  FontSize,
  FontWeight,
  MIN_TOUCH,
  PRESSED_OPACITY,
  useThemeColors,
} from "../theme";

interface Props {
  label: string;
  onPress: () => void;
  // "secondary" steps back from a primary above it; "primary" stands alone.
  tone?: "primary" | "secondary";
  disabled?: boolean;
  accessibilityHint?: string;
}

export default function TextButton({
  label,
  onPress,
  tone = "secondary",
  disabled = false,
  accessibilityHint,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        disabled && styles.disabled,
        !disabled && pressed && styles.pressed,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityHint={accessibilityHint}
    >
      <Text
        style={[styles.label, tone === "primary" && styles.labelPrimary]}
        numberOfLines={2}
      >
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
    disabled: {
      opacity: DISABLED_OPACITY,
    },
    label: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
      textAlign: "center",
    },
    labelPrimary: {
      color: Colors.textPrimary,
    },
  });
}
