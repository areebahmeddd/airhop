// Tier O: what a phone owes the relays while it cannot reach them.
//
// A relay outage, or Tor holding the pool down while it starts, must not lose
// what the user did meanwhile: a read receipt, a room post the radio already
// carried, a notice retraction. And a publish attempted during the outage must
// not cost the pool its view of the relay coming back.

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
  const shim = require("../../harness/bridge-shim") as { bleBridge: unknown };
  return { __esModule: true, default: shim.bleBridge };
});
jest.mock("@bridge/NativeAirhopWiFi", () => {
  const shim = require("../../harness/bridge-shim") as { wifiBridge: unknown };
  return { __esModule: true, default: shim.wifiBridge };
});

import { SimDevice, type DeviceSpec } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { locations, PLACES } from "../harness/location-fabric";
import { RadioFabric } from "../harness/radio-fabric";
import { RelayFabric } from "../harness/relay-fabric";
import { advanceFor, Scenario, waitForCoarse } from "../harness/scenario";

jest.setTimeout(240_000);

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

const online = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
  internetEnabled: true,
});

interface MeshInternals {
  relaysConnected: boolean;
  nostrClient: {
    publish: (event: object) => Promise<unknown>;
  } | null;
  restartNostr: () => void;
  deleteBoardPost: (post: unknown) => boolean;
}

const internals = (d: SimDevice): MeshInternals =>
  d.mesh as unknown as MeshInternals;

test("O01 a receipt read with the internet on but no relay goes when the sender returns", async () => {
  // The internet switch being on says nothing about a relay being up. A
  // receipt sent into a pool with none would be lost, and never owed again.
  const s = (scenario = new Scenario({
    id: "O01",
    title: "a read receipt with no relay waits for a route",
    seed: 4242,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  for (const d of [alice, bob]) radio.add(d);
  s.track(alice, bob);
  for (const d of [alice, bob]) d.launch();
  s.check(
    "alice and bob met, bob on a relay",
    await waitForCoarse(
      s.world,
      () =>
        alice.peers().includes(bob.peerID) &&
        bob.peers().includes(alice.peerID) &&
        relay.connectionCount("bob") > 0,
      30_000,
    ),
  );

  s.world.say("NETWORK", "bob loses data, then alice walks off");
  relay.setOffline("bob", true);
  await s.world.advance(5_000);
  alice.send(`dm:${bob.peerID}`, "hello");
  const status = (): string | undefined =>
    alice.messages(`dm:${bob.peerID}`).find((m) => m.text === "hello")?.status;
  s.check(
    "the DM was delivered over the radio",
    await waitForCoarse(s.world, () => status() === "delivered", 60_000),
  );
  radio.setIsolated("alice", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"), 20_000);
  // Long enough for bob to stop counting alice as reachable.
  await s.world.advance(120_000);

  bob.openThread(`dm:${alice.peerID}`);
  bob.closeThread();
  await s.world.advance(5_000);

  s.world.say("TOPOLOGY_CHANGE", "alice comes back; bob's data returns");
  radio.setIsolated("alice", false);
  relay.setOffline("bob", false);
  s.check(
    "alice sees her DM read",
    await waitForCoarse(s.world, () => status() === "read", 90_000),
    `status=${String(status())}`,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});

test("O02 a publish during an outage does not hide the relay's recovery", async () => {
  // nostr-tools connects afresh to a relay in reconnect backoff when asked to
  // publish to it, and on failure drops it from the pool while it keeps
  // reconnecting unseen. The pool then never reports the relay back.
  const s = (scenario = new Scenario({
    id: "O02",
    title: "the pool sees its relays come back",
    seed: 5005,
  }));
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  s.track(alice);
  alice.launch();
  s.check(
    "alice is on the relays",
    await waitForCoarse(
      s.world,
      () => internals(alice).relaysConnected,
      30_000,
    ),
  );

  relay.setOffline("alice", true);
  await s.world.advance(20_000);
  s.check("the outage is seen", !internals(alice).relaysConnected);
  void internals(alice)
    .nostrClient?.publish({
      id: "a".repeat(64),
      kind: 1,
      pubkey: "b".repeat(64),
      created_at: 1,
      tags: [],
      content: "",
      sig: "c".repeat(128),
    })
    .catch(() => undefined);
  await s.world.advance(15_000);

  relay.setOffline("alice", false);
  const nostrConnected = (): boolean =>
    alice.meshState().nostrConnected === true;
  s.check(
    "the relays are seen again, and the banner says so",
    await waitForCoarse(
      s.world,
      () => internals(alice).relaysConnected && nostrConnected(),
      180_000,
    ),
  );
  s.expectNone("process health", noCrashes([alice]));
  s.assert(true);
});

test("O03 a room post made while Tor starts reaches the room once Tor carries", async () => {
  // With Tor wanted and no circuit yet there is no relay pool at all, so the
  // post goes out over the radio only, and the composer shows it sent.
  const s = (scenario = new Scenario({
    id: "O03",
    title: "a post held through Tor's start",
    seed: 5002,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  // A member out of radio range, on the internet.
  const carol = SimDevice.create(s.world, online("carol", 33), relay);
  for (const d of [alice, bob, carol]) radio.add(d);
  s.track(alice, bob, carol);
  radio.setIsolated("carol", true);
  const key = new Uint8Array(32).fill(7);
  const room = alice.joinPrivateChannel("#room", key, true);
  bob.joinPrivateChannel("#room", key, true);
  carol.joinPrivateChannel("#room", key, true);
  for (const d of [alice, bob, carol]) d.launch();
  s.check(
    "the room is up on both transports",
    await waitForCoarse(
      s.world,
      () =>
        alice.peers().includes(bob.peerID) &&
        relay.connectionCount("alice") > 0 &&
        relay.connectionCount("carol") > 0,
      30_000,
    ),
  );
  await s.world.advance(10_000);

  s.world.say("USER", "alice turns Tor on; it is still starting");
  const meshState = alice.store("meshStateStore").getState() as {
    setNostrBlockedByTor: (blocked: boolean) => void;
  };
  meshState.setNostrBlockedByTor(true);
  internals(alice).restartNostr();
  await s.world.advance(2_000);
  alice.send(room, "while tor starts");
  await s.world.advance(15_000);
  s.check(
    "the radio carried it to bob",
    bob.texts(room).includes("while tor starts"),
  );
  s.check(
    "carol has nothing yet",
    !carol.texts(room).includes("while tor starts"),
  );

  s.world.say("USER", "Tor carries");
  meshState.setNostrBlockedByTor(false);
  internals(alice).restartNostr();
  s.check(
    "carol gets it over the relays",
    await waitForCoarse(
      s.world,
      () => carol.texts(room).includes("while tor starts"),
      120_000,
    ),
  );
  s.expectNone("process health", noCrashes([alice, bob, carol]));
  s.assert(true);
});

test("O04 a notice deleted offline is still retracted from the relays", async () => {
  // A retraction tried once with no relay and then forgotten would leave the
  // note up for internet readers until it expired.
  const s = (scenario = new Scenario({
    id: "O04",
    title: "a retraction owed through an outage",
    seed: 728,
  }));
  const relay = new RelayFabric(s.world);
  const lone = SimDevice.create(s.world, online("lone", 11), relay);
  locations().place(lone.id, PLACES.bengaluru);
  s.track(lone);
  lone.launch();
  lone.joinChannel("#city");
  await waitForCoarse(
    s.world,
    () => lone.channelGeohash("#city") !== null,
    60_000,
  );
  await waitForCoarse(s.world, () => relay.connectionCount("lone") > 0, 60_000);

  const cell = lone.channelGeohash("#city") ?? "";
  const text = "lost cat by the market";
  s.check("the notice was posted", lone.postNotice(text, cell));
  await waitForCoarse(
    s.world,
    () => relay.eventsOfKind(1).some((e) => e.content === text),
    60_000,
  );
  const eventID = relay.eventsOfKind(1).find((e) => e.content === text)?.id;
  s.check("its Nostr copy is on the relays", eventID !== undefined);
  await advanceFor(s.world, 5_000);

  relay.setOffline("lone", true);
  await s.world.advance(20_000);
  const posts = lone.store("boardStore").getState().posts as {
    content: string;
  }[];
  s.check(
    "the notice was deleted",
    internals(lone).deleteBoardPost(posts.find((p) => p.content === text)),
  );
  const retracted = (): boolean =>
    relay
      .eventsOfKind(5)
      .some((e) => e.tags.some((t) => t[0] === "e" && t[1] === eventID));
  await s.world.advance(15_000);
  s.check("no relay could take the retraction yet", !retracted());

  relay.setOffline("lone", false);
  s.check(
    "the retraction goes once the relays are back",
    await waitForCoarse(s.world, retracted, 120_000),
  );
  s.expectNone("process health", noCrashes([lone]));
  s.assert(true);
});
