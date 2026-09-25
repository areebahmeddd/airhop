/**
 * @jest-environment node
 */
// Tier R: bare relay nodes, the ESP32-on-a-pole case.
//
// Third-party relays exist (bitle.org, bitchat-esp32, bitchat-relay) and Airhop
// works with them for one reason: forwarding consults no registry and verifies
// no signature. If that ever changes, these fail. See PROTOCOLS.md section 10.
//
// R08 onward are the other side: what an Airhop phone, which does check a few
// types before forwarding them as bitchat-ios does, refuses to carry.

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

import {
  encodeBoardWire,
  newPostID,
  signBoardPost,
} from "@core/mesh/wire/board-packet";
import { encodeFilePacket } from "@core/mesh/wire/file-packet";
import {
  decodePacket,
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { SimDevice } from "../harness/device";
import {
  badgeMatchesThreads,
  exactlyOnce,
  noCrashes,
  noDuplicateText,
  noForgedSenders,
} from "../harness/invariants";
import { media } from "../harness/media-fabric";
import { RadioFabric } from "../harness/radio-fabric";
import { RelayNode } from "../harness/relay-node";
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

function phones(s: Scenario, ids: string[]): SimDevice[] {
  return ids.map((id, i) =>
    SimDevice.create(s.world, {
      id,
      platform: "android",
      seedByte: 21 + i * 13,
    }),
  );
}

test("R01 two phones out of range of each other talk through a relay", async () => {
  const s = (scenario = new Scenario({
    id: "R01",
    title: "a box on a pole stands in for the person who is not there",
    seed: 501,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob] = phones(s, ["alice", "bob"]);
  const relay = new RelayNode(s.world, { id: "pole" });
  for (const n of [alice, bob]) radio.add(n);
  radio.add(relay);
  s.track(alice, bob);

  // Alice and bob cannot hear each other, and there is no third PERSON between
  // them. Only the relay.
  radio.setTopology([
    ["alice", "pole"],
    ["bob", "pole"],
  ]);
  alice.launch();
  bob.launch();
  relay.launch();

  alice.joinChannel(CHANNEL);
  bob.joinChannel(CHANNEL);

  const linked = await waitFor(s.world, () => relay.seen.received > 0, 30_000);
  s.check("the relay is carrying traffic", linked, `${relay.seen.received}`);

  // Discovery first, and the ordering is the property rather than setup. A
  // public message is verified against a signing key learned from an ANNOUNCE,
  // so a relay does not make two strangers reachable: it makes their announces
  // reachable. Sending before that lands is correctly dropped at the far end.
  const found = await waitFor(
    s.world,
    () => bob.peers().includes(alice.peerID),
    60_000,
  );
  s.check("bob learned alice through the relay", found);

  alice.send(CHANNEL, "anyone at the south gate");
  const arrived = await waitFor(
    s.world,
    () => bob.texts(CHANNEL).includes("anyone at the south gate"),
    60_000,
  );

  s.check(
    "bob heard alice through a node that holds no keys and knows nobody",
    arrived,
    `bob=[${bob.texts(CHANNEL).join(" | ")}] relayed=${relay.seen.relayed}`,
  );
  s.check("the relay actually forwarded", relay.seen.relayed > 0);

  s.expectNone("exactly once", exactlyOnce([alice, bob]));
  s.expectNone("no duplicate text", noDuplicateText([alice, bob], CHANNEL));
  s.expectNone("no forged senders", noForgedSenders([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});

test("R02 a relay never appears as a peer", async () => {
  // A relay that announced itself would sit in the Mesh tab as a person nobody
  // can message. Saying nothing keeps it out of the roster and costs it nothing.
  const s = (scenario = new Scenario({
    id: "R02",
    title: "infrastructure is not a contact",
    seed: 502,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob] = phones(s, ["alice", "bob"]);
  const relay = new RelayNode(s.world, { id: "pole" });
  for (const n of [alice, bob]) radio.add(n);
  radio.add(relay);
  s.track(alice, bob);

  radio.setTopology([
    ["alice", "pole"],
    ["bob", "pole"],
  ]);
  alice.launch();
  bob.launch();
  relay.launch();
  alice.joinChannel(CHANNEL);
  bob.joinChannel(CHANNEL);

  await waitFor(s.world, () => alice.peers().includes(bob.peerID), 60_000);

  s.check(
    "alice found bob through the relay",
    alice.peers().includes(bob.peerID),
    `peers=[${alice.peers().join(", ")}]`,
  );
  // The relay's fabric label is not a peer ID and must never be treated as one.
  s.check(
    "the relay itself is not in anyone's peer list",
    !alice.peers().includes(relay.peerID) &&
      !bob.peers().includes(relay.peerID),
    `alice=[${alice.peers().join(", ")}] bob=[${bob.peers().join(", ")}]`,
  );

  s.expectNone("badge matches threads", badgeMatchesThreads([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});

test("R03 a chain of relays carries a message further than one hop", async () => {
  // Two poles and nobody in between, which a single extender cannot answer.
  const s = (scenario = new Scenario({
    id: "R03",
    title: "relay to relay, with no person anywhere in the middle",
    seed: 503,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob] = phones(s, ["alice", "bob"]);
  const north = new RelayNode(s.world, { id: "north" });
  const south = new RelayNode(s.world, { id: "south" });
  for (const n of [alice, bob]) radio.add(n);
  radio.add(north);
  radio.add(south);
  s.track(alice, bob);

  radio.setTopology([
    ["alice", "north"],
    ["north", "south"],
    ["south", "bob"],
  ]);
  alice.launch();
  bob.launch();
  north.launch();
  south.launch();
  alice.joinChannel(CHANNEL);
  bob.joinChannel(CHANNEL);

  // Two relays deep, so the announce has further to travel than in R01.
  const found = await waitFor(
    s.world,
    () => bob.peers().includes(alice.peerID),
    90_000,
  );
  s.check("the announce crossed both relays", found);

  alice.send(CHANNEL, "two poles and no people");
  const arrived = await waitFor(
    s.world,
    () => bob.texts(CHANNEL).includes("two poles and no people"),
    90_000,
  );

  s.check(
    "the message crossed both relays",
    arrived,
    `north=${north.seen.relayed} south=${south.seen.relayed} bob=[${bob
      .texts(CHANNEL)
      .join(" | ")}]`,
  );
  s.check(
    "both relays carried it",
    north.seen.relayed > 0 && south.seen.relayed > 0,
  );

  s.expectNone("exactly once", exactlyOnce([alice, bob]));
  s.expectNone("no duplicate text", noDuplicateText([alice, bob], CHANNEL));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});

test("R04 relays in a loop do not trade a packet forever", async () => {
  // Three nodes wired in a ring have a path back to themselves. Without dedup
  // and TTL one message circles until the air is full, which is worse than no
  // relay at all.
  const s = (scenario = new Scenario({
    id: "R04",
    title: "a ring of relays settles instead of resonating",
    seed: 504,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob] = phones(s, ["alice", "bob"]);
  const a = new RelayNode(s.world, { id: "ra" });
  const b = new RelayNode(s.world, { id: "rb" });
  const c = new RelayNode(s.world, { id: "rc" });
  for (const n of [alice, bob]) radio.add(n);
  for (const r of [a, b, c]) radio.add(r);
  s.track(alice, bob);

  radio.setTopology([
    ["alice", "ra"],
    ["ra", "rb"],
    ["rb", "rc"],
    ["rc", "ra"],
    ["rc", "bob"],
  ]);
  alice.launch();
  bob.launch();
  for (const r of [a, b, c]) r.launch();
  alice.joinChannel(CHANNEL);
  bob.joinChannel(CHANNEL);

  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 90_000);

  alice.send(CHANNEL, "ring test");
  await waitFor(
    s.world,
    () => bob.texts(CHANNEL).includes("ring test"),
    90_000,
  );

  // Well past delivery, so anything circulating has time to show itself.
  await advanceFor(s.world, 30_000);

  // Once each, not "the counter stopped". Announces flow for as long as the
  // mesh is up, so a total that stops growing is a dead mesh. What must hold is
  // that no relay forwards the same packet twice.
  for (const [name, r] of [
    ["ra", a],
    ["rb", b],
    ["rc", c],
  ] as const) {
    s.check(
      `${name} forwarded each packet exactly once`,
      r.seen.relayed === r.seen.relayedIDs.size,
      `relayed=${r.seen.relayed} distinct=${r.seen.relayedIDs.size}`,
    );
  }
  s.check(
    "duplicates were recognised rather than forwarded",
    a.seen.droppedDuplicate +
      b.seen.droppedDuplicate +
      c.seen.droppedDuplicate >
      0,
  );

  s.expectNone("no duplicate text", noDuplicateText([alice, bob], CHANNEL));
  s.expectNone("exactly once", exactlyOnce([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});

test("R05 a private message survives a relay it cannot read", async () => {
  // A DM crosses a node holding no keys and arrives readable at the far end.
  const s = (scenario = new Scenario({
    id: "R05",
    title: "the postbox cannot open the envelope",
    seed: 505,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob] = phones(s, ["alice", "bob"]);
  const relay = new RelayNode(s.world, { id: "pole" });
  for (const n of [alice, bob]) radio.add(n);
  radio.add(relay);
  s.track(alice, bob);

  radio.setTopology([
    ["alice", "pole"],
    ["bob", "pole"],
  ]);
  alice.launch();
  bob.launch();
  relay.launch();
  alice.joinChannel(CHANNEL);
  bob.joinChannel(CHANNEL);

  // The handshake floods through the relay too, which is half the property.
  const found = await waitFor(
    s.world,
    () => alice.peers().includes(bob.peerID),
    60_000,
  );
  s.check("the handshake path exists through the relay", found);

  const dm = `dm:${bob.peerID}`;
  alice.send(dm, "meet at the north gate");
  const arrived = await waitFor(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("meet at the north gate"),
    90_000,
  );

  s.check(
    "bob received the private message",
    arrived,
    `relayed=${relay.seen.relayed}`,
  );
  s.check("the relay carried it", relay.seen.relayed > 0);

  s.expectNone("no forged senders", noForgedSenders([alice, bob]));
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert(true);
});

// ---- What an Airhop phone refuses to forward ----

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return globalThis.btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Everything one phone puts on the air, decoded. What a phone chose to relay
// shows only here; its own state cannot say.
function watchAir(radio: RadioFabric, fromID: string): Packet[] {
  const packets: Packet[] = [];
  radio.tapWrites((who, _linkID, dataBase64) => {
    if (who !== fromID) return;
    const p = decodePacket(fromBase64(dataBase64));
    if (p !== null) packets.push(p);
  });
  return packets;
}

// A broadcast claiming `claimed` as its sender, signed by `signer`'s key.
function broadcastAs(
  claimed: SimDevice,
  signer: SimDevice,
  type: PacketType,
  payload: Uint8Array,
  timestamp: number,
): string {
  const packet: Packet = {
    type,
    ttl: 7,
    flags: Flags.SIGNED,
    senderID: hexToBytes(claimed.peerID),
    recipientID: new Uint8Array(8),
    timestamp,
    signature: new Uint8Array(64),
    payload,
  };
  packet.signature = signPacket(packet, signer.identity.signingPrivKey);
  return toBase64(encodePacket(packet));
}

function boardPost(
  author: SimDevice,
  signer: SimDevice,
  content: string,
  createdAt: number,
): Uint8Array {
  const post = signBoardPost(
    {
      postID: newPostID(),
      geohash: "",
      content,
      authorSigningKey: author.identity.signingPubKey,
      authorNickname: "n",
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1000,
      flags: 0,
    },
    signer.identity.signingPrivKey,
  );
  return encodeBoardWire({ kind: "post", post });
}

const sentBy = (p: Packet, d: SimDevice): boolean =>
  bytesToHex(p.senderID) === d.peerID;

test("R08 a forged board post, file or voice frame is relayed by no one", async () => {
  // bitchat-ios checks these before it relays them, and relays only what its
  // handler accepted. Carried unchecked, each costs its forger nothing and
  // every relay the airtime; a file arriving whole is cut into hundreds of
  // Bluetooth fragments per neighbour.
  const s = (scenario = new Scenario({
    id: "R08",
    title: "the relay checks before it spends airtime",
    seed: 508,
  }));
  const radio = new RadioFabric(s.world);
  const [alice, bob, carol, mallory] = phones(s, [
    "alice",
    "bob",
    "carol",
    "mallory",
  ]);
  for (const n of [alice, bob, carol, mallory]) radio.add(n);
  s.track(alice, bob, carol, mallory);
  // Carol hears only bob, so anything reaching her crossed his relay.
  radio.setTopology([
    ["alice", "bob"],
    ["bob", "carol"],
    ["mallory", "bob"],
  ]);
  for (const d of [alice, bob, carol, mallory]) d.launch();
  for (const d of [alice, bob, carol]) d.joinChannel(CHANNEL);
  carol.listenTo(CHANNEL);

  const known = await waitFor(
    s.world,
    () =>
      bob.peers().includes(alice.peerID) &&
      bob.peers().includes(mallory.peerID) &&
      carol.peers().includes(alice.peerID),
    60_000,
  );
  s.check("everyone has heard alice's announce", known);

  const air = watchAir(radio, bob.id);
  const now = (): number => s.world.wallClock();
  const day = 24 * 60 * 60 * 1000;

  // A post naming alice's key that her key never signed, and one mallory
  // really signed that expired yesterday.
  radio.injectTo(
    bob.id,
    mallory.id,
    broadcastAs(
      mallory,
      mallory,
      PacketType.BOARD_POST,
      boardPost(alice, mallory, "forged notice", now()),
      now(),
    ),
  );
  radio.injectTo(
    bob.id,
    mallory.id,
    broadcastAs(
      mallory,
      mallory,
      PacketType.BOARD_POST,
      boardPost(mallory, mallory, "expired notice", now() - 2 * day),
      now(),
    ),
  );
  // A photo and a burst of voice under alice's ID, signed by mallory.
  const photo = encodeFilePacket({
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    content: media.jpeg(2_000),
    caption: "forged photo",
  })!;
  radio.injectTo(
    bob.id,
    mallory.id,
    broadcastAs(alice, mallory, PacketType.FILE_TRANSFER, photo, now()),
  );
  const burstStart = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0x01, 1]);
  radio.injectTo(
    bob.id,
    mallory.id,
    broadcastAs(alice, mallory, PacketType.VOICE_FRAME, burstStart, now()),
  );
  await advanceFor(s.world, 10_000);

  s.check(
    "bob relayed neither forged board post",
    !air.some((p) => p.type === PacketType.BOARD_POST),
    `${air.filter((p) => p.type === PacketType.BOARD_POST).length} written`,
  );
  s.check(
    "bob relayed no part of the forged file",
    !air.some(
      (p) =>
        sentBy(p, alice) &&
        (p.type === PacketType.FILE_TRANSFER || p.type === PacketType.FRAGMENT),
    ),
  );
  s.check(
    "bob relayed no forged voice frame",
    !air.some((p) => p.type === PacketType.VOICE_FRAME),
  );
  s.check(
    "carol shows none of it",
    carol.notices().length === 0 &&
      carol.attachments(CHANNEL).length === 0 &&
      (carol.voice?.framesPlayed.length ?? 0) === 0,
  );

  // The same three, genuinely alice's, cross the same relay.
  alice.postNotice("genuine notice");
  alice.sendAttachment(CHANNEL, media.jpeg(3_000), {
    type: "image",
    name: "real.jpg",
    mimeType: "image/jpeg",
  });
  const posted = await waitFor(
    s.world,
    () =>
      carol.notices().some((n) => n.content === "genuine notice") &&
      carol.attachments(CHANNEL).length > 0,
    90_000,
  );
  s.check("alice's notice and photo reached carol through bob", posted);
  await alice.startVoiceBurst(CHANNEL);
  await s.world.advance(1_000);
  await alice.stopVoiceBurst();
  await s.world.advance(2_000);
  s.check(
    "alice's voice reached carol's speaker through bob",
    (carol.voice?.framesPlayed.length ?? 0) > 0,
  );
  s.check(
    "bob relayed each of alice's",
    air.some((p) => p.type === PacketType.BOARD_POST) &&
      air.some((p) => sentBy(p, alice) && p.type === PacketType.FRAGMENT) &&
      air.some((p) => p.type === PacketType.VOICE_FRAME),
  );

  s.expectNone("no forged senders", noForgedSenders([alice, bob, carol]));
  s.expectNone("process health", noCrashes([alice, bob, carol, mallory]));
  s.assert();
});
