// The teleported-cell channel key. It matches bitchat's key for the same cell,
// so a round trip that loses or mangles the geohash puts the two apps in
// different rooms.

import {
  geohashChannel,
  isManualGeoChannel,
  manualGeohashOf,
} from "../channel-key";

describe("teleported cell channels", () => {
  it("recognises a teleported cell, and not a named location channel", () => {
    expect(isManualGeoChannel("geohash:tdr1k")).toBe(true);
    expect(isManualGeoChannel("#city")).toBe(false);
  });

  it("round-trips a geohash through the channel key", () => {
    const channel = geohashChannel("tdr1k");
    expect(channel).toBe("geohash:tdr1k");
    expect(manualGeohashOf(channel)).toBe("tdr1k");
  });

  it("returns null geohash for a non-manual channel", () => {
    expect(manualGeohashOf("#city")).toBeNull();
    expect(manualGeohashOf("group:abcd")).toBeNull();
  });
});
