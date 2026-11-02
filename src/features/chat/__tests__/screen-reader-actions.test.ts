// A screen reader's double tap and named actions reach their handlers on both
// platforms, which deliver them through different props.

import type { AccessibilityActionEvent } from "react-native";
import { activateOnly, screenReaderActions } from "../screen-reader-actions";

function fire(
  props: ReturnType<typeof screenReaderActions>,
  actionName: string,
): void {
  props.onAccessibilityAction?.({
    nativeEvent: { actionName },
  } as AccessibilityActionEvent);
}

describe("screenReaderActions", () => {
  it("routes a double tap through onAccessibilityTap on iOS", () => {
    const activate = jest.fn();
    const props = screenReaderActions(activate, [], "ios");
    expect(props.accessibilityActions).toBeUndefined();
    props.onAccessibilityTap?.();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("routes a double tap through the activate action on Android", () => {
    const activate = jest.fn();
    const props = screenReaderActions(activate, [], "android");
    expect(props.onAccessibilityTap).toBeUndefined();
    expect(props.accessibilityActions).toEqual([{ name: "activate" }]);
    fire(props, "activate");
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("never lists activate on iOS, where the rotor would read its name", () => {
    const run = jest.fn();
    const props = screenReaderActions(
      jest.fn(),
      [{ name: "longpress", label: "More options", run }],
      "ios",
    );
    expect(props.accessibilityActions).toEqual([
      { name: "longpress", label: "More options" },
    ]);
    fire(props, "activate");
    fire(props, "longpress");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs each named action by its name on both platforms", () => {
    for (const platform of ["ios", "android"]) {
      const play = jest.fn();
      const link = jest.fn();
      const props = screenReaderActions(
        undefined,
        [
          { name: "media", label: "Play voice note", run: play },
          { name: "link0", label: "Open example.com", run: link },
        ],
        platform,
      );
      fire(props, "link0");
      expect(link).toHaveBeenCalledTimes(1);
      expect(play).not.toHaveBeenCalled();
    }
  });

  it("declares nothing for a view with nothing to do", () => {
    expect(screenReaderActions(undefined, [], "android")).toEqual({});
    expect(screenReaderActions(undefined, [], "ios")).toEqual({});
  });
});

describe("activateOnly", () => {
  it("declares activate on Android only", () => {
    expect(activateOnly("android")).toEqual([{ name: "activate" }]);
    expect(activateOnly("ios")).toBeUndefined();
  });
});
