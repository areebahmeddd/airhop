// The "in range" dot on a peer's circle, shared by Avatar and RelayGlyph so a
// person and a relay node in the same list carry the same badge.
//
// Sized from the circle in the profile screen's status dot proportions.
// Absolutely positioned, so the host must be the circle's own view.

import React from "react";
import { View } from "react-native";
import { useThemeColors } from "../theme";

interface Props {
  // Diameter of the circle the badge sits on.
  circleSize: number;
  // The background the circle sits on, so the ring reads as a cut-out.
  ringColor?: string;
}

export default function PresenceBadge({
  circleSize,
  ringColor,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const dotSize = Math.max(8, Math.round(circleSize * 0.1875));
  const dotBorder = Math.max(1.5, Math.round(circleSize * 0.02));
  const dotInset = Math.max(1, Math.round(circleSize * 0.02));
  return (
    <View
      style={{
        position: "absolute",
        end: dotInset,
        bottom: dotInset,
        width: dotSize,
        height: dotSize,
        borderRadius: dotSize / 2,
        borderWidth: dotBorder,
        borderColor: ringColor ?? Colors.bg,
        backgroundColor: Colors.online,
      }}
    />
  );
}
