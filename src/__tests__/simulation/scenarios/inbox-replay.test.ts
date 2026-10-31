// What a relaunch replays, and what it must not redo.
//
// Relays hand every inbox its whole lookback each time it subscribes: a week
// of gift wraps, a day of courier drops. A phone that forgets what it already
// opened files and acknowledges all of it again on every launch, bringing back
// threads the user deleted and telling every sender, in a burst, that it is
// online. These relaunch a real phone against a real relay pool and count what
// it sends.

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

const GIFT_WRAP_KIND = 1059;
const COURIER_DROP_KIND = 1401;

const online = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
  internetEnabled: true,
});

// Gift wraps on the relays addressed to this Nostr key: every DM, receipt and
// acknowledgement anyone sent it.
function wrapsTo(relay: RelayFabric, pubkey: string): number {
  return relay
    .eventsOfKind(GIFT_WRAP_KIND)
    .filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === pubkey)).length;
}

function removeChannel(device: SimDevice, channel: string): void {
  (device.store("chatStore").getState().removeChannel as (c: string) => void)(
    channel,
  );
}

test("IR01 a deleted Nostr thread stays deleted, and nothing is acknowledged again", async () => {
  const s = (scenario = new Scenario({
    id: "IR01",
    title: "the main inbox's replay after a relaunch",
    seed: 1101,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const dave = SimDevice.create(s.world, online("dave", 44), relay);
  const cast = [alice, dave];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  // Never in radio range: dave reaches alice by her npub alone.
  radio.setTopology([]);
  for (const d of cast) d.launch();
  s.check(
    "both are online",
    await waitForCoarse(
      s.world,
      () =>
        relay.connectionCount("alice") > 0 && relay.connectionCount("dave") > 0,
      30_000,
    ),
  );

  const write = (id: string, text: string): void => {
    (
      dave.mesh as unknown as {
        publishNostrDm: (pub: string, id: string, text: string) => boolean;
      }
    ).publishNostrDm(alice.nostrPubkey, id, text);
  };
  const thread = `dm:nostr_${dave.nostrPubkey}`;
  write("ir01-kept", "keep this one");
  write("ir01-gone", "and this");
  s.check(
    "both arrive",
    await waitForCoarse(
      s.world,
      () => alice.texts(thread).length === 2,
      30_000,
    ),
  );
  // Read, so its receipt goes now and is owed no more.
  alice.openThread(thread);
  alice.closeThread();
  await s.world.advance(10_000);
  const answered = wrapsTo(relay, dave.nostrPubkey);
  s.check(
    "each was acknowledged and read once",
    answered === 4,
    `wraps=${String(answered)}`,
  );

  alice.relaunch();
  await waitForCoarse(
    s.world,
    () => relay.connectionCount("alice") > 0,
    30_000,
  );
  await s.world.advance(30_000);
  alice.openThread(thread);
  await s.world.advance(10_000);
  s.check(
    "a relaunch replays the inbox without answering it again",
    wrapsTo(relay, dave.nostrPubkey) === answered,
    `wraps=${String(wrapsTo(relay, dave.nostrPubkey))}`,
  );

  alice.closeThread();
  removeChannel(alice, thread);
  alice.relaunch();
  await waitForCoarse(
    s.world,
    () => relay.connectionCount("alice") > 0,
    30_000,
  );
  await s.world.advance(30_000);
  s.check(
    "the deleted thread does not come back",
    !alice.channels().includes(thread),
    `channels=${alice.channels().join(",")}`,
  );
  s.check(
    "and its sender hears nothing",
    wrapsTo(relay, dave.nostrPubkey) === answered,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("IR02 a courier drop opened before a relaunch is not opened again", async () => {
  const s = (scenario = new Scenario({
    id: "IR02",
    title: "the courier drop inbox's replay after a relaunch",
    seed: 1102,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  s.check(
    "they met on the mesh and are both online",
    await waitForCoarse(
      s.world,
      () =>
        alice.peers().includes(bob.peerID) &&
        bob.peers().includes(alice.peerID) &&
        relay.connectionCount("alice") > 0 &&
        relay.connectionCount("bob") > 0,
      30_000,
    ),
  );
  radio.setIsolated("bob", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"), 20_000);

  // Parked on the relays for bob, the way mail goes when nobody carries it.
  (
    alice.mesh as unknown as {
      sendViaCourier: (peerID: string, text: string, id: string) => boolean;
    }
  ).sendViaCourier(bob.peerID, "picked up from a relay", "ir02-drop");
  const thread = `dm:${alice.peerID}`;
  s.check(
    "the drop reaches bob",
    await waitForCoarse(
      s.world,
      () => bob.texts(thread).includes("picked up from a relay"),
      60_000,
    ),
    `drops=${String(relay.eventsOfKind(COURIER_DROP_KIND).length)}`,
  );
  await s.world.advance(10_000);
  const acks = wrapsTo(relay, alice.nostrPubkey);
  s.check("bob acknowledged it", acks > 0, `wraps=${String(acks)}`);

  removeChannel(bob, thread);
  bob.relaunch();
  await waitForCoarse(s.world, () => relay.connectionCount("bob") > 0, 30_000);
  await s.world.advance(30_000);
  s.check(
    "the deleted thread does not come back",
    !bob.channels().includes(thread),
    `channels=${bob.channels().join(",")}`,
  );
  s.check(
    "and alice is not told again",
    wrapsTo(relay, alice.nostrPubkey) === acks,
    `wraps=${String(wrapsTo(relay, alice.nostrPubkey))}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("IR03 a read receipt owed before a relaunch still goes when the thread opens", async () => {
  // The phone is killed between the message arriving and the user reading it,
  // which on iOS is the usual order of things. Nothing in memory survives, and
  // the new process holds no session with the sender either.
  const s = (scenario = new Scenario({
    id: "IR03",
    title: "an owed read receipt outlives the process",
    seed: 1103,
  }));
  const radio = new RadioFabric(s.world);
  const offline = (id: string, seedByte: number): DeviceSpec => ({
    id,
    platform: "android",
    seedByte,
  });
  const alice = SimDevice.create(s.world, offline("alice", 11));
  const bob = SimDevice.create(s.world, offline("bob", 22));
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () =>
      alice.peers().includes(bob.peerID) && bob.peers().includes(alice.peerID),
    30_000,
  );

  alice.send(`dm:${bob.peerID}`, "read me after a restart");
  const status = (): string | undefined =>
    alice
      .messages(`dm:${bob.peerID}`)
      .find((m) => m.text === "read me after a restart")?.status;
  s.check(
    "it was delivered",
    await waitForCoarse(s.world, () => status() === "delivered", 60_000),
    `status=${String(status())}`,
  );

  bob.relaunch();
  await waitForCoarse(
    s.world,
    () => bob.peers().includes(alice.peerID),
    30_000,
  );
  bob.openThread(`dm:${alice.peerID}`);
  s.check(
    "alice sees it read",
    await waitForCoarse(s.world, () => status() === "read", 60_000),
    `status=${String(status())}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});
