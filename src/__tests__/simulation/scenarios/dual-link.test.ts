// Tier L: two Bluetooth links to one neighbour.
//
// Two phones that meet each scan, each see the other and each dial, so on
// hardware a neighbour is usually two links. Fanout goes per peer, not per
// link: a flood written down both costs twice the airtime for a copy the far
// deduplicator discards, and a relay down the second one hands the sender its
// own packet back.

jest.mock("expo-location", () => ({}));
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
jest.mock("expo-file-system", () =>
  require("../harness/media-fabric").createExpoFileSystemMock(),
);
jest.mock("@bridge/NativeAirhopVoice", () => {
  const { createNativeVoiceMock } = require("../harness/media-fabric");
  const built = createNativeVoiceMock();
  const mod = built.module as Record<string, unknown>;
  mod.__record = built.record;
  return { __esModule: true, default: mod };
});

import { base64ToBytes, bytesToBase64 } from "@core/encoding/base64";
import {
  decodePacket,
  encodePacket,
  PacketType,
} from "@core/mesh/wire/packet-codec";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AndroidBleModule } from "../../harness/android-native";
import { SimDevice } from "../harness/device";
import { noCrashes, noDuplicateText } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { advanceFor, Scenario, waitFor } from "../harness/scenario";

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

const CHANNEL = "#bluetooth";

test("L01 a dual-linked line writes each flood once per neighbour, with no echo", async () => {
  const s = (scenario = new Scenario({
    id: "L01",
    title: "one write per neighbour, however many links it holds",
    seed: 601,
  }));
  const radio = new RadioFabric(s.world);
  radio.setDualLinks(true);
  const [alice, bob, carol] = ["alice", "bob", "carol"].map((id, i) =>
    SimDevice.create(s.world, {
      id,
      platform: "android",
      seedByte: 31 + i * 13,
    }),
  );
  for (const d of [alice, bob, carol]) radio.add(d);
  s.track(alice, bob, carol);
  radio.setChain(["alice", "bob", "carol"]);
  for (const d of [alice, bob, carol]) {
    d.launch();
    d.joinChannel(CHANNEL);
  }

  const linked = await waitFor(s.world, () => radio.linkCount() === 4, 30_000);
  s.check(
    "each neighbouring pair holds two links",
    linked,
    `${radio.linkCount()}`,
  );
  const found = await waitFor(
    s.world,
    () => carol.peers().includes(alice.peerID),
    60_000,
  );
  s.check("carol learned alice through bob", found);
  // Long enough for both links of every pair to be bound by an announce.
  await advanceFor(s.world, 5_000);

  // Writes of alice's message as a flood: sync replies go down one link by
  // design and are not counted.
  const writes: string[] = [];
  radio.tapWrites((from, linkID, dataBase64) => {
    const packet = decodePacket(base64ToBytes(dataBase64));
    if (packet === null || packet.isRSR === true) return;
    if (
      packet.type !== PacketType.CHANNEL_MSG &&
      packet.type !== PacketType.CHANNEL_MSG_AIRHOP
    ) {
      return;
    }
    if (bytesToHex(packet.senderID) !== alice.peerID) return;
    writes.push(`${from}>${linkID}`);
  });

  alice.send(CHANNEL, "two links, one copy");
  const arrived = await waitFor(
    s.world,
    () => carol.texts(CHANNEL).includes("two links, one copy"),
    30_000,
  );
  s.check("carol got the message", arrived);
  await advanceFor(s.world, 3_000);

  const to = (w: string): string => w.slice(w.indexOf(":") + 1);
  s.check(
    "alice wrote it once, to bob",
    writes.filter((w) => w.startsWith("alice>")).length === 1,
    writes.join(" "),
  );
  s.check(
    "bob relayed it once, to carol, and never back to alice",
    writes
      .filter((w) => w.startsWith("bob>"))
      .map(to)
      .join() === "carol",
    writes.join(" "),
  );
  s.check(
    "carol sent nothing back to bob",
    !writes.some((w) => w.startsWith("carol>")),
    writes.join(" "),
  );

  s.expectNone(
    "no duplicate text",
    noDuplicateText([alice, bob, carol], CHANNEL),
  );
  s.expectNone("process health", noCrashes([alice, bob, carol]));
  s.assert(true);
});

test("L02 a duplicate direct announce binds the link it arrives on, if it verifies", async () => {
  // Our announce goes down every link as the same bytes, so the copy on a
  // neighbour's second link is a duplicate of the one on its first. Dropped
  // as one before the announce handler binds it, that link would stay
  // unattributed until some later announce happened to reach it first. The
  // packet ID leaves the signature out, so a duplicate is bound only once it
  // verifies against the key already held for its sender.
  const s = (scenario = new Scenario({
    id: "L02",
    title: "a second link is bound by the duplicate announce on it",
    seed: 602,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob] = ["alice", "bob"].map((id, i) =>
    SimDevice.create(s.world, {
      id,
      platform: "android",
      seedByte: 31 + i * 13,
    }),
  );
  for (const d of [alice, bob]) radio.add(d);
  s.track(alice, bob);
  let announce: string | null = null;
  radio.tapWrites((from, _linkID, dataBase64) => {
    const packet = decodePacket(base64ToBytes(dataBase64));
    if (from !== alice.id || packet?.type !== PacketType.ANNOUNCE) return;
    if (packet.ttl === 7) announce = dataBase64;
  });
  for (const d of [alice, bob]) d.launch();
  s.check(
    "bob holds alice as a direct peer",
    await waitFor(s.world, () => bob.peers().includes(alice.peerID), 30_000),
  );
  s.check("alice's direct announce was captured", announce !== null);
  const heard = announce ?? "";

  type Links = { peerOf: (linkID: string) => string | undefined };
  const links = (bob.mesh as unknown as { links: Links }).links;
  // A copy with its signature spoiled has the same packet ID.
  const forged = decodePacket(base64ToBytes(heard));
  if (forged === null) throw new Error("captured announce does not decode");
  forged.signature = new Uint8Array(64);
  // Two more links come up from alice, as a second Bluetooth role would.
  const native = bob.native as AndroidBleModule;
  native.simulatePeerConnect("link2:alice");
  native.simulatePeerConnect("link3:alice");
  await advanceFor(s.world, 50);
  bob.native.fabricDeliver("link3:alice", bytesToBase64(encodePacket(forged)));
  bob.native.fabricDeliver("link2:alice", heard);
  await advanceFor(s.world, 200);

  s.check(
    "the second link carrying the same announce is bound to alice",
    links.peerOf("link2:alice") === alice.peerID,
    `${String(links.peerOf("link2:alice"))}`,
  );
  s.check(
    "a duplicate that does not verify binds nothing",
    links.peerOf("link3:alice") === undefined,
    `${String(links.peerOf("link3:alice"))}`,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});
