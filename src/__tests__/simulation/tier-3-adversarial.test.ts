/**
 * @jest-environment node
 */
// Tier C: somebody in the room is hostile, or the world is.
//
// Everything here is an attack or a failure injected on purpose. The bar is not
// "the app survives" - it is "the app refuses, and tells the user nothing false
// while refusing".

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
  encodeContactCard,
  type ContactCard,
} from "@core/crypto/contact-exchange";
import type { Identity } from "@core/crypto/identity";
import { NoiseHandshake } from "@core/crypto/noise-xx";
import { base64ToBytes } from "@core/encoding/base64";
import {
  ANNOUNCE_TTL,
  encodeAnnouncePayload,
} from "@core/mesh/discovery/announce-manager";
import {
  openChannelMessage,
  sealChannelMessage,
} from "@core/mesh/rooms/channel-crypto";
import { encodeFilePacket } from "@core/mesh/wire/file-packet";
import {
  decodePacket,
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import {
  encodePrekeyBundle,
  signPrekeyBundle,
} from "@core/mesh/wire/prekey-bundle";
import { sealGeoCard } from "@core/nostr/geo-card-proof";
import {
  channelPacketType,
  decodeAirhopChannelPayload,
  encodeAirhopChannelPayload,
  encodeMeshPublicPayload,
  MESH_PUBLIC_CHANNEL,
} from "@core/router/message-router";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { SimDevice } from "./harness/device";
import { noCrashes, noForgedSenders } from "./harness/invariants";
import { media } from "./harness/media-fabric";
import { RadioFabric } from "./harness/radio-fabric";
import { Scenario, waitFor } from "./harness/scenario";

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

function peerIdToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// The bridge carries base64, so an injected packet has to be encoded the same
// way the native module would encode it.
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 0x3f];
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// A public channel message that CLAIMS to come from `claimedPeerID`.
function forgePublicMessage(opts: {
  claimedPeerID: string;
  channel: string;
  text: string;
  timestamp: number;
  // When set, sign with this key. An attacker holds their own key and never the
  // victim's, so a signature made here can only verify against the claimed
  // peer's registered key in the one case where the caller deliberately passes
  // that peer's real key (scenario C02).
  signWith?: Uint8Array;
}): string {
  const packet: Packet = {
    // The mesh room and a named channel travel under different types, so a
    // forgery aimed at either has to use the right one to be worth testing.
    type: channelPacketType(opts.channel),
    ttl: 7,
    flags: opts.signWith !== undefined ? Flags.SIGNED : 0,
    senderID: peerIdToBytes(opts.claimedPeerID),
    recipientID: new Uint8Array(8),
    timestamp: opts.timestamp,
    signature: new Uint8Array(64),
    payload:
      opts.channel === MESH_PUBLIC_CHANNEL
        ? encodeMeshPublicPayload(opts.text)
        : encodeAirhopChannelPayload(
            opts.channel,
            opts.text,
            `forged-${String(opts.timestamp)}`,
          ),
  };
  if (opts.signWith !== undefined) {
    packet.signature = signPacket(packet, opts.signWith);
  }
  return toBase64(encodePacket(packet));
}

// An ANNOUNCE that claims `claimedPeerID`, carrying whatever key material the
// caller wants bound to it. This is the packet that decides, for every later
// packet, WHICH key a claimed sender is checked against - so getting it wrong
// silently defeats the signature rule that C01 pins.
function forgeAnnounce(opts: {
  claimedPeerID: string;
  noisePubKey: Uint8Array;
  signingPubKey: Uint8Array;
  nickname: string;
  timestamp: number;
  signWith?: Uint8Array;
  nostrPubKey?: Uint8Array;
}): string {
  const payload = encodeAnnouncePayload(
    {
      noiseStaticPubKey: opts.noisePubKey,
      signingPubKey: opts.signingPubKey,
    } as Identity,
    opts.nickname,
    [],
    opts.nostrPubKey,
  );
  const packet: Packet = {
    type: PacketType.ANNOUNCE,
    ttl: ANNOUNCE_TTL,
    flags: opts.signWith !== undefined ? Flags.SIGNED : 0,
    senderID: peerIdToBytes(opts.claimedPeerID),
    recipientID: new Uint8Array(8),
    timestamp: opts.timestamp,
    signature: new Uint8Array(64),
    payload,
  };
  if (opts.signWith !== undefined) {
    packet.signature = signPacket(packet, opts.signWith);
  }
  return toBase64(encodePacket(packet));
}

test("C08 a forged ANNOUNCE cannot rebind a known peer's signing key", async () => {
  // C01 proves a message is checked against the signing key bound to the peer
  // it claims to be. This proves an attacker cannot choose that key.
  //
  // The attack is one packet upstream of C01 and defeats it completely. A peer
  // ID is the first 16 hex of SHA-256(noise pubkey), and that noise key is
  // broadcast in the clear in every announce - so Mallory can replay Alice's
  // real peer ID and real noise key (both public), attach her OWN signing key,
  // and sign the announce with it. It is internally consistent: the derivation
  // matches and the signature verifies against the key inside the packet.
  // Nothing about it is detectably wrong in isolation.
  //
  // The only thing that stops it is refusing to REPLACE a signing key already
  // bound to that peer. Hence the last assertion, which is the real one: after
  // the attack, genuine traffic from the real Alice must still verify - which
  // it can only do if her original key is still the pinned one.
  const s = (scenario = new Scenario({
    id: "C08",
    title: "announce-level identity hijack",
    seed: 68,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();

  const channel = "#bluetooth";
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);
  for (const d of cast) d.joinChannel(channel);

  alice.send(channel, "alice, before the attack");
  const legit = await waitFor(
    s.world,
    () => bob.texts(channel).includes("alice, before the attack"),
    15_000,
  );
  s.check("bob has alice's real signing key bound before the attack", legit);

  // Attack 1: an UNSIGNED announce claiming alice's ID.
  //
  // This used to be accepted outright. Verification ran only `if (SIGNED)`, so
  // clearing the flag meant the sender opted out of being checked and their
  // keys were written to the registry unchallenged.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgeAnnounce({
      claimedPeerID: alice.peerID,
      noisePubKey: alice.identity.noiseStaticPubKey,
      signingPubKey: mallory.identity.signingPubKey,
      nickname: "alice",
      timestamp: s.world.wallClock(),
    }),
  );
  await s.world.advance(2000);

  // Attack 2: a fully self-consistent signed announce - alice's public noise
  // key (so the peer ID derivation checks out), mallory's signing key, signed
  // by mallory. Both the derivation check and the signature check PASS. Only
  // the pin refuses it.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgeAnnounce({
      claimedPeerID: alice.peerID,
      noisePubKey: alice.identity.noiseStaticPubKey,
      signingPubKey: mallory.identity.signingPubKey,
      nickname: "alice",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(2000);

  // Attack 3: sender mismatch - claim alice's ID while carrying mallory's own
  // noise key. Rejected because the ID no longer derives from the key.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgeAnnounce({
      claimedPeerID: alice.peerID,
      noisePubKey: mallory.identity.noiseStaticPubKey,
      signingPubKey: mallory.identity.signingPubKey,
      nickname: "alice",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(2000);

  // If any of the three had landed, this message would render as alice: it is
  // signed with the key the attacker tried to bind to her ID.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgePublicMessage({
      claimedPeerID: alice.peerID,
      channel,
      text: "alice says: send me your ecash",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(2000);
  s.check(
    "a message signed by the key the attacker tried to bind is not displayed",
    !bob.texts(channel).includes("alice says: send me your ecash"),
    `bob thread = [${bob.texts(channel).join(" | ")}]`,
  );

  // The load-bearing assertion. A pin that survived by breaking alice would be
  // no better than the hijack, so the real requirement is that her key is still
  // the bound one and her genuine traffic still verifies.
  alice.send(channel, "alice, after the attack");
  const stillWorks = await waitFor(
    s.world,
    () => bob.texts(channel).includes("alice, after the attack"),
    20_000,
  );
  s.check(
    "the real alice's key survived the attack and her traffic still verifies",
    stillWorks,
    `bob thread = [${bob.texts(channel).join(" | ")}]`,
  );

  s.expectNone("no forged senders", noForgedSenders(cast));
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

test("C10 an announce claiming someone else's Nostr key cannot take their thread or their mail", async () => {
  // An announce is signed by the announcer, which proves nothing about the
  // Nostr key it carries. Bob has been writing to alice over Nostr while
  // offline. Mallory, in range, announces herself with alice's npub. If that
  // claim could fold alice's thread into mallory's, bob's queued mail would be
  // re-addressed to mallory and sealed to her Noise key. The only act that may
  // do either is scanning a card off the other phone.
  const s = (scenario = new Scenario({
    id: "C10",
    title: "nostr key claim in an announce",
    seed: 70,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  // Alice is away: only bob and mallory share the air.
  radio.add(bob);
  radio.add(mallory);
  s.track(alice, bob, mallory);
  for (const d of [alice, bob, mallory]) d.launch();
  await waitFor(s.world, () => bob.peers().includes(mallory.peerID), 20_000);
  const aliceNpub = hexToBytes(alice.nostrPubkey);

  const aliceKey = `nostr_${alice.nostrPubkey}`;
  const aliceThread = `dm:${aliceKey}`;
  bob.sendDm(aliceKey, "for alice only");
  const outbox = bob.store("outboxStore");
  const chat = bob.store("chatStore");
  const queuedFor = (peer: string): number =>
    (outbox.getState().forPeer as (p: string) => unknown[])(peer).length;
  s.check(
    "bob's message to alice is queued for her key",
    queuedFor(aliceKey) === 1,
  );

  radio.injectTo(
    bob.id,
    mallory.id,
    forgeAnnounce({
      claimedPeerID: mallory.peerID,
      noisePubKey: mallory.identity.noiseStaticPubKey,
      signingPubKey: mallory.identity.signingPubKey,
      nickname: "mallory",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
      nostrPubKey: aliceNpub,
    }),
  );
  await s.world.advance(2000);

  const redirects = chat.getState().channelRedirects as Record<string, string>;
  s.check(
    "alice's thread was not folded into mallory's",
    redirects[aliceThread] === undefined,
    `redirect = ${String(redirects[aliceThread])}`,
  );
  s.check(
    "bob's mail for alice is still queued for alice, none for mallory",
    queuedFor(aliceKey) === 1 && queuedFor(mallory.peerID) === 0,
  );

  // The positive control: bob scans alice's real card in person.
  (
    bob.mesh as unknown as {
      addVerifiedContact: (card: unknown, opts: unknown) => boolean;
    }
  ).addVerifiedContact(
    {
      peerID: alice.peerID,
      noisePubKey: alice.identity.noiseStaticPubKey,
      signingPubKey: alice.identity.signingPubKey,
      nickname: "alice",
      nostrPubKey: aliceNpub,
    },
    { inPerson: true },
  );
  await s.world.advance(500);
  const after = chat.getState().channelRedirects as Record<string, string>;
  s.check(
    "an in-person scan folds the thread and re-addresses the mail",
    after[aliceThread] === `dm:${alice.peerID}` &&
      queuedFor(aliceKey) === 0 &&
      queuedFor(alice.peerID) === 1,
    `redirect = ${String(after[aliceThread])}`,
  );

  s.expectNone("process health", noCrashes([bob, mallory]));
  s.assert();
});

test("C01 a message claiming a trusted peer's ID is refused unless it is signed by them", async () => {
  const s = (scenario = new Scenario({
    id: "C01",
    title: "impersonating a contact on a public channel",
    seed: 66,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();

  const channel = "#bluetooth";
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);
  for (const d of cast) d.joinChannel(channel);

  // Establish that bob knows alice and accepts her real traffic, so a later
  // refusal cannot be explained away as "bob was not listening".
  alice.send(channel, "this one is really from alice");
  const legit = await waitFor(
    s.world,
    () => bob.texts(channel).includes("this one is really from alice"),
    15_000,
  );
  s.check("a genuine signed message from a known peer is accepted", legit);

  // Attack 1: no signature at all, claiming alice's peer ID.
  //
  // This is the one that used to work. The old check was `if (SIGNED &&
  // haveKey) verify`, so clearing the signature flag skipped verification
  // entirely and the message rendered as alice.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgePublicMessage({
      claimedPeerID: alice.peerID,
      channel,
      text: "alice says: send me your ecash",
      timestamp: s.world.wallClock(),
    }),
  );
  await s.world.advance(2000);
  s.check(
    "an UNSIGNED message claiming a known peer's ID is not displayed",
    !bob.texts(channel).includes("alice says: send me your ecash"),
    `bob thread = [${bob.texts(channel).join(" | ")}]`,
  );

  // Attack 2: signed, but with mallory's own key rather than alice's.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgePublicMessage({
      claimedPeerID: alice.peerID,
      channel,
      text: "alice says: meet me alone",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(2000);
  s.check(
    "a message signed by the WRONG key is not displayed",
    !bob.texts(channel).includes("alice says: meet me alone"),
    `bob thread = [${bob.texts(channel).join(" | ")}]`,
  );

  // Attack 3: a peer nobody has ever heard announce. There is no key to check
  // against, which must read as a failed check rather than a skipped one.
  radio.injectTo(
    bob.id,
    mallory.id,
    forgePublicMessage({
      claimedPeerID: "deadbeefdeadbeef",
      channel,
      text: "from nobody at all",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(2000);
  s.check(
    "a message from a peer with no announced signing key is not displayed",
    !bob.texts(channel).includes("from nobody at all"),
    `bob thread = [${bob.texts(channel).join(" | ")}]`,
  );

  s.expectNone("no forged senders", noForgedSenders(cast));
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

test("C02 the strict signature rule still lets genuine traffic through", async () => {
  // The counterpart to C01. A check that rejects everything would pass C01 and
  // be worthless, so this pins the other side of the boundary.
  const s = (scenario = new Scenario({
    id: "C02",
    title: "a correctly signed packet from a known peer is accepted",
    seed: 67,
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
  for (const d of [alice, bob]) radio.add(d);
  s.track(alice, bob);
  for (const d of [alice, bob]) d.launch();

  const channel = "#bluetooth";
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);
  for (const d of [alice, bob]) d.joinChannel(channel);

  s.check(
    "the harness is signing with alice's real identity key",
    sameBytes(
      ed25519.getPublicKey(alice.identity.signingPrivKey),
      alice.identity.signingPubKey,
    ),
  );

  radio.injectTo(
    bob.id,
    alice.id,
    forgePublicMessage({
      claimedPeerID: alice.peerID,
      channel,
      text: "genuinely alice",
      timestamp: s.world.wallClock(),
      signWith: alice.identity.signingPrivKey,
    }),
  );
  await s.world.advance(2000);

  s.check(
    "a correctly signed message from a known peer is displayed",
    bob.texts(channel).includes("genuinely alice"),
    `bob thread = [${bob.texts(channel).join(" | ")}]`,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

// A LEAVE says "this peer is gone" and costs nothing to forge for any peer ID
// in earshot. Refusing to act on one is necessary but not sufficient: a relay
// that forwards it anyway spends the room's airtime on a lie and hands the same
// lie to every node downstream, including any that check less strictly.
test("C09 a forged LEAVE is neither acted on nor passed along", async () => {
  const s = (scenario = new Scenario({
    id: "C09",
    title: "forged departure stops at the first honest relay",
    seed: 69,
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
  const carol = SimDevice.create(s.world, {
    id: "carol",
    platform: "android",
    seedByte: 33,
  });
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, carol, mallory];
  for (const d of cast) radio.add(d);
  // A line, so anything reaching carol had to be relayed BY bob. Without the
  // third hop there is no way to tell "bob ignored it" from "bob did not
  // forward it", and forwarding is half of what this scenario is about.
  radio.setTopology([
    ["alice", "bob"],
    ["bob", "carol"],
    ["mallory", "bob"],
  ]);
  s.track(...cast);
  for (const d of cast) d.launch();

  const channel = "#bluetooth";
  for (const d of cast) d.joinChannel(channel);
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 30_000);
  s.check(
    "bob can see alice before the attack",
    bob.peers().includes(alice.peerID),
  );

  const leaveFramesBefore = radio.countOfType(PacketType.LEAVE);

  // Mallory claims alice's peer ID on a LEAVE signed with her own key. The
  // packet is well-formed and self-consistent; it is only wrong about who sent
  // it, which is exactly what the pinned signing key exists to detect.
  const forged: Packet = {
    type: PacketType.LEAVE,
    ttl: 3,
    flags: Flags.SIGNED,
    senderID: peerIdToBytes(alice.peerID),
    recipientID: new Uint8Array(8),
    timestamp: s.world.wallClock(),
    signature: new Uint8Array(64),
    payload: new Uint8Array(0),
  };
  forged.signature = signPacket(forged, mallory.identity.signingPrivKey);
  radio.injectTo(bob.id, mallory.id, toBase64(encodePacket(forged)));
  await s.world.advance(5_000);

  s.check(
    "bob did not evict alice on a forged departure",
    bob.peers().includes(alice.peerID),
    `bob sees [${bob.peers().join(",")}]`,
  );
  s.check(
    "and did not put the forgery back on the air",
    radio.countOfType(PacketType.LEAVE) === leaveFramesBefore,
    `LEAVE frames before=${leaveFramesBefore} after=${radio.countOfType(PacketType.LEAVE)}`,
  );

  // The other half: a real departure must still be honoured, or the rule above
  // is just a way to break presence.
  //
  // Driven through the actual "user goes Away" path rather than an injected
  // packet, because the goodbye has to survive its own shutdown to be worth
  // anything. MeshService.stop() sends the LEAVE before taking the radios
  // down; with those two the other way round the farewell was handed to a
  // transport already told to shut, and a departing peer vanished by timeout
  // instead of by announcement.
  alice.mesh?.stop();
  const noticed = await waitFor(
    s.world,
    () => !bob.peers().includes(alice.peerID),
    20_000,
  );
  s.check(
    "a genuine departure is announced, not waited out",
    noticed,
    `bob sees [${bob.peers().join(",")}]`,
  );

  s.expectNone("no forged senders", noForgedSenders([bob, carol]));
  s.expectNone("process health", noCrashes([bob, carol]));
  s.assert(true);
});

test("C09b a genuine old LEAVE dressed as a sync reply is refused", async () => {
  // The freshness window stops a replayed LEAVE, except through the one path
  // allowed to carry old packets: a reply to our own sync request. Every
  // neighbour is asked every round, so a neighbour holding a recording of
  // alice's goodbye could tag it IS_RSR and end her session with us. Only the
  // types sync serves pass as replies, and LEAVE is not one.
  const s = (scenario = new Scenario({
    id: "C09b",
    title: "replayed departure through the sync exemption",
    seed: 75,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  radio.setTopology([
    ["alice", "bob"],
    ["mallory", "bob"],
  ]);
  s.track(...cast);
  for (const d of cast) d.launch();
  const channel = "#bluetooth";
  for (const d of cast) d.joinChannel(channel);
  await waitFor(
    s.world,
    () =>
      bob.peers().includes(alice.peerID) &&
      bob.peers().includes(mallory.peerID),
    30_000,
  );
  let asked = false;
  const stop = radio.tapWrites((who, linkID, data) => {
    if (who !== bob.id || linkID !== `link:${mallory.id}`) return;
    if (decodeWrite(data)?.type === PacketType.REQUEST_SYNC) asked = true;
  });
  s.check(
    "bob asked mallory for a sync",
    await waitFor(s.world, () => asked, 40_000),
  );
  stop();

  // A recording of alice's real, signed departure from ten minutes ago, and
  // an equally old message of hers, both re-tagged as replies. Neither ttl nor
  // IS_RSR is signed, so both signatures still verify.
  const at = s.world.wallClock() - 10 * 60_000;
  const recorded = (type: PacketType, payload: Uint8Array): string => {
    const packet: Packet = {
      type,
      ttl: 0,
      flags: Flags.SIGNED,
      senderID: peerIdToBytes(alice.peerID),
      recipientID: new Uint8Array(8),
      timestamp: at,
      signature: new Uint8Array(64),
      payload,
    };
    packet.signature = signPacket(packet, alice.identity.signingPrivKey);
    return toBase64(encodePacket({ ...packet, isRSR: true }));
  };
  radio.injectTo(
    bob.id,
    mallory.id,
    recorded(PacketType.LEAVE, new Uint8Array(0)),
  );
  radio.injectTo(
    bob.id,
    mallory.id,
    recorded(
      PacketType.CHANNEL_MSG,
      encodeMeshPublicPayload("still here, earlier"),
    ),
  );
  await s.world.advance(3_000);

  s.check(
    "bob did not drop alice on a recorded goodbye",
    bob.peers().includes(alice.peerID),
    `bob sees [${bob.peers().join(",")}]`,
  );
  s.check(
    "while the same reply of a type sync serves is backfilled",
    bob.texts(channel).includes("still here, earlier"),
  );
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

// A NOISE_HANDSHAKE packet as a hostile phone would write it: any claimed
// sender, addressed to the victim.
function forgeHandshake(opts: {
  claimedPeerID: string;
  toPeerID: string;
  payload: Uint8Array;
  timestamp: number;
}): string {
  return toBase64(
    encodePacket({
      type: PacketType.NOISE_HANDSHAKE,
      ttl: 7,
      flags: Flags.HAS_RECIPIENT,
      senderID: peerIdToBytes(opts.claimedPeerID),
      recipientID: peerIdToBytes(opts.toPeerID),
      timestamp: opts.timestamp,
      signature: new Uint8Array(64),
      payload: opts.payload,
    }),
  );
}

function decodeWrite(dataBase64: string): Packet | null {
  return decodePacket(base64ToBytes(dataBase64));
}

function pendingHandshakes(device: SimDevice): Map<string, unknown> {
  return (device.mesh as unknown as { pendingHandshakes: Map<string, unknown> })
    .pendingHandshakes;
}

test("C12 a msg1 flood under random IDs stays bounded and first contact still completes", async () => {
  // Every msg1 costs the victim two DH operations, a stored handshake and a
  // reply flooded at TTL 7, and the claimed sender is free to choose. 500 of
  // them under 500 made-up IDs must not become 500 of each.
  const s = (scenario = new Scenario({
    id: "C12",
    title: "handshake initiation flood",
    seed: 72,
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
  const carol = SimDevice.create(s.world, {
    id: "carol",
    platform: "android",
    seedByte: 33,
  });
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, carol, mallory];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitFor(
    s.world,
    () =>
      bob.peers().includes(alice.peerID) && bob.peers().includes(carol.peerID),
    20_000,
  );

  const msg2Targets = new Set<string>();
  radio.tapWrites((fromID, _link, data) => {
    if (fromID !== bob.id) return;
    const p = decodeWrite(data);
    if (p?.type !== PacketType.NOISE_HANDSHAKE || p.payload.length !== 96)
      return;
    msg2Targets.add(bytesToHex(p.recipientID));
  });

  const floodStart = s.world.now;
  for (let i = 0; i < 500; i++) {
    const id = bytesToHex(sha256(Uint8Array.of(i >> 8, i & 0xff))).slice(0, 16);
    radio.injectTo(
      bob.id,
      mallory.id,
      forgeHandshake({
        claimedPeerID: id,
        toPeerID: bob.peerID,
        payload: NoiseHandshake.createInitiator(
          ed25519.utils.randomSecretKey(),
        ).writeMsg1(),
        timestamp: s.world.wallClock(),
      }),
    );
    if (i % 50 === 49) await s.world.advance(1000);
  }

  s.check(
    "bob answered at most 30 forged openings in the minute",
    msg2Targets.size <= 30,
    `msg2 sent to ${String(msg2Targets.size)} peers`,
  );
  s.check(
    "and holds no more handshakes than he answered",
    pendingHandshakes(bob).size <= 30,
    `pending = ${String(pendingHandshakes(bob).size)}`,
  );

  // Our own initiations never meet the msg1 budget, so bob reaching out to
  // someone new works in the middle of the flood.
  bob.send(`dm:${alice.peerID}`, "bob, during the flood");
  const outbound = await waitFor(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("bob, during the flood"),
    10_000,
  );
  s.check("bob's own first-contact DM completes during the flood", outbound);

  // An inbound first contact waits out the minute, then completes from the
  // outbox without anyone doing anything.
  carol.send(`dm:${bob.peerID}`, "carol, first contact");
  const inbound = await waitFor(
    s.world,
    () => bob.texts(`dm:${carol.peerID}`).includes("carol, first contact"),
    180_000,
  );
  s.check(
    "an inbound first-contact DM still lands once the window slides",
    inbound,
    `landed after ${String(s.world.now - floodStart)} ms`,
  );
  s.check(
    "expired handshakes do not accumulate",
    pendingHandshakes(bob).size <= 31,
    `pending = ${String(pendingHandshakes(bob).size)}`,
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

test("C13 a forged msg2 does not cost the genuine handshake", async () => {
  // Bob's msg1 floods, so anyone can answer it with a valid msg2 under their
  // own static key and the peer ID bob addressed. It fails the identity
  // binding, but only after it was read into the handshake. Read into the real
  // one, it spent it and the genuine msg2 found nothing to complete.
  const s = (scenario = new Scenario({
    id: "C13",
    title: "forged handshake reply",
    seed: 73,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);

  let forged = 0;
  radio.tapWrites((fromID, _link, data) => {
    if (fromID !== bob.id) return;
    const p = decodeWrite(data);
    if (p?.type !== PacketType.NOISE_HANDSHAKE || p.payload.length !== 32)
      return;
    // Mallory is one hop from bob, as alice is, so her answer lands first.
    const responder = NoiseHandshake.createResponder(
      mallory.identity.noiseStaticPrivKey,
    );
    responder.readMsg1(p.payload);
    const msg2 = responder.writeMsg2();
    const garbled = msg2.slice();
    garbled[60] ^= 0xff;
    forged++;
    setTimeout(() => {
      for (const payload of [msg2, garbled]) {
        radio.injectTo(
          bob.id,
          mallory.id,
          forgeHandshake({
            claimedPeerID: alice.peerID,
            toPeerID: bob.peerID,
            payload,
            timestamp: s.world.wallClock(),
          }),
        );
      }
    }, 1);
  });

  const sentAt = s.world.now;
  bob.send(`dm:${alice.peerID}`, "first words");
  const landed = await waitFor(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("first words"),
    10_000,
  );
  s.check("mallory answered bob's msg1 first", forged > 0);
  s.check(
    "the genuine msg2 still completes, well inside any outbox retry",
    landed && s.world.now - sentAt < 5_000,
    `after ${String(s.world.now - sentAt)} ms`,
  );
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

test("C13b a forged msg1 under a peer's ID displaces its live attempt, and the DM recovers", async () => {
  // The case a clone cannot cover. A msg1 is how a peer that restarted opens a
  // new handshake, so a fresh one replaces a responder attempt in flight, and
  // its claimed sender is unauthenticated. bitchat-ios yields the same way. The
  // accepted cost is one handshake round: the message is delayed, not lost.
  const s = (scenario = new Scenario({
    id: "C13b",
    title: "handshake displaced by a forged opening",
    seed: 74,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);

  let displaced = false;
  const stop = radio.tapWrites((fromID, _link, data) => {
    if (fromID !== bob.id || displaced) return;
    const p = decodeWrite(data);
    if (p?.type !== PacketType.NOISE_HANDSHAKE || p.payload.length !== 96)
      return;
    // Bob has just answered alice's msg1. Before her msg3 lands, a fresh
    // opening in her name replaces the attempt it belongs to.
    displaced = true;
    setTimeout(() => {
      radio.injectTo(
        bob.id,
        mallory.id,
        forgeHandshake({
          claimedPeerID: alice.peerID,
          toPeerID: bob.peerID,
          payload: NoiseHandshake.createInitiator(
            mallory.identity.noiseStaticPrivKey,
          ).writeMsg1(),
          timestamp: s.world.wallClock(),
        }),
      );
    }, 1);
  });

  alice.send(`dm:${bob.peerID}`, "delayed, not lost");
  await s.world.advance(3_000);
  stop();
  s.check("the forged opening displaced bob's responder attempt", displaced);
  const landed = await waitFor(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("delayed, not lost"),
    180_000,
  );
  s.check("the DM still arrives once a later handshake completes", landed);
  s.check(
    "exactly once",
    bob.texts(`dm:${alice.peerID}`).filter((t) => t === "delayed, not lost")
      .length === 1,
  );
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

interface ContactLike {
  signingPubKeyHex: string;
  nostrPubkeyHex?: string;
}

function contactOf(device: SimDevice, peerID: string): ContactLike | undefined {
  return (
    device.store("contactsStore").getState().contacts as Record<
      string,
      ContactLike
    >
  )[peerID];
}

// The prekeys bob would seal to for this Noise key, as hex.
function prekeysHeldFor(device: SimDevice, noiseKey: Uint8Array): string[] {
  const peers = (
    device.mesh as unknown as {
      peerPrekeys: { peers: Record<string, { prekeys: { pub: string }[] }> };
    }
  ).peerPrekeys.peers;
  return (peers[bytesToHex(noiseKey)]?.prekeys ?? []).map((p) => p.pub);
}

// A packet claiming `claimedPeerID`, signed with whatever key the caller holds.
function forgeSigned(opts: {
  type: PacketType;
  claimedPeerID: string;
  recipientPeerID?: string;
  payload: Uint8Array;
  timestamp: number;
  signWith: Uint8Array;
}): string {
  const packet: Packet = {
    type: opts.type,
    ttl: 7,
    flags:
      Flags.SIGNED |
      (opts.recipientPeerID !== undefined ? Flags.HAS_RECIPIENT : 0),
    senderID: peerIdToBytes(opts.claimedPeerID),
    recipientID:
      opts.recipientPeerID !== undefined
        ? peerIdToBytes(opts.recipientPeerID)
        : new Uint8Array(8),
    timestamp: opts.timestamp,
    signature: new Uint8Array(64),
    payload: opts.payload,
  };
  packet.signature = signPacket(packet, opts.signWith);
  return toBase64(encodePacket(packet));
}

test("C14 after a restart, whoever announces first as a saved contact speaks for nobody", async () => {
  // The registry of who holds which key starts empty after a restart. Mallory,
  // in range, announces alice's peer ID and public Noise key with her own
  // signing key, which is self-consistent and so passes every check an
  // announce can be put to. Bob holds alice's key from an earlier session, on
  // her saved contact, and that is the key she must be held to: not the one
  // whoever announced first.
  const s = (scenario = new Scenario({
    id: "C14",
    title: "restart, then an impostor announces a saved contact",
    seed: 76,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  radio.setTopology([["alice", "bob"]]);
  s.track(...cast);
  for (const d of cast) d.launch();
  const channel = "#bluetooth";
  for (const d of cast) d.joinChannel(channel);
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);

  // Messaging alice saves her, and the session proves her keys onto the record.
  bob.send(`dm:${alice.peerID}`, "hi alice");
  const aliceKey = bytesToHex(alice.identity.signingPubKey);
  const saved = await waitFor(
    s.world,
    () => contactOf(bob, alice.peerID)?.signingPubKeyHex === aliceKey,
    20_000,
  );
  s.check("bob saved alice with her proven signing key", saved);
  s.world.say("TOPOLOGY_CHANGE", "alice leaves; bob restarts beside mallory");
  radio.setTopology([["bob", "mallory"]]);
  bob.relaunch();
  bob.joinChannel(channel);
  // As for a bitchat contact, which never announces a Nostr key. After the
  // restart, or the registry would put alice's own back at once.
  bob.store("contactsStore").setState({
    contacts: {
      ...(bob.store("contactsStore").getState().contacts as Record<
        string,
        ContactLike
      >),
      [alice.peerID]: {
        ...contactOf(bob, alice.peerID)!,
        nostrPubkeyHex: undefined,
      },
    },
  });

  await waitFor(s.world, () => radio.isLinked("bob", "mallory"), 30_000);
  await s.world.advance(2_000);

  const inject = (frame: string): void => {
    radio.injectTo(bob.id, mallory.id, frame);
  };
  inject(
    forgeAnnounce({
      claimedPeerID: alice.peerID,
      noisePubKey: alice.identity.noiseStaticPubKey,
      signingPubKey: mallory.identity.signingPubKey,
      nickname: "alice",
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
      nostrPubKey: hexToBytes(mallory.nostrPubkey),
    }),
  );
  await s.world.advance(1_000);
  const now = (): number => s.world.wallClock();
  inject(
    forgePublicMessage({
      claimedPeerID: alice.peerID,
      channel,
      text: "alice: meet me by the gate",
      timestamp: now(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  inject(
    forgeSigned({
      type: PacketType.FILE_TRANSFER,
      claimedPeerID: alice.peerID,
      payload: encodeFilePacket({
        fileName: "gate.jpg",
        mimeType: "image/jpeg",
        content: media.jpeg(300),
        channel,
      })!,
      timestamp: now(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  const bundle = signPrekeyBundle(
    {
      noiseStaticPublicKey: alice.identity.noiseStaticPubKey,
      prekeys: [{ id: 1, publicKey: new Uint8Array(32).fill(9) }],
      generatedAt: now(),
    },
    mallory.identity.signingPrivKey,
  );
  inject(
    forgeSigned({
      type: PacketType.PREKEY_BUNDLE,
      claimedPeerID: alice.peerID,
      payload: encodePrekeyBundle(bundle)!,
      timestamp: now(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(3_000);

  s.check(
    "mallory's post under alice's name is not shown",
    !bob.texts(channel).includes("alice: meet me by the gate"),
  );
  s.check(
    "nor her photo under alice's name",
    bob.attachments(channel).length === 0,
  );
  s.check(
    "nor her prekey bundle kept for alice's key",
    !prekeysHeldFor(bob, alice.identity.noiseStaticPubKey).includes(
      "09".repeat(32),
    ),
  );
  s.check(
    "nor her Nostr key planted on alice's contact",
    contactOf(bob, alice.peerID)?.nostrPubkeyHex === undefined,
  );

  // One hop away, relayed by mallory's phone, so no session forms on a link
  // and nothing but the stored key tells her apart from the impostor.
  s.world.say("TOPOLOGY_CHANGE", "alice returns, one hop beyond mallory");
  radio.setTopology([
    ["bob", "mallory"],
    ["mallory", "alice"],
  ]);
  const back = await waitFor(
    s.world,
    () => bob.peers().includes(alice.peerID),
    30_000,
  );
  s.check("alice's own announce is accepted", back);
  alice.send(channel, "alice, really");
  const verifies = await waitFor(
    s.world,
    () => bob.texts(channel).includes("alice, really"),
    15_000,
  );
  s.check("and her traffic verifies", verifies);
  s.check(
    "while bob holds no session with her to have proven it",
    (
      bob.mesh as unknown as {
        registry: { sessionFor: (p: string) => unknown };
      }
    ).registry.sessionFor(alice.peerID) === undefined,
  );

  inject(
    forgeSigned({
      type: PacketType.LEAVE,
      claimedPeerID: alice.peerID,
      payload: new Uint8Array(0),
      timestamp: now(),
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(3_000);
  s.check(
    "a LEAVE mallory signs in her name does not remove her",
    bob.peers().includes(alice.peerID),
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

test("C14b a contact key from a forged link card gives way to a session proof", async () => {
  // A link card proves nothing about who made it. This one carries alice's
  // real peer ID and Noise key with mallory's signing key. Bob's announces
  // check refuses the real alice against it, and only a session can say which
  // key is hers: she completes one because she holds the Noise private key,
  // and her proof corrects the stored contact.
  const s = (scenario = new Scenario({
    id: "C14b",
    title: "a forged link card against the real peer",
    seed: 78,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob];
  for (const d of cast) radio.add(d);
  radio.setTopology([]);
  s.track(...cast);
  for (const d of cast) d.launch();
  const channel = "#bluetooth";
  for (const d of cast) d.joinChannel(channel);

  const forged = {
    peerID: alice.peerID,
    noisePubKey: alice.identity.noiseStaticPubKey,
    signingPubKey: mallory.identity.signingPubKey,
    nickname: "alice",
  };
  const accepted = (
    bob.mesh as unknown as {
      addVerifiedContact: (card: unknown, opts: unknown) => boolean;
    }
  ).addVerifiedContact(forged, { inPerson: false });
  (bob.store("contactsStore").getState().addContact as (c: unknown) => void)({
    peerID: alice.peerID,
    noisePubKeyHex: bytesToHex(alice.identity.noiseStaticPubKey),
    signingPubKeyHex: bytesToHex(mallory.identity.signingPubKey),
    nickname: "alice",
    addedAtMs: s.world.wallClock(),
    source: "link",
  });
  s.check("bob took the link card", accepted);

  radio.setTopology([["alice", "bob"]]);
  const aliceKey = bytesToHex(alice.identity.signingPubKey);
  const corrected = await waitFor(
    s.world,
    () => contactOf(bob, alice.peerID)?.signingPubKeyHex === aliceKey,
    60_000,
  );
  s.check("alice's session proof corrected the stored key", corrected);
  alice.send(channel, "the real alice");
  const verifies = await waitFor(
    s.world,
    () => bob.texts(channel).includes("the real alice"),
    30_000,
  );
  s.check("and her traffic verifies from then on", verifies);
  s.check(
    "and bob sees her nearby",
    await waitFor(s.world, () => bob.peers().includes(alice.peerID), 30_000),
  );

  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

test("C11 one forged ratchet packet does not break a conversation", async () => {
  // A DR_ENCRYPTED header is cleartext, and a packet only has to be addressed
  // to bob and claim alice. Decrypted before it was authenticated, one such
  // packet stepped bob's ratchet onto a chain alice never had, and every DM
  // between them failed from then on without a word.
  const s = (scenario = new Scenario({
    id: "C11",
    title: "forged Double Ratchet packet",
    seed: 71,
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  const cast = [alice, bob, mallory];
  for (const d of cast) radio.add(d);
  s.track(...cast);
  for (const d of cast) d.launch();
  await waitFor(s.world, () => bob.peers().includes(alice.peerID), 20_000);

  alice.send(`dm:${bob.peerID}`, "one");
  await waitFor(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("one"),
    20_000,
  );
  bob.send(`dm:${alice.peerID}`, "two");
  await waitFor(
    s.world,
    () => alice.texts(`dm:${bob.peerID}`).includes("two"),
    20_000,
  );

  // A fresh ratchet key in the header, as a forger would pick, once unsigned
  // and once signed with mallory's own key.
  const forged = new Uint8Array(40 + 48).fill(0x5a);
  forged.set(ed25519.utils.randomSecretKey(), 0);
  forged.fill(0, 32, 40);
  const unsigned: Packet = {
    type: PacketType.DR_ENCRYPTED,
    ttl: 7,
    flags: Flags.HAS_RECIPIENT,
    senderID: peerIdToBytes(alice.peerID),
    recipientID: peerIdToBytes(bob.peerID),
    timestamp: s.world.wallClock(),
    signature: new Uint8Array(64),
    payload: forged,
  };
  radio.injectTo(bob.id, mallory.id, toBase64(encodePacket(unsigned)));
  radio.injectTo(
    bob.id,
    mallory.id,
    forgeSigned({
      type: PacketType.DR_ENCRYPTED,
      claimedPeerID: alice.peerID,
      recipientPeerID: bob.peerID,
      payload: forged,
      timestamp: s.world.wallClock() + 1,
      signWith: mallory.identity.signingPrivKey,
    }),
  );
  await s.world.advance(1_000);

  const sentAt = s.world.now;
  alice.send(`dm:${bob.peerID}`, "after the forgery");
  const landed = await waitFor(
    s.world,
    () => bob.texts(`dm:${alice.peerID}`).includes("after the forgery"),
    10_000,
  );
  s.check(
    "the next DM still arrives, without waiting for a retry",
    landed && s.world.now - sentAt < 5_000,
    `after ${String(s.world.now - sentAt)} ms`,
  );
  const delivered = await waitFor(
    s.world,
    () =>
      alice
        .messages(`dm:${bob.peerID}`)
        .find((m) => m.text === "after the forgery")?.status === "delivered",
    10_000,
  );
  s.check("and alice sees it delivered", delivered);
  s.check(
    "exactly once",
    bob.texts(`dm:${alice.peerID}`).filter((t) => t === "after the forgery")
      .length === 1,
  );
  s.expectNone("process health", noCrashes(cast));
  s.assert();
});

// Three phones in radio range of each other, the first two about to be
// attacked by the third, with every link up and every announce heard.
async function threeInRange(
  seed: number,
  id: string,
  title: string,
): Promise<{
  s: Scenario;
  radio: RadioFabric;
  alice: SimDevice;
  bob: SimDevice;
  mallory: SimDevice;
}> {
  const s = (scenario = new Scenario({ id, title, seed }));
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
  const mallory = SimDevice.create(s.world, {
    id: "mallory",
    platform: "android",
    seedByte: 77,
  });
  for (const d of [alice, bob, mallory]) radio.add(d);
  s.track(alice, bob, mallory);
  for (const d of [alice, bob, mallory]) d.launch();
  await waitFor(
    s.world,
    () =>
      bob.peers().includes(alice.peerID) &&
      bob.peers().includes(mallory.peerID),
    20_000,
  );
  return { s, radio, alice, bob, mallory };
}

test("F10 a private-room member cannot write in another member's name", async () => {
  // Holding the room key makes mallory a member, able to seal anything. On
  // Bluetooth the outer signature says who sent it, so a sealed author that
  // differs is a claim to be someone else. And re-using alice's message ID
  // under her own name must not swallow alice's message.
  const { s, radio, alice, bob, mallory } = await threeInRange(
    610,
    "F10",
    "forged author in a private room",
  );
  const channel = "#crew";
  const key = new Uint8Array(32).fill(7);
  for (const d of [alice, bob, mallory]) d.joinPrivateChannel(channel, key);
  const keyB64 = (
    bob.store("chatStore").getState().channelKeys as Record<string, string>
  )[channel];

  const sealed = (senderID: string, msgId: string, text: string): string =>
    forgeSigned({
      type: PacketType.CHANNEL_ENC,
      claimedPeerID: mallory.peerID,
      payload: sealChannelMessage(keyB64, {
        msgId,
        senderID,
        senderNickname: "someone",
        text,
      }),
      timestamp: s.world.wallClock(),
      signWith: mallory.identity.signingPrivKey,
    });

  radio.injectTo(
    bob.id,
    mallory.id,
    sealed(alice.peerID, "f10", "alice: pay me"),
  );

  // When alice speaks, mallory reads her message ID off the air and gets a
  // copy of her own under it to bob first.
  let copied = false;
  const stop = radio.tapWrites((who, _link, data) => {
    if (who !== alice.id || copied) return;
    const p = decodeWrite(data);
    if (p?.type !== PacketType.CHANNEL_ENC) return;
    const opened = openChannelMessage(keyB64, p.payload);
    if (opened === null) return;
    copied = true;
    radio.injectTo(
      bob.id,
      mallory.id,
      sealed(mallory.peerID, opened.msgId, "mallory's version"),
    );
  });
  alice.send(channel, "alice's own words");
  await s.world.advance(3_000);
  stop();

  const rows = bob.messages(channel);
  s.check(
    "a message sealed in alice's name but signed by mallory is dropped",
    !rows.some((m) => m.text === "alice: pay me"),
  );
  s.check("mallory copied alice's message ID", copied);
  s.check(
    "alice's message still shows, as hers",
    rows.some(
      (m) => m.text === "alice's own words" && m.senderID === alice.peerID,
    ),
    `rows=${JSON.stringify(rows.map((m) => [m.senderID.slice(0, 4), m.text]))}`,
  );
  s.check(
    "and mallory's copy stands apart, as hers",
    rows.some(
      (m) => m.text === "mallory's version" && m.senderID === mallory.peerID,
    ),
  );
  s.expectNone("process health", noCrashes([alice, bob, mallory]));
  s.assert();
});

test("C16 a copied message ID cannot displace a room message", async () => {
  // A room message and its internet copy share a message ID so they collapse
  // into one bubble. Mallory reads alice's off the air and gets her own text
  // to bob first under the same ID. Bob must see both, each as its author's.
  const { s, radio, alice, bob, mallory } = await threeInRange(
    611,
    "C16",
    "copied room message ID",
  );
  const channel = "#den";
  for (const d of [alice, bob, mallory]) d.joinChannel(channel);

  let copied = false;
  const stop = radio.tapWrites((who, _link, data) => {
    if (who !== alice.id || copied) return;
    const p = decodeWrite(data);
    if (p?.type !== PacketType.CHANNEL_MSG_AIRHOP) return;
    const decoded = decodeAirhopChannelPayload(p.payload);
    if (decoded === null) return;
    copied = true;
    radio.injectTo(
      bob.id,
      mallory.id,
      forgeSigned({
        type: PacketType.CHANNEL_MSG_AIRHOP,
        claimedPeerID: mallory.peerID,
        payload: encodeAirhopChannelPayload(
          channel,
          "the gate is closed",
          decoded.msgId,
        ),
        timestamp: s.world.wallClock(),
        signWith: mallory.identity.signingPrivKey,
      }),
    );
  });
  alice.send(channel, "the gate is open");
  await s.world.advance(3_000);
  stop();

  const rows = bob.messages(channel);
  s.check("mallory copied alice's message ID", copied);
  s.check(
    "alice's message still shows, as hers",
    rows.some(
      (m) => m.text === "the gate is open" && m.senderID === alice.peerID,
    ),
    `rows=${JSON.stringify(rows.map((m) => [m.senderID.slice(0, 4), m.text]))}`,
  );
  s.check(
    "and mallory's stands apart, as hers",
    rows.some(
      (m) => m.text === "the gate is closed" && m.senderID === mallory.peerID,
    ),
  );
  s.expectNone("process health", noCrashes([alice, bob, mallory]));
  s.assert();
});

test("C15 a stranger in a location DM cannot hand over a friend's card", async () => {
  // Every field of alice's card is public. A stranger, known to bob only by a
  // per-cell pseudonym, forwards it; bob has already shared his own, so an
  // accepted card would fold the stranger's thread into alice's and every
  // later word from the pseudonym would read as hers. The card must carry
  // alice's own proof over this very conversation.
  const { s, alice, bob, mallory } = await threeInRange(
    612,
    "C15",
    "forwarded contact card in a location DM",
  );
  const aliceCard = (
    alice.mesh as unknown as { getContactCard: () => ContactCard }
  ).getContactCard();
  (
    bob.mesh as unknown as {
      addVerifiedContact: (card: unknown, opts: unknown) => boolean;
    }
  ).addVerifiedContact(aliceCard, { inPerson: true });
  (bob.store("contactsStore").getState().addContact as (c: unknown) => void)({
    peerID: alice.peerID,
    noisePubKeyHex: bytesToHex(aliceCard.noisePubKey),
    signingPubKeyHex: bytesToHex(aliceCard.signingPubKey),
    nickname: "alice",
    addedAtMs: s.world.wallClock(),
    source: "qr",
  });

  const bobCell = "b0".repeat(32);
  const strangerCell = "5a".repeat(32);
  const aliceCell = "a1".repeat(32);
  const chat = bob.store("chatStore");
  const noteExchange = chat.getState().noteGeoCardExchange as (
    pubkey: string,
    half: { sentMine: boolean },
  ) => void;
  noteExchange(strangerCell, { sentMine: true });
  noteExchange(aliceCell, { sentMine: true });
  const accept = (body: Uint8Array, from: string): string | null =>
    (
      bob.mesh as unknown as {
        acceptGeoContactCard: (
          body: Uint8Array,
          sender: string,
          recipient: string,
        ) => string | null;
      }
    ).acceptGeoContactCard(body, from, bobCell);
  const redirects = (): Record<string, string> =>
    chat.getState().channelRedirects as Record<string, string>;

  const plain = encodeContactCard(aliceCard);
  const substituted = encodeContactCard({
    ...aliceCard,
    signingPubKey: mallory.identity.signingPubKey,
  });
  const attempts = [
    // Alice's card as she publishes it, with no proof at all.
    plain,
    // Alice's card with a proof mallory can make: by her own key.
    sealGeoCard(plain, strangerCell, bobCell, mallory.identity.signingPrivKey),
    // Mallory's key written into alice's card, proven by that key.
    sealGeoCard(
      substituted,
      strangerCell,
      bobCell,
      mallory.identity.signingPrivKey,
    ),
  ];
  const accepted = attempts.map((body) => accept(body, strangerCell));
  s.check(
    "every forwarded card is refused",
    accepted.every((r) => r === null),
    `accepted=${JSON.stringify(accepted)}`,
  );
  s.check(
    "the stranger's thread was not folded into alice's",
    redirects()[`dm:nostr_${strangerCell}`] === undefined,
  );
  s.check(
    "alice's saved key is untouched",
    contactOf(bob, alice.peerID)?.signingPubKeyHex ===
      bytesToHex(aliceCard.signingPubKey),
  );
  s.check(
    "and nothing was written in the stranger's thread",
    bob.messages(`dm:nostr_${strangerCell}`).length === 0,
  );

  // The control: alice's own card, proven by her from her own pseudonym.
  const genuine = accept(
    sealGeoCard(plain, aliceCell, bobCell, alice.identity.signingPrivKey),
    aliceCell,
  );
  s.check(
    "alice's own proven card completes the exchange",
    genuine === alice.peerID &&
      redirects()[`dm:nostr_${aliceCell}`] === `dm:${alice.peerID}`,
  );
  s.expectNone("process health", noCrashes([alice, bob, mallory]));
  s.assert();
});
