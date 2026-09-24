/**
 * @jest-environment node
 */
// A pin is only offered for a fix precise enough to point at the right place.

import { getPinLocation } from "../location-service";

type Fix = {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
} | null;

const mockLocation = {
  lastKnown: null as Fix,
  current: null as Fix,
};

jest.mock("expo-location", () => ({
  PermissionStatus: { GRANTED: "granted" },
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: () => Promise.resolve({ status: "granted" }),
  getLastKnownPositionAsync: () => Promise.resolve(mockLocation.lastKnown),
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
