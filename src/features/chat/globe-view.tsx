// The globe itself: a Skia canvas redrawn from the engine on every frame it
// moves, and one touch handler for every gesture. Drawing and touches run on
// the UI thread; React only sees the selected cell, through the picker.

import { stepped } from "@platform/haptics";
import { FontSize, useThemeColors } from "@ui/theme";
import { worldData } from "@utils/world-data";
import React, { useMemo } from "react";
import {
  PixelRatio,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import {
  GestureDetector,
  GestureStateManager,
  useManualGesture,
} from "react-native-gesture-handler";
import {
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  Canvas,
  PaintStyle,
  Picture,
  Skia,
  StrokeJoin,
  matchFont,
  type SkFont,
  type SkPaint,
} from "react-native-skia";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import {
  frameDetail,
  layout,
  makeTouch,
  touchesDown,
  touchesMove,
  touchesUp,
  type GlobeEngine,
} from "./globe-engine";
import { renderGlobe, type GlobeInk } from "./globe-renderer";

// System faces, which Skia finds on both platforms without loading a file:
// labels are drawn on the canvas, not in React Native text.
const SANS = Platform.select({ ios: "Helvetica", default: "sans-serif" });
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

// `width` makes it a stroke, in points.
function paint(color: string, alpha = 1, width = 0): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  p.setAlphaf(alpha);
  if (width > 0) {
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeJoin(StrokeJoin.Round);
    p.setStrokeWidth(width);
  }
  return p;
}

function font(family: string, size: number, weight: "500" | "600"): SkFont {
  return matchFont({ fontFamily: family, fontSize: size, fontWeight: weight });
}

// Line widths are bitchat's, in device pixels (`px` is one, in points), so a
// coastline is the same hairline on every screen.
function makeInk(Colors: ReturnType<typeof useThemeColors>): GlobeInk {
  const px = 1 / PixelRatio.get();
  return {
    water: paint(Colors.globeWater),
    land: paint(Colors.globeLand),
    coast: paint(Colors.globeCoast, 1, 1.4 * px),
    border: paint(Colors.globeBorder, 1, 1.2 * px),
    graticule: paint(Colors.globeGraticule, 1, px),
    limb: paint(Colors.borderStrong, 1, px),
    // Neighbours are textMuted, which clears 3:1 against both water and land
    // in either theme; the selected cell is the only accent on the globe.
    gridFill: paint(Colors.textMuted, 0.05),
    gridStroke: paint(Colors.textMuted, 1, 1.6 * px),
    selectedFill: paint(Colors.accent, 0.12),
    selectedHalo: paint(Colors.accent, 0.3, 7 * px),
    selectedStroke: paint(Colors.accent, 1, 3.2 * px),
    city: paint(Colors.textMuted),
    capital: paint(Colors.textSecondary),
    label: paint(Colors.textSecondary),
    selectedLabel: paint(Colors.accent),
    // Wide enough to clear the glyph edges at the label sizes used here.
    halo: paint(Colors.globeWater, 1, 3),
    crosshair: paint(Colors.accent, 1, 1.6),
    crosshairDot: paint(Colors.accent),
    cityFont: font(SANS, FontSize.xs, "500"),
    cellFont: font(MONO, FontSize.xs, "500"),
    selectedFont: font(MONO, FontSize.sm, "600"),
  };
}

interface Props {
  engine: SharedValue<GlobeEngine>;
  // The first finger down, so the picker can retire its gesture hint.
  onFirstTouch: () => void;
  // The cell under the crosshair, for the screen reader, and the precision
  // step its adjustable action takes.
  accessibilityLabel: string;
  accessibilityValue: string;
  accessibilityHint: string;
  onAdjust: (delta: number) => void;
}

// The screen reader's view of the globe: one adjustable element whose value
// is the selected cell. Its props change with every cell, so the canvas and
// its gesture sit in a child that does not re-render with them.
export function GlobeView({
  engine,
  onFirstTouch,
  accessibilityLabel,
  accessibilityValue,
  accessibilityHint,
  onAdjust,
}: Props) {
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "increment") onAdjust(1);
    else if (e.nativeEvent.actionName === "decrement") onAdjust(-1);
  };
  return (
    <View
      style={StyleSheet.absoluteFill}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: accessibilityValue }}
      accessibilityHint={accessibilityHint}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAccessibilityAction}
    >
      <GlobeCanvas engine={engine} onFirstTouch={onFirstTouch} />
    </View>
  );
}

const GlobeCanvas = React.memo(function GlobeCanvas({
  engine,
  onFirstTouch,
}: Pick<Props, "engine" | "onFirstTouch">) {
  const Colors = useThemeColors();
  const ink = useMemo(() => makeInk(Colors), [Colors]);
  const recorder = useMemo(() => Skia.PictureRecorder(), []);
  // Decoded on first open and kept for the life of the process.
  const world = useMemo(() => worldData(), []);
  const touch = useSharedValue(makeTouch());

  const picture = useDerivedValue(() => {
    const g = engine.value;
    return renderGlobe(
      recorder,
      world,
      {
        camera: g.camera,
        detail: frameDetail(g),
        width: g.width,
        height: g.height,
      },
      ink,
    );
  });

  // Raw touches, read the way bitchat's touch surface reads them. Nothing in
  // the picker competes for them, so the gesture is never activated; a manual
  // gesture does not end on its own either, so it is ended once the last
  // finger is off.
  const gesture = useManualGesture({
    onTouchesDown: (e) => {
      "worklet";
      if (touchesDown(engine, touch, e)) scheduleOnRN(onFirstTouch);
    },
    onTouchesMove: (e) => {
      "worklet";
      if (touchesMove(engine, touch, e) !== null) scheduleOnRN(stepped);
    },
    onTouchesUp: (e) => {
      "worklet";
      touchesUp(engine, touch, e, false);
      if (e.numberOfTouches === 0) GestureStateManager.deactivate(e.handlerTag);
    },
    onTouchesCancel: (e) => {
      "worklet";
      touchesUp(engine, touch, e, true);
      GestureStateManager.deactivate(e.handlerTag);
    },
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    scheduleOnUI(layout, engine, width, height);
  };

  return (
    <GestureDetector gesture={gesture}>
      {/* The default TextureView backing on Android: a SurfaceView is a
          frame faster but sits outside the view tree, so it would not slide
          in with the modal. */}
      <Canvas style={StyleSheet.absoluteFill} onLayout={onLayout}>
        <Picture picture={picture} />
      </Canvas>
    </GestureDetector>
  );
});
