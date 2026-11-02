// A screen reader's double tap and named actions, wired the way each platform
// delivers them.
//
// They differ under the New Architecture, and neither API covers both:
// - iOS sends a double tap to `onAccessibilityTap` only, never to
//   `onAccessibilityAction("activate")`, and lists every `accessibilityActions`
//   entry in the rotor under its label (or its bare name when it has none), so
//   an "activate" entry there would read as an untranslated word.
// - Android routes a double tap to `onAccessibilityAction("activate")` once
//   "activate" is declared, and never calls `onAccessibilityTap`.
// "longpress" is the one shared name: Android maps it to a long click, and iOS
// lists it as a named action like any other.

import type {
  AccessibilityActionEvent,
  AccessibilityActionInfo,
} from "react-native";

export interface ScreenReaderAction {
  // Unique among the actions on one view. "longpress" maps to Android's long
  // click; any other name is a custom action.
  name: string;
  // Spoken, so translated.
  label: string;
  run: () => void;
}

interface ScreenReaderProps {
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  onAccessibilityTap?: () => void;
}

// For a view whose double tap is its only action: declare this, and hand the
// same handler to both `onAccessibilityTap` (iOS) and an
// `onAccessibilityAction` that runs it for "activate" (Android). Each platform
// ignores the other's prop, so neither handler needs a platform test. Inline
// props rather than a `screenReaderActions` spread, which the React Compiler
// lint refuses when the handler reads a ref.
export function activateOnly(
  platform: string,
): AccessibilityActionInfo[] | undefined {
  return platform === "ios" ? undefined : [{ name: "activate" }];
}

export function screenReaderActions(
  onActivate: (() => void) | undefined,
  actions: readonly ScreenReaderAction[],
  platform: string,
): ScreenReaderProps {
  const ios = platform === "ios";
  const declared: AccessibilityActionInfo[] = actions.map(
    ({ name, label }) => ({ name, label }),
  );
  if (!ios && onActivate !== undefined) declared.unshift({ name: "activate" });
  const props: ScreenReaderProps = {};
  if (ios && onActivate !== undefined) props.onAccessibilityTap = onActivate;
  if (declared.length > 0) {
    props.accessibilityActions = declared;
    props.onAccessibilityAction = (event) => {
      const name = event.nativeEvent.actionName;
      if (name === "activate" && !ios) {
        onActivate?.();
        return;
      }
      actions.find((action) => action.name === name)?.run();
    };
  }
  return props;
}
