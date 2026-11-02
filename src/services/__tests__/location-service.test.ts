// A pin is only offered for a fix precise enough to point at the right place,
// and no position outlives the permission it was read under.

import {
  clearLocationCache,
  getCoarseLocation,
  getFreshLocation,
  getPinLocation,
} from "../location-service";

type Fix = {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
} | null;

const mockLocation = {
  status: "granted",
  lastKnown: null as Fix,
  current: null as Fix,
  // The maxAge the last call to getLastKnownPositionAsync asked for.
  lastMaxAge: undefined as number | undefined,
  lastKnownCalls: 0,
};

jest.mock("expo-location", () => ({
  PermissionStatus: { GRANTED: "granted" },
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: () =>
    Promise.resolve({ status: mockLocation.status }),
  getLastKnownPositionAsync: (options?: { maxAge?: number }) => {
    mockLocation.lastMaxAge = options?.maxAge;
    mockLocation.lastKnownCalls += 1;
    return Promise.resolve(mockLocation.lastKnown);
  },
  getCurrentPositionAsync: () => Promise.resolve(mockLocation.current),
}));

function fix(accuracy: number | null): Fix {
  return { coords: { latitude: 1, longitude: 2, accuracy }, timestamp: 5 };
}

describe("getPinLocation", () => {
  it("returns a precise fix", async () => {
    mockLocation.lastKnown = fix(30);
    expect(await getPinLocation()).toEqual({
      lat: 1,
      lng: 2,
      accuracyM: 30,
      takenAtMs: 5,
    });
  });

  it("tries a live fix when the cached one is too coarse", async () => {
    mockLocation.lastKnown = fix(12_000);
    mockLocation.current = fix(80);
    expect((await getPinLocation())?.accuracyM).toBe(80);
  });

  it("refuses when no fix is precise enough", async () => {
    mockLocation.lastKnown = fix(12_000);
    mockLocation.current = fix(9_000);
    expect(await getPinLocation()).toBeNull();
  });
});

// "Here" for a received pin's distance: never the any-age, any-accuracy fix
// the location channels make do with.
describe("getFreshLocation", () => {
  beforeEach(() => {
    mockLocation.status = "granted";
    mockLocation.lastKnownCalls = 0;
    clearLocationCache();
  });

  it("asks the OS for a recent fix only", async () => {
    mockLocation.lastKnown = {
      coords: { latitude: 1, longitude: 2, accuracy: 30 },
      timestamp: Date.now(),
    };
    expect(await getFreshLocation()).toMatchObject({ lat: 1, lng: 2 });
    expect(mockLocation.lastMaxAge).toBe(60_000);
  });

  it("has no fix rather than a coarse one", async () => {
    mockLocation.lastKnown = fix(12_000);
    mockLocation.current = fix(9_000);
    expect(await getFreshLocation()).toBeNull();
  });

  it("shares a recent fix across callers", async () => {
    mockLocation.lastKnown = {
      coords: { latitude: 1, longitude: 2, accuracy: 30 },
      timestamp: Date.now(),
    };
    await Promise.all([getFreshLocation(), getFreshLocation()]);
    await getFreshLocation();
    expect(mockLocation.lastKnownCalls).toBe(1);
  });

  it("stops serving its fix once the permission is revoked", async () => {
    mockLocation.lastKnown = {
      coords: { latitude: 1, longitude: 2, accuracy: 30 },
      timestamp: Date.now(),
    };
    await getFreshLocation();
    mockLocation.status = "denied";
    expect(await getFreshLocation()).toBeNull();
  });
});

describe("getCoarseLocation", () => {
  beforeEach(() => {
    mockLocation.status = "granted";
  });

  it("stops serving its cached fix once the permission is revoked", async () => {
    // iOS keeps the process alive across a revoke in Settings, so the next
    // channel refresh lands inside the cache window.
    mockLocation.lastKnown = fix(30);
    expect(await getCoarseLocation()).toEqual({ lat: 1, lng: 2 });

    mockLocation.status = "denied";
    expect(await getCoarseLocation()).toBeNull();
  });

  it("does not bring the old fix back after a fresh grant", async () => {
    mockLocation.lastKnown = fix(30);
    await getCoarseLocation();
    mockLocation.status = "denied";
    await getCoarseLocation();

    mockLocation.status = "granted";
    mockLocation.lastKnown = null;
    mockLocation.current = null;
    expect(await getCoarseLocation()).toBeNull();
  });
});
