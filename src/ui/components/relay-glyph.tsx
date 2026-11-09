// Stands in for the Avatar when a peer is a relay node: the same circle in the
// same place, so a list keeps its rhythm, with a radio tower where a person's
// initials would be.
//
// The tower comes from Material Design Icons because Feather has no antenna,
// and its `radio` already means this phone (the radar's center, the Mesh tab).
//
// Colorless on purpose. Avatar tints itself from the peer ID so a crowd looks
// like a crowd; equipment should recede instead.
//
// Hidden from screen readers: the icon is a private-use character, and every
// place that draws it says "relay node" in words beside it.

import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons/static";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useThemeColors } from "../theme";
import PresenceBadge from "./presence-badge";

// Named once, so a row that cannot hold the whole glyph (a settings row's icon
// slot) still draws the same tower.
export const RELAY_ICON = "radio-tower";

interface Props {
  size?: number;
  // As on Avatar: a dot when the node is in range, nothing otherwise.
  presence?: "online" | "offline";
  ringColor?: string;
}

export default function RelayGlyph({
  size = 40,
  presence,
  ringColor,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <MaterialDesignIcons
        name={RELAY_ICON}
        size={Math.round(size * 0.42)}
        color={Colors.textSecondary}
      />
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
      backgroundColor: Colors.surfaceRaised,
    },
  });
}
