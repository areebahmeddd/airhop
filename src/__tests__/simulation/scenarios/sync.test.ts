/**
 * @jest-environment node
 */
// Tier S: the gossip sync and replay contract, across real phones.
//
// Each scenario pins a property that only appears with more than one device and
// more than one hop. The unit tests in core/mesh cover the shapes; these cover
// what those shapes do to a room.
//
// Both failures guarded against here are silent. A sync storm looks like a busy
// mesh, and a replayed packet looks like a message, so neither surfaces as an
// error on any device. Watching the air is the only way to see them.

jest.mock("expo-location", () => ({}));
jest.mock("react-native/Libraries/EventEmitter/RCTDeviceEventEmitter", () =>
  // Every phone needs its own listener set. See harness/event-router.ts: this
  // is the only interception point that reliably catches every path by which
  // mesh-service and the native modules reach the emitter.
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

import { generateChannelKey } from "@core/mesh/rooms/channel-crypto";
import {
  fragmentPacket,
  MAX_BLE_FRAME,
} from "@core/mesh/routing/fragment-manager";
import { encodeGossipFilterPayload } from "@core/mesh/sync/gossip-sync";
import {
  decodePacket,
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import {
  channelPacketType,
  encodeAirhopChannelPayload,
  encodeMeshPublicPayload,
  MESH_PUBLIC_CHANNEL,
} from "@core/router/message-router";
import { SimDevice } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { Scenario, waitFor, waitForCoarse } from "../harness/scenario";

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

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return globalThis.btoa(s);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Everything a given phone puts on the air, decoded. The tap is the only
// honest place to ask "what actually went out" - a device's own state cannot
// tell you what it chose to relay.
function watchAir(
  radio: RadioFabric,
  fromID: string,
): { packets: Packet[]; stop: () => void } {
  const packets: Packet[] = [];
  const stop = radio.tapWrites((who, _linkID, dataBase64) => {
    if (who !== fromID) return;
    const p = decodePacket(base64ToBytes(dataBase64));
    if (p !== null) packets.push(p);
  });
  return { packets, stop };
}

// A public message genuinely signed by `author`, stamped at whatever time the
// caller wants. Signing with the author's real key is the point: it removes the
// signature rule from the question entirely, so anything that refuses the
// packet refused it for the reason under test.
function signedPublicMessage(
  author: SimDevice,
  channel: string,
  text: string,
  timestamp: number,
  messageID: string,
  isRSR = false,
): Uint8Array {
  const senderID = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    senderID[i] = parseInt(author.peerID.slice(i * 2, i * 2 + 2), 16);
  }
  const packet: Packet = {
    type: channelPacketType(channel),
    // A sync reply is link-local, so one tagged IS_RSR travels at ttl 0.
    ttl: isRSR ? 0 : 7,
    flags: Flags.SIGNED,
    senderID,
    recipientID: new Uint8Array(8),
    timestamp,
    signature: new Uint8Array(64),
    payload:
      channel === MESH_PUBLIC_CHANNEL
        ? encodeMeshPublicPayload(text)
        : encodeAirhopChannelPayload(channel, text, messageID),
    ...(isRSR ? { isRSR: true } : {}),
  };
  packet.signature = signPacket(packet, author.identity.signingPrivKey);
  return encodePacket(packet);
}

// Text that DEFLATE cannot shrink back under one frame, so a message carrying
// it has to travel as fragments over Bluetooth.
function incompressible(world: Scenario["world"], length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[world.rng.int(0, alphabet.length - 1)];
  }
  return out;
}

// Fragments of `inner`, cut the way a Bluetooth sender cuts them, as frames
// ready to put on the air.
function asFragments(inner: Uint8Array, cutBy: SimDevice): string[] {
  const packet = decodePacket(inner);
  if (packet === null) throw new Error("inner packet does not decode");
  return fragmentPacket(packet, { peerID: cutBy.peerID }).map((f) =>
    bytesToBase64(encodePacket(f)),
  );
}

function phones(
  s: Scenario,
  ids: string[],
): { radio: RadioFabric; devices: SimDevice[] } {
  const radio = new RadioFabric(s.world);
  const devices = ids.map((id, i) =>
    SimDevice.create(s.world, {
      id,
      platform: "android",
      seedByte: 11 + i * 11,
    }),
  );
  for (const d of devices) radio.add(d);
  s.track(...devices);
  return { radio, devices };
}

test("S01 catching up after a partition does not re-flood the mesh", async () => {
  // The bug this exists for: sync responses were replayed carrying their
  // original ttl. The requester's flood router sees each one as new, which it
  // is, and forwards it to every other neighbour, who forward it again. One
  // phone rejoining after a partition pushes the entire archive across the
  // mesh, and the symptom is a room that gets slower the longer it runs.
  const s = (scenario = new Scenario({
    id: "S01",
    title: "a rejoining phone catches up without rebroadcasting what it learns",
    seed: 91,
  }));
  // Four phones, because the fourth is what makes the test able to fail: a
  // rejoining node with a single link has nowhere to relay to, since the relay
  // path skips the link a packet arrived on. Carol arrives between bob and
  // dave, so anything she forwards has somewhere to go.
  const { radio, devices } = phones(s, ["alice", "bob", "carol", "dave"]);
  const [alice, bob, carol, dave] = devices;

  // Carol and dave start out of everyone's range.
  radio.setTopology([["alice", "bob"]]);
  for (const d of devices) d.launch();

  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);

  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);

  const said = ["water at the south gate", "medic tent moved", "bridge is up"];
  for (const text of said) {
    alice.send(channel, text);
    await s.world.advance(300);
  }
  const bobHeard = await waitFor(
    s.world,
    () => said.every((t) => bob.texts(channel).includes(t)),
    20_000,
  );
  s.check("bob heard the room while carol was away", bobHeard);

  // Carol walks into range, bridging bob and dave. From here on, watch what
  // she puts on the air.
  const carolAir = watchAir(radio, carol.id);
  s.world.say("TOPOLOGY_CHANGE", "carol arrives between bob and dave");
  radio.setTopology([
    ["alice", "bob"],
    ["bob", "carol"],
    ["carol", "dave"],
  ]);

  const caughtUp = await waitForCoarse(
    s.world,
    () =>
      said.every((t) => carol.texts(channel).includes(t)) &&
      carol.peers().includes(dave.peerID),
    60_000,
  );
  s.check(
    "carol caught up on everything she missed",
    caughtUp,
    `carol thread = [${carol.texts(channel).join(" | ")}]`,
  );
  s.check(
    "carol had somewhere to relay to, so a storm would have been visible",
    carol.peers().includes(dave.peerID),
  );

  // Give any scheduled relay its chance before judging. A relay is jittered by
  // up to 220ms, so asserting the instant the text appears would race the timer
  // and pass for the wrong reason - the storm would simply not have started
  // yet. Three seconds is well past the window and past a further sync round.
  await s.world.advance(3_000);

  // The load-bearing half. Catching up is only correct if it stays local: a
  // node that relays what it was just handed turns one catch-up into a storm.
  const aliceSenderID = alice.peerID;
  const rebroadcast = carolAir.packets.filter(
    (p) =>
      p.type === PacketType.CHANNEL_MSG && hex(p.senderID) === aliceSenderID,
  );
  carolAir.stop();
  s.check(
    "carol never rebroadcast a single packet she caught up on",
    rebroadcast.length === 0,
    `carol relayed ${String(rebroadcast.length)} of alice's messages back onto the air`,
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S02 sync requests and their answers never leave the link", async () => {
  // REQUEST_SYNC is a question about what the phone on the far end of THIS
  // link is missing. Relaying it asks a node that was never being addressed,
  // and every hop it travels multiplies the answers.
  const s = (scenario = new Scenario({
    id: "S02",
    title: "sync traffic is link-local in both directions",
    seed: 92,
  }));
  const { radio, devices } = phones(s, ["alice", "bob", "carol"]);
  radio.setChain(devices.map((d) => d.id));
  for (const d of devices) d.launch();

  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  await waitForCoarse(s.world, () => radio.linkCount() === 2, 30_000);

  devices[0].send(channel, "something to sync about");

  // Watch the middle phone: it is the only one with somewhere to relay TO.
  const bobAir = watchAir(radio, devices[1].id);
  await s.world.advance(40_000);
  bobAir.stop();

  const syncPackets = bobAir.packets.filter(
    (p) => p.type === PacketType.REQUEST_SYNC,
  );
  s.check(
    "the middle phone did send sync requests of its own",
    syncPackets.length > 0,
    `saw ${String(syncPackets.length)} REQUEST_SYNC writes`,
  );
  s.check(
    "every sync request went out link-local (ttl 0)",
    syncPackets.every((p) => p.ttl === 0),
    `ttls = [${syncPackets.map((p) => String(p.ttl)).join(",")}]`,
  );
  // A request carrying someone else's senderID would mean we relayed theirs.
  const ownID = devices[1].peerID;
  s.check(
    "the middle phone never forwarded a neighbour's sync request",
    syncPackets.every((p) => hex(p.senderID) === ownID),
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S03 an old packet is refused even when its signature is perfect", async () => {
  // The deduplicator is not the defence here: its window is five minutes and
  // its state is per device, so it says nothing about a phone that never saw
  // the original. Someone can record a message in one room and play it into
  // strangers' phones later, attributed to its author and presented as current.
  //
  // The test is built as a matched pair. Two messages, both signed with
  // alice's real key, both injected by a phone that is not alice, into a phone
  // that has met alice but never saw either message. They differ in exactly one
  // field: the timestamp. If only the stale one is refused, the age check is
  // what refused it - not the signature rule, not dedup, not routing.
  const s = (scenario = new Scenario({
    id: "S03",
    title: "a matched pair differing only in age",
    seed: 93,
  }));
  const { radio, devices } = phones(s, ["alice", "bob", "carol", "mallory"]);
  const [alice, , carol, mallory] = devices;

  // Everyone meets first, so carol holds alice's signing key. Without that,
  // both messages would be dropped for being unverifiable and the test would
  // pass while proving nothing.
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(alice.peerID),
    45_000,
  );
  s.check("carol learned alice's identity before the attack", met);

  // Alice leaves. Carol is now alone with mallory, so nothing can reach her
  // through an honest path and any arrival is the injection under test.
  s.world.say("TOPOLOGY_CHANGE", "alice and bob walk away; mallory stays");
  radio.setTopology([
    ["alice", "bob"],
    ["carol", "mallory"],
  ]);
  await waitForCoarse(
    s.world,
    () => radio.isLinked("carol", "mallory"),
    30_000,
  );

  const stale = "the meeting is at four";
  const fresh = "the meeting is at five";
  const staleAt = s.world.wallClock() - 6 * 60_000;

  // Mallory replays something alice said six minutes ago, byte-perfect.
  radio.injectTo(
    carol.id,
    mallory.id,
    bytesToBase64(
      signedPublicMessage(alice, channel, stale, staleAt, `replay-${staleAt}`),
    ),
  );
  await s.world.advance(5_000);
  s.check(
    "a six-minute-old message is refused",
    !carol.texts(channel).includes(stale),
    `carol thread = [${carol.texts(channel).join(" | ")}]`,
  );

  // The control. Same author, same key, same injector, same link - only the
  // timestamp differs. A check that rejected both would pass the assertion
  // above and be worthless.
  const freshAt = s.world.wallClock();
  radio.injectTo(
    carol.id,
    mallory.id,
    bytesToBase64(
      signedPublicMessage(alice, channel, fresh, freshAt, `live-${freshAt}`),
    ),
  );
  const arrived = await waitFor(
    s.world,
    () => carol.texts(channel).includes(fresh),
    15_000,
  );
  s.check(
    "the identical message stamped now IS accepted",
    arrived,
    `carol thread = [${carol.texts(channel).join(" | ")}]`,
  );

  // And the one path that is allowed to carry old packets buys a stranger
  // nothing. IS_RSR is the sender's claim; the pending request is our own
  // record, and carol never asked mallory for a sync of this.
  radio.injectTo(
    carol.id,
    mallory.id,
    bytesToBase64(
      signedPublicMessage(
        alice,
        channel,
        stale,
        staleAt,
        `rsr-${staleAt}`,
        true,
      ),
    ),
  );
  await s.world.advance(5_000);
  s.check(
    "claiming IS_RSR does not buy an unsolicited replay an exemption",
    !carol.texts(channel).includes(stale),
    `carol thread = [${carol.texts(channel).join(" | ")}]`,
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S04 a route planned by another node is followed, not flooded", async () => {
  // Airhop never plans routes, since publishing a crowd's adjacency graph is
  // the wrong price for routing bandwidth (see core/mesh/source-route.ts). A
  // bitchat peer that has planned one is still owed the hop it asked for, or we
  // become a node other implementations route around. The forged packet here
  // stands in for that peer.
  const s = (scenario = new Scenario({
    id: "S04",
    title: "an intermediate hop unicasts along the route instead of flooding",
    seed: 94,
  }));
  const { radio, devices } = phones(s, ["alice", "bob", "carol", "dave"]);
  const [alice, bob, carol] = devices;

  // Bob has TWO onward neighbours. With one, following a route and flooding
  // look identical from the air and the test could not tell them apart.
  radio.setTopology([
    ["alice", "bob"],
    ["bob", "carol"],
    ["bob", "dave"],
  ]);
  for (const d of devices) d.launch();
  const linked = await waitForCoarse(
    s.world,
    () => radio.linkCount() === 3,
    45_000,
  );
  s.check("bob has two onward neighbours", linked);

  const bobAir = watchAir(radio, bob.id);

  // Alice -> [bob] -> carol. The route carries intermediate hops only; carol is
  // in the header, per SOURCE_ROUTING.md section 3.
  const senderID = new Uint8Array(8);
  const recipientID = new Uint8Array(8);
  const hop = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    senderID[i] = parseInt(alice.peerID.slice(i * 2, i * 2 + 2), 16);
    recipientID[i] = parseInt(carol.peerID.slice(i * 2, i * 2 + 2), 16);
    hop[i] = parseInt(bob.peerID.slice(i * 2, i * 2 + 2), 16);
  }
  const marker = new Uint8Array([0x5e, 0xed, 0x01, 0x02, 0x03, 0x04]);
  const routedPacket: Packet = {
    type: PacketType.NOISE_ENCRYPTED,
    ttl: 7,
    flags: Flags.HAS_RECIPIENT,
    senderID,
    recipientID,
    timestamp: s.world.wallClock(),
    signature: new Uint8Array(64),
    payload: marker,
    version: 2,
    route: [hop],
  };
  radio.injectTo(bob.id, alice.id, bytesToBase64(encodePacket(routedPacket)));
  await s.world.advance(5_000);
  bobAir.stop();

  const forwarded = bobAir.packets.filter(
    (p) =>
      p.type === PacketType.NOISE_ENCRYPTED &&
      p.payload.length === marker.length &&
      p.payload.every((b, i) => b === marker[i]),
  );
  s.check(
    "bob forwarded the routed packet",
    forwarded.length > 0,
    `saw ${String(forwarded.length)} forwards`,
  );
  s.check(
    "bob forwarded it exactly once, not to every neighbour",
    forwarded.length === 1,
    `saw ${String(forwarded.length)} forwards; a flood would be 2 (carol and dave)`,
  );
  s.check(
    "the route survived the hop, so the next relay can follow it too",
    forwarded[0]?.route?.length === 1,
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S05 a plaintext message cannot land in a private channel", async () => {
  // A private channel is sealed, but its name also exists as a public room
  // type. A correctly signed public message under that name would render
  // beneath the encryption lock, from anyone in range. Matched pair: the same
  // author and path into a public room is the control.
  const s = (scenario = new Scenario({
    id: "S05",
    title: "plaintext under a private channel's name",
    seed: 95,
  }));
  const { radio, devices } = phones(s, ["carol", "mallory"]);
  const [carol, mallory] = devices;
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(mallory.peerID),
    45_000,
  );
  s.check(
    "carol holds mallory's key, so the signature is not the question",
    met,
  );

  (
    carol.store("chatStore").getState().joinPrivateChannel as (
      channel: string,
      key: string,
      overNostr: boolean,
    ) => string
  )("#crew", generateChannelKey(), false);
  carol.joinChannel("#den");

  const inject = (channel: string, text: string): void => {
    const at = s.world.wallClock();
    radio.injectTo(
      carol.id,
      mallory.id,
      bytesToBase64(
        signedPublicMessage(mallory, channel, text, at, `${channel}-${at}`),
      ),
    );
  };
  inject("#crew", "in the clear");
  await s.world.advance(5_000);
  s.check(
    "a plaintext message is refused in the private channel",
    !carol.texts("#crew").includes("in the clear"),
  );

  inject("#den", "in public");
  const arrived = await waitFor(
    s.world,
    () => carol.texts("#den").includes("in public"),
    15_000,
  );
  s.check("the same message into a public room is accepted", arrived);

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S06 a plaintext message cannot land in a group or a DM thread", async () => {
  // Groups and DMs are joined rooms like any channel, so without a check by
  // name a signed public message naming one would render inside a thread the
  // UI marks as encrypted. The control is the same message into a public room.
  const s = (scenario = new Scenario({
    id: "S06",
    title: "plaintext under a group's or a DM's name",
    seed: 96,
  }));
  const { radio, devices } = phones(s, ["carol", "mallory"]);
  const [carol, mallory] = devices;
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(mallory.peerID),
    45_000,
  );
  s.check(
    "carol holds mallory's key, so the signature is not the question",
    met,
  );

  const group = "group:00112233445566778899aabbccddeeff";
  const dm = `dm:${mallory.peerID}`;
  const addChannel = carol.store("chatStore").getState().addChannel as (
    channel: string,
  ) => void;
  addChannel(group);
  addChannel(dm);
  carol.joinChannel("#den");

  const inject = (channel: string, text: string): void => {
    const at = s.world.wallClock();
    radio.injectTo(
      carol.id,
      mallory.id,
      bytesToBase64(
        signedPublicMessage(mallory, channel, text, at, `${text}-${at}`),
      ),
    );
  };
  inject(group, "in the group");
  inject(dm, "in the dm");
  await s.world.advance(5_000);
  s.check(
    "a plaintext message is refused in the group",
    !carol.texts(group).includes("in the group"),
  );
  s.check(
    "a plaintext message is refused in the DM thread",
    !carol.texts(dm).includes("in the dm"),
  );

  inject("#den", "in public");
  const arrived = await waitFor(
    s.world,
    () => carol.texts("#den").includes("in public"),
    15_000,
  );
  s.check("the same message into a public room is accepted", arrived);

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S07 a fragmented sync reply is let in only when it was asked for", async () => {
  // A sync reply is old by nature, and one longer than a Bluetooth frame
  // arrives as fragments, which are stamped when cut and so always look fresh.
  // The freshness question therefore has to be asked of the packet inside. The
  // matched pair: two old messages signed by alice, both in fragments over the
  // one link carol has just asked for a sync. Only the one carrying IS_RSR is
  // a reply; the other is a replay wrapped to dodge the window.
  const s = (scenario = new Scenario({
    id: "S07",
    title: "old packets inside fresh fragments",
    seed: 97,
  }));
  const { radio, devices } = phones(s, ["alice", "carol", "mallory"]);
  const [alice, carol, mallory] = devices;
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const channel = "#den";
  for (const d of devices) d.joinChannel(channel);
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(alice.peerID),
    45_000,
  );
  s.check("carol holds alice's key", met);

  radio.setTopology([["carol", "mallory"]]);
  await waitForCoarse(
    s.world,
    () => radio.isLinked("carol", "mallory"),
    30_000,
  );

  // Carol's own request to mallory is what opens the window.
  let asked = false;
  const stopTap = radio.tapWrites((who, linkID, dataBase64) => {
    if (who !== carol.id || linkID !== `link:${mallory.id}`) return;
    const p = decodePacket(base64ToBytes(dataBase64));
    if (p?.type === PacketType.REQUEST_SYNC) asked = true;
  });
  const requested = await waitFor(s.world, () => asked, 40_000);
  stopTap();
  s.check("carol asked mallory for a sync", requested);

  const staleAt = s.world.wallClock() - 6 * 60_000;
  const replyText = incompressible(s.world, 900);
  const reply = signedPublicMessage(
    alice,
    channel,
    replyText,
    staleAt,
    "reply",
    true,
  );
  s.check(
    "the reply needs fragments on Bluetooth",
    reply.length > MAX_BLE_FRAME,
    `${String(reply.length)} bytes`,
  );
  for (const frame of asFragments(reply, alice)) {
    radio.injectTo(carol.id, mallory.id, frame);
  }
  const accepted = await waitFor(
    s.world,
    () => carol.texts(channel).includes(replyText),
    5_000,
  );
  s.check("the solicited reply, reassembled, is accepted", accepted);

  const replayText = incompressible(s.world, 900);
  const replay = signedPublicMessage(
    alice,
    channel,
    replayText,
    staleAt - 1_000,
    "replay",
  );
  for (const frame of asFragments(replay, alice)) {
    radio.injectTo(carol.id, mallory.id, frame);
  }
  await s.world.advance(5_000);
  s.check(
    "an old packet that is no reply is refused, fragments or not",
    !carol.texts(channel).includes(replayText),
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S09 a bitchat transfer that outlasts the window still completes", async () => {
  // bitchat-ios and bitchat-android stamp every fragment with the time of the
  // packet inside, so a slow transfer's later fragments look minutes old. One
  // that continues a stream already under way is live traffic; a stream that
  // opens with old fragments is a replay, and must be neither kept nor relayed.
  const s = (scenario = new Scenario({
    id: "S09",
    title: "a long bitchat transfer against the freshness window",
    seed: 99,
  }));
  const { radio, devices } = phones(s, ["alice", "carol", "dave"]);
  const [alice, carol, dave] = devices;
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const channel = "#den";
  for (const d of devices) d.joinChannel(channel);
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(alice.peerID),
    45_000,
  );
  s.check("carol holds alice's key", met);

  radio.setTopology([
    ["alice", "carol"],
    ["carol", "dave"],
  ]);
  await waitForCoarse(s.world, () => radio.isLinked("carol", "dave"), 30_000);

  // Cut as bitchat cuts: every fragment carries the inner packet's stamp.
  function bitchatFragments(inner: Uint8Array): string[] {
    const packet = decodePacket(inner);
    if (packet === null) throw new Error("inner packet does not decode");
    return fragmentPacket(packet, { peerID: alice.peerID }).map((f) =>
      bytesToBase64(encodePacket({ ...f, timestamp: packet.timestamp })),
    );
  }

  // Under the 30s idle timeout, so only the freshness window is in play.
  const gapMs = 25_000;
  const text = incompressible(s.world, 6_000);
  const frames = bitchatFragments(
    signedPublicMessage(alice, channel, text, s.world.wallClock(), "slow"),
  );
  s.check(
    "the transfer runs past the two-minute window",
    (frames.length - 1) * gapMs > 2 * 60_000,
    `${String(frames.length)} fragments`,
  );
  for (const [i, frame] of frames.entries()) {
    if (i > 0) await s.world.advance(gapMs);
    radio.injectTo(carol.id, alice.id, frame);
  }
  const arrived = await waitFor(
    s.world,
    () => carol.texts(channel).includes(text),
    5_000,
  );
  s.check("the slow transfer is reassembled and shown", arrived);

  const air = watchAir(radio, carol.id);
  const staleAt = s.world.wallClock() - 6 * 60_000;
  const replayText = incompressible(s.world, 900);
  for (const frame of bitchatFragments(
    signedPublicMessage(alice, channel, replayText, staleAt, "replay"),
  )) {
    radio.injectTo(carol.id, alice.id, frame);
  }
  await s.world.advance(5_000);
  air.stop();
  s.check(
    "a stream that opens with old fragments is refused",
    !carol.texts(channel).includes(replayText),
  );
  s.check(
    "and none of its fragments is relayed",
    !air.packets.some(
      (p) => p.type === PacketType.FRAGMENT && p.timestamp === staleAt,
    ),
  );
  s.check(
    "dave never sees it either",
    !dave.texts(channel).includes(replayText),
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("S08 a message too long for one frame still reaches a latecomer", async () => {
  // Bob hears alice's message as fragments. He has to remember it for sync,
  // and his reply to carol has to be cut to fit the link, or the history a
  // latecomer turns up for silently stops at the frame size.
  const s = (scenario = new Scenario({
    id: "S08",
    title: "long history crosses sync over Bluetooth",
    seed: 98,
  }));
  const { radio, devices } = phones(s, ["alice", "bob", "carol"]);
  const [alice, bob, carol] = devices;
  radio.setTopology([["alice", "bob"]]);
  for (const d of devices) d.launch();
  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);

  const text = incompressible(s.world, 900);
  alice.send(channel, text);
  const bobHeard = await waitFor(
    s.world,
    () => bob.texts(channel).includes(text),
    20_000,
  );
  s.check("bob heard the long message", bobHeard);

  radio.setTopology([
    ["alice", "bob"],
    ["bob", "carol"],
  ]);
  const caughtUp = await waitForCoarse(
    s.world,
    () => carol.texts(channel).includes(text),
    60_000,
  );
  s.check("carol caught up on it through bob", caughtUp);
  s.check(
    "nothing was written past the Bluetooth frame",
    radio.framesOversized === 0,
    `oversized=${String(radio.framesOversized)}`,
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

// The same packet re-tagged as a sync reply: ttl and IS_RSR sit outside the
// signed bytes, so the author's signature still verifies.
function asReply(bytes: Uint8Array, ttl = 0): string {
  const packet = decodePacket(bytes);
  if (packet === null) throw new Error("packet does not decode");
  return bytesToBase64(encodePacket({ ...packet, ttl, isRSR: true }));
}

function stripped(bytes: Uint8Array, ttl: number): string {
  const packet = decodePacket(bytes);
  if (packet === null) throw new Error("packet does not decode");
  return bytesToBase64(encodePacket({ ...packet, ttl, isRSR: false }));
}

function syncRequest(opts: {
  claimed: SimDevice;
  to: SimDevice;
  ttl: number;
  signWith?: SimDevice;
  at: number;
}): string {
  const senderID = new Uint8Array(8);
  const recipientID = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    senderID[i] = parseInt(opts.claimed.peerID.slice(i * 2, i * 2 + 2), 16);
    recipientID[i] = parseInt(opts.to.peerID.slice(i * 2, i * 2 + 2), 16);
  }
  const packet: Packet = {
    type: PacketType.REQUEST_SYNC,
    ttl: opts.ttl,
    flags:
      Flags.HAS_RECIPIENT | (opts.signWith !== undefined ? Flags.SIGNED : 0),
    senderID,
    recipientID,
    timestamp: opts.at,
    signature: new Uint8Array(64),
    // An empty filter: "I hold nothing", so any answer is the whole store.
    payload: encodeGossipFilterPayload({
      p: 7,
      m: 1,
      data: new Uint8Array(0),
      types: 1 << 1,
    }),
  };
  if (opts.signWith !== undefined) {
    packet.signature = signPacket(
      packet,
      opts.signWith.identity.signingPrivKey,
    );
  }
  return bytesToBase64(encodePacket(packet));
}

// Mallory's own periodic sync requests would draw answers indistinguishable
// from the ones under test, so her gossip round is stopped.
function silenceSync(device: SimDevice): void {
  (device.mesh as unknown as { gossip: { stop: () => void } }).gossip.stop();
}

test("S11 a sync request is answered only when it is the link peer's own", async () => {
  // One request can draw a node's whole store down a link, so it is answered
  // only when it is what bitchat-ios would answer: link-local, from the peer
  // bound to the link it came in on, and signed by that peer. A relayed one
  // asks every node it reaches.
  const s = (scenario = new Scenario({
    id: "S11",
    title: "unsigned, relayed and misattributed sync requests",
    seed: 111,
  }));
  const { radio, devices } = phones(s, ["alice", "carol", "mallory"]);
  const [alice, carol, mallory] = devices;
  radio.setChain(["mallory", "carol", "alice"]);
  for (const d of devices) d.launch();
  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  await waitForCoarse(
    s.world,
    () =>
      carol.peers().includes(alice.peerID) &&
      carol.peers().includes(mallory.peerID),
    45_000,
  );
  silenceSync(mallory);
  carol.send(channel, "something carol holds");
  await s.world.advance(20_000);

  let answers = 0;
  let relayed = 0;
  const stop = radio.tapWrites((who, linkID, dataBase64) => {
    if (who !== carol.id) return;
    const p = decodePacket(base64ToBytes(dataBase64));
    if (p === null) return;
    if (linkID === `link:${mallory.id}` && p.isRSR === true) answers++;
    if (
      p.type === PacketType.REQUEST_SYNC &&
      hex(p.senderID) !== carol.peerID
    ) {
      relayed++;
    }
  });
  const tryRequest = async (frame: string): Promise<number> => {
    const before = answers;
    radio.injectTo(carol.id, mallory.id, frame);
    await s.world.advance(2_000);
    return answers - before;
  };

  const crafted = await tryRequest(
    syncRequest({
      claimed: mallory,
      to: carol,
      ttl: 7,
      signWith: mallory,
      at: s.world.wallClock(),
    }),
  );
  s.check("a request with TTL headroom is not answered", crafted === 0);
  s.check("nor relayed onward", relayed === 0, `relayed=${String(relayed)}`);

  const unsigned = await tryRequest(
    syncRequest({
      claimed: mallory,
      to: carol,
      ttl: 0,
      at: s.world.wallClock(),
    }),
  );
  s.check("an unsigned request is not answered", unsigned === 0);

  const misattributed = await tryRequest(
    syncRequest({
      claimed: alice,
      to: carol,
      ttl: 0,
      signWith: alice,
      at: s.world.wallClock(),
    }),
  );
  s.check(
    "a request naming someone other than the link's peer is not answered",
    misattributed === 0,
  );

  const genuine = await tryRequest(
    syncRequest({
      claimed: mallory,
      to: carol,
      ttl: 0,
      signWith: mallory,
      at: s.world.wallClock(),
    }),
  );
  s.check(
    "the link peer's own signed request is answered",
    genuine > 0,
    `answers=${String(genuine)}`,
  );
  stop();

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

// Carol, having met alice, now alone with mallory, who she asks for a sync on
// every round: the neighbour whose replies are exempt from the window.
async function askedNeighbour(s: Scenario): Promise<{
  radio: RadioFabric;
  alice: SimDevice;
  carol: SimDevice;
  mallory: SimDevice;
  channel: string;
}> {
  const { radio, devices } = phones(s, ["alice", "carol", "mallory"]);
  const [alice, carol, mallory] = devices;
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const channel = "#den";
  for (const d of devices) d.joinChannel(channel);
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(alice.peerID),
    45_000,
  );
  s.check("carol holds alice's key", met);
  radio.setTopology([["carol", "mallory"]]);
  await waitForCoarse(
    s.world,
    () => radio.isLinked("carol", "mallory"),
    30_000,
  );
  let asked = false;
  const stopTap = radio.tapWrites((who, linkID, dataBase64) => {
    if (who !== carol.id || linkID !== `link:${mallory.id}`) return;
    const p = decodePacket(base64ToBytes(dataBase64));
    if (p?.type === PacketType.REQUEST_SYNC) asked = true;
  });
  const requested = await waitFor(s.world, () => asked, 40_000);
  stopTap();
  s.check("carol asked mallory for a sync", requested);
  return { radio, alice, carol, mallory, channel };
}

test("S12 a sync reply is taken only inside the window it would be served for", async () => {
  // bitchat-ios serves six hours of public history, so a reply that old is
  // backfill. One from two days ago is a recording wearing the flag.
  const s = (scenario = new Scenario({
    id: "S12",
    title: "old IS_RSR replays against the message window",
    seed: 112,
  }));
  const { radio, alice, carol, mallory, channel } = await askedNeighbour(s);
  const now = s.world.wallClock();
  const reply = (text: string, ageMs: number): void => {
    radio.injectTo(
      carol.id,
      mallory.id,
      asReply(signedPublicMessage(alice, channel, text, now - ageMs, text)),
    );
  };

  reply("from two days ago", 2 * 24 * 60 * 60_000);
  reply("from ten minutes ago", 10 * 60_000);
  reply("from five hours ago", 5 * 60 * 60_000);
  await s.world.advance(3_000);
  s.check(
    "a two-day-old reply is refused",
    !carol.texts(channel).includes("from two days ago"),
  );
  s.check(
    "a ten-minute-old reply is backfilled",
    carol.texts(channel).includes("from ten minutes ago"),
  );
  s.check(
    "and one from five hours ago, inside bitchat-ios's six",
    carol.texts(channel).includes("from five hours ago"),
    `carol thread = [${carol.texts(channel).join(" | ")}]`,
  );
  s.assert(true);
});

test("S13 a sync reply carrying TTL is refused", async () => {
  // A reply is link-local by construction. One with hops left would be relayed
  // with its exemption intact, and the next node, which also asked us, would
  // take it too.
  const s = (scenario = new Scenario({
    id: "S13",
    title: "IS_RSR with TTL headroom",
    seed: 113,
  }));
  const { radio, alice, carol, mallory, channel } = await askedNeighbour(s);
  const at = s.world.wallClock() - 10 * 60_000;
  radio.injectTo(
    carol.id,
    mallory.id,
    asReply(signedPublicMessage(alice, channel, "hops left", at, "ttl7"), 7),
  );
  radio.injectTo(
    carol.id,
    mallory.id,
    asReply(signedPublicMessage(alice, channel, "link-local", at, "ttl0")),
  );
  await s.world.advance(3_000);
  s.check(
    "the reply with TTL 7 is refused",
    !carol.texts(channel).includes("hops left"),
  );
  s.check(
    "the same reply at TTL 0 is taken",
    carol.texts(channel).includes("link-local"),
  );
  s.assert(true);
});

test("S14 a stale packet at TTL 0 without IS_RSR is refused", async () => {
  // bitchat-android answers a sync with TTL 0 and no flag. bitchat-ios refuses
  // those once they are stale, and so does Airhop: TTL 0 alone claims nothing.
  const s = (scenario = new Scenario({
    id: "S14",
    title: "TTL 0 is not a sync reply",
    seed: 114,
  }));
  const { radio, alice, carol, mallory, channel } = await askedNeighbour(s);
  const at = s.world.wallClock() - 10 * 60_000;
  radio.injectTo(
    carol.id,
    mallory.id,
    stripped(signedPublicMessage(alice, channel, "no flag", at, "noflag"), 0),
  );
  await s.world.advance(3_000);
  s.check(
    "a ten-minute-old packet at TTL 0 without IS_RSR is refused",
    !carol.texts(channel).includes("no flag"),
  );
  s.assert(true);
});

test("S10 catching up on someone who has since gone quiet", async () => {
  // Sync re-serves a message for six hours but its author's announce for
  // only one, so history often comes from someone no longer announcing. Carol
  // met alice earlier, and the key she pinned then must still verify it.
  const s = (scenario = new Scenario({
    id: "S10",
    title: "history from a quiet author still verifies",
    seed: 100,
  }));
  const { radio, devices } = phones(s, ["alice", "bob", "carol"]);
  const [alice, bob, carol] = devices;
  radio.setFullMesh();
  for (const d of devices) d.launch();
  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  const met = await waitForCoarse(
    s.world,
    () => carol.peers().includes(alice.peerID),
    45_000,
  );
  s.check("carol learned alice's identity first", met);

  s.world.say("TOPOLOGY_CHANGE", "carol walks away");
  radio.setTopology([["alice", "bob"]]);
  const text = "the pharmacy on fifth is open";
  alice.send(channel, text);
  const bobHeard = await waitFor(
    s.world,
    () => bob.texts(channel).includes(text),
    20_000,
  );
  s.check("bob heard alice while carol was away", bobHeard);

  // Past the 60s a peer stays reachable, well inside the sync window.
  s.world.say("TOPOLOGY_CHANGE", "alice leaves; bob is alone");
  radio.setTopology([]);
  await s.world.advance(3 * 60_000);

  s.world.say("TOPOLOGY_CHANGE", "carol returns to bob");
  radio.setTopology([["bob", "carol"]]);
  const caughtUp = await waitForCoarse(
    s.world,
    () => carol.texts(channel).includes(text),
    60_000,
  );
  s.check(
    "carol caught up on alice's message",
    caughtUp,
    `carol thread = [${carol.texts(channel).join(" | ")}]`,
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});
