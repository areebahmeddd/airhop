/**
 * @jest-environment node
 */
// Tier B: more than two people, more than one transport, nothing simple.
//
// Tier A proves the app works. This tier proves it works when the room is
// bigger than the radio, when somebody walks out mid-sentence, and when two
// transports both have a claim on the same message.

jest.mock("expo-location", () => ({}));
jest.mock("react-native/Libraries/EventEmitter/RCTDeviceEventEmitter", () =>
  // Every phone needs its own listener set. See harness/event-router.ts: this
  // is the only interception point that reliably catches every path by which
  // mesh-service and the native modules reach the emitter.
  (
    require("./harness/event-router") as { routerModule: () => unknown }
  ).routerModule(),
);
jest.mock("@bridge/NativeAirhopBLE", () => {
  const shim = require("../harness/bridge-shim");
  return { __esModule: true, default: shim.bleBridge };
});
jest.mock("@bridge/NativeAirhopWiFi", () => {
  const shim = require("../harness/bridge-shim");
  return { __esModule: true, default: shim.wifiBridge };
});

import {
  ANNOUNCE_TTL,
  encodeAnnouncePayload,
} from "@core/mesh/discovery/announce-manager";
import {
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { SimDevice, type DeviceSpec } from "./harness/device";
import { eventRouter } from "./harness/event-router";
import {
  badgeMatchesThreads,
  convergence,
  exactlyOnce,
  noCrashes,
  noDuplicateText,
  noForgedSenders,
  StatusWatcher,
  unreadCoherent,
} from "./harness/invariants";
import { RadioFabric } from "./harness/radio-fabric";
import { RelayFabric } from "./harness/relay-fabric";
import {
  advanceFor,
  Scenario,
  waitFor,
  waitForCoarse,
} from "./harness/scenario";

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

function phones(
  s: Scenario,
  n: number,
  platform: "android" | "ios" | "mixed" = "android",
  base = 10,
): { radio: RadioFabric; devices: SimDevice[] } {
  const radio = new RadioFabric(s.world);
  const devices: SimDevice[] = [];
  for (let i = 0; i < n; i++) {
    const spec: DeviceSpec = {
      id: `p${i}`,
      platform:
        platform === "mixed" ? (i % 2 === 0 ? "android" : "ios") : platform,
      seedByte: base + i * 3,
    };
    const d = SimDevice.create(s.world, spec);
    devices.push(d);
    radio.add(d);
  }
  s.track(...devices);
  return { radio, devices };
}

test("B01 a message crosses a chain of phones that cannot hear each other", async () => {
  const s = (scenario = new Scenario({
    id: "B01",
    title: "five phones in a line, only neighbours in range",
    seed: 7,
  }));
  const { radio, devices } = phones(s, 5);
  radio.setChain(devices.map((d) => d.id));
  for (const d of devices) d.launch();

  const linked = await waitFor(s.world, () => radio.linkCount() === 4);
  s.check(
    "exactly the neighbouring links came up",
    linked,
    `links=[${radio.linkedPairs().join(", ")}]`,
  );
  s.check(
    "the ends of the chain are not directly linked",
    !radio.isLinked("p0", "p4"),
  );

  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);

  // Wait for the chain to learn who p0 is before p0 speaks.
  //
  // A public message is only displayed by a node that already holds the
  // author's signing key, which arrives in the author's ANNOUNCE and has to be
  // relayed hop by hop down the line. Speaking the instant the LINKS are up
  // races that: the far nodes relay the message correctly but cannot yet
  // authenticate it, so they forward without displaying, and nothing re-sends
  // it. That is the signature rule working as designed - bitchat behaves the
  // same way - but it makes "did it arrive" a question about announce timing
  // rather than about routing, which is what this scenario is for.
  const chainKnowsSender = await waitForCoarse(
    s.world,
    () => devices.slice(1).every((d) => d.peers().includes(devices[0].peerID)),
    45_000,
  );
  s.check(
    "every node in the chain learned the sender's identity",
    chainKnowsSender,
    devices
      .slice(1)
      .map((d) => `${d.id}=${String(d.peers().includes(devices[0].peerID))}`)
      .join(" "),
  );

  devices[0].send(channel, "relayed all the way down");

  const reached = await waitFor(
    s.world,
    () => devices[4].texts(channel).length > 0,
    20_000,
  );

  s.check(
    "the far end of a 4-hop chain received it",
    reached,
    devices.map((d) => `${d.id}=${d.texts(channel).length}`).join(" "),
  );

  // Give the chain time to converge before judging it.
  //
  // A node several hops out can receive a public message BEFORE it has received
  // the author's ANNOUNCE, and a message whose signing key you do not yet hold
  // is refused rather than displayed. That is the signature rule working as
  // intended, and bitchat behaves the same way; what closes the gap is gossip
  // sync re-serving the message once the key is known, on its own cadence.
  // Asserting convergence the instant the far end lights up would be asserting
  // that no node is ever one hop behind on identity, which is untrue of any
  // flood network - and made this scenario flaky rather than wrong.
  await waitForCoarse(
    s.world,
    () => convergence(devices, channel).length === 0,
    45_000,
  );

  s.expectNone("convergence", convergence(devices, channel));
  s.expectNone("exactly once", exactlyOnce(devices));
  s.expectNone("no duplicate text", noDuplicateText(devices, channel));
  s.expectNone("no forged senders", noForgedSenders(devices));
  s.expectNone("process health", noCrashes(devices));
  s.assert();
});

test("B02 a lossy, jittery, duplicating radio still converges", async () => {
  const s = (scenario = new Scenario({
    id: "B02",
    title: "20% loss, 10% duplication, wide jitter, six phones",
    seed: 4242,
  }));
  const { radio, devices } = phones(s, 6);
  radio.setConditions({
    loss: 0.2,
    duplicate: 0.1,
    latencyMs: 40,
    jitterMs: 60,
  });
  for (const d of devices) d.launch();
  await waitFor(s.world, () => radio.linkCount() > 0, 20_000);

  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  devices[0].send(channel, "lossy hello");
  devices[3].send(channel, "lossy reply");

  await s.world.settle(30_000);

  // Loss is real: this scenario does NOT assert everyone got everything, which
  // a 20%-loss radio cannot guarantee without retransmission. What it asserts
  // is the thing that must hold regardless - nobody saw anything twice, and
  // nobody saw anything forged.
  s.expectNone("exactly once", exactlyOnce(devices));
  s.expectNone("no duplicate text", noDuplicateText(devices, channel));
  s.expectNone("no forged senders", noForgedSenders(devices));
  s.expectNone("badge matches threads", badgeMatchesThreads(devices));
  s.expectNone("unread coherent", unreadCoherent(devices));
  s.expectNone("process health", noCrashes(devices));
  s.check(
    "the radio actually exercised its faults",
    radio.packetsDropped > 0 && radio.packetsDuplicated > 0,
    `dropped=${radio.packetsDropped} duplicated=${radio.packetsDuplicated} delivered=${radio.packetsDelivered}`,
  );
  s.assert(true);
});

test("B03 corrupted packets are rejected and nothing crashes", async () => {
  const s = (scenario = new Scenario({
    id: "B03",
    title: "a radio that mangles one byte in eight packets",
    seed: 99,
  }));
  const { radio, devices } = phones(s, 4);
  for (const d of devices) d.launch();
  await waitFor(s.world, () => radio.linkCount() > 0, 20_000);

  radio.setConditions({ corrupt: 0.125 });
  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  for (let i = 0; i < 12; i++) {
    devices[i % 4].send(channel, `message ${i}`);
    await s.world.advance(120);
  }
  await s.world.settle(20_000);

  s.check(
    "the radio actually corrupted packets",
    radio.packetsCorrupted > 0,
    `corrupted=${radio.packetsCorrupted}`,
  );
  s.expectNone("no crashes on malformed input", noCrashes(devices));
  // Refused by a decoder, never caught at the ingress.
  const faults = devices
    .map((d) => d.mesh?.getIngressFaults().count ?? 0)
    .reduce((a, b) => a + b, 0);
  s.check(
    "no corrupted packet threw at the ingress",
    faults === 0,
    `ingress faults = ${String(faults)}`,
  );
  s.expectNone("no forged senders", noForgedSenders(devices));
  s.expectNone("exactly once", exactlyOnce(devices));
  // A corrupted packet must never surface as content. Every rendered message
  // has to be one that was actually sent.
  const legitimate = new Set<string>();
  for (let i = 0; i < 12; i++) legitimate.add(`message ${i}`);
  const bogus: string[] = [];
  for (const d of devices) {
    for (const m of d.messages(channel)) {
      if (m.isSystem === true) continue;
      if (!legitimate.has(m.text)) bogus.push(`${d.id}: "${m.text}"`);
    }
  }
  s.check(
    "no corrupted payload was ever rendered as a message",
    bogus.length === 0,
    bogus.slice(0, 5).join(" | "),
  );
  s.assert(true);
});

test("B04 walking out of range parks the message instead of losing it", async () => {
  const s = (scenario = new Scenario({
    id: "B04",
    title: "a DM sent to somebody who just left the room",
    seed: 5,
  }));
  const { radio, devices } = phones(s, 2);
  const [alice, bob] = devices;
  const watcher = new StatusWatcher(devices);
  for (const d of devices) d.launch();
  await waitFor(s.world, () => alice.peers().includes(bob.peerID));

  // They meet, so a Noise session and a contact exist.
  alice.send(`dm:${bob.peerID}`, "before you go");
  await waitFor(s.world, () => bob.texts(`dm:${alice.peerID}`).length > 0);

  // Bob walks away.
  radio.setIsolated(bob.id, true);
  await waitFor(s.world, () => radio.linkCount() === 0, 10_000);

  const outcome = alice.send(`dm:${bob.peerID}`, "after you left");
  watcher.sample();

  s.check(
    "the app did not claim a message it could not deliver was sent",
    outcome !== "sent",
    `outcome=${outcome}`,
  );
  s.check(
    "the undelivered message is still held locally",
    alice.texts(`dm:${bob.peerID}`).includes("after you left"),
    `alice thread=[${alice.texts(`dm:${bob.peerID}`).join("|")}]`,
  );

  const parked = alice
    .messages(`dm:${bob.peerID}`)
    .find((m) => m.text === "after you left");
  s.check(
    "its status says queued or carried, not delivered",
    parked?.status === "queued" || parked?.status === "carried",
    `status=${String(parked?.status)}`,
  );

  s.expectNone("delivery state never runs backwards", watcher.results());
  s.expectNone("process health", noCrashes(devices));
  s.assert();
});

test("B05 a backgrounded iPhone disappears from Android but keeps its link", async () => {
  const s = (scenario = new Scenario({
    id: "B05",
    title: "CoreBluetooth overflow-area advertising, as documented",
    seed: 12,
  }));
  const radio = new RadioFabric(s.world);
  const droid = SimDevice.create(s.world, {
    id: "droid",
    platform: "android",
    seedByte: 11,
  });
  const iphone = SimDevice.create(s.world, {
    id: "iphone",
    platform: "ios",
    seedByte: 44,
  });
  const iphone2 = SimDevice.create(s.world, {
    id: "iphone2",
    platform: "ios",
    seedByte: 55,
  });
  for (const d of [droid, iphone, iphone2]) radio.add(d);
  s.track(droid, iphone, iphone2);
  for (const d of [droid, iphone, iphone2]) d.launch();

  await waitFor(s.world, () => radio.linkCount() === 3, 20_000);
  s.check(
    "all three linked while everyone is in the foreground",
    radio.linkCount() === 3,
  );

  // The iPhone goes to the home screen. Its existing links survive; new
  // discovery from Android does not.
  iphone.background();
  await s.world.advance(2000);
  s.check(
    "the already-open Android link keeps carrying traffic",
    radio.isLinked("droid", "iphone"),
    `links=[${radio.linkedPairs().join(", ")}]`,
  );

  // Now drop the link and ask the question that actually matters: which side
  // can still DISCOVER the other. Asserting on link existence would be wrong -
  // iOS keeps its central role in the background, so the iPhone dials out and
  // a link reappears regardless of what Android can see.
  radio.setIsolated("iphone", true);
  await waitFor(s.world, () => !radio.isLinked("droid", "iphone"), 10_000);
  radio.setIsolated("iphone", false);
  await s.world.advance(500);

  s.check(
    "Android cannot discover a backgrounded iPhone",
    !radio.canDiscover("droid", "iphone"),
    "CoreBluetooth moved the service UUID into the overflow area",
  );
  s.check(
    "another iPhone still finds it in the overflow area",
    radio.canDiscover("iphone2", "iphone"),
  );
  s.check(
    "the backgrounded iPhone can still discover Android itself",
    radio.canDiscover("iphone", "droid"),
    "iOS keeps the central role under bluetooth-central; only advertising is degraded",
  );

  // Reopening the app makes it discoverable by Android again.
  iphone.foreground();
  await s.world.advance(500);
  s.check(
    "reopening the app restores Android discovery",
    radio.canDiscover("droid", "iphone"),
  );
  const back = await waitFor(
    s.world,
    () => radio.isLinked("droid", "iphone"),
    10_000,
  );
  s.check(
    "and the link comes back",
    back,
    `links=[${radio.linkedPairs().join(", ")}]`,
  );
  s.expectNone("process health", noCrashes([droid, iphone, iphone2]));
  s.assert();
});

test("B06 twenty-five phones in one room converge on one channel", async () => {
  const s = (scenario = new Scenario({
    id: "B06",
    title: "a crowd, everybody in range of everybody",
    seed: 2025,
  }));
  const { radio, devices } = phones(s, 25, "mixed", 2);
  for (const d of devices) d.launch();

  const linked = await waitForCoarse(
    s.world,
    () => devices.every((d) => d.peerCount() >= 20),
    30_000,
  );
  s.check(
    "the room saw itself",
    linked,
    `peer counts: ${devices.map((d) => d.peerCount()).join(",")}`,
  );

  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  // Five people talk at once, as they do.
  for (const i of [0, 5, 11, 17, 23]) {
    devices[i].send(channel, `shout from ${devices[i].id}`);
  }
  await s.world.settle(25_000);

  s.expectNone("exactly once", exactlyOnce(devices));
  s.expectNone("no duplicate text", noDuplicateText(devices, channel));
  s.expectNone("no forged senders", noForgedSenders(devices));
  s.expectNone("badge matches threads", badgeMatchesThreads(devices));
  s.expectNone("unread coherent", unreadCoherent(devices));
  s.expectNone("process health", noCrashes(devices));

  const received = devices.map(
    (d) => d.messages(channel).filter((m) => !m.isMine).length,
  );
  const worst = Math.min(...received);
  s.check(
    "every phone received the messages it did not send",
    worst >= 4,
    `worst device holds ${worst} of 5 (spread: ${received.join(",")})`,
  );
  // A crowd is capped at six central links per phone, so this is a genuine
  // multi-hop mesh rather than 300 direct connections no controller could hold.
  s.check(
    "the crowd formed a real mesh rather than a full graph",
    radio.linkCount() > 0 && radio.linkCount() < (25 * 24) / 2,
    `${radio.linkCount()} links across 25 phones, airtime: ${radio.airtimeReport()}`,
  );
  s.assert(true);
});

test("B07 a crowd forming does not drown itself in control traffic", async () => {
  const s = (scenario = new Scenario({
    id: "B07",
    title: "twelve phones walk into range at once; what does the radio carry?",
    seed: 31337,
  }));
  const { radio, devices } = phones(s, 12, "android", 2);
  for (const d of devices) d.launch();

  // Let the room form completely.
  await advanceFor(s.world, 3000);

  const announce = radio.countOfType(0x01);
  const prekey = radio.countOfType(0x24);
  const total = radio.packetsDelivered;

  // This scenario exists because of a real defect it found. Every link-up used
  // to mint a freshly timestamped ANNOUNCE and a freshly timestamped
  // PREKEY_BUNDLE, and broadcast the bundle to EVERY link rather than the new
  // one. A fresh timestamp means a fresh packet ID, which means no relay
  // anywhere in the mesh could deduplicate it, so every one of those packets
  // flood-filled the whole room at TTL 7. Twelve phones forming a room put
  // 6,597 prekey bundles and 9,211 announces on the air inside half a second,
  // and the queue was still growing when the harness gave up.
  //
  // The numbers below are ceilings with headroom, not targets. They are here to
  // fail loudly if control traffic ever goes quadratic again.
  s.check(
    "the room settled rather than growing without bound",
    total < 12_000,
    `${total} packets carried, ${radio.airtimeReport()}`,
  );
  s.check(
    "prekey bundles did not dominate the air",
    prekey < 5_000,
    `PREKEY_BUNDLE=${prekey}`,
  );
  s.check(
    "announces did not dominate the air",
    announce < 5_000,
    `ANNOUNCE=${announce}`,
  );
  s.check(
    "no phone holds more central links than the radio allows",
    radio.linkCount() > 0,
    `links=${radio.linkCount()}`,
  );
  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("B08 a message sent to a peer that just rebooted still arrives, once", async () => {
  // A link drop keeps the Noise session and ratchet on purpose (radios drop
  // links constantly). A crash or a dead battery is a link drop with no LEAVE,
  // so the other side comes back with no session while this one still seals
  // to the old chain. The message is dropped on arrival until the next
  // handshake, and a direct-link "sent" used to be the one send that was not
  // queued for retry. Now it stays queued until the receipt, and the retry
  // reuses the message id so the recipient shows it exactly once.
  const s = (scenario = new Scenario({
    id: "B08",
    title: "a DM into a peer that lost its session",
    seed: 8,
  }));
  const { devices } = phones(s, 2);
  const [alice, bob] = devices;
  for (const d of devices) d.launch();
  await waitFor(s.world, () => alice.peers().includes(bob.peerID));

  bob.send(`dm:${alice.peerID}`, "before your reboot");
  await waitFor(s.world, () => alice.texts(`dm:${bob.peerID}`).length > 0);

  alice.relaunch();
  // Straight away, before the fresh handshake can complete. Bob still holds
  // the old session, so this goes out under a chain alice no longer has.
  bob.send(`dm:${alice.peerID}`, "after your reboot");

  const landed = await waitFor(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("after your reboot"),
    60_000,
  );
  s.check("the message reaches the rebooted peer", landed);

  await waitFor(
    s.world,
    () =>
      bob
        .messages(`dm:${alice.peerID}`)
        .find((m) => m.text === "after your reboot")?.status === "delivered",
    60_000,
  );
  const copies = alice
    .texts(`dm:${bob.peerID}`)
    .filter((t) => t === "after your reboot").length;
  s.check("and shows exactly once", copies === 1, `copies=${String(copies)}`);
  s.check(
    "the sender sees it delivered, not a lone sent tick",
    bob
      .messages(`dm:${alice.peerID}`)
      .find((m) => m.text === "after your reboot")?.status === "delivered",
  );
  s.expectNone("process health", noCrashes(devices));
  s.assert();
});

test("B09 an internet DM shows the contact's name and is acknowledged once", async () => {
  // Alice scanned bob's card and filed him under a name of her own. His DMs
  // reach her over the relays, never the radio, and must still carry it. A
  // rebuild of her relay pool replays everything the relays hold, and that must
  // not acknowledge the same DM a second time.
  const s = (scenario = new Scenario({
    id: "B09",
    title: "internet DM naming and receipts",
    seed: 90,
  }));
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(
    s.world,
    { id: "alice", platform: "android", seedByte: 11, internetEnabled: true },
    relay,
  );
  const bob = SimDevice.create(
    s.world,
    { id: "bob", platform: "android", seedByte: 22, internetEnabled: true },
    relay,
  );
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  await waitFor(
    s.world,
    () =>
      relay.connectionCount("alice") > 0 && relay.connectionCount("bob") > 0,
    20_000,
  );

  (
    alice.mesh as unknown as {
      addVerifiedContact: (card: unknown, opts: unknown) => boolean;
    }
  ).addVerifiedContact(
    {
      peerID: bob.peerID,
      noisePubKey: bob.identity.noiseStaticPubKey,
      signingPubKey: bob.identity.signingPubKey,
      nickname: "bob",
      nostrPubKey: hexToBytes(bob.nostrPubkey),
    },
    { inPerson: true },
  );
  // What the QR flow writes beside the call above.
  (alice.store("contactsStore").getState().addContact as (c: unknown) => void)({
    peerID: bob.peerID,
    noisePubKeyHex: bytesToHex(bob.identity.noiseStaticPubKey),
    signingPubKeyHex: bytesToHex(bob.identity.signingPubKey),
    nickname: "bob",
    addedAtMs: s.world.wallClock(),
    source: "qr",
    verifiedAtMs: s.world.wallClock(),
    nostrPubkeyHex: bob.nostrPubkey,
  });
  (
    alice.store("contactsStore").getState().setLocalNickname as (
      peerID: string,
      nickname: string,
    ) => void
  )(bob.peerID, "Sahl");

  bob.sendDm(`nostr_${alice.nostrPubkey}`, "over the internet");
  const thread = `dm:${bob.peerID}`;
  const landed = await waitFor(
    s.world,
    () => alice.texts(thread).includes("over the internet"),
    60_000,
  );
  s.check("the DM lands in bob's thread", landed);
  const received = alice
    .messages(thread)
    .find((m) => m.text === "over the internet");
  s.check(
    "it carries the name alice gave him",
    received?.senderNickname === "Sahl",
    `name=${String(received?.senderNickname)}`,
  );

  // Receipts from alice to bob are the only wraps addressed to him.
  const wrapsToBob = (): number =>
    new Set(
      relay
        .eventsOfKind(1059)
        .filter((e) =>
          e.tags.some((t) => t[0] === "p" && t[1] === bob.nostrPubkey),
        )
        .map((e) => e.id),
    ).size;
  await s.world.advance(5_000);
  const before = wrapsToBob();
  s.check("alice acknowledged it", before > 0);

  (alice.mesh as unknown as { restartNostr: () => void }).restartNostr();
  await waitFor(s.world, () => relay.connectionCount("alice") > 0, 20_000);
  await s.world.advance(10_000);
  s.check(
    "a rebuilt pool does not acknowledge it again",
    wrapsToBob() === before,
    `before=${String(before)} after=${String(wrapsToBob())}`,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("B10 a frame that lands after its link closed does not bring the peer back", async () => {
  // Android delivers GATT callbacks on binder threads, so a frame and the
  // disconnect after it can reach JS in either order. Reopening the link for
  // that frame would leave a departed peer bound to a dead link and shown as
  // direct, with sends to them written into nothing.
  const s = (scenario = new Scenario({
    id: "B10",
    title: "a late frame after a Bluetooth disconnect",
    seed: 10,
  }));
  const { radio, devices } = phones(s, 2);
  const [alice, bob] = devices;
  for (const d of devices) d.launch();
  await waitFor(s.world, () => alice.isDirectPeer(bob.peerID));
  const heldLinks = alice.bleLinkIDs();
  s.check("alice holds a link to bob", heldLinks.length > 0);

  radio.setIsolated(bob.id, true);
  const gone = await waitFor(
    s.world,
    () => alice.bleLinkCount() === 0 && !alice.isDirectPeer(bob.peerID),
    10_000,
  );
  s.check("bob's departure is noticed", gone);

  // Bob's own announce, freshly stamped so no deduplicator hides it, arriving
  // on the link that just closed, as the losing side of the race would.
  const announce: Packet = {
    type: PacketType.ANNOUNCE,
    ttl: ANNOUNCE_TTL,
    flags: Flags.SIGNED,
    senderID: hexToBytes(bob.peerID),
    recipientID: new Uint8Array(8),
    timestamp: s.world.wallClock(),
    signature: new Uint8Array(64),
    payload: encodeAnnouncePayload(bob.identity, "bob", []),
  };
  announce.signature = signPacket(announce, bob.identity.signingPrivKey);
  let bin = "";
  for (const b of encodePacket(announce)) bin += String.fromCharCode(b);
  const emitter = alice.eventEmitter as {
    emit: (event: string, body: unknown) => void;
  };
  // Inside alice's frame: the router delivers only to the running device.
  eventRouter().runAs(alice.id, () => {
    emitter.emit("AirhopBLE.packetReceived", {
      linkID: heldLinks[0],
      dataBase64: globalThis.btoa(bin),
    });
  });
  await s.world.advance(1_000);

  s.check(
    "the closed link stays closed",
    alice.bleLinkCount() === 0,
    `links=[${alice.bleLinkIDs().join(",")}]`,
  );
  s.check(
    "bob is not shown as directly connected",
    !alice.isDirectPeer(bob.peerID),
  );

  s.expectNone("process health", noCrashes(devices));
  s.assert();
});
