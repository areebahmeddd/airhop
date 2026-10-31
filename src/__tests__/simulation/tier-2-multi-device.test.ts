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

import { base64ToBytes, bytesToBase64 } from "@core/encoding/base64";
import {
  ANNOUNCE_TTL,
  encodeAnnouncePayload,
} from "@core/mesh/discovery/announce-manager";
import {
  decodePacket,
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
  // it. That is the signature rule working as designed (bitchat behaves the
  // same way), but it makes "did it arrive" a question about announce timing
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
  // flood network, and would make this scenario flaky rather than wrong.
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
  // Everyone has to know everyone first. A public message is shown only by a
  // phone holding its author's key, so speaking before the announces land
  // would be dropped for that reason and the radio would never be tested.
  const met = await waitForCoarse(
    s.world,
    () => devices.every((d) => d.peerCount() === devices.length - 1),
    60_000,
  );
  s.check(
    "every phone learned every other before anyone spoke",
    met,
    `peer counts: ${devices.map((d) => d.peerCount()).join(",")}`,
  );

  const channel = "#bluetooth";
  for (const d of devices) d.joinChannel(channel);
  devices[0].send(channel, "lossy hello");
  devices[3].send(channel, "lossy reply");

  // A flood on a 20%-loss radio can miss a phone, and gossip sync is what
  // makes up for it, one round every 15s. Two rounds and more, so a phone the
  // flood missed has been asked at least twice.
  await advanceFor(s.world, 35_000);
  await waitForCoarse(
    s.world,
    () => convergence(devices, channel).length === 0,
    30_000,
  );

  s.expectNone("convergence", convergence(devices, channel));
  const received = devices.map(
    (d) => d.messages(channel).filter((m) => !m.isMine).length,
  );
  s.check(
    "every phone holds both messages, less its own",
    received.every((n, i) => n === (i === 0 || i === 3 ? 1 : 2)),
    `inbound per phone: ${received.join(",")}`,
  );
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
  // can still DISCOVER the other. Asserting on link existence would be wrong:
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

  s.expectNone("convergence", convergence(devices, channel));
  const shouters = new Set([0, 5, 11, 17, 23]);
  const received = devices.map(
    (d) => d.messages(channel).filter((m) => !m.isMine).length,
  );
  s.check(
    "every phone holds all five shouts, less its own",
    received.every((n, i) => n === (shouters.has(i) ? 4 : 5)),
    `inbound per phone: ${received.join(",")}`,
  );
  // A crowd is capped at six central links per phone, so the room cannot be a
  // full graph, and the proof that it was a mesh is a shout that reached
  // someone its author held no link to. That copy had to be relayed.
  const byPeer = new Map(devices.map((d) => [d.peerID, d]));
  const relayed = devices.flatMap((d) =>
    d
      .messages(channel)
      .filter((m) => !m.isMine)
      .flatMap((m) => {
        const author = byPeer.get(m.senderID);
        return author !== undefined && !radio.isLinked(author.id, d.id)
          ? [`${author.id}->${d.id}`]
          : [];
      }),
  );
  s.check(
    "a shout crossed at least one relay to reach someone",
    relayed.length > 0,
    `${String(relayed.length)} relayed deliveries (e.g. ${relayed.slice(0, 3).join(" ")}), ${radio.linkCount()} links, airtime: ${radio.airtimeReport()}`,
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

  // A link-up must not mint a freshly timestamped ANNOUNCE and PREKEY_BUNDLE
  // and broadcast the bundle to EVERY link rather than the new one. A fresh
  // timestamp means a fresh packet ID, which no relay anywhere in the mesh can
  // deduplicate, so each such packet flood-fills the whole room at TTL 7:
  // twelve phones forming a room would put thousands of prekey bundles and
  // announces on the air inside half a second.
  //
  // The numbers below are ceilings at about twice what this seed carries
  // (2,061 packets: 1,018 announces, 1,043 prekey bundles), not targets. They
  // are here to fail loudly if control traffic goes quadratic, and tight
  // enough that doubling it does too. Re-measure if the seed or the room
  // changes.
  s.check(
    "the room settled rather than growing without bound",
    total < 4_500,
    `${total} packets carried, ${radio.airtimeReport()}`,
  );
  s.check(
    "prekey bundles did not dominate the air",
    prekey < 2_500,
    `PREKEY_BUNDLE=${prekey}`,
  );
  s.check(
    "announces did not dominate the air",
    announce < 2_500,
    `ANNOUNCE=${announce}`,
  );
  // With no room the ceilings above pass on empty air, so the room has to
  // have formed: nearly everyone heard nearly everyone, over a crowd's worth of
  // links (this seed forms 51 and every phone hears all eleven others).
  s.check(
    "the room actually formed, so the ceilings measured real traffic",
    radio.linkCount() >= 45 && devices.every((d) => d.peerCount() >= 10),
    `links=${radio.linkCount()} peers=${devices.map((d) => d.peerCount()).join(",")}`,
  );
  s.expectNone("process health", noCrashes(devices));
  s.assert(true);
});

test("B08 a message sent to a peer that just rebooted still arrives, once", async () => {
  // A link drop keeps the Noise session and ratchet on purpose (radios drop
  // links constantly). A crash or a dead battery is a link drop with no LEAVE,
  // so the other side comes back with no session while this one still seals
  // to the old chain. The message is dropped on arrival until the next
  // handshake, so a direct-link "sent" stays queued until the receipt like any
  // other send, and the retry reuses the message id so the recipient shows it
  // exactly once.
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

test("B08b a rehandshake with a peer whose last announce is past the TTL ends on one ratchet", async () => {
  // The ratchet is seeded when a handshake completes, from what we know of the
  // peer then, and that lookup must not go through the 60s reachability
  // window. Through it, a peer whose last announce had aged out would get no
  // fresh ratchet and keep the previous session's: alice seals to her new
  // chain, bob opens with his old one, and every DM between them fails
  // silently.
  const s = (scenario = new Scenario({
    id: "B08b",
    title: "rehandshake against an aged-out announce",
    seed: 81,
  }));
  const { radio, devices } = phones(s, 2);
  const [alice, bob] = devices;
  for (const d of devices) d.launch();
  await waitFor(s.world, () => alice.peers().includes(bob.peerID));

  bob.send(`dm:${alice.peerID}`, "before the reboot");
  await waitFor(s.world, () => alice.texts(`dm:${bob.peerID}`).length > 0);

  alice.relaunch();
  // The moment bob answers alice's new handshake, her entry in his registry
  // reads as last heard over a minute ago.
  let aged = false;
  const stop = radio.tapWrites((who, _link, data) => {
    if (who !== bob.id || aged) return;
    const raw = base64ToBytes(data);
    if (raw[1] !== PacketType.NOISE_HANDSHAKE) return;
    const registry = (
      bob.mesh as unknown as {
        registry: { peers: Map<string, { lastSeenMs: number }> };
      }
    ).registry;
    const entry = registry.peers.get(alice.peerID);
    if (entry === undefined) return;
    entry.lastSeenMs -= 2 * 60_000;
    aged = true;
  });
  await waitFor(s.world, () => alice.peers().includes(bob.peerID));
  alice.send(`dm:${bob.peerID}`, "after the reboot");

  const landed = await waitFor(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("after the reboot"),
    60_000,
  );
  stop();
  s.check("bob's entry for alice was past its TTL at the handshake", aged);
  s.check("the DM reaches bob", landed);
  const delivered = await waitFor(
    s.world,
    () =>
      alice
        .messages(`dm:${bob.peerID}`)
        .find((m) => m.text === "after the reboot")?.status === "delivered",
    60_000,
  );
  s.check("and alice sees it delivered", delivered);
  s.check(
    "exactly once",
    bob.texts(`dm:${alice.peerID}`).filter((t) => t === "after the reboot")
      .length === 1,
  );
  s.expectNone("process health", noCrashes(devices));
  s.assert();
});

test("B08c a rehandshake whose msg3 is lost converges without a restart", async () => {
  // Alice comes back from a crash and opens a new session. She completes it
  // on bob's msg2; her msg3 never reaches him, so he keeps the old one. Each
  // side now seals under keys the other does not hold, and neither side's
  // recovery fires, since each still has a session. She then walks out of
  // range for longer than his attempt lasts, as the link that lost msg3
  // usually means.
  const s = (scenario = new Scenario({
    id: "B08c",
    title: "rehandshake with a lost msg3",
    seed: 82,
  }));
  const { radio, devices } = phones(s, 2);
  const [alice, bob] = devices;
  for (const d of devices) d.launch();
  await waitFor(s.world, () => alice.peers().includes(bob.peerID));

  bob.send(`dm:${alice.peerID}`, "before the crash");
  await waitFor(s.world, () => alice.texts(`dm:${bob.peerID}`).length > 0);

  let lost = false;
  const restore = radio.loseWrites((fromID, data) => {
    if (fromID !== alice.id || lost) return false;
    const p = decodePacket(base64ToBytes(data));
    if (p?.type !== PacketType.NOISE_HANDSHAKE || p.payload.length !== 64) {
      return false;
    }
    lost = true;
    return true;
  });
  alice.relaunch();
  await waitFor(s.world, () => lost, 30_000);
  restore();
  s.check("alice's msg3 was lost", lost);
  radio.setIsolated(alice.id, true);
  await s.world.advance(150_000);
  radio.setIsolated(alice.id, false);
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 60_000);

  bob.send(`dm:${alice.peerID}`, "after the crash");
  const landed = await waitFor(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("after the crash"),
    180_000,
  );
  s.check("bob's DM reaches alice", landed);
  alice.send(`dm:${bob.peerID}`, "and back");
  const back = await waitFor(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("and back"),
    30_000,
  );
  s.check("and alice's reply reaches bob", back);
  s.check(
    "exactly once",
    alice.texts(`dm:${bob.peerID}`).filter((t) => t === "after the crash")
      .length === 1,
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

// What alice's QR scan of bob's card leaves behind: a verified contact with
// his durable npub, so a DM to him can go over the relays.
function scanCard(s: Scenario, alice: SimDevice, bob: SimDevice): void {
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
}

function outboxIDs(d: SimDevice): string[] {
  return (d.store("outboxStore").getState().pending as { id: string }[]).map(
    (m) => m.id,
  );
}

// Every copy of `text` bob shows, across all his threads.
function copiesOf(d: SimDevice, text: string): number {
  return Object.values(d.allMessages())
    .flat()
    .filter((m) => m.text === text).length;
}

test("B09b an internet DM to someone offline waits on the relay, never fails, and lands once", async () => {
  // A relay holds a gift wrap for days, and the inbox reads a week back, so a
  // recipient who stays offline is not a failed send. The message stays queued
  // for the receipt, keeps its tick, is not republished on every sweep, and
  // survives a relaunch.
  const s = (scenario = new Scenario({
    id: "B09b",
    title: "internet DM to an offline contact",
    seed: 91,
  }));
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(
    s.world,
    { id: "alice", platform: "android", seedByte: 11, internetEnabled: true },
    relay,
  );
  const bob = SimDevice.create(
    s.world,
    { id: "bob", platform: "ios", seedByte: 22, internetEnabled: true },
    relay,
  );
  s.track(alice, bob);
  alice.launch();
  await waitFor(s.world, () => relay.connectionCount("alice") > 0, 20_000);
  // Bob's keys exist once his app has run; then his phone goes dark.
  bob.launch();
  scanCard(s, alice, bob);
  const bobNpub = bob.nostrPubkey;
  bob.kill();

  const thread = `dm:${bob.peerID}`;
  const wrapsToBob = (): number =>
    relay
      .eventsOfKind(1059)
      .filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === bobNpub))
      .length;
  const status = (): string | undefined =>
    alice.messages(thread).find((m) => m.text === "are you there")?.status;

  alice.send(thread, "are you there");
  const msgID = alice
    .messages(thread)
    .find((m) => m.text === "are you there")?.id;
  await waitFor(s.world, () => wrapsToBob() > 0, 20_000);
  s.check(
    "it waits in the outbox for bob's receipt",
    msgID !== undefined && outboxIDs(alice).includes(msgID),
  );

  // Half an hour of sweeps, announces and foregrounds with bob offline.
  await s.world.advance(30 * 60_000, 1_000);
  s.check(
    "a relay holding it is not asked again on every sweep",
    wrapsToBob() === 1,
    `wraps=${String(wrapsToBob())}`,
  );
  s.check(
    "its bubble keeps the tick, never failed",
    status() === "sent",
    `status=${String(status())}`,
  );

  alice.kill();
  alice.relaunch();
  await waitFor(s.world, () => relay.connectionCount("alice") > 0, 20_000);
  s.check(
    "a relaunch keeps it queued",
    msgID !== undefined && outboxIDs(alice).includes(msgID),
  );

  bob.relaunch();
  const landed = await waitFor(
    s.world,
    () => copiesOf(bob, "are you there") > 0,
    60_000,
  );
  s.check("bob fetches it from the relay when he comes online", landed);
  const acked = await waitFor(
    s.world,
    () => msgID !== undefined && !outboxIDs(alice).includes(msgID),
    60_000,
  );
  s.check("his receipt resolves alice's entry", acked);
  s.check(
    "and her bubble says delivered",
    status() === "delivered" || status() === "read",
    `status=${String(status())}`,
  );
  s.check(
    "bob shows it once",
    copiesOf(bob, "are you there") === 1,
    `copies=${String(copiesOf(bob, "are you there"))}`,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("B09c a DM a relay holds goes over Bluetooth when they walk into range, and shows once", async () => {
  // Bob has no internet, so the relay copy waits. When he walks into range the
  // next flush prefers the radio, and the relay copy he fetches later
  // collapses on its message id.
  const s = (scenario = new Scenario({
    id: "B09c",
    title: "relay-queued DM delivered over BLE",
    seed: 92,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(
    s.world,
    { id: "alice", platform: "android", seedByte: 11, internetEnabled: true },
    relay,
  );
  const bob = SimDevice.create(
    s.world,
    { id: "bob", platform: "android", seedByte: 22, internetEnabled: false },
    relay,
  );
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  radio.setIsolated(bob.id, true);
  alice.launch();
  bob.launch();
  await waitFor(s.world, () => relay.connectionCount("alice") > 0, 20_000);
  scanCard(s, alice, bob);

  const thread = `dm:${bob.peerID}`;
  alice.send(thread, "walk this way");
  const msgID = alice
    .messages(thread)
    .find((m) => m.text === "walk this way")?.id;
  await s.world.advance(5_000);
  s.check(
    "the relay copy waits in the outbox",
    msgID !== undefined && outboxIDs(alice).includes(msgID),
  );

  radio.setIsolated(bob.id, false);
  const overRadio = await waitFor(
    s.world,
    () => copiesOf(bob, "walk this way") > 0,
    60_000,
  );
  s.check("bob gets it over Bluetooth", overRadio);
  const acked = await waitFor(
    s.world,
    () => msgID !== undefined && !outboxIDs(alice).includes(msgID),
    30_000,
  );
  s.check("his radio receipt resolves the entry", acked);

  bob.setSetting("internetEnabled", true);
  await waitFor(s.world, () => relay.connectionCount("bob") > 0, 20_000);
  await s.world.advance(20_000);
  s.check(
    "the relay copy he fetches later collapses into the one he has",
    copiesOf(bob, "walk this way") === 1,
    `copies=${String(copiesOf(bob, "walk this way"))}`,
  );

  s.expectNone("rendered once", exactlyOnce([alice, bob]));
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
    payload: encodeAnnouncePayload(bob.identity, "bob"),
  };
  announce.signature = signPacket(announce, bob.identity.signingPrivKey);
  const emitter = alice.eventEmitter as {
    emit: (event: string, body: unknown) => void;
  };
  // Inside alice's frame: the router delivers only to the running device.
  eventRouter().runAs(alice.id, () => {
    emitter.emit("AirhopBLE.packetReceived", {
      linkID: heldLinks[0],
      dataBase64: bytesToBase64(encodePacket(announce)),
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
