/**
 * @jest-environment node
 */
// Ring, end to end: the grant, the proof, the ring, and every answer. The
// grant is made after the first message throughout, since that is the order
// people use, and the proof that lights the button must follow it (#60).

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

import { RingRefusalReason } from "@core/mesh/wire/ring-payload";
import { REACHABLE_TTL_MS } from "@store/peer-store";
import { RING_COOLDOWN_MS } from "@store/ring-store";
import { SimDevice, type DeviceSpec } from "../harness/device";
import { exactlyOnce, noCrashes } from "../harness/invariants";
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

// Two phones in range that have exchanged one message each way, so both hold
// the other as a contact and a Noise session exists between them.
async function acquainted(
  s: Scenario,
): Promise<{ alice: SimDevice; bob: SimDevice; radio: RadioFabric }> {
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  await waitFor(s.world, () => alice.peers().includes(bob.peerID));
  alice.send(`dm:${bob.peerID}`, "hello");
  await waitFor(s.world, () => bob.texts(`dm:${alice.peerID}`).length > 0);
  bob.send(`dm:${alice.peerID}`, "hi");
  await waitFor(s.world, () => alice.texts(`dm:${bob.peerID}`).length > 0);
  return { alice, bob, radio };
}

test("R01 a grant made after the first message lights the button on the other phone", async () => {
  const s = (scenario = new Scenario({
    id: "R01",
    title: "message first, grant second, as the instructions say",
  }));
  const { alice, bob } = await acquainted(s);

  s.check(
    "nothing is offered before any grant",
    !alice.peerAcceptsRing(bob.peerID) && !bob.peerAcceptsRing(alice.peerID),
  );

  // Bob allows alice, on a session that already exists.
  bob.allowRing(alice.peerID, true);
  const lit = await waitFor(
    s.world,
    () => alice.peerAcceptsRing(bob.peerID),
    10_000,
  );
  s.check("alice is offered Ring within seconds, with no new message", lit);
  s.check(
    "the sheet and the registry agree",
    alice.meshPeerAcceptsRing(bob.peerID) === alice.peerAcceptsRing(bob.peerID),
  );
  s.check(
    "the grant is one way: bob is not offered Ring",
    !bob.peerAcceptsRing(alice.peerID),
  );

  // And back off again.
  bob.allowRing(alice.peerID, false);
  const dark = await waitFor(
    s.world,
    () => !alice.peerAcceptsRing(bob.peerID),
    10_000,
  );
  s.check("revoking hides it again", dark);

  s.expectNone("exactly once", exactlyOnce([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("R02 the master switch is told to every session, and the grant is per person", async () => {
  const s = (scenario = new Scenario({
    id: "R02",
    title: "master switch off then on, third person granted nobody",
  }));
  const { alice, bob } = await acquainted(s);
  bob.allowRing(alice.peerID, true);
  await waitFor(s.world, () => alice.peerAcceptsRing(bob.peerID), 10_000);

  bob.setSetting("ringAlertsEnabled", false);
  const off = await waitFor(
    s.world,
    () => !alice.peerAcceptsRing(bob.peerID),
    10_000,
  );
  s.check("switching Ring off hides the button on alice", off);

  bob.setSetting("ringAlertsEnabled", true);
  const on = await waitFor(
    s.world,
    () => alice.peerAcceptsRing(bob.peerID),
    10_000,
  );
  s.check("switching it back on restores it", on);

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("R03 a ring lands, and opening the thread answers it", async () => {
  const s = (scenario = new Scenario({
    id: "R03",
    title: "ring, bell row, ack on open",
  }));
  const { alice, bob } = await acquainted(s);
  bob.allowRing(alice.peerID, true);
  await waitFor(s.world, () => alice.peerAcceptsRing(bob.peerID), 10_000);

  const id = alice.ring(bob.peerID);
  s.check("the ring went out", id !== null);
  s.check("alice is ringing", alice.ringState(bob.peerID).sending);

  const landed = await waitFor(
    s.world,
    () => bob.ringsReceived(`dm:${alice.peerID}`) === 1,
  );
  s.check("bob's thread shows one bell row", landed);

  bob.openThread(`dm:${alice.peerID}`);
  const acked = await waitFor(s.world, () => alice.ringState(bob.peerID).acked);
  s.check("alice sees the ring answered", acked);
  s.check("and is no longer ringing", !alice.ringState(bob.peerID).sending);
  const row = alice.messages(`dm:${bob.peerID}`).find((m) => m.id === id);
  s.check("alice's bell row reads as read", row?.status === "read");

  s.expectNone("exactly once", exactlyOnce([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("R04 a refused ring is answered with the reason, never left ringing", async () => {
  const s = (scenario = new Scenario({
    id: "R04",
    title: "grant revoked between proof and ring; then the cooldown",
  }));
  const { alice, bob } = await acquainted(s);
  bob.allowRing(alice.peerID, true);
  await waitFor(s.world, () => alice.peerAcceptsRing(bob.peerID), 10_000);

  // A ring inside the receiver's cooldown: alice rings, bob accepts; a wiped
  // or reinstalled alice (modelled by clearing her ring store) rings again.
  const first = alice.ring(bob.peerID);
  s.check("first ring went out", first !== null);
  await waitFor(s.world, () => bob.ringsReceived(`dm:${alice.peerID}`) === 1);
  (alice.store("ringStore").getState() as { clearAll: () => void }).clearAll();
  const second = alice.ring(bob.peerID);
  s.check("second ring went out", second !== null);
  const tooSoon = await waitFor(
    s.world,
    () => alice.ringState(bob.peerID).refusal === RingRefusalReason.COOLDOWN,
  );
  s.check("bob answered: too soon", tooSoon);
  s.check("alice stopped ringing", !alice.ringState(bob.peerID).sending);
  s.check(
    "bob's phone did not ring a second time",
    bob.ringsReceived(`dm:${alice.peerID}`) === 1,
  );

  // Past the cooldown, with the grant revoked: the sheet would have hidden
  // the button by now, but a ring sent anyway must be answered, not dropped.
  await advanceFor(s.world, RING_COOLDOWN_MS + 1_000);
  bob.allowRing(alice.peerID, false);
  await waitFor(s.world, () => !alice.peerAcceptsRing(bob.peerID), 10_000);
  (alice.store("ringStore").getState() as { clearAll: () => void }).clearAll();
  const third = alice.ring(bob.peerID);
  s.check("third ring went out over the live session", third !== null);
  const notAllowed = await waitFor(
    s.world,
    () => alice.ringState(bob.peerID).refusal === RingRefusalReason.NOT_ALLOWED,
  );
  s.check("bob answered: not allowed", notAllowed);
  s.check(
    "bob's phone still rang only once",
    bob.ringsReceived(`dm:${alice.peerID}`) === 1,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("R05 a saved contact walking into range is proven before anyone types", async () => {
  const s = (scenario = new Scenario({
    id: "R05",
    title: "both relaunch; the grant shows up with no message sent",
  }));
  const { alice, bob } = await acquainted(s);
  bob.allowRing(alice.peerID, true);
  await waitFor(s.world, () => alice.peerAcceptsRing(bob.peerID), 10_000);

  alice.relaunch();
  bob.relaunch();
  const lit = await waitFor(
    s.world,
    () => alice.peerAcceptsRing(bob.peerID),
    30_000,
  );
  s.check("after a cold start on both, the button returns by itself", lit);

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("R06 a grant made while the other phone is out of earshot is told when it returns", async () => {
  const s = (scenario = new Scenario({
    id: "R06",
    title: "link down past the reachability window, grant flips, link back",
  }));
  const { alice, bob, radio } = await acquainted(s);
  // Bob had already allowed alice, so her side holds his proof.
  bob.allowRing(alice.peerID, true);
  await waitFor(s.world, () => alice.peerAcceptsRing(bob.peerID), 10_000);

  // Bob walks off. The link drops, alice keeps the session (an ordinary drop
  // is not a LEAVE), and after the reachability window she can no longer
  // route to him. The Mesh tab's sweep drops him from the peer store too.
  radio.setIsolated("bob", true);
  await waitFor(s.world, () => !radio.isLinked("alice", "bob"));
  await advanceFor(s.world, REACHABLE_TTL_MS + 5_000);
  (
    alice.store("peerStore").getState() as { evictStale: () => void }
  ).evictStale();
  s.check(
    "bob has aged out of alice's mesh",
    !alice.peers().includes(bob.peerID),
  );

  // Alice allows bob now. Nothing can carry the proof yet.
  alice.allowRing(bob.peerID, true);
  await advanceFor(s.world, 2_000);
  s.check(
    "bob has not been told while out of earshot",
    !bob.peerAcceptsRing(alice.peerID),
  );

  // He walks back. His announce is the first thing alice hears, and the
  // proof follows it.
  radio.setIsolated("bob", false);
  const told = await waitFor(
    s.world,
    () => bob.peerAcceptsRing(alice.peerID),
    30_000,
  );
  s.check("bob is offered Ring once he is back in range", told);
  // And alice's button for bob, whose proof she never lost, is back with his
  // first announce.
  const kept = await waitFor(
    s.world,
    () => alice.peerAcceptsRing(bob.peerID),
    10_000,
  );
  s.check("alice is offered Ring for bob again as soon as he reappears", kept);

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("R07 ring, answer, ring again; snooze, ring again, snooze over, ring again", async () => {
  const s = (scenario = new Scenario({
    id: "R07",
    title: "the repeat cycles a doorbell goes through in a day",
  }));
  const { alice, bob } = await acquainted(s);
  bob.allowRing(alice.peerID, true);
  await waitFor(s.world, () => alice.peerAcceptsRing(bob.peerID), 10_000);
  const thread = `dm:${alice.peerID}`;

  // Ring, answered by opening the thread.
  alice.ring(bob.peerID);
  await waitFor(s.world, () => bob.ringsReceived(thread) === 1);
  bob.openThread(thread);
  await waitFor(s.world, () => alice.ringState(bob.peerID).acked);
  bob.closeThread();

  // Straight away again: the sheet does not offer it.
  s.check(
    "alice's own cooldown holds the button",
    alice.ringCooldownMs(bob.peerID) > 0,
  );

  // After the cooldown the doorbell works again.
  await advanceFor(s.world, RING_COOLDOWN_MS + 1_000);
  s.check("and releases it", alice.ringCooldownMs(bob.peerID) === 0);
  alice.ring(bob.peerID);
  const second = await waitFor(s.world, () => bob.ringsReceived(thread) === 2);
  s.check("a ring after the cooldown lands", second);

  // Bob snoozes alice. The overlay's preset is an hour and the rule is the
  // same for any length, so the scenario waits out a short one.
  const snoozeMs = RING_COOLDOWN_MS + 60_000;
  bob.snoozeRings(alice.peerID, snoozeMs);
  await advanceFor(s.world, RING_COOLDOWN_MS + 1_000);
  alice.ring(bob.peerID);
  const snoozed = await waitFor(
    s.world,
    () => alice.ringState(bob.peerID).refusal === RingRefusalReason.SNOOZED,
  );
  s.check("alice is told the ring was snoozed", snoozed);
  s.check("bob's phone stayed quiet", bob.ringsReceived(thread) === 2);

  // The snooze passes, and so does the next cooldown.
  await advanceFor(s.world, RING_COOLDOWN_MS + 1_000);
  alice.ring(bob.peerID);
  const afterSnooze = await waitFor(
    s.world,
    () => bob.ringsReceived(thread) === 3,
  );
  s.check("once the snooze is over, a ring lands again", afterSnooze);

  s.expectNone("exactly once", exactlyOnce([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});
