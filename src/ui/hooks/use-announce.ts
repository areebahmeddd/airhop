// Speaks a status change to VoiceOver, the iOS half of a live region.
//
// `accessibilityLiveRegion` is Android only, so a state that changes with no
// navigation (a failure replacing a spinner, Bluetooth going off, a transfer
// moving on) reaches TalkBack and leaves VoiceOver silent. Each site keeps its
// live region for Android and calls this beside it; announcing on Android too
// would make TalkBack say everything twice.
//
// Contract: on iOS, `message` is announced each time `trigger` (the message
// itself unless given) changes after the first render and the message is
// non-empty. The value at mount is never spoken, as a live region says nothing
// about the content it appears with. Pass a `trigger` when the text moves more
// often than its meaning, such as a percentage, so a phase is announced once
// rather than at every step. A trigger that changes while the message is empty
// still counts as seen, so a caller holding its message back (a modal not yet
// open) keeps the value it reappears with from being spoken. Join separate
// sentences with a line break: VoiceOver pauses on it rather than running
// them together.

import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform } from "react-native";

interface AnnounceOptions {
  // What decides that something new happened. Defaults to the message.
  trigger?: unknown;
  // Interrupts whatever VoiceOver is reading, like an "assertive" live region.
  // Otherwise the announcement waits its turn ("polite").
  assertive?: boolean;
}

export function useAnnounce(
  message: string | null | undefined,
  options: AnnounceOptions = {},
): void {
  const trigger = "trigger" in options ? options.trigger : message;
  const assertive = options.assertive === true;
  // The last trigger seen, starting from the one at mount so the first render
  // says nothing. A comparison rather than a "mounted" flag, which a remounted
  // effect would get past with the mount value still showing.
  const previous = useRef(trigger);

  useEffect(() => {
    if (Object.is(previous.current, trigger)) return;
    previous.current = trigger;
    if (Platform.OS !== "ios") return;
    if (message === null || message === undefined || message === "") return;
    AccessibilityInfo.announceForAccessibilityWithOptions(message, {
      queue: !assertive,
    });
  }, [trigger, message, assertive]);
}
