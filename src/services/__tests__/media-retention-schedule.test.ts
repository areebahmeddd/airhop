/**
 * @jest-environment node
 */
// When the retention sweep runs. What it deletes is media-retention.test.ts;
// this pins that a process kept alive for weeks still enforces the window,
// without listing the cache directory on every app switch.

const mockSweep = jest.fn<number, [number, number]>(() => 0);
let mockDays = 7;

jest.mock("../file-transfer-service", () => ({
  sweepExpiredAttachments: (now: number, maxAgeMs: number) =>
    mockSweep(now, maxAgeMs),
}));

jest.mock("@store/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({ mediaRetentionDays: mockDays }),
  },
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

// Fresh module state per case: the throttle is module scope, like a process.
function load(): typeof import("../media-retention") {
  let mod!: typeof import("../media-retention");
  jest.isolateModules(() => {
    mod = jest.requireActual("../media-retention");
  });
  return mod;
}

beforeEach(() => {
  mockSweep.mockClear();
  mockSweep.mockImplementation(() => 0);
  mockDays = 7;
});

describe("sweepMediaIfDue", () => {
  test("the first call in a process always sweeps, with the chosen window", () => {
    const { sweepMediaIfDue } = load();
    mockDays = 14;

    expect(sweepMediaIfDue(T0)).toBe(true);

    expect(mockSweep).toHaveBeenCalledWith(T0, 14 * DAY);
  });

  test("a return inside the interval does not sweep again", () => {
    const { sweepMediaIfDue, SWEEP_INTERVAL_MS } = load();
    sweepMediaIfDue(T0);

    expect(sweepMediaIfDue(T0 + HOUR)).toBe(false);
    expect(sweepMediaIfDue(T0 + SWEEP_INTERVAL_MS - 1)).toBe(false);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  test("a return past the interval sweeps, so a long-lived process keeps the window", () => {
    const { sweepMediaIfDue, SWEEP_INTERVAL_MS } = load();
    sweepMediaIfDue(T0);

    expect(sweepMediaIfDue(T0 + SWEEP_INTERVAL_MS)).toBe(true);
    expect(sweepMediaIfDue(T0 + 21 * DAY)).toBe(true);
    expect(mockSweep).toHaveBeenCalledTimes(3);
  });

  test("a clock that moved backwards counts as due", () => {
    const { sweepMediaIfDue } = load();
    sweepMediaIfDue(T0);

    expect(sweepMediaIfDue(T0 - DAY)).toBe(true);
  });

  test("an unreadable cache directory does not throw out of a resume", () => {
    const { sweepMediaIfDue } = load();
    mockSweep.mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    expect(() => sweepMediaIfDue(T0)).not.toThrow();
  });
});
