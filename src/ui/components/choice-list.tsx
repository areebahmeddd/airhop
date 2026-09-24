// A short list of ways forward in one grouped card (Start new, and the wallet's
// choosers). Each row states the one fact that decides it; a disabled row says
// why in its detail.

import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  DISABLED_OPACITY,
  FontSize,
  FontWeight,
  Radius,
  Spacing,
  useThemeColors,
} from "../theme";

type FeatherName = React.ComponentProps<typeof Feather>["name"];

export interface Choice {
  key: string;
  icon: FeatherName;
  title: string;
  detail: string;
  // When the title alone would be ambiguous to a screen reader.
  a11yLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}

// The divider insets past this glyph circle to the label.
const ICON_SIZE = 38;

export default function ChoiceList({
  choices,
}: {
  choices: Choice[];
}): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <View style={styles.group}>
      {choices.map((choice, index) => (
        <View key={choice.key}>
          {index > 0 && <View style={styles.divider} />}
          <Pressable
            style={({ pressed }) => [
              styles.row,
              pressed && styles.rowPressed,
              choice.disabled === true && styles.rowDisabled,
            ]}
            onPress={choice.onPress}
            disabled={choice.disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: choice.disabled === true }}
            accessibilityLabel={choice.a11yLabel ?? choice.title}
            accessibilityHint={choice.detail}
          >
            <View style={styles.icon}>
              <Feather
                name={choice.icon}
                size={18}
                color={Colors.textPrimary}
              />
            </View>
            <View style={styles.text}>
              <Text style={styles.title}>{choice.title}</Text>
              <Text style={styles.detail}>{choice.detail}</Text>
            </View>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    group: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      overflow: "hidden",
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
      marginStart: Spacing.base + ICON_SIZE + Spacing.md,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.base,
    },
    // Darkens rather than dims: the row has a neutral fill of its own.
    rowPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    rowDisabled: {
      opacity: DISABLED_OPACITY,
    },
    icon: {
      width: ICON_SIZE,
      height: ICON_SIZE,
      borderRadius: Radius.full,
      backgroundColor: Colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    text: {
      flex: 1,
    },
    title: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    detail: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: FontSize.sm * 1.4,
    },
  });
}
