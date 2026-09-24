/**
 * @jest-environment node
 */
// Blocking over the internet path, across real phones and a real relay pool.
//
// On the mesh a block is one check at one chokepoint. Over Nostr the sender is
// a public key, and what ties that key to a person is a mapping the block
// itself tears down, so these pin that a block still holds once it is gone.
// Each case sends a control message first, so a pass cannot mean "nothing
// arrives over Nostr at all".

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
import { RelayFabric } from "../harness/relay-fabric";
import { Scenario, waitForCoarse } from "../harness/scenario";

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

const online = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
  internetEnabled: true,
});

// What the DM list's Block action does, in the order it does it.
function block(device: SimDevice, peerID: string): void {
  const call = (store: string, action: string, arg: string): void => {
    (
      device.store(store as Parameters<SimDevice["store"]>[0]).getState()[
        action
      ] as (a: string) => void
    )(arg);
  };
  call("blockedStore", "blockPeer", peerID);
  (device.mesh as unknown as { forgetPeer: (p: string) => void }).forgetPeer(
    peerID,
  );
  call("contactsStore", "removeContact", peerID);
  call("chatStore", "removeChannel", `dm:${peerID}`);
}

function heardAnywhere(device: SimDevice, text: string): boolean {
  return Object.values(device.allMessages())
    .flat()
    .some((m) => m.text === text);
}

test("B01 a blocked peer cannot switch to Nostr to get through", async () => {
  const s = (scenario = new Scenario({
    id: "B01",
    title: "a mesh block follows the peer onto Nostr",
    seed: 811,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();

  const met = await waitForCoarse(
    s.world,
    () =>
      alice.peers().includes(bob.peerID) &&
      bob.peers().includes(alice.peerID) &&
      relay.connectionCount("alice") > 0 &&
      relay.connectionCount("bob") > 0,
    30_000,
  );
  s.check("they met on the mesh and are both online", met);

  // Out of radio range, so anything that arrives came over Nostr.
  radio.setIsolated("bob", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"), 20_000);

  bob.sendDm(alice.peerID, "before the block");
  const control = await waitForCoarse(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("before the block"),
    30_000,
  );
  s.check("the control message arrives over Nostr", control);

  block(alice, bob.peerID);
  bob.sendDm(alice.peerID, "after the block");
  await s.world.advance(20_000);
  s.check(
    "nothing from the blocked peer lands anywhere",
    !heardAnywhere(alice, "after the block"),
  );
  const status = bob
    .messages(`dm:${alice.peerID}`)
    .find((m) => m.text === "after the block")?.status;
  s.check(
    "and no delivery receipt tells them it arrived",
    status !== "delivered" && status !== "read",
    `status=${String(status)}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("B02 a blocked Nostr-only thread stays blocked", async () => {
  const s = (scenario = new Scenario({
    id: "B02",
    title: "blocking a stranger who only ever wrote over Nostr",
    seed: 812,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const dave = SimDevice.create(s.world, online("dave", 44), relay);
  const cast = [alice, dave];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  // Never in radio range: dave knows alice only by her npub.
  radio.setTopology([]);
  for (const d of cast) d.launch();
  const connected = await waitForCoarse(
    s.world,
    () =>
      relay.connectionCount("alice") > 0 && relay.connectionCount("dave") > 0,
    30_000,
  );
  s.check("both are online", connected);

  const write = (id: string, text: string): void => {
    (
      dave.mesh as unknown as {
        publishNostrDm: (pub: string, id: string, text: string) => boolean;
      }
    ).publishNostrDm(alice.nostrPubkey, id, text);
  };
  const thread = `nostr_${dave.nostrPubkey}`;

  write("b02-control", "hello stranger");
  const control = await waitForCoarse(
    s.world,
    () => alice.texts(`dm:${thread}`).includes("hello stranger"),
    30_000,
  );
  s.check("the control message opens a Nostr-only thread", control);

  block(alice, thread);
  write("b02-blocked", "still here");
  await s.world.advance(20_000);
  s.check(
    "nothing from the blocked key lands anywhere",
    !heardAnywhere(alice, "still here"),
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});
