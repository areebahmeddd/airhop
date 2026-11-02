// Cells a real bitchat-ios build displayed, pinning that our geohash encoder
// agrees with theirs on the actual characters. That
// each channel maps to the same character count is a service table, pinned in
// geohash-channels.test.ts.
//
// Only coarse precisions assert exact strings: their cells are large enough
// (about 1250 km and 39 km) that central Bengaluru lands in the same ones, so the
// vector is stable without a handset's exact GPS fix.

import { encodeGeohash } from "../geohash-presence";

// The center of Bengaluru.
const BLR_LAT = 12.9716;
const BLR_LNG = 77.5946;

describe("geohash interop with bitchat", () => {
  it("encodes the same cells bitchat resolved for Bengaluru", () => {
    expect(encodeGeohash(BLR_LAT, BLR_LNG, 2)).toBe("td");
    expect(encodeGeohash(BLR_LAT, BLR_LNG, 4)).toBe("tdr1");
  });

  it("puts a different continent in a different region cell", () => {
    // The Android emulator defaults to Mountain View, which is why an emulator
    // and a handset in India never share a location channel.
    expect(encodeGeohash(37.422, -122.0841, 2)).toBe("9q");
    expect(encodeGeohash(37.422, -122.0841, 2)).not.toBe(
      encodeGeohash(BLR_LAT, BLR_LNG, 2),
    );
  });
});
