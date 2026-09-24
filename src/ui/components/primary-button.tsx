// PrimaryButton component.
// The single filled CTA surface for a screen's primary action (onboarding,
// confirmations). Near-black fill + inverse text, matching the same
// iMessage-style inversion used for outgoing message bubbles.

import React, { useMemo } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  BUTTON_HEIGHT,
  FontSize,
  FontWeight,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  useThemeColors,
} from "../theme";

interface Props {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  // Spoken after the label, for saying WHY a disabled CTA is disabled. A dimmed
  // button with no stated blocker is the most common dead end in an onboarding
  // flow, and it is invisible to a screen reader without this.
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  // When true the button reads as inactive: muted fill, muted label, no
  // press feedback, and taps do nothing. Used for gated CTAs (e.g. an
  // agreement checkbox must be ticked first).
  disabled?: boolean;
}

export default function PrimaryButton({
  label,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  disabled = false,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <Pressable
      // Pressable's style callback, the one form every tappable surface here
      // uses: holding the press in state re-renders twice per tap, which a list
      // row cannot afford.
      style={({ pressed }) => [
        styles.button,
        style,
        disabled && styles.disabled,
        !disabled && pressed && styles.pressed,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
    >
      <Text
        style={[styles.label, disabled && styles.labelDisabled]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    button: {
      backgroundColor: Colors.accent,
      borderRadius: Radius.full,
      paddingVertical: Spacing["md-base"],
      minHeight: BUTTON_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
      // A transparent border when enabled, so disabling changes only its colour,
      // never the button's geometry.
      borderWidth: 1,
      borderColor: "transparent",
    },
    pressed: {
      opacity: PRESSED_OPACITY,
    },
    // Disabled keeps a visible border: the raised fill barely differs from the
    // onboarding background, so without it the pill reads as stray grey text.
    disabled: {
      backgroundColor: Colors.surfaceRaised,
      borderColor: Colors.border,
    },
    label: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textInverse,
      letterSpacing: 0.1,
    },
    labelDisabled: {
      color: Colors.textMuted,
    },
  });
}
