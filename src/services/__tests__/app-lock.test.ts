// The app lock's whole contract, driven without a real prompt: locked from a
// cold start, locked again on leaving, opened only by the phone's own screen
// lock, never by a prompt answered for an earlier lock, and inert while off.

type Listener = (state: string) => void;
const mockAppStateSubs = new Set<Listener>();
jest.mock("react-native", () => ({
  Platform: {
    OS: "android",
    select: (options: Record<string, unknown>) =>
      options.android ?? options.default,
  },
  AppState: {
    currentState: "active",
    addEventListener: (_: string, fn: Listener) => {
      mockAppStateSubs.add(fn);
      return { remove: () => mockAppStateSubs.delete(fn) };
    },
  },
}));

const mockConfirm = jest.fn();
let mockInFlight = false;
jest.mock("@platform/device-auth", () => ({
  confirmDeviceOwner: (params: unknown) => mockConfirm(params),
  isDeviceAuthInFlight: () => mockInFlight,
}));

import { useAppLockStore } from "@store/app-lock-store";
import { useSettingsStore } from "@store/settings-store";
import {
  awayMs,
  disableAppLock,
  enableAppLock,
  noteBackground,
  noteForeground,
  promptIfDue,
  requestUnlock,
  watchAppLock,
} from "../app-lock";

const at = (seconds: number) => ({
  wallMs: 1_000_000 + seconds * 1000,
  monoMs: 5_000 + seconds * 1000,
});

function phase() {
  return useAppLockStore.getState().phase;
}

function setLock(enabled: boolean, delay: 0 | 60 | 300 | 1800 = 0): void {
  useSettingsStore.setState({
    appLockEnabled: enabled,
    appLockDelaySeconds: delay,
  });
}

beforeEach(() => {
  mockConfirm.mockReset();
  mockInFlight = false;
  setLock(false);
  useAppLockStore.setState({
    phase: "open",
    generation: 1,
    promptedGeneration: 0,
    authenticating: false,
    coveredAt: null,
  });
});

describe("while off", () => {
  it("never covers, locks or asks", async () => {
    noteBackground(at(0));
    expect(phase()).toBe("open");
    noteForeground(at(3600));
    expect(phase()).toBe("open");
    promptIfDue();
    await requestUnlock();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe("locking", () => {
  it("locks on leaving at once when the delay is immediate", () => {
    setLock(true, 0);
    noteBackground(at(0));
    expect(phase()).toBe("locked");
  });

  it("covers on leaving, then opens a return inside the delay", () => {
    setLock(true, 60);
    noteBackground(at(0));
    expect(phase()).toBe("covered");
    noteForeground(at(59));
    expect(phase()).toBe("open");
  });

  it("asks on a return at or past the delay", () => {
    setLock(true, 60);
    noteBackground(at(0));
    noteForeground(at(60));
    expect(phase()).toBe("locked");
  });

  it("does not read a system prompt pausing the app as leaving", () => {
    setLock(true, 0);
    mockInFlight = true;
    noteBackground(at(0));
    expect(phase()).toBe("open");
  });

  it("stands down the moment it is turned off", () => {
    const stop = watchAppLock();
    setLock(true, 0);
    noteBackground(at(0));
    expect(phase()).toBe("locked");
    disableAppLock();
    expect(phase()).toBe("open");
    stop();
  });

  // The prompt itself takes the app away: "inactive" on iOS, a pause read as
  // "background" on Android. Neither may re-arm the lock it is answering, or a
  // dismissed prompt would be asked again forever.
  it("does not re-arm on the system prompt's own comings and goings", async () => {
    const stop = watchAppLock();
    setLock(true, 0);
    const emit = (state: string) => {
      for (const fn of mockAppStateSubs) fn(state);
    };
    emit("background");
    emit("active");
    const { generation } = useAppLockStore.getState();

    // iOS: Face ID dismissed.
    emit("inactive");
    emit("active");
    // Android: the prompt paused the activity while it was up.
    mockInFlight = true;
    emit("background");
    mockInFlight = false;
    emit("active");

    expect(useAppLockStore.getState().generation).toBe(generation);
    stop();
  });

  it("follows the app in and out of the background", () => {
    const stop = watchAppLock();
    setLock(true, 0);
    for (const fn of mockAppStateSubs) fn("inactive");
    expect(phase()).toBe("open");
    for (const fn of mockAppStateSubs) fn("background");
    expect(phase()).toBe("locked");
    stop();
    expect(mockAppStateSubs.size).toBe(0);
  });
});

describe("time away", () => {
  it("counts the larger clock, so sleep and a wound-back clock both count", () => {
    // The monotonic clock stalled while the phone slept; wall time did not.
    expect(
      awayMs({ wallMs: 0, monoMs: 0 }, { wallMs: 600_000, monoMs: 1_000 }),
    ).toBe(600_000);
    // Wall time wound back in Settings: the delay is taken as passed.
    expect(
      awayMs({ wallMs: 600_000, monoMs: 0 }, { wallMs: 0, monoMs: 1_000 }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("asks when the clock was wound back to dodge the delay", () => {
    setLock(true, 1800);
    noteBackground({ wallMs: 10_000_000, monoMs: 5_000 });
    noteForeground({ wallMs: 9_000_000, monoMs: 6_000 });
    expect(phase()).toBe("locked");
  });
});

describe("unlocking", () => {
  beforeEach(() => {
    setLock(true, 0);
    noteBackground(at(0));
  });

  it("opens only on a passed prompt", async () => {
    mockConfirm.mockResolvedValueOnce("refused");
    await requestUnlock();
    expect(phase()).toBe("locked");
    mockConfirm.mockResolvedValueOnce("passed");
    await requestUnlock();
    expect(phase()).toBe("open");
  });

  it("ignores a prompt answered for a lock that has since been replaced", async () => {
    let answer: (r: string) => void = () => undefined;
    mockConfirm.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const pending = requestUnlock();
    // However the lock was re-armed meanwhile, the answer belongs to the old
    // one. Forced here: a live prompt holds `authenticating`.
    useAppLockStore.setState({ authenticating: false });
    noteForeground(at(1));
    answer("passed");
    await pending;
    expect(phase()).toBe("locked");
  });

  it("opens and turns itself off when the screen lock was removed", async () => {
    mockConfirm.mockResolvedValueOnce("no-lock");
    await requestUnlock();
    expect(phase()).toBe("open");
    expect(useSettingsStore.getState().appLockEnabled).toBe(false);
  });

  it("asks once per lock on its own, and again on each return", async () => {
    mockConfirm.mockResolvedValue("refused");
    promptIfDue();
    await Promise.resolve();
    promptIfDue();
    await Promise.resolve();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    noteForeground(at(5));
    promptIfDue();
    expect(mockConfirm).toHaveBeenCalledTimes(2);
  });

  it("never asks twice at once", () => {
    mockConfirm.mockReturnValue(new Promise(() => undefined));
    void requestUnlock();
    void requestUnlock();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("turning it on", () => {
  it("arms only after the screen lock answers", async () => {
    mockConfirm.mockResolvedValueOnce("passed");
    await expect(enableAppLock()).resolves.toBe("enabled");
    expect(useSettingsStore.getState().appLockEnabled).toBe(true);
  });

  it("refuses without a screen lock, and on a dismissed prompt", async () => {
    mockConfirm.mockResolvedValueOnce("no-lock");
    await expect(enableAppLock()).resolves.toBe("no-lock");
    mockConfirm.mockResolvedValueOnce("refused");
    await expect(enableAppLock()).resolves.toBe("refused");
    expect(useSettingsStore.getState().appLockEnabled).toBe(false);
  });
});
