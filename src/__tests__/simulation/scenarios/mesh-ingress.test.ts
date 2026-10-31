// What a phone does with packets arriving in an awkward order or at an awkward
// time: its own fragments echoed back, a prekey bundle that outran its owner's
// announce, live voice from a talker whose clock runs ahead, live voice the
// listener silenced by playing something else, and a DM held up by a handshake
// that never answers.

jest.mock("expo-location", () => ({}));
jest.mock("react-native/Libraries/EventEmitter/RCTDeviceEventEmitter", () =>
  // Every phone needs its own listener set. See harness/event-router.ts.
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

import type { Identity } from "@core/crypto/identity";
import { base64ToBytes, bytesToBase64 } from "@core/encoding/base64";
import { encodeAnnouncePayload } from "@core/mesh/discovery/announce-manager";
import {
  encodeBurstData,
  encodeBurstEnd,
  encodeBurstStart,
  VoiceCodec,
} from "@core/mesh/voice/voice-capture";
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
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { SimDevice, type DeviceSpec } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { media } from "../harness/media-fabric";
import { RadioFabric } from "../harness/radio-fabric";
import { Scenario, waitFor } from "../harness/scenario";

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

async function pair(
  s: Scenario,
): Promise<{ radio: RadioFabric; alice: SimDevice; bob: SimDevice }> {
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  const met = await waitFor(
    s.world,
    () =>
      alice.peers().includes(bob.peerID) && bob.peers().includes(alice.peerID),
    20_000,
  );
  s.check("alice and bob met", met, "precondition");
  return { radio, alice, bob };
}

// Someone who is not on the radio, whose packets reach bob only as injected
// bytes, so the order they arrive in is the test's to choose.
function stranger(seedByte: number): Identity {
  const noisePriv = new Uint8Array(32).fill(seedByte);
  const noisePub = x25519.getPublicKey(noisePriv);
  const signingPriv = new Uint8Array(32).fill(seedByte + 1);
  return {
    noiseStaticPrivKey: noisePriv,
    noiseStaticPubKey: noisePub,
    signingPrivKey: signingPriv,
    signingPubKey: ed25519.getPublicKey(signingPriv),
    peerID: bytesToHex(sha256(noisePub)).slice(0, 16),
  };
}

function signed(
  sender: Identity,
  type: PacketType,
  payload: Uint8Array,
  timestamp: number,
  signWith: Uint8Array = sender.signingPrivKey,
): string {
  const packet: Packet = {
    type,
    // Relayed, not direct, so the injected announce binds no link.
    ttl: 6,
    flags: Flags.SIGNED,
    senderID: hexToBytes(sender.peerID),
    recipientID: new Uint8Array(8),
    timestamp,
    signature: new Uint8Array(64),
    payload,
  };
  packet.signature = signPacket(packet, signWith);
  return bytesToBase64(encodePacket(packet));
}

function bundleFrom(
  owner: Identity,
  prekeyByte: number,
  at: number,
  signWith: Uint8Array = owner.signingPrivKey,
): string {
  const bundle = signPrekeyBundle(
    {
      noiseStaticPublicKey: owner.noiseStaticPubKey,
      prekeys: [{ id: 1, publicKey: new Uint8Array(32).fill(prekeyByte) }],
      generatedAt: at,
    },
    signWith,
  );
  return signed(
    owner,
    PacketType.PREKEY_BUNDLE,
    encodePrekeyBundle(bundle)!,
    at,
    signWith,
  );
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

function assembliesHeldBy(device: SimDevice): number {
  return (device.mesh as unknown as { fragmentManager: { size: number } })
    .fragmentManager.size;
}

// A whole push-to-talk burst from `talker`, every packet dated `at`.
function burstFrom(talker: Identity, at: number): string[] {
  const burstID = randomBytes(8);
  const frames = [randomBytes(60), randomBytes(60), randomBytes(60)];
  return [
    encodeBurstStart(burstID, VoiceCodec.AAC_LC_16KHZ_MONO),
    encodeBurstData(burstID, 1, frames),
    encodeBurstData(burstID, 2, frames),
    encodeBurstEnd(burstID, 3, 2, 120),
  ].map((payload) => signed(talker, PacketType.VOICE_FRAME, payload, at));
}

test("I01 our own fragments echoed back open no assembly", async () => {
  // A dual link or a relay hands our broadcast fragments straight back. They
  // are duplicates of what we originated, and reassembling them rebuilds and
  // decodes our own file, or with one missing, holds a slot until it expires.
  const s = (scenario = new Scenario({
    id: "I01",
    title: "own fragments echoed",
    seed: 91,
  }));
  const { radio, alice } = await pair(s);
  const channel = "#bluetooth";
  alice.joinChannel(channel);

  const echoes: string[] = [];
  const untap = radio.tapWrites((fromID, _linkID, dataBase64) => {
    if (fromID !== alice.id) return;
    const p = decodePacket(base64ToBytes(dataBase64));
    if (p?.type === PacketType.FRAGMENT) echoes.push(dataBase64);
  });
  alice.sendAttachment(channel, media.jpeg(20_000), {
    type: "image",
    name: "echo.jpg",
    mimeType: "image/jpeg",
  });
  await s.world.advance(10_000);
  untap();
  s.check("alice sent the photo as fragments", echoes.length > 2);

  // All but the last, so an assembly opened by them would still be open.
  for (const frame of echoes.slice(0, -1)) {
    radio.injectTo(alice.id, "bob", frame);
  }
  await s.world.advance(500);
  s.check(
    "no assembly was opened for alice's own fragments",
    assembliesHeldBy(alice) === 0,
    `${assembliesHeldBy(alice)} assemblies held`,
  );
  s.expectNone("process health", noCrashes([alice]));
  s.assert();
});

test("I02 a prekey bundle that outran its owner's announce is kept and used", async () => {
  // The owner's announce and bundle go out together and are relayed with
  // independent jitter, so a node two hops away often gets the bundle first.
  // Bundles are never synced, so one dropped then may never come again.
  const s = (scenario = new Scenario({
    id: "I02",
    title: "prekey bundle before announce",
    seed: 92,
  }));
  const { radio, alice, bob } = await pair(s);
  const dave = stranger(71);
  const now = (): number => s.world.wallClock();

  radio.injectTo(bob.id, alice.id, bundleFrom(dave, 9, now()));
  await s.world.advance(500);
  s.check(
    "nothing is kept before dave's key is known",
    prekeysHeldFor(bob, dave.noiseStaticPubKey).length === 0,
  );

  radio.injectTo(
    bob.id,
    alice.id,
    signed(
      dave,
      PacketType.ANNOUNCE,
      encodeAnnouncePayload(dave, "dave"),
      now(),
    ),
  );
  await s.world.advance(500);
  s.check("bob heard dave's announce", bob.peers().includes(dave.peerID));
  s.check(
    "dave's held bundle was checked and kept once his key was pinned",
    prekeysHeldFor(bob, dave.noiseStaticPubKey).includes("09".repeat(32)),
    `held: ${JSON.stringify(prekeysHeldFor(bob, dave.noiseStaticPubKey))}`,
  );

  // The held bundle is checked against the key the announce pins, so one
  // signed by anybody else is still refused when the real owner turns up.
  const erin = stranger(81);
  const mallory = stranger(91);
  radio.injectTo(
    bob.id,
    alice.id,
    bundleFrom(erin, 7, now(), mallory.signingPrivKey),
  );
  await s.world.advance(500);
  radio.injectTo(
    bob.id,
    alice.id,
    signed(
      erin,
      PacketType.ANNOUNCE,
      encodeAnnouncePayload(erin, "erin"),
      now(),
    ),
  );
  await s.world.advance(500);
  s.check("bob heard erin's announce", bob.peers().includes(erin.peerID));
  s.check(
    "a held bundle erin did not sign is refused",
    prekeysHeldFor(bob, erin.noiseStaticPubKey).length === 0,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("I03 live voice from a clock running ahead is heard; too far ahead or too old is not", async () => {
  // bitchat-ios bounds only the past for live frames (30 s) and leaves the
  // future to its two-minute ingress guard. Bounding the future at 30 s here
  // would cut a fast-clocked talker off at every Airhop hop while bitchat-ios
  // phones hear and relay them.
  const s = (scenario = new Scenario({
    id: "I03",
    title: "live voice clock skew",
    seed: 93,
  }));
  const { radio, alice, bob } = await pair(s);
  const channel = "#bluetooth";
  alice.joinChannel(channel);
  bob.joinChannel(channel);
  bob.listenTo(channel);
  const talker = alice.identity;
  const played = (): number => bob.voice?.framesPlayed.length ?? 0;
  const inject = (frames: string[]): void => {
    for (const f of frames) radio.injectTo(bob.id, alice.id, f);
  };

  inject(burstFrom(talker, s.world.wallClock() + 60_000));
  await s.world.advance(2_000);
  const ahead = played();
  s.check(
    "a burst dated 60 s ahead plays",
    ahead > 0,
    `${String(ahead)} frames played`,
  );

  inject(burstFrom(talker, s.world.wallClock() + 150_000));
  await s.world.advance(2_000);
  s.check(
    "one dated past the two-minute guard does not",
    played() === ahead,
    `before=${String(ahead)} after=${String(played())}`,
  );

  inject(burstFrom(talker, s.world.wallClock() - 45_000));
  await s.world.advance(2_000);
  s.check(
    "nor one 45 s old",
    played() === ahead,
    `before=${String(ahead)} after=${String(played())}`,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("I04 a burst silenced for a note stays quiet to its end, and the next one plays", async () => {
  // bitchat-ios stops a burst when a note starts: one sound at a time, and the
  // listener chose the note.
  const s = (scenario = new Scenario({
    id: "I04",
    title: "live voice silenced by the listener",
    seed: 94,
  }));
  const { alice, bob } = await pair(s);
  const channel = "#bluetooth";
  alice.joinChannel(channel);
  bob.joinChannel(channel);
  bob.listenTo(channel);
  const played = (): number => bob.voice?.framesPlayed.length ?? 0;
  const silence = (): void =>
    (bob.mesh as unknown as { silenceLiveVoice(): void }).silenceLiveVoice();

  s.check("alice keyed up", await alice.startVoiceBurst(channel));
  await s.world.advance(1_000);
  const before = played();
  s.check("bob was hearing her", before > 0, `${String(before)} frames`);
  silence();
  await s.world.advance(1_000);
  await alice.stopVoiceBurst();
  await s.world.advance(2_000);
  s.check(
    "nothing more of that burst played",
    played() === before,
    `before=${String(before)} after=${String(played())}`,
  );

  s.check("alice keyed up again", await alice.startVoiceBurst(channel));
  await s.world.advance(1_000);
  await alice.stopVoiceBurst();
  await s.world.advance(2_000);
  s.check(
    "her next burst played",
    played() > before,
    `before=${String(before)} after=${String(played())}`,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("I05 a DM waiting on a handshake is not spent like a failed send", async () => {
  // Under a handshake nothing carrying the words has left the phone. Charged as
  // an attempt, a peer in range whose handshake never answers would see the
  // message fail within minutes; bitchat-ios keeps it, bounded by the outbox's
  // week.
  const s = (scenario = new Scenario({
    id: "I05",
    title: "DM held by a silent handshake",
    seed: 95,
  }));
  const { radio, alice, bob } = await pair(s);
  // Heard through bob, never answering a handshake: nobody holds his keys.
  const dave = stranger(61);
  const announce = (): void => {
    radio.injectTo(
      alice.id,
      bob.id,
      signed(
        dave,
        PacketType.ANNOUNCE,
        encodeAnnouncePayload(dave, "dave"),
        s.world.wallClock(),
      ),
    );
  };
  announce();
  await s.world.advance(500);
  s.check("alice knows dave", alice.peers().includes(dave.peerID));
  s.check(
    "the DM waits for a session",
    alice.sendDm(dave.peerID, "are you there?") === "queued",
  );

  // Twenty minutes of dave announcing, each announce a flush: well past eight
  // charged attempts at their two-minute spacing.
  for (let i = 0; i < 20; i++) {
    await s.world.advance(60_000);
    announce();
  }
  await s.world.advance(1_000);
  s.check(
    "the message is still queued for him",
    alice.outboxSize() === 1,
    `outbox=${String(alice.outboxSize())}`,
  );
  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});
