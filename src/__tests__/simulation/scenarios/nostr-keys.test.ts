// One person, one thread, whichever way they first reached you.
//
//   NK01  A card scanned one way, a chat over Nostr, then a meeting over
//         Bluetooth: the npub's own DMs name the peer and the peer's proven
//         session names the npub, so the threads fold, the reply's tick moves
//         and the mail queued for the npub goes over the mesh.
//   NK02  The same two halves the other way round: the session's key first,
//         the Nostr DM naming the peer after, which moves a stranger's earlier
//         claim on that npub, and keeps the key past the launch.
//   NK03  The key a session handed over outlives a relaunch for a peer whose
//         DM went unanswered, without making them a contact.

jest.mock("expo-location", () => ({}));
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

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { SimDevice, type DeviceSpec } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { RelayFabric } from "../harness/relay-fabric";
import { Scenario, waitFor } from "../harness/scenario";

jest.setTimeout(240_000);

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

// What `holder`'s QR scan of `owner`'s card leaves behind: a verified contact
// with the owner's npub. Nothing goes the other way.
function scanCard(s: Scenario, holder: SimDevice, owner: SimDevice): void {
  (
    holder.mesh as unknown as {
      addVerifiedContact: (card: unknown, opts: unknown) => unknown;
    }
  ).addVerifiedContact(
    {
      peerID: owner.peerID,
      noisePubKey: owner.identity.noiseStaticPubKey,
      signingPubKey: owner.identity.signingPubKey,
      nickname: owner.id,
      nostrPubKey: hexToBytes(owner.nostrPubkey),
    },
    { inPerson: true },
  );
  (holder.store("contactsStore").getState().addContact as (c: unknown) => void)(
    {
      peerID: owner.peerID,
      noisePubKeyHex: bytesToHex(owner.identity.noiseStaticPubKey),
      signingPubKeyHex: bytesToHex(owner.identity.signingPubKey),
      nickname: owner.id,
      addedAtMs: s.world.wallClock(),
      source: "qr",
      verifiedAtMs: s.world.wallClock(),
      nostrPubkeyHex: owner.nostrPubkey,
    },
  );
}

function outboxIDs(d: SimDevice): string[] {
  return (d.store("outboxStore").getState().pending as { id: string }[]).map(
    (m) => m.id,
  );
}

function copiesOf(d: SimDevice, text: string): number {
  return Object.values(d.allMessages())
    .flat()
    .filter((m) => m.text === text).length;
}

function nostrRoute(d: SimDevice): Map<string, string> {
  return (d.mesh as unknown as { nostrPubkeyToPeerID: Map<string, string> })
    .nostrPubkeyToPeerID;
}

function relayUp(s: Scenario, relay: RelayFabric, d: SimDevice) {
  return waitFor(s.world, () => relay.connectionCount(d.id) > 0, 20_000);
}

test("NK01 a card scanned one way, a Nostr chat, then a meeting: one thread", async () => {
  const s = (scenario = new Scenario({
    id: "NK01",
    title: "mutual claim folds the Nostr thread",
    seed: 401,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  radio.setIsolated(bob.id, true);
  alice.launch();
  bob.launch();
  await relayUp(s, relay, alice);
  await relayUp(s, relay, bob);
  // Bob holds alice's card; alice holds nothing of his.
  scanCard(s, bob, alice);

  const nostrThread = `dm:nostr_${bob.nostrPubkey}`;
  const thread = `dm:${bob.peerID}`;
  bob.send(`dm:${alice.peerID}`, "found your card");
  const arrived = await waitFor(
    s.world,
    () => alice.texts(nostrThread).includes("found your card"),
    60_000,
  );
  s.check("bob's DM lands in a Nostr thread on alice's side", arrived);

  // Bob drops off the internet, so alice's reply waits for his receipt.
  bob.setSetting("internetEnabled", false);
  await waitFor(s.world, () => relay.connectionCount(bob.id) === 0, 20_000);
  alice.send(nostrThread, "nice to meet you");
  const replyID = alice
    .messages(nostrThread)
    .find((m) => m.text === "nice to meet you")?.id;
  await s.world.advance(5_000);
  s.check(
    "the reply waits in alice's outbox under the npub",
    replyID !== undefined && outboxIDs(alice).includes(replyID),
  );

  radio.setIsolated(bob.id, false);
  const folded = await waitFor(
    s.world,
    () =>
      !alice.channels().includes(nostrThread) &&
      alice.texts(thread).includes("found your card"),
    60_000,
  );
  s.check(
    "meeting over Bluetooth folds the Nostr thread into bob's",
    folded,
    `channels=${alice.channels().join(",")}`,
  );
  s.check(
    "the reply moved with it",
    alice.texts(thread).includes("nice to meet you"),
  );
  const overMesh = await waitFor(
    s.world,
    () => copiesOf(bob, "nice to meet you") > 0,
    60_000,
  );
  s.check("the queued reply reaches bob over Bluetooth", overMesh);
  const status = (): string | undefined =>
    alice.messages(thread).find((m) => m.id === replyID)?.status;
  const ticked = await waitFor(
    s.world,
    () => status() === "delivered" || status() === "read",
    60_000,
  );
  s.check("its tick advances", ticked, `status=${String(status())}`);
  s.check(
    "and the outbox lets it go",
    replyID !== undefined && !outboxIDs(alice).includes(replyID),
  );

  // Out of range again and back on the internet: still the one thread.
  radio.setIsolated(bob.id, true);
  bob.setSetting("internetEnabled", true);
  await relayUp(s, relay, bob);
  bob.send(`dm:${alice.peerID}`, "back on the internet");
  const later = await waitFor(
    s.world,
    () => alice.texts(thread).includes("back on the internet"),
    60_000,
  );
  s.check("later Nostr DMs land in bob's thread", later);
  s.check(
    "and no Nostr thread comes back",
    !alice.channels().includes(nostrThread),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("NK02 the session's key first, the npub's DM after, moves a stranger's claim", async () => {
  const s = (scenario = new Scenario({
    id: "NK02",
    title: "mutual claim in the other order",
    seed: 402,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  await relayUp(s, relay, alice);
  await relayUp(s, relay, bob);

  // A stranger got there first: some other peer ID named bob's npub.
  const stranger = "0123456789abcdef";
  nostrRoute(alice).set(bob.nostrPubkey, stranger);

  scanCard(s, bob, alice);
  const handed = await waitFor(
    s.world,
    () =>
      (
        alice.mesh as unknown as {
          npubNamedInSession: Map<string, string>;
        }
      ).npubNamedInSession.get(bob.peerID) === bob.nostrPubkey,
    60_000,
  );
  s.check("bob's session hands alice his key", handed);
  s.check(
    "which on its own does not move the stranger's claim",
    nostrRoute(alice).get(bob.nostrPubkey) === stranger,
  );

  radio.setIsolated(bob.id, true);
  bob.send(`dm:${alice.peerID}`, "it is really me");
  const thread = `dm:${bob.peerID}`;
  const landed = await waitFor(
    s.world,
    () => alice.texts(thread).includes("it is really me"),
    60_000,
  );
  s.check("bob's Nostr DM lands in his own thread", landed);
  s.check(
    "the npub now routes to bob",
    nostrRoute(alice).get(bob.nostrPubkey) === bob.peerID,
  );
  s.check(
    "nothing was filed under the stranger",
    !alice.channels().includes(`dm:${stranger}`),
  );
  // Unanswered, so bob is no contact: only the remembered key routes him
  // after a relaunch.
  s.check(
    "and alice keeps his key past this launch",
    (
      alice.store("nostrKeysStore").getState().learned as Record<string, string>
    )[bob.peerID] === bob.nostrPubkey,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("NK03 an unanswered peer's Nostr key survives a relaunch", async () => {
  const s = (scenario = new Scenario({
    id: "NK03",
    title: "learned Nostr key persists",
    seed: 403,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  await relayUp(s, relay, alice);
  await relayUp(s, relay, bob);
  await waitFor(
    s.world,
    () =>
      alice.peers().includes(bob.peerID) && bob.peers().includes(alice.peerID),
    20_000,
  );

  const thread = `dm:${bob.peerID}`;
  bob.send(`dm:${alice.peerID}`, "hello neighbor");
  await waitFor(
    s.world,
    () => alice.texts(thread).includes("hello neighbor"),
    30_000,
  );
  const learned = (): Record<string, string> =>
    alice.store("nostrKeysStore").getState().learned as Record<string, string>;
  const kept = await waitFor(
    s.world,
    () => learned()[bob.peerID] === bob.nostrPubkey,
    30_000,
  );
  s.check("alice keeps the key bob's session named", kept);
  s.check(
    "without saving bob as a contact",
    !alice.contacts().includes(bob.peerID),
  );

  radio.setIsolated(bob.id, true);
  alice.kill();
  alice.relaunch();
  await relayUp(s, relay, alice);

  bob.send(`dm:${alice.peerID}`, "over the internet now");
  const landed = await waitFor(
    s.world,
    () => alice.texts(thread).includes("over the internet now"),
    60_000,
  );
  s.check("bob's Nostr DM after the relaunch lands in his thread", landed);
  s.check(
    "not a stranger's",
    !alice.channels().includes(`dm:nostr_${bob.nostrPubkey}`),
  );

  alice.send(thread, "got it");
  const reached = await waitFor(
    s.world,
    () => copiesOf(bob, "got it") > 0,
    60_000,
  );
  s.check("alice's answer reaches bob over the relays", reached);

  // Deleting the thread lets the key go.
  (alice.store("chatStore").getState().removeChannel as (c: string) => void)(
    thread,
  );
  await s.world.advance(1_000);
  s.check(
    "removing the thread forgets the key",
    learned()[bob.peerID] === undefined,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});
