/**
 * @jest-environment node
 */
// Cross-implementation vectors captured from a real bitchat-ios build.
//
// On 2026-07-24 a bitchat handset in Kumaraswamy Layout, Bengaluru displayed
// its location channels as:
//
//   block         #tdr1kyp   (7 chars)
//   neighborhood  #tdr1ky    (6 chars)
//   city          #tdr1k     (5 chars)
//   province      #tdr1      (4 chars)
//   region        #td        (2 chars)
//
// Two things are pinned here. First, that our channel -> precision table maps
// to the same character counts bitchat uses, because a mismatch puts the two
// apps in different cells and they silently never meet. Second, that our
// geohash encoder agrees with theirs on the actual characters.
//
// Only precisions 2, 4 and 5 assert exact strings: those cells are large enough
// (about 1250 km, 39 km and 4.9 km) that any point in the neighbourhood lands
// in the same one, so the vector is stable without the handset's exact GPS fix.
// A 6 or 7 char cell is 1.2 km / 150 m wide, so asserting those would only be
// testing how well we guessed someone's street corner.

import { GEO_CHANNEL_PRECISION } from "@services/geohash-channel-service";
import type { Event } from "nostr-tools";
import { generateSecretKey } from "nostr-tools";
import {
  encodeGeohash,
  GeohashPresence,
  KIND_PRESENCE,
} from "../geohash-presence";
import type { NostrClient } from "../nostr-client";

// A point in Kumaraswamy Layout, Bengaluru.
const BLR_LAT = 12.9082;
const BLR_LNG = 77.5601;

describe("geohash interop with bitchat", () => {
  it("maps each channel to the precision bitchat uses", () => {
    // Character counts read directly off the bitchat screenshot.
    expect(GEO_CHANNEL_PRECISION["#block"]).toBe("tdr1kyp".length);
    expect(GEO_CHANNEL_PRECISION["#neighborhood"]).toBe("tdr1ky".length);
    expect(GEO_CHANNEL_PRECISION["#city"]).toBe("tdr1k".length);
    expect(GEO_CHANNEL_PRECISION["#province"]).toBe("tdr1".length);
    expect(GEO_CHANNEL_PRECISION["#region"]).toBe("td".length);
  });

  it("encodes the same cells bitchat resolved for Bengaluru", () => {
    expect(encodeGeohash(BLR_LAT, BLR_LNG, 2)).toBe("td");
    expect(encodeGeohash(BLR_LAT, BLR_LNG, 4)).toBe("tdr1");
    expect(encodeGeohash(BLR_LAT, BLR_LNG, 5)).toBe("tdr1k");
  });

  it("is a prefix hierarchy, so a finer cell sits inside its parent", () => {
    const region = encodeGeohash(BLR_LAT, BLR_LNG, 2);
    const province = encodeGeohash(BLR_LAT, BLR_LNG, 4);
    const city = encodeGeohash(BLR_LAT, BLR_LNG, 5);
    expect(province.startsWith(region)).toBe(true);
    expect(city.startsWith(province)).toBe(true);
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

// bitchat-ios reads presence from the cell's own relays and sends a heartbeat
// only when that list is non-empty (GeohashPresenceService). A heartbeat sent
// anywhere else is never counted, and tells the DM relays where the key is.
describe("presence heartbeat relays", () => {
  const CELL_RELAYS = ["wss://near-1.example", "wss://near-2.example"];

  function presenceWith(publish: jest.Mock): GeohashPresence {
    return new GeohashPresence({ nostrPrivKey: generateSecretKey() }, {
      publish,
    } as unknown as NostrClient);
  }

  it("publishes a kind 20001 heartbeat to the cell's relays only", async () => {
    const publish = jest.fn().mockResolvedValue({ relay: "", ok: true });
    await presenceWith(publish).publishHeartbeat("tdr1k", CELL_RELAYS);

    expect(publish).toHaveBeenCalledTimes(1);
    const [event, relays] = publish.mock.calls[0] as [Event, string[]];
    expect(event.kind).toBe(KIND_PRESENCE);
    expect(event.tags).toEqual([["g", "tdr1k"]]);
    expect(relays).toEqual(CELL_RELAYS);
  });

  it("skips the heartbeat when the cell has no relays", async () => {
    const publish = jest.fn().mockResolvedValue({ relay: "", ok: true });
    await presenceWith(publish).publishHeartbeat("tdr1k", []);
    expect(publish).not.toHaveBeenCalled();
  });
});
