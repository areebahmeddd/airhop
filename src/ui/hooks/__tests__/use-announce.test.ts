// VoiceOver's half of a live region: spoken on a change, never at mount, never
// twice for one change, and never on Android, where the live region speaks.

import { renderHook } from "@testing-library/react-native";
import { AccessibilityInfo, Platform } from "react-native";
import { useAnnounce } from "../use-announce";

let announce: jest.SpyInstance;

beforeEach(() => {
  jest.replaceProperty(Platform, "OS", "ios");
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => {});
  // The preset's AccessibilityInfo is already a mock, which spyOn reuses, so
  // its calls carry over between tests unless cleared.
  announce.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

type Props = {
  message: string | null;
  trigger?: unknown;
  assertive?: boolean;
};

function mount(initial: Props) {
  return renderHook(
    ({ message, ...options }: Props) => useAnnounce(message, options),
    { initialProps: initial },
  );
}

describe("useAnnounce", () => {
  it("says nothing about the value it mounts with", async () => {
    await mount({ message: "Bluetooth off" });
    expect(announce).not.toHaveBeenCalled();
  });

  it("speaks each new message once, politely", async () => {
    const hook = await mount({ message: null });
    await hook.rerender({ message: "Couldn’t create your keys" });
    await hook.rerender({ message: "Couldn’t create your keys" });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Couldn’t create your keys", {
      queue: true,
    });
  });

  it("says nothing when the message clears, and again when it returns", async () => {
    const hook = await mount({ message: null });
    await hook.rerender({ message: "Name taken" });
    await hook.rerender({ message: null });
    await hook.rerender({ message: "Name taken" });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("follows the trigger rather than the text when given one", async () => {
    const hook = await mount({ message: "Preparing", trigger: "preparing" });
    await hook.rerender({ message: "Receiving 0%", trigger: "receiving" });
    await hook.rerender({ message: "Receiving 40%", trigger: "receiving" });
    await hook.rerender({ message: "Receiving 80%", trigger: "receiving" });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Receiving 0%", { queue: true });
  });

  it("takes a trigger that moved while silent as already seen", async () => {
    // A modal holds its message back while shut: what it opens on is not news.
    const hook = await mount({ message: null, trigger: null });
    await hook.rerender({ message: null, trigger: "Waiting for camera" });
    await hook.rerender({
      message: "Waiting for camera",
      trigger: "Waiting for camera",
    });
    expect(announce).not.toHaveBeenCalled();
    await hook.rerender({ message: "Camera off", trigger: "Camera off" });
    expect(announce).toHaveBeenCalledWith("Camera off", { queue: true });
  });

  it("interrupts when asked to", async () => {
    const hook = await mount({ message: null, assertive: true });
    await hook.rerender({ message: "Transfer failed", assertive: true });
    expect(announce).toHaveBeenCalledWith("Transfer failed", { queue: false });
  });

  it("leaves Android to the live region", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const hook = await mount({ message: null });
    await hook.rerender({ message: "Bluetooth off" });
    expect(announce).not.toHaveBeenCalled();
  });
});
