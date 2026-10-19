// The features that only mean anything with more than two phones in the room.
//
// Store-and-forward, private groups and the bulletin board all have unit tests
// for their wire formats and their stores. None of that says whether the
// FEATURE works, because every one of them is defined by what a third device
// does: a courier is a phone carrying somebody else's mail, a group is
// meaningful only because a non-member is present and cannot read it. The
// internet gateway and the mesh bridge have their own file,
// gateway-bridge.test.ts.
//
// So each scenario here puts the bystander in the room and asserts what they
// can and cannot see.

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
// A Tor client that starts and never finishes bootstrapping, which is what a
// network that filters Tor looks like from the app: no error to react to, only
// a deadline that passes. Every way the real one can fail to carry traffic
// (an ABI it was not packaged for, a blocked network, a stalled bootstrap)
// reaches the app as this.
jest.mock("@bridge/NativeAirhopTor", () => {
  const stalled = {
    isReady: false,
    isStarting: true,
    port: 0,
    progress: 5,
    bootstrapSummary: "connecting to a relay",
  };
  return {
    __esModule: true,
    default: {
      startTor: async () => undefined,
      stopTor: async () => undefined,
      wipeTorState: async () => undefined,
      holdRoute: async () => undefined,
      setAppForeground: async () => undefined,
      getTorStatus: async () => stalled,
      awaitTorReady: (timeoutSeconds: number) =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), timeoutSeconds * 1000),
        ),
      addListener: () => undefined,
      removeListeners: () => undefined,
    },
    subscribeTorStatus: () => null,
  };
});

import { base64ToBytes } from "@core/encoding/base64";
import { NoisePayloadType } from "@core/mesh/wire/noise-payload";
import { decodePacket, PacketType } from "@core/mesh/wire/packet-codec";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SimDevice, type DeviceSpec } from "../harness/device";
import { exactlyOnce, noCrashes, noForgedSenders } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { RelayFabric } from "../harness/relay-fabric";
import { advanceFor, Scenario, waitForCoarse } from "../harness/scenario";

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

// Whether `needle` occurs anywhere in `haystack`.
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

const android = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
});

test("F01 a private group is unreadable to the phone standing next to it", async () => {
  const s = (scenario = new Scenario({
    id: "F01",
    title: "creator, two members, and one outsider in radio range",
    seed: 600,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  const carol = SimDevice.create(s.world, android("carol", 33));
  const dave = SimDevice.create(s.world, android("dave", 44));
  const cast = [alice, bob, carol, dave];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();

  await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peerCount() === 3),
    30_000,
  );

  // No prior conversation. Grouping people you have never messaged is the
  // ordinary case (you pick them off the radar), and the invite has to survive
  // the handshake it triggers.
  // Dave is in the room and is NOT invited. That is the whole point.
  const groupID = alice.createGroup("south gate crew", [
    bob.peerID,
    carol.peerID,
  ]);
  s.check("the group was created", groupID !== null, `id=${String(groupID)}`);
  if (groupID === null) {
    s.assert();
    return;
  }

  // The roster and key travel to each member inside their Noise session, so
  // members have to learn the group before they can read anything.
  const membersKnow = await waitForCoarse(
    s.world,
    () => bob.knowsGroup(groupID) && carol.knowsGroup(groupID),
    45_000,
  );
  s.check(
    "both invited members received the signed roster",
    membersKnow,
    `bob=${String(bob.knowsGroup(groupID))} carol=${String(carol.knowsGroup(groupID))}`,
  );

  const channel = `group:${groupID}`;
  alice.send(channel, "regroup at the fountain");
  await s.world.settle(30_000);

  s.check(
    "an invited member can read it",
    bob.texts(channel).includes("regroup at the fountain"),
    `bob=[${bob.texts(channel).join(" | ")}]`,
  );
  s.check(
    "the other invited member can read it too",
    carol.texts(channel).includes("regroup at the fountain"),
    `carol=[${carol.texts(channel).join(" | ")}]`,
  );
  s.check(
    "the outsider in the same room never learned the group",
    !dave.knowsGroup(groupID),
    `dave groups=[${dave.groups().join(",")}]`,
  );
  const daveSawIt = Object.values(dave.allMessages())
    .flat()
    .some((m) => m.text.includes("regroup at the fountain"));
  s.check(
    "and cannot read the message in any thread",
    !daveSawIt,
    `dave threads=${JSON.stringify(
      Object.fromEntries(
        Object.entries(dave.allMessages()).map(([k, v]) => [k, v.length]),
      ),
    )}`,
  );
  s.expectNone("no forged senders", noForgedSenders(cast));
  s.expectNone("exactly once", exactlyOnce(cast));
  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F02 a bulletin notice outlives the conversation and reaches a latecomer", async () => {
  const s = (scenario = new Scenario({
    id: "F02",
    title: "a notice pinned to the mesh, read by someone who arrives after",
    seed: 601,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  const latecomer = SimDevice.create(s.world, android("latecomer", 55));
  const cast = [alice, bob, latecomer];
  for (const d of cast) radio.add(d);
  s.track(...cast);

  // The latecomer is not in range yet: this is a notice left for whoever walks
  // past an hour later, which is the case the board exists for.
  radio.setTopology([["alice", "bob"]]);
  alice.launch();
  bob.launch();
  latecomer.launch();
  await waitForCoarse(s.world, () => alice.peerCount() === 1, 30_000);

  const posted = alice.postNotice("water station at the south entrance");
  s.check("the notice was signed and broadcast", posted);

  const bobGotIt = await waitForCoarse(
    s.world,
    () => bob.notices().some((n) => n.content.includes("water station")),
    30_000,
  );
  s.check(
    "a peer in range received it",
    bobGotIt,
    `bob notices=[${bob
      .notices()
      .map((n) => n.content)
      .join(" | ")}]`,
  );

  // Now the latecomer walks in. Nobody re-posts anything; gossip sync is what
  // has to carry it.
  radio.setTopology([
    ["alice", "bob"],
    ["bob", "latecomer"],
  ]);
  const caughtUp = await waitForCoarse(
    s.world,
    () => latecomer.notices().some((n) => n.content.includes("water station")),
    60_000,
  );
  s.check(
    "someone who arrived afterwards catches up through gossip",
    caughtUp,
    `latecomer notices=[${latecomer
      .notices()
      .map((n) => n.content)
      .join(" | ")}]`,
  );
  // The key is the attribution, since a nickname is anybody's to claim.
  const aliceKey = bytesToHex(alice.identity.signingPubKey);
  s.check(
    "and it is attributed to its author",
    latecomer.notices().length > 0 &&
      latecomer
        .notices()
        .every((n) => n.authorKey === aliceKey && n.author === alice.nickname),
    `authors=[${latecomer
      .notices()
      .map((n) => `${n.author}:${n.authorKey.slice(0, 8)}`)
      .join(",")}] alice=${aliceKey.slice(0, 8)}`,
  );
  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F03 a message for someone out of range is carried by a third phone", async () => {
  const s = (scenario = new Scenario({
    id: "F03",
    title: "store-and-forward: the carrier cannot read what it carries",
    seed: 602,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const carrier = SimDevice.create(s.world, android("carrier", 22));
  const bob = SimDevice.create(s.world, android("bob", 33));
  const cast = [alice, carrier, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();

  // Everyone meets first, so alice holds bob's static key and prekeys (a
  // courier envelope is sealed to them) and the carrier knows both.
  await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peerCount() === 2),
    30_000,
  );
  await s.world.advance(10_000);
  s.check("everyone met at least once", alice.peers().includes(bob.peerID));

  // Every frame the carrier is party to, either way. What a carrier can read
  // is exactly what crossed its radio, so this is the whole of its view.
  const text = "meet me at the north gate";
  const plaintext = new TextEncoder().encode(text);
  const carrierAir: { from: string; bytes: Uint8Array }[] = [];
  const stopTap = radio.tapWrites((who, linkID, dataBase64) => {
    if (who !== carrier.id && linkID !== `link:${carrier.id}`) return;
    carrierAir.push({ from: who, bytes: base64ToBytes(dataBase64) });
  });

  // Bob leaves, past the registry's minute, so he is gone rather than quiet
  // and the DM goes to the carrier instead of flooding a room he is not in.
  radio.setIsolated("bob", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"), 20_000);
  await s.world.advance(90_000);

  const status = alice.send(`dm:${bob.peerID}`, text);
  s.check("alice handed it to a carrier", status === "carried", status);

  const bag = (carrier.mesh as unknown as { courier: { size: number } })
    .courier;
  const held = await waitForCoarse(s.world, () => bag.size > 0, 60_000);
  s.check(
    "the carrier holds a sealed envelope",
    held,
    `size=${String(bag.size)}`,
  );

  // Alice goes too, so the only route left to bob is the carrier walking up.
  radio.setTopology([["carrier", "bob"]]);
  const delivered = await waitForCoarse(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes(text),
    180_000,
  );
  stopTap();
  s.check(
    "bob gets it from the carrier, with alice nowhere near",
    delivered && !radio.isLinked("alice", "bob"),
    `bob thread=[${bob.texts(`dm:${alice.peerID}`).join(" | ")}]`,
  );
  s.check(
    "and the carrier let go of it",
    bag.size === 0,
    `size=${String(bag.size)}`,
  );

  // The positive control for the check below: the envelope did cross the
  // carrier's radio both ways, so its silence on the plaintext means something.
  const envelopeFrames = (from: string): number =>
    carrierAir.filter(({ from: who, bytes }) => {
      if (who !== from) return false;
      const p = decodePacket(bytes);
      if (p === null) return false;
      return (
        p.type === PacketType.COURIER_ENV ||
        (p.type === PacketType.FRAGMENT &&
          p.payload[12] === PacketType.COURIER_ENV)
      );
    }).length;
  s.check(
    "the envelope reached the carrier and left it",
    envelopeFrames(alice.id) > 0 && envelopeFrames(carrier.id) > 0,
    `in=${String(envelopeFrames(alice.id))} out=${String(envelopeFrames(carrier.id))}`,
  );
  // Searched in the frame as sent and in its payload once inflated, since a
  // compressed packet would hide plaintext from a search of the raw bytes.
  const readable = carrierAir.filter(({ bytes }) => {
    const payload = decodePacket(bytes)?.payload;
    return (
      contains(bytes, plaintext) ||
      (payload !== undefined && contains(payload, plaintext))
    );
  });
  s.check(
    "no frame the carrier received or sent carries the text",
    readable.length === 0,
    `${String(readable.length)} of ${String(carrierAir.length)} frames`,
  );
  const carrierSawIt = Object.values(carrier.allMessages())
    .flat()
    .some((m) => m.text.includes("north gate"));
  s.check("and nothing the carrier shows has it either", !carrierSawIt);

  s.expectNone("exactly once", exactlyOnce(cast));
  s.expectNone("no forged senders", noForgedSenders(cast));
  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F04 Tor that cannot connect holds the relays rather than using the clear net", async () => {
  const s = (scenario = new Scenario({
    id: "F04",
    title: "a Tor client that cannot bootstrap must fail closed",
    seed: 603,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const phone = SimDevice.create(
    s.world,
    { ...android("phone", 11), internetEnabled: true },
    relay,
  );
  radio.add(phone);
  s.track(phone);
  phone.launch();
  const online = await waitForCoarse(
    s.world,
    () => relay.connectionCount("phone") > 0,
    20_000,
  );
  // The control: without it a phone that never reached a relay would pass every
  // check below.
  s.check(
    "the phone is on the internet to begin with",
    online,
    `${relay.connectionCount("phone")} relay connections`,
  );

  // The Tor screen's switch, through the real routing service: the native
  // start, the socket swap, the relay gate and the mesh rebuild.
  const result = await phone.setTorRouting(true);
  s.check(
    "the switch reports that Tor could not connect",
    !result.ok && result.reason === "timeout",
    `ok=${String(result.ok)} reason=${String(result.reason)}`,
  );
  const settings = phone.store("settingsStore").getState();
  s.check(
    "Tor is still what the user asked for, so nothing went back to direct",
    settings.torEnabled === true,
    `torEnabled=${String(settings.torEnabled)}`,
  );

  // The security property: a Tor the user asked for and cannot have is
  // neither claimed nor quietly replaced by the clear net.
  const state = phone.meshState();
  s.check(
    "Tor did not report itself active without a circuit",
    state.torActive !== true,
    `torActive=${String(state.torActive)}`,
  );
  s.check(
    "the relay pool is held behind the gate",
    state.nostrBlockedByTor === true,
    `nostrBlockedByTor=${String(state.nostrBlockedByTor)}`,
  );
  s.check(
    "and no relay connection is left open on the clear net",
    relay.connectionCount("phone") === 0,
    `${relay.connectionCount("phone")} relay connections`,
  );

  // Held, not merely slow to reconnect: a reconnect timer or a transport
  // rebuild that went direct would show up here.
  await advanceFor(s.world, 60_000);
  s.check(
    "nor does one reopen while Tor stays down",
    relay.connectionCount("phone") === 0 &&
      phone.meshState().nostrBlockedByTor === true,
    `${relay.connectionCount("phone")} relay connections after another minute`,
  );
  s.expectNone("process health", noCrashes([phone]));
  s.assert(true);
});

test("F07 a group you left stays left through the creator's next rotation", async () => {
  // Leaving is local: the creator is never told, so its next roster change
  // sends the leaver a key update. That must not bring the group back.
  const s = (scenario = new Scenario({
    id: "F07",
    title: "leave, then a rotation the creator did not know to skip",
    seed: 607,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  const carol = SimDevice.create(s.world, android("carol", 33));
  const dave = SimDevice.create(s.world, android("dave", 44));
  const cast = [alice, bob, carol, dave];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peerCount() === 3),
    30_000,
  );

  const groupID = alice.createGroup("crew", [bob.peerID, carol.peerID]);
  if (groupID === null) {
    s.check("the group was created", false);
    s.assert();
    return;
  }
  const joined = await waitForCoarse(
    s.world,
    () => bob.knowsGroup(groupID) && carol.knowsGroup(groupID),
    45_000,
  );
  s.check("both members joined", joined);

  (bob.store("groupStore").getState().leave as (groupIDHex: string) => void)(
    groupID,
  );
  // The rotation has to actually reach bob for his leave to be tested: a
  // creator that skipped him would pass the check below for nothing.
  const router = (
    alice.mesh as unknown as {
      router: {
        sendNoisePayload: (
          peerID: string,
          type: number,
          bytes: Uint8Array,
        ) => boolean;
      };
    }
  ).router;
  const sends = jest.spyOn(router, "sendNoisePayload");
  const added = (
    alice.mesh as unknown as {
      addGroupMembers: (id: string, peers: string[]) => boolean;
    }
  ).addGroupMembers(groupID, [dave.peerID]);
  s.check("alice added dave", added);

  const rotated = await waitForCoarse(
    s.world,
    () => dave.knowsGroup(groupID),
    45_000,
  );
  // A four-member roster is larger than one Bluetooth frame, so this also
  // proves the state was split rather than written whole and dropped.
  s.check("the rotation went out", rotated);
  const towardBob = sends.mock.calls
    .map((call, i) => ({ call, sent: sends.mock.results[i]?.value }))
    .filter(
      ({ call: [peer, type] }) =>
        peer === bob.peerID && type === NoisePayloadType.GROUP_KEY_UPDATE,
    );
  sends.mockRestore();
  s.check(
    "and was written toward bob, who had left",
    towardBob.length > 0 && towardBob.every(({ sent }) => sent === true),
    `key updates toward bob=${String(towardBob.length)}`,
  );
  s.check(
    "nothing was written past the Bluetooth frame",
    radio.framesOversized === 0,
    `oversized=${String(radio.framesOversized)}`,
  );
  await s.world.settle(15_000);
  s.check(
    "the member who left did not get the group back",
    !bob.knowsGroup(groupID),
  );
  s.check("a member who stayed is still in it", carol.knowsGroup(groupID));

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F08 a message for someone long gone is carried, past one frame, from the composer", async () => {
  // The case store-and-forward exists for: the recipient left more than a
  // minute ago, so the registry no longer shows them, and a carrier is in
  // range. The DM must reach the carrier, sealed to the key alice still holds,
  // rather than be flooded at a room bob is not in. A long message also seals
  // into an envelope longer than a Bluetooth frame. Written whole, the
  // carrier's radio would refuse it while the write counted as a handover, so
  // it goes as fragments, and only a complete write is a handover.
  const s = (scenario = new Scenario({
    id: "F08",
    title: "a full-size envelope reaches its carrier over Bluetooth",
    seed: 608,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const carrier = SimDevice.create(s.world, android("carrier", 22));
  const bob = SimDevice.create(s.world, android("bob", 33));
  const cast = [alice, carrier, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peerCount() === 2),
    30_000,
  );
  // Long enough for every announce to land, so alice holds bob's key to seal
  // to and the carrier's to charge the deposit against.
  await s.world.advance(10_000);
  // And a conversation first, so alice holds a session and a ratchet for bob,
  // which must not send the DM flooding into the room instead.
  alice.send(`dm:${bob.peerID}`, "see you later");
  const talked = await waitForCoarse(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("see you later"),
    120_000,
  );
  s.check("alice and bob talked while together", talked);

  radio.setIsolated("bob", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"), 20_000);
  // Past the registry's minute, so bob is gone rather than briefly quiet.
  await s.world.advance(90_000);

  // Envelope fragments from alice, told apart by the inner type byte (12) of
  // the fragment header.
  let envelopeFragments = 0;
  const stopTap = radio.tapWrites((who, _linkID, dataBase64) => {
    if (who !== alice.id) return;
    const p = decodePacket(base64ToBytes(dataBase64));
    if (p?.type !== PacketType.FRAGMENT) return;
    if (p.payload[12] === PacketType.COURIER_ENV) envelopeFragments++;
  });

  // The largest message a courier envelope can carry: sealed, past 512 bytes
  // on the air.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 255; i++) {
    text += alphabet[s.world.rng.int(0, alphabet.length - 1)];
  }
  const status = alice.send(`dm:${bob.peerID}`, text);
  s.check("alice found a courier", status === "carried", `status=${status}`);

  const courier = (
    carrier.mesh as unknown as { courier: { size: number } } | null
  )?.courier;
  const carried = await waitForCoarse(
    s.world,
    () => (courier?.size ?? 0) > 0,
    180_000,
  );
  stopTap();
  s.check("the carrier holds the envelope", carried);
  s.check(
    "it went as fragments",
    envelopeFragments > 0,
    `fragments=${String(envelopeFragments)}`,
  );
  s.check(
    "nothing was written past the Bluetooth frame",
    radio.framesOversized === 0,
    `oversized=${String(radio.framesOversized)}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F09 carried mail is not flooded at peers heard only through relays", async () => {
  // Spray-and-wait splits a budget of four copies among the carriers it meets.
  // A carrier that also sprayed every peer it heard through relays would spend
  // nothing, since a flood confirms no carrier, and every phone within seven
  // hops would end up holding a copy, re-flooded on each of their announces.
  // Only the recipient's own mail goes toward a relayed peer, once per
  // cooldown, and it still reaches them.
  const s = (scenario = new Scenario({
    id: "F09",
    title: "a carrier in a chain sprays its neighbours, not the whole mesh",
    seed: 609,
  }));
  const radio = new RadioFabric(s.world);
  const ids = ["alice", "bob", "carrier", "d", "e", "f"];
  const cast = ids.map((id, i) =>
    SimDevice.create(s.world, android(id, 11 * (i + 1))),
  );
  const [alice, bob, carrier, d, e, f] = cast;
  for (const dev of cast) radio.add(dev);
  s.track(...cast);
  const chain: [string, string][] = [
    ["alice", "carrier"],
    ["carrier", "d"],
    ["d", "e"],
    ["e", "f"],
  ];
  radio.setTopology([["alice", "bob"], ...chain]);
  for (const dev of cast) dev.launch();
  await waitForCoarse(
    s.world,
    () => cast.every((dev) => dev.peerCount() >= 5),
    60_000,
  );
  await s.world.advance(10_000);

  // Bob leaves, and alice writes once he is gone.
  radio.setTopology(chain);
  await s.world.advance(90_000);
  const status = alice.send(`dm:${bob.peerID}`, "back at the north gate");
  s.check(
    "alice handed it to the carrier",
    status === "carried",
    `status=${status}`,
  );

  interface Carried {
    courier: { size: number; envelopes: { copies: number }[] };
  }
  const bag = (dev: SimDevice) => (dev.mesh as unknown as Carried).courier;
  const originated = jest.spyOn(
    carrier.mesh as unknown as {
      sendCourierPayloadTo: (
        payload: Uint8Array,
        peerID: string,
      ) => Promise<boolean>;
    },
    "sendCourierPayloadTo",
  );
  await s.world.advance(180_000);
  const copies = [carrier, d, e, f].map((dev) =>
    bag(dev).envelopes.reduce((sum, env) => sum + env.copies, 0),
  );
  const held = `carrier=${copies[0]} d=${copies[1]} e=${copies[2]} f=${copies[3]}`;
  s.check(
    "the copies in the mesh never exceed the budget",
    copies.reduce((a, b) => a + b, 0) <= 4,
    held,
  );
  s.check(
    "a phone reached only through relays carries nothing",
    bag(f).size === 0,
    held,
  );
  const neighbours = new Set([alice.peerID, d.peerID]);
  const beyond = originated.mock.calls.filter(
    ([, peer]) => !neighbours.has(peer),
  );
  s.check(
    "the carrier sent nothing to peers it hears only through relays",
    beyond.length === 0,
    `to neighbours=${String(originated.mock.calls.length - beyond.length)}, beyond=${String(beyond.length)}`,
  );

  // Bob comes back at the far end, where no carrier holds a link to him.
  originated.mockClear();
  radio.setTopology([...chain, ["f", "bob"]]);
  const delivered = await waitForCoarse(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("back at the north gate"),
    180_000,
  );
  s.check("the mail reaches him through the relays", delivered);
  const towardBob = originated.mock.calls.filter(
    ([, peer]) => peer === bob.peerID,
  );
  s.check(
    "it is flooded toward him at most once per cooldown",
    towardBob.length <= 1,
    `floods=${String(towardBob.length)}`,
  );
  originated.mockRestore();

  s.expectNone("exactly once", exactlyOnce(cast));
  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F13 mail written with nobody in range goes to the first carrier that arrives", async () => {
  // Alice writes to bob, who left long ago, while nobody else is around, so
  // there is no carrier to seal it to. A carrier walking up later is a
  // delivery opportunity for every recipient alice owes, not only for itself.
  const s = (scenario = new Scenario({
    id: "F13",
    title: "a carrier that arrives late still takes the mail",
    seed: 610,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const carrier = SimDevice.create(s.world, android("carrier", 22));
  const bob = SimDevice.create(s.world, android("bob", 33));
  const cast = [alice, carrier, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () => cast.every((d) => d.peerCount() === 2),
    30_000,
  );
  await s.world.advance(10_000);

  radio.setIsolated("bob", true);
  radio.setIsolated("carrier", true);
  await waitForCoarse(
    s.world,
    () =>
      !radio.isLinked("alice", "bob") && !radio.isLinked("alice", "carrier"),
    20_000,
  );
  // Past the registry's minute, so both are gone rather than briefly quiet.
  await s.world.advance(90_000);

  const status = alice.send(`dm:${bob.peerID}`, "left you a note");
  s.check(
    "with nobody around it is only queued",
    status === "queued",
    `status=${status}`,
  );

  radio.setIsolated("carrier", false);
  const courier = (
    carrier.mesh as unknown as { courier: { size: number } } | null
  )?.courier;
  const carried = await waitForCoarse(
    s.world,
    () => (courier?.size ?? 0) > 0,
    120_000,
  );
  s.check("the carrier that arrived holds the envelope", carried);

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F11 a message read after its sender left still reports read, over Nostr", async () => {
  // Bob gets alice's DM over Bluetooth but opens it only after she has walked
  // away. The read receipt owed over the mesh has no route left, and bob still
  // holds the npub alice announced.
  const s = (scenario = new Scenario({
    id: "F11",
    title: "a read receipt follows its sender onto the internet",
    seed: 611,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const online = (id: string, seedByte: number): DeviceSpec => ({
    ...android(id, seedByte),
    internetEnabled: true,
  });
  const alice = SimDevice.create(s.world, online("alice", 11), relay);
  const bob = SimDevice.create(s.world, online("bob", 22), relay);
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(
    s.world,
    () =>
      alice.peers().includes(bob.peerID) &&
      bob.peers().includes(alice.peerID) &&
      relay.connectionCount("alice") > 0 &&
      relay.connectionCount("bob") > 0,
    30_000,
  );

  alice.send(`dm:${bob.peerID}`, "read me later");
  const delivered = await waitForCoarse(
    s.world,
    () =>
      alice
        .messages(`dm:${bob.peerID}`)
        .some((m) => m.text === "read me later" && m.status === "delivered"),
    120_000,
  );
  s.check("it was delivered over Bluetooth", delivered);

  radio.setIsolated("alice", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"), 20_000);
  // Past the registry's minute, so alice is gone rather than briefly quiet.
  await s.world.advance(90_000);

  bob.openThread(`dm:${alice.peerID}`);
  const read = await waitForCoarse(
    s.world,
    () =>
      alice
        .messages(`dm:${bob.peerID}`)
        .some((m) => m.text === "read me later" && m.status === "read"),
    60_000,
  );
  s.check("alice sees it read", read);

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});

test("F12 a group invite to someone who just walked off waits for them", async () => {
  // Their session outlives the link, so a live session is no proof the invite
  // was written anywhere: it has to queue until they are back. addGroupMembers
  // skips existing members, so nothing would send it again.
  const s = (scenario = new Scenario({
    id: "F12",
    title: "group created with a member whose link dropped a moment ago",
    seed: 612,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitForCoarse(s.world, () => alice.peers().includes(bob.peerID));
  alice.send(`dm:${bob.peerID}`, "hello");
  await waitForCoarse(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).length > 0,
  );

  radio.setIsolated("bob", true);
  await waitForCoarse(s.world, () => !radio.isLinked("alice", "bob"));
  const groupID = alice.createGroup("crew", [bob.peerID]);
  s.check("the group was created", groupID !== null);
  if (groupID === null) {
    s.assert();
    return;
  }

  radio.setIsolated("bob", false);
  const joined = await waitForCoarse(
    s.world,
    () => bob.knowsGroup(groupID),
    45_000,
  );
  s.check("bob gets the invite once he is back", joined);

  s.expectNone("process health", noCrashes(cast));
  s.assert(true);
});
