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

import { encodeBitchatDmEnvelope } from "@core/nostr/bitchat-envelope";
import {
  deriveGeohashIdentity,
  deriveGeohashSeed,
} from "@core/nostr/geohash-identity";
import { wrapDm } from "@core/nostr/gift-wrap";
import { ed25519 } from "@noble/curves/ed25519.js";
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

test("BL01 a blocked peer cannot switch to Nostr to get through", async () => {
  const s = (scenario = new Scenario({
    id: "BL01",
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
  // Through the composer, so bob's own row exists to carry a status. The
  // service call above writes none, and a receipt check against a missing row
  // passes whatever the receipt said.
  bob.send(`dm:${alice.peerID}`, "after the block");
  await s.world.advance(20_000);
  s.check(
    "nothing from the blocked peer lands anywhere",
    !heardAnywhere(alice, "after the block"),
  );
  const row = bob
    .messages(`dm:${alice.peerID}`)
    .find((m) => m.text === "after the block");
  s.check(
    "and no delivery receipt tells them it arrived",
    row !== undefined && row.status !== "delivered" && row.status !== "read",
    `status=${String(row?.status)}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("BL02 a blocked Nostr-only thread stays blocked", async () => {
  const s = (scenario = new Scenario({
    id: "BL02",
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

test("BL03 unblocking a peer on the mesh hears them again", async () => {
  // The block drops the ratchet, so the Noise session has to go with it. Kept,
  // it is a session with no ratchet bound to it, where every DM and receipt
  // from them is dropped without a word until one side restarts.
  const s = (scenario = new Scenario({
    id: "BL03",
    title: "block, unblock, and talk again over Bluetooth",
    seed: 813,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, {
    id: "alice",
    platform: "android",
    seedByte: 11,
  });
  const bob = SimDevice.create(s.world, {
    id: "bob",
    platform: "android",
    seedByte: 22,
  });
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

  bob.sendDm(alice.peerID, "before the block");
  const control = await waitForCoarse(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("before the block"),
    30_000,
  );
  s.check("the control message arrives", control);

  block(alice, bob.peerID);
  (alice.store("blockedStore").getState().unblockPeer as (p: string) => void)(
    bob.peerID,
  );

  bob.sendDm(alice.peerID, "after the unblock");
  const heard = await waitForCoarse(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("after the unblock"),
    60_000,
  );
  s.check("their next message arrives", heard);

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("BL04 couriered mail from a blocked peer still spends its one-time key", async () => {
  // The prekey an envelope opened under is burned before anything else is
  // decided. Dropping a blocked sender's mail first would leave the key live,
  // so a carrier that kept the ciphertext could have it opened after any later
  // seizure of the phone, which is what the one-time key exists to prevent.
  const s = (scenario = new Scenario({
    id: "BL04",
    title: "a blocked sender's courier envelope is dropped and its key burned",
    seed: 814,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, carrier, bob] = ["alice", "carrier", "bob"].map((id, i) =>
    SimDevice.create(s.world, {
      id,
      platform: "android",
      seedByte: 11 * (i + 1),
    }),
  );
  const cast = [alice, carrier, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peerCount() === 2),
    30_000,
  );
  // Long enough for every announce and prekey bundle to land.
  await s.world.advance(10_000);

  block(bob, alice.peerID);
  radio.setTopology([["alice", "carrier"]]);
  await s.world.advance(90_000);
  const status = alice.send(`dm:${bob.peerID}`, "from behind the block");
  s.check("a courier took it", status === "carried", `status=${status}`);

  interface Carried {
    courier: { size: number; envelopes: { prekeyID?: number }[] };
  }
  const bag = (carrier.mesh as unknown as Carried).courier;
  await waitForCoarse(s.world, () => bag.size > 0, 30_000);
  const prekeyID = bag.envelopes[0]?.prekeyID;
  const liveKeys = (): number[] | undefined =>
    (
      bob.mesh as unknown as {
        localPrekeys: { state: { prekeys: { id: number }[] } | null };
      }
    ).localPrekeys.state?.prekeys.map((p) => p.id);
  // Live before the handover, so its absence afterwards is the burn and not a
  // key that was never bob's to spend.
  s.check(
    "it was sealed to one of bob's live one-time keys",
    prekeyID !== undefined && (liveKeys() ?? []).includes(prekeyID),
    `prekey=${String(prekeyID)} live=[${String(liveKeys())}]`,
  );

  radio.setTopology([
    ["alice", "carrier"],
    ["carrier", "bob"],
  ]);
  const handed = await waitForCoarse(s.world, () => bag.size === 0, 60_000);
  s.check("the carrier handed it over", handed);
  await s.world.advance(5_000);

  s.check(
    "nothing from the blocked peer lands",
    !heardAnywhere(bob, "from behind the block"),
  );
  const live = liveKeys();
  s.check(
    "the key it opened under is no longer live",
    live !== undefined && prekeyID !== undefined && !live.includes(prekeyID),
    `prekey=${String(prekeyID)} live=[${String(live)}]`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

const CELL = "u4pruy";

// A location DM pseudonym, folded into a contact's thread by a completed card
// exchange. Set up through the stores the exchange writes, since a real one
// needs two phones placed in one cell.
function foldGeoThread(
  device: SimDevice,
  cellKey: string,
  peerID: string,
): void {
  const chat = device.store("chatStore").getState() as unknown as {
    addChannel: (c: string) => void;
    setGeoDmCell: (pubkey: string, geohash: string) => void;
    noteGeoCardExchange: (
      pubkey: string,
      half: { theirPeerID?: string; sentMine?: boolean },
    ) => void;
  };
  chat.addChannel(`dm:nostr_${cellKey}`);
  chat.setGeoDmCell(cellKey, CELL);
  chat.noteGeoCardExchange(cellKey, { theirPeerID: peerID, sentMine: true });
  (
    device.mesh as unknown as {
      mergeGeoThreadIfMutual: (pubkey: string) => void;
    }
  ).mergeGeoThreadIfMutual(cellKey);
}

test("BL05 blocking a contact also blocks the location pseudonym folded into their thread", async () => {
  const s = (scenario = new Scenario({
    id: "BL05",
    title: "a block covers the cell key a card exchange tied to the peer",
    seed: 815,
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
        relay.connectionCount("alice") > 0,
      30_000,
    ),
  );

  // Bob's key in the cell where the two of them met.
  const bobCell = deriveGeohashIdentity(
    deriveGeohashSeed(ed25519.utils.randomSecretKey()),
    CELL,
  );
  foldGeoThread(alice, bobCell.pubKeyHex, bob.peerID);
  block(alice, bob.peerID);

  const blocked = alice.store("blockedStore").getState() as unknown as {
    isBlocked: (key: string) => boolean;
  };
  s.check(
    "the pseudonym is blocked with them",
    blocked.isBlocked(`nostr_${bobCell.pubKeyHex}`),
  );

  // Bob writes to alice's pseudonym in that cell, from his.
  const geo = (
    alice.mesh as unknown as {
      geoChannels: {
        cellPubkeyFor: (geohash: string) => string;
        handleGeoDm: (event: unknown, geohash: string) => void;
      };
    }
  ).geoChannels;
  const envelope = encodeBitchatDmEnvelope(
    null,
    null,
    "bl05-cell",
    "it's me again",
  );
  const { event } = wrapDm(
    envelope ?? "",
    bobCell.privKey,
    geo.cellPubkeyFor(CELL),
  );
  geo.handleGeoDm(event, CELL);
  await s.world.advance(5_000);
  s.check(
    "nothing from the pseudonym lands anywhere",
    !heardAnywhere(alice, "it's me again"),
  );
  s.check(
    "and no thread opens for them",
    !alice.channels().includes(`dm:${bob.peerID}`),
    `channels=${alice.channels().join(",")}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("BL06 mail queued for a folded pseudonym moves to the contact and never leaves from our main key", async () => {
  const s = (scenario = new Scenario({
    id: "BL06",
    title: "a card exchange re-addresses the pseudonym's queued mail",
    seed: 816,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  radio.setTopology([]);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () =>
      relay.connectionCount("alice") > 0 && relay.connectionCount("bob") > 0,
    30_000,
  );

  const bobCell = deriveGeohashIdentity(
    deriveGeohashSeed(ed25519.utils.randomSecretKey()),
    CELL,
  );
  const outbox = alice.store("outboxStore").getState() as unknown as {
    enqueue: (msg: Record<string, unknown>) => unknown;
  };
  outbox.enqueue({
    id: "bl06-queued",
    recipientPeerID: `nostr_${bobCell.pubKeyHex}`,
    channel: `dm:nostr_${bobCell.pubKeyHex}`,
    text: "written before the exchange",
    createdAtMs: Date.now(),
  });
  foldGeoThread(alice, bobCell.pubKeyHex, bob.peerID);
  const entry = (
    alice.store("outboxStore").getState() as unknown as {
      pending: { id: string; recipientPeerID: string }[];
    }
  ).pending.find((m) => m.id === "bl06-queued");
  s.check(
    "the queued message now names the contact",
    entry?.recipientPeerID === bob.peerID,
    `recipient=${String(entry?.recipientPeerID)}`,
  );

  // And a send still naming the pseudonym, held for undo across the merge.
  alice.sendDm(`nostr_${bobCell.pubKeyHex}`, "sent after it", "bl06-late");
  await s.world.advance(60_000);
  const toCell = relay
    .eventsOfKind(1059)
    .filter((e) =>
      e.tags.some((t) => t[0] === "p" && t[1] === bobCell.pubKeyHex),
    ).length;
  s.check(
    "nothing is ever written to the cell key from our main identity",
    toCell === 0,
    `wraps=${String(toCell)}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});
