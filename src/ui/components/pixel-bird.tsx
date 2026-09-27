// The Airhop brand mark: a monochrome pixel bird, the soaring seabird on every
// app icon (a nod to the release codenames, birds, alphabetical). Drawn as a
// grid of square cells so it stays crisp at any size, in whatever colour the
// surface needs, so it reads in both themes.

import React from "react";
import { View } from "react-native";

// Frame 0 is the glide, the mark itself; frame 1 is the downstroke useBirdFlap
// swaps in. Both are 11 x 6, so the box never resizes mid-flap.
const FRAMES = [
  [
    [1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    [0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  ],
  [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0],
    [1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1],
  ],
];

export const BIRD_COLUMNS = FRAMES[0][0].length;
export const BIRD_ROWS = FRAMES[0].length;

interface Props {
  color: string;
  // Side of one pixel, in points. Whole numbers keep the edges crisp.
  cell: number;
  frame?: number;
}

export default function PixelBird({
  color,
  cell,
  frame = 0,
}: Props): React.JSX.Element {
  const pixels = FRAMES[frame] ?? FRAMES[0];
  return (
    <View style={{ width: BIRD_COLUMNS * cell }}>
      {pixels.map((row, y) => (
        <View key={y} style={{ flexDirection: "row" }}>
          {row.map((filled, x) => (
            <View
              key={x}
              style={{
                width: cell,
                height: cell,
                backgroundColor: filled ? color : "transparent",
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
