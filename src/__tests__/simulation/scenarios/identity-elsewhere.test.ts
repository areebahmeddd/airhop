/**
 * @jest-environment node
 */
// One identity on two phones: the state a device transfer exists to prevent,
// and the safety net for when it happens anyway (the person kept using the old
// phone after the new one had everything). Two phones built from the same seed
// are exactly that: same keys, same peer ID, both announcing.
//
// Each case pins both halves of the warning: that it rises for a real second
// phone, and that it never rises for the echoes a phone hears of itself, which
// every phone in a mesh hears constantly.

jest.mock("expo-location", () => ({}));
jest.mock("react-native/Libraries/EventEmitter/RCTDeviceEventEmitter", () =>
  (
    require("../harness/event-router") as { routerModule: () => unknown }
  ).routerModule(),
);
jest.mock("@bridge/NativeAirhopBLE", () => {
  const shim = require("../../harness/bridge-shim") as {
    bleBridge: unknown;
  };
  return { __esModule: true, default: shim.bleBridge };
});
jest.mock("@bridge/NativeAirhopWiFi", () => {
  const shim = require("../../harness/bridge-shim") as {
    wifiBridge: unknown;
  };
  return { __esModule: true, default: shim.wifiBridge };
});

import { SimDevice, type DeviceSpec } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { advanceFor, Scenario, waitFor } from "../harness/scenario";

jest.setTimeout(180_000);

let scenario: Scenario | null = null;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  scenario?.close();
  scenario = null;
  jest.clearAllTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

const android = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
});

function room(s: Scenario, specs: DeviceSpec[]): SimDevice[] {
  const radio = new RadioFabric(s.world);
  const devices = specs.map((spec) => SimDevice.create(s.world, spec));
  for (const d of devices) radio.add(d);
  s.track(...devices);
  return devices;
}

const warned = (d: SimDevice): boolean =>
  d.meshState().identityElsewhere === true;

// Long enough for several announce rounds, isolated and connected alike.
const SETTLE_MS = 90_000;

test("I01 two phones on one identity both warn, and a bystander does not", async () => {
  const s = (scenario = new Scenario({
    id: "I01",
    title: "one identity running on two phones",
  }));
  const [oldPhone, newPhone, bystander] = room(s, [
    android("old", 41),
    android("new", 41),
    android("bob", 42),
  ]);
  s.check("the twins share a peer ID", oldPhone.peerID === newPhone.peerID);
  for (const d of [oldPhone, newPhone, bystander]) d.launch();

  const both = await waitFor(
    s.world,
    () => warned(oldPhone) && warned(newPhone),
    SETTLE_MS,
  );
  s.check("both phones say the identity is on another phone", both);
  s.check(
    "a third phone on the mesh is not warned about anything",
    !warned(bystander),
  );
  s.expectNone("process health", noCrashes([oldPhone, newPhone, bystander]));
  s.assert();
});

test("I02 a phone hearing echoes of itself, before and after a relaunch, never warns", async () => {
  const s = (scenario = new Scenario({
    id: "I02",
    title: "echoes of our own announces are not another phone",
  }));
  const [alice, bob, carol] = room(s, [
    android("alice", 51),
    android("bob", 52),
    android("carol", 53),
  ]);
  for (const d of [alice, bob, carol]) d.launch();
  await advanceFor(s.world, SETTLE_MS);
  s.check(
    "no warning while two neighbours relay our announces",
    !warned(alice),
  );

  // The previous run's announces are still circulating when the new one starts.
  alice.relaunch();
  await advanceFor(s.world, SETTLE_MS);
  s.check("no warning after a relaunch", !warned(alice));
  s.expectNone("process health", noCrashes([alice, bob, carol]));
  s.assert();
});

test("I03 the warning comes down once the other phone is gone", async () => {
  const s = (scenario = new Scenario({
    id: "I03",
    title: "the other phone is erased or switched off",
  }));
  const [kept, other, bob] = room(s, [
    android("kept", 61),
    android("other", 61),
    android("bob", 62),
  ]);
  for (const d of [kept, other, bob]) d.launch();
  const rose = await waitFor(s.world, () => warned(kept), SETTLE_MS);
  s.check("the warning rises while both run", rose);

  other.kill();
  const fell = await waitFor(s.world, () => !warned(kept), 8 * 60_000, 500, 50);
  s.check("and falls once the other phone has been quiet a while", fell);
  s.expectNone("process health", noCrashes([kept, other, bob]));
  s.assert();
});
