// The pixel bird's easter egg: three quick taps and it flaps twice with a small
// hop (a nod to "airhop"). Shared so every bird answers the same way. Local
// delight only; nothing persists.

import { useEffect, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import { useReducedMotion } from "./use-reduced-motion";

const TAPS = 3;
// Longest pause between taps that still counts toward the three.
const TAP_GAP_MS = 450;
// A wing frame holds this long. At 110 the beat read as a slideshow; 80 is
// fast enough to look like one motion and still let each frame register.
const FLAP_MS = 80;
// Downstroke, glide, downstroke. Settling back on the glide is the final
// timer's job, so the bird unlocks the moment the wings are back up rather
// than holding a dead frame.
const BEATS = [1, 0, 1];

export function useBirdFlap(hopHeight: number): {
  frame: number;
  hop: Animated.Value;
  onTap: () => void;
} {
  const reduceMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);
  const [hop] = useState(() => new Animated.Value(0));
  const flapping = useRef(false);
  const taps = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      beatTimers.current.forEach(clearTimeout);
      hop.stopAnimation();
    };
  }, [hop]);

  function flap(): void {
    if (flapping.current) return;
    flapping.current = true;
    BEATS.forEach((beat, i) => {
      beatTimers.current.push(setTimeout(() => setFrame(beat), i * FLAP_MS));
    });
    beatTimers.current.push(
      setTimeout(() => {
        setFrame(0);
        flapping.current = false;
        beatTimers.current = [];
      }, BEATS.length * FLAP_MS),
    );
    // The wing beats stay under reduce-motion; only the travel goes.
    if (reduceMotion) return;
    // The lift rides the two downstrokes and springs back as the wings come
    // up, so the hop and the flap finish together.
    Animated.sequence([
      Animated.timing(hop, {
        toValue: -hopHeight,
        duration: BEATS.length * FLAP_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(hop, {
        toValue: 0,
        friction: 5,
        tension: 120,
        useNativeDriver: true,
      }),
    ]).start();
  }

  function onTap(): void {
    if (tapTimer.current) clearTimeout(tapTimer.current);
    taps.current += 1;
    if (taps.current >= TAPS) {
      taps.current = 0;
      flap();
      return;
    }
    tapTimer.current = setTimeout(() => {
      taps.current = 0;
    }, TAP_GAP_MS);
  }

  return { frame, hop, onTap };
}
