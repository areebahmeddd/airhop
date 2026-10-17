/**
 * @jest-environment node
 */
import { confirmDeviceOwner, isDeviceAuthInFlight } from "../device-auth";

const mockLevel = jest.fn();
const mockAuthenticate = jest.fn();
jest.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: () => mockLevel(),
  authenticateAsync: (options: unknown) => mockAuthenticate(options),
}));

const PARAMS = { prompt: "prompt", cancelLabel: "cancel" };

beforeEach(() => {
  mockLevel.mockReset();
  mockAuthenticate.mockReset();
});

describe("confirmDeviceOwner", () => {
  test("no screen lock at all is no-lock, without a prompt", async () => {
    mockLevel.mockResolvedValue(0);
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("no-lock");
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  test("a passed prompt, with the passcode allowed as a fallback", async () => {
    mockLevel.mockResolvedValue(3);
    mockAuthenticate.mockResolvedValue({ success: true });
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("passed");
    expect(mockAuthenticate).toHaveBeenCalledWith({
      promptMessage: "prompt",
      cancelLabel: "cancel",
      disableDeviceFallback: false,
    });
  });

  test("a cancelled or locked-out prompt is refused", async () => {
    mockLevel.mockResolvedValue(1);
    mockAuthenticate.mockResolvedValue({
      success: false,
      error: "user_cancel",
    });
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("refused");
    mockAuthenticate.mockResolvedValue({ success: false, error: "lockout" });
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("refused");
  });

  test("an OS that reports no passcode after all is no-lock", async () => {
    mockLevel.mockResolvedValue(1);
    mockAuthenticate.mockResolvedValue({
      success: false,
      error: "passcode_not_set",
    });
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("no-lock");
  });

  test("a throw from the OS is refused, never a pass", async () => {
    mockLevel.mockRejectedValue(new Error("boom"));
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("refused");
    mockLevel.mockResolvedValue(3);
    mockAuthenticate.mockRejectedValue(new Error("boom"));
    await expect(confirmDeviceOwner(PARAMS)).resolves.toBe("refused");
  });

  // The app lock reads this so an Android prompt pausing the activity is not
  // taken for the user leaving the app.
  test("reports a prompt as in flight only while it is on screen", async () => {
    mockLevel.mockResolvedValue(3);
    let answer: (value: { success: boolean }) => void = () => undefined;
    mockAuthenticate.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const pending = confirmDeviceOwner(PARAMS);
    await Promise.resolve();
    await Promise.resolve();
    expect(isDeviceAuthInFlight()).toBe(true);
    answer({ success: true });
    await pending;
    expect(isDeviceAuthInFlight()).toBe(false);
  });

  test("clears the flag when the prompt throws", async () => {
    mockLevel.mockResolvedValue(3);
    mockAuthenticate.mockRejectedValue(new Error("boom"));
    await confirmDeviceOwner(PARAMS);
    expect(isDeviceAuthInFlight()).toBe(false);
  });
});
