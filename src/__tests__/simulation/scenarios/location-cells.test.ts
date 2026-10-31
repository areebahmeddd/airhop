// Location levels over Bluetooth. #block names a different cell for every
// phone, so the radio copy of a location message carries the cell it was
// written in, and a phone standing in another cell drops it. A phone with no
// fix (often location denied on purpose) still uses the levels over Bluetooth:
// it sends with no cell, and shows everything.

jest.mock("expo-location", () =>
  (
    require("../harness/location-fabric") as { expoLocationMock: () => unknown }
  ).expoLocationMock(),
);
jest.mock("react-native/Libraries/EventEmitter/RCTDeviceEventEmitter", () =>
  (
    require("../harness/event-router") as { routerModule: () => unknown }
  ).routerModule(),
);
jest.mock("@bridge/NativeAirhopBLE", () => {
  const shim = require("../../harness/bridge-shim");
  return { __esModule: true, default: shim.bleBridge };
});
jest.mock("@bridge/NativeAirhopWiFi", () => {
  const shim = require("../../harness/bridge-shim");
  return { __esModule: true, default: shim.wifiBridge };
});

import { SimDevice, type DeviceSpec } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { locations, PLACES } from "../harness/location-fabric";
import { RadioFabric } from "../harness/radio-fabric";
import { RelayFabric } from "../harness/relay-fabric";
import { Scenario, waitForCoarse } from "../harness/scenario";

jest.setTimeout(120_000);

let scenario: Scenario | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  locations().reset();
});

afterEach(() => {
  scenario?.close();
  scenario = null;
  jest.clearAllTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

// Location channels exist only with the internet switched on, though no relay
// is reachable here: everything below travels over Bluetooth.
const phone = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
  internetEnabled: true,
});

test("L01 a #block message stays out of the next block, and a phone with no fix still sees and sends over Bluetooth", async () => {
  const s = (scenario = new Scenario({
    id: "L01",
    title: "location levels keep to their cell",
    seed: 95,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, phone("alice", 11), relay);
  const carol = SimDevice.create(s.world, phone("carol", 33), relay);
  const bob = SimDevice.create(s.world, phone("bob", 22), relay);
  const dave = SimDevice.create(s.world, phone("dave", 44), relay);
  const cast = [alice, carol, bob, dave];
  // In radio range of each other, but bob stands a kilometre north: the same
  // city, another block. Dave has no fix.
  locations().place(alice.id, PLACES.bengaluru);
  locations().place(carol.id, PLACES.bengaluru);
  locations().place(bob.id, PLACES.bengaluruNorth);
  locations().place(dave.id, null);
  for (const d of cast) {
    radio.add(d);
    relay.setOffline(d.id, true);
  }
  s.track(...cast);
  for (const d of cast) d.launch();

  const met = await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peers().length === cast.length - 1),
    60_000,
  );
  s.check("everyone met over Bluetooth", met, "precondition");
  for (const d of cast) {
    d.joinChannel("#block");
    d.joinChannel("#city");
  }
  const placed = await waitForCoarse(
    s.world,
    () => [alice, carol, bob].every((d) => d.channelGeohash("#block") !== null),
    60_000,
  );
  s.check("the placed phones resolved their block", placed, "precondition");
  s.check(
    "bob's block is not alice's, and his city is",
    bob.channelGeohash("#block") !== alice.channelGeohash("#block") &&
      bob.channelGeohash("#city") === alice.channelGeohash("#city"),
    "precondition",
  );

  alice.send("#block", "the gate on this street is open");
  alice.send("#city", "market closes at six");
  await waitForCoarse(
    s.world,
    () => carol.texts("#city").includes("market closes at six"),
    30_000,
  );
  await waitForCoarse(s.world, () => false, 5_000);

  s.check(
    "carol, in alice's block, sees the #block message",
    carol.texts("#block").includes("the gate on this street is open"),
  );
  s.check(
    "bob, in the next block, does not",
    !bob.texts("#block").includes("the gate on this street is open"),
  );
  s.check(
    "but bob shares her city and sees the #city one",
    bob.texts("#city").includes("market closes at six"),
  );
  s.check(
    "dave, with no fix, cannot tell and sees both",
    dave.texts("#block").includes("the gate on this street is open") &&
      dave.texts("#city").includes("market closes at six"),
  );

  // Dave names no cell, so nobody can place his message and everyone in
  // range shows it.
  dave.send("#block", "anyone near the station?");
  const reached = await waitForCoarse(
    s.world,
    () =>
      [alice, carol, bob].every((d) =>
        d.texts("#block").includes("anyone near the station?"),
      ),
    30_000,
  );
  s.check("dave's #block message reached every phone in range", reached);
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});
