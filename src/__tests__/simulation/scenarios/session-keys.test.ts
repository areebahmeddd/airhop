// What a Noise session carries beyond the messages: who runs the Double
// Ratchet, the Nostr key that reaches a peer over the internet, and when the
// session itself is renewed.
//
//   SK01-SK03  The Nostr key and the ratchet bit ride inside the session
//              (0x54, bit 26 of 0x21), never the public announce.
//   SK04-SK07  The daily rekey: who starts it, the minute a replaced session
//              keeps decrypting (longer while a file is arriving), a peer
//              that restarted, and a wipe mid-rekey.
//   SK08       A session alone earns no Nostr key: a DM has to pass first.

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

import {
  HELD_SESSION_GRACE_MS,
  REKEY_AT_MS,
  REKEY_CHECK_INTERVAL_MS,
} from "@core/crypto/session-rekey";
import { base64ToBytes } from "@core/encoding/base64";
import { Capability } from "@core/mesh/discovery/announce-manager";
import { encodeDmMessage } from "@core/mesh/wire/dm-payload";
import { NoisePayloadType } from "@core/mesh/wire/noise-payload";
import {
  decodePacket,
  PacketType,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SimDevice, type DeviceSpec } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { advanceFor, Scenario, waitFor } from "../harness/scenario";

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

const android = (id: string, seedByte: number): DeviceSpec => ({
  id,
  platform: "android",
  seedByte,
});

// The mesh service's session state, read across the sandbox the way the
// adversarial suite reads its registry.
interface Bound {
  session: unknown;
  role: "initiator" | "responder";
  ratchet: object | null;
}
interface Internals {
  registry: {
    sessionFor: (peerID: string) => unknown;
    nostrPubkeyFor: (peerID: string) => string | undefined;
  };
  drStates: Map<string, Bound>;
  heldSessions: Map<string, unknown[]>;
  fragmentManager: { assemblingFrom: (senderID: Uint8Array) => boolean };
  pendingSwitches: Map<string, unknown>;
  sessionBornAt: WeakMap<object, number>;
  peerRunsAirhop: (peerID: string) => boolean;
  prepareDmSession: (peerID: string) => void;
  localCapabilities: (forPeer?: string) => number;
  sendPeerState: (peerID: string) => void;
  sendNostrKey: (...args: unknown[]) => void;
  sendDRMessage: (peerID: string, payload: Uint8Array, state: object) => void;
  switchToStaged: (peerID: string) => void;
  onAuthenticatedPeerState: (...args: unknown[]) => void;
  onNostrKey: (...args: unknown[]) => void;
  seedRatchet: (...args: unknown[]) => unknown;
  router: { sendNoisePayload: (...args: unknown[]) => boolean };
}

function internals(device: SimDevice): Internals {
  return device.mesh as unknown as Internals;
}

function decodeWrite(dataBase64: string): Packet | null {
  return decodePacket(base64ToBytes(dataBase64));
}

function pair(s: Scenario): {
  alice: SimDevice;
  bob: SimDevice;
  radio: RadioFabric;
} {
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, android("alice", 11));
  const bob = SimDevice.create(s.world, android("bob", 22));
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  return { alice, bob, radio };
}

async function met(s: Scenario, a: SimDevice, b: SimDevice): Promise<boolean> {
  return waitFor(
    s.world,
    () => a.peers().includes(b.peerID) && b.peers().includes(a.peerID),
    20_000,
  );
}

async function delivered(
  s: Scenario,
  from: SimDevice,
  to: SimDevice,
  text: string,
  budgetMs = 20_000,
): Promise<boolean> {
  from.send(`dm:${to.peerID}`, text);
  return waitFor(
    s.world,
    () =>
      from.messages(`dm:${to.peerID}`).find((m) => m.text === text)?.status ===
      "delivered",
    budgetMs,
  );
}

// A ratchet on both sides, so either can seal: each side has sent and received.
async function talking(
  s: Scenario,
  alice: SimDevice,
  bob: SimDevice,
): Promise<boolean> {
  const first = await delivered(s, alice, bob, "hello");
  const back = await delivered(s, bob, alice, "hi");
  const again = await delivered(s, alice, bob, "how are you");
  return first && back && again;
}

function ratchetSeeded(device: SimDevice, peerID: string): boolean {
  const m = internals(device);
  const bound = m.drStates.get(peerID);
  return (
    bound !== undefined &&
    bound.ratchet !== null &&
    bound.session === m.registry.sessionFor(peerID)
  );
}

// Make the session this phone holds with `peerID` look `ageMs` old.
function age(device: SimDevice, peerID: string, ageMs: number): void {
  const m = internals(device);
  const session = m.registry.sessionFor(peerID) as object;
  m.sessionBornAt.set(session, Date.now() - ageMs);
}

test("SK01 the ratchet seeds only after both proofs, and the Nostr key arrives inside the session", async () => {
  const s = (scenario = new Scenario({
    id: "SK01",
    title: "Nostr key and ratchet ride the session, not the announce",
    seed: 1301,
  }));
  const { alice, bob, radio } = pair(s);

  // Every announce on the air, read TLV by TLV: no Nostr key (the retired
  // 0x07), and neither Airhop-only proof bit among the capabilities (0x05):
  // bit 26 (ratchet) or bit 25 (location pin), which would mark the phone.
  const announcesWithNostr: string[] = [];
  const announcesWithRatchet: string[] = [];
  let announces = 0;
  const stop = radio.tapWrites((fromID, _link, data) => {
    const p = decodeWrite(data);
    if (p?.type !== PacketType.ANNOUNCE) return;
    announces++;
    let off = 0;
    while (off + 2 <= p.payload.length) {
      const type = p.payload[off];
      const value = p.payload.slice(off + 2, off + 2 + p.payload[off + 1]);
      if (type === 0x07) announcesWithNostr.push(fromID);
      // Bits 25 and 26 are bits 1 and 2 of the fourth little-endian byte.
      if (type === 0x05 && value.length >= 4 && (value[3] & 0x06) !== 0) {
        announcesWithRatchet.push(fromID);
      }
      off += 2 + p.payload[off + 1];
    }
  });

  // Call order on each phone: a proof accepted, a ratchet seeded, a key taken.
  const events: string[] = [];
  for (const d of [alice, bob]) {
    const m = internals(d);
    const proof = m.onAuthenticatedPeerState.bind(m);
    m.onAuthenticatedPeerState = (...args: unknown[]) => {
      events.push(`${d.id}:proof`);
      proof(...args);
    };
    const seed = m.seedRatchet.bind(m);
    m.seedRatchet = (...args: unknown[]) => {
      events.push(`${d.id}:seed`);
      return seed(...args);
    };
    const key = m.onNostrKey.bind(m);
    m.onNostrKey = (...args: unknown[]) => {
      events.push(`${d.id}:key`);
      key(...args);
    };
  }

  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check(
    "before any session, each reads the other as bitchat",
    !internals(alice).peerRunsAirhop(bob.peerID) &&
      !internals(bob).peerRunsAirhop(alice.peerID),
  );
  s.check(
    "and knows no Nostr key for them",
    internals(alice).registry.nostrPubkeyFor(bob.peerID) === undefined &&
      internals(bob).registry.nostrPubkeyFor(alice.peerID) === undefined,
  );

  s.check("a first DM gets through", await delivered(s, alice, bob, "hello"));
  await advanceFor(s.world, 2_000);
  stop();

  s.check(
    "no announce carried a Nostr key",
    announces > 0 && announcesWithNostr.length === 0,
    `${String(announces)} announces, with 0x07 from [${announcesWithNostr.join(", ")}]`,
  );
  s.check(
    "nor an Airhop-only proof bit",
    announcesWithRatchet.length === 0,
    `bit 25 or 26 from [${announcesWithRatchet.join(", ")}]`,
  );
  for (const d of [alice, bob]) {
    const seeded = events.indexOf(`${d.id}:seed`);
    const proven = events.indexOf(`${d.id}:proof`);
    s.check(
      `${d.id} seeded its ratchet only after a proof`,
      proven >= 0 && seeded > proven,
      events.join(" "),
    );
    s.check(
      `${d.id} took a Nostr key from the session`,
      events.includes(`${d.id}:key`),
    );
  }
  s.check(
    "both hold a ratchet bound to the session",
    ratchetSeeded(alice, bob.peerID) && ratchetSeeded(bob, alice.peerID),
  );
  s.check(
    "each holds the other's Nostr key",
    internals(alice).registry.nostrPubkeyFor(bob.peerID) === bob.nostrPubkey &&
      internals(bob).registry.nostrPubkeyFor(alice.peerID) ===
        alice.nostrPubkey,
  );
  s.check(
    "and each now reads the other as Airhop",
    internals(alice).peerRunsAirhop(bob.peerID) &&
      internals(bob).peerRunsAirhop(alice.peerID),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK02 a second proof does not reseed a live ratchet", async () => {
  // The proof is sent again (the echo, a ring grant re-proven). Seeding again
  // would reset a ratchet mid-conversation and every DM after would vanish.
  const s = (scenario = new Scenario({
    id: "SK02",
    title: "a repeated 0x21 leaves the ratchet alone",
    seed: 1302,
  }));
  const { alice, bob } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));

  const aliceRatchet = internals(alice).drStates.get(bob.peerID)?.ratchet;
  const bobRatchet = internals(bob).drStates.get(alice.peerID)?.ratchet;
  internals(alice).sendPeerState(bob.peerID);
  internals(bob).sendPeerState(alice.peerID);
  await advanceFor(s.world, 2_000);

  s.check(
    "both ratchets are the ones they were",
    aliceRatchet != null &&
      internals(alice).drStates.get(bob.peerID)?.ratchet === aliceRatchet &&
      bobRatchet != null &&
      internals(bob).drStates.get(alice.peerID)?.ratchet === bobRatchet,
  );
  s.check(
    "and the conversation carries on",
    (await delivered(s, alice, bob, "still here")) &&
      (await delivered(s, bob, alice, "me too")),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK03 a peer that proves no ratchet gets no Nostr key and no ratchet", async () => {
  // Bob plays a bitchat phone: a session and a proof, without bit 26. Alice
  // must keep plain Noise toward him and never send him a payload type bitchat
  // does not know.
  const s = (scenario = new Scenario({
    id: "SK03",
    title: "no 0x54 to a peer without the ratchet bit",
    seed: 1303,
  }));
  const { alice, bob } = pair(s);
  const bobMesh = internals(bob);
  const caps = bobMesh.localCapabilities.bind(bobMesh);
  bobMesh.localCapabilities = (forPeer?: string) =>
    caps(forPeer) & ~Capability.doubleRatchet;
  // Nor does bitchat hand over a Nostr key inside the session.
  bobMesh.sendNostrKey = () => {};
  const aliceSends: number[] = [];
  const aliceRouter = internals(alice).router;
  const send = aliceRouter.sendNoisePayload.bind(aliceRouter);
  aliceRouter.sendNoisePayload = (...args: unknown[]) => {
    aliceSends.push(args[1] as number);
    return send(...args);
  };

  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));

  s.check(
    "alice never sent bob her Nostr key",
    !aliceSends.includes(NoisePayloadType.NOSTR_KEY),
    `payload types sent: ${aliceSends.map((t) => `0x${t.toString(16)}`).join(", ")}`,
  );
  s.check(
    "she seeded no ratchet for him",
    internals(alice).drStates.get(bob.peerID)?.ratchet === null,
  );
  s.check(
    "and reads him as bitchat",
    !internals(alice).peerRunsAirhop(bob.peerID),
  );
  // As a bitchat QR card would leave it: an npub on the contact. The app is
  // what his proofs said, which outlives the session.
  const contacts = alice.store("contactsStore");
  (contacts.getState().setNostrPubkey as (p: string, k: string) => void)(
    bob.peerID,
    "cc".repeat(32),
  );
  const contactOfBob = (): { provenAirhop?: boolean } | undefined =>
    (
      contacts.getState().contacts as Record<string, { provenAirhop?: boolean }>
    )[bob.peerID];
  s.check(
    "his contact records a proof without the bit",
    contactOfBob()?.provenAirhop === false,
  );
  alice.relaunch();
  s.check(
    "and with no session left, an npub on his contact still reads as bitchat",
    !internals(alice).peerRunsAirhop(bob.peerID),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK04 at 90% of a day the lower peer ID rekeys, once, and the ratchet is reseeded", async () => {
  // Both phones reach the threshold together, as two Airhop phones in one
  // session always do. Only the lower peer ID starts the handshake.
  const s = (scenario = new Scenario({
    id: "SK04",
    title: "a timed rekey between two Airhop phones",
    seed: 1304,
  }));
  const { alice, bob, radio } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));
  const [low, high] = alice.peerID < bob.peerID ? [alice, bob] : [bob, alice];

  const before = {
    low: internals(low).registry.sessionFor(high.peerID),
    high: internals(high).registry.sessionFor(low.peerID),
  };
  const firstMessages: string[] = [];
  const stop = radio.tapWrites((_fromID, _link, data) => {
    const p = decodeWrite(data);
    if (p?.type === PacketType.NOISE_HANDSHAKE && p.payload.length === 32) {
      firstMessages.push(bytesToHex(p.senderID));
    }
  });
  age(low, high.peerID, REKEY_AT_MS + 1_000);
  age(high, low.peerID, REKEY_AT_MS + 1_000);
  await advanceFor(s.world, REKEY_CHECK_INTERVAL_MS + 5_000);
  stop();

  s.check(
    "one side started it, the lower peer ID",
    firstMessages.length > 0 && firstMessages.every((id) => id === low.peerID),
    `msg1 from [${firstMessages.join(", ")}]`,
  );
  const after = {
    low: internals(low).registry.sessionFor(high.peerID),
    high: internals(high).registry.sessionFor(low.peerID),
  };
  s.check(
    "both moved to a new session",
    after.low !== undefined &&
      after.high !== undefined &&
      after.low !== before.low &&
      after.high !== before.high,
  );
  s.check(
    "and reseeded the ratchet on it",
    ratchetSeeded(low, high.peerID) && ratchetSeeded(high, low.peerID),
  );
  s.check(
    "the conversation carries on both ways",
    (await delivered(s, low, high, "after the rekey")) &&
      (await delivered(s, high, low, "same here")),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK05 a ratchet message sealed under the old session opens for a minute, then not", async () => {
  const s = (scenario = new Scenario({
    id: "SK05",
    title: "stragglers across a rekey",
    seed: 1305,
  }));
  const { alice, bob } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));
  const [low, high] = alice.peerID < bob.peerID ? [alice, bob] : [bob, alice];
  const oldSession = internals(low).registry.sessionFor(high.peerID);
  const highOldSession = internals(high).registry.sessionFor(low.peerID);
  const oldRatchet = internals(low).drStates.get(high.peerID)?.ratchet;
  s.check("the low side holds a ratchet to seal with", oldRatchet != null);

  age(low, high.peerID, REKEY_AT_MS + 1_000);
  const rekeyed = await waitFor(
    s.world,
    () =>
      internals(low).registry.sessionFor(high.peerID) !== oldSession &&
      internals(high).registry.sessionFor(low.peerID) !== highOldSession &&
      ratchetSeeded(high, low.peerID),
    REKEY_CHECK_INTERVAL_MS + 10_000,
  );
  s.check("the session was renewed", rekeyed);

  // A message the low side sealed just before switching, arriving late.
  const seal = (id: string, text: string): void => {
    internals(low).sendDRMessage(
      high.peerID,
      encodeDmMessage(id, text),
      oldRatchet as object,
    );
  };
  seal("straggler-1", "sealed before the switch");
  s.check(
    "inside the grace window it opens under the held session",
    await waitFor(
      s.world,
      () => high.texts(`dm:${low.peerID}`).includes("sealed before the switch"),
      5_000,
    ),
  );

  await advanceFor(s.world, HELD_SESSION_GRACE_MS + REKEY_CHECK_INTERVAL_MS);
  seal("straggler-2", "sealed long before");
  await advanceFor(s.world, 5_000);
  s.check(
    "after it, the old session opens nothing",
    !high.texts(`dm:${low.peerID}`).includes("sealed long before"),
  );
  s.check(
    "and holds nothing for it anymore",
    (internals(high).heldSessions.get(low.peerID) ?? []).length === 0,
  );
  s.check(
    "while the new session works",
    await delivered(s, low, high, "on the new keys"),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

// A 1 MiB file sealed just before the switch takes about a minute over
// Bluetooth. Its last fragment ends the assembly before the whole packet is
// opened, so the held session must still be there at that moment.
test("SK05b a file still arriving keeps the old session past its minute, through its last fragment", async () => {
  const s = (scenario = new Scenario({
    id: "SK05b",
    title: "a rekey in the middle of a file",
    seed: 1315,
  }));
  const { alice, bob } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));
  const [low, high] = alice.peerID < bob.peerID ? [alice, bob] : [bob, alice];
  const oldSession = internals(low).registry.sessionFor(high.peerID);
  const oldRatchet = internals(low).drStates.get(high.peerID)?.ratchet;

  age(low, high.peerID, REKEY_AT_MS + 1_000);
  s.check(
    "the session was renewed",
    await waitFor(
      s.world,
      () =>
        internals(low).registry.sessionFor(high.peerID) !== oldSession &&
        ratchetSeeded(high, low.peerID),
      REKEY_CHECK_INTERVAL_MS + 10_000,
    ),
  );

  // The file's fragments keep arriving past the grace and a rekey tick.
  const fragments = internals(high).fragmentManager;
  const assemblingFrom = fragments.assemblingFrom.bind(fragments);
  let arriving = true;
  fragments.assemblingFrom = (sender: Uint8Array) =>
    arriving || assemblingFrom(sender);
  try {
    await advanceFor(s.world, HELD_SESSION_GRACE_MS + REKEY_CHECK_INTERVAL_MS);
    s.check(
      "the old session is still held while the file arrives",
      (internals(high).heldSessions.get(low.peerID) ?? []).length > 0,
    );

    // The last fragment lands: the assembly is gone, then the packet opens.
    arriving = false;
    internals(low).sendDRMessage(
      high.peerID,
      encodeDmMessage("file-tail", "sealed before the switch, opened late"),
      oldRatchet as object,
    );
    s.check(
      "and it opens what was sealed under it",
      await waitFor(
        s.world,
        () =>
          high
            .texts(`dm:${low.peerID}`)
            .includes("sealed before the switch, opened late"),
        5_000,
      ),
    );

    await advanceFor(s.world, REKEY_CHECK_INTERVAL_MS + 1_000);
    s.check(
      "the next tick lets it go",
      (internals(high).heldSessions.get(low.peerID) ?? []).length === 0,
    );
  } finally {
    fragments.assemblingFrom = assemblingFrom;
  }

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK06 a peer that restarts mid-conversation is reseeded, not carried over", async () => {
  // A restart and a rekey look identical on the wire. The phone that kept its
  // state must not keep its old ratchet, or every message after fails silently.
  const s = (scenario = new Scenario({
    id: "SK06",
    title: "restart mid-session",
    seed: 1306,
  }));
  const { alice, bob } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));

  bob.relaunch();
  s.check(
    "bob is back",
    await waitFor(s.world, () => alice.peers().includes(bob.peerID), 30_000),
  );
  // Alice first: she still holds the old session and ratchet, which bob lost.
  s.check(
    "alice's next message reaches the restarted bob",
    await delivered(s, alice, bob, "did you restart?", 60_000),
  );
  s.check(
    "and bob's reaches her",
    await delivered(s, bob, alice, "I did", 60_000),
  );
  s.check(
    "on a fresh ratchet each",
    ratchetSeeded(alice, bob.peerID) && ratchetSeeded(bob, alice.peerID),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK07 a wipe in the middle of a rekey leaves no session held", async () => {
  const s = (scenario = new Scenario({
    id: "SK07",
    title: "panic wipe during a rekey",
    seed: 1307,
  }));
  const { alice, bob } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));
  s.check("they are talking", await talking(s, alice, bob));
  const [low, high] = alice.peerID < bob.peerID ? [alice, bob] : [bob, alice];

  // Hold the low side at the moment between its msg3 and the switch, with a
  // staged session and a held one both alive.
  const lowMesh = internals(low);
  lowMesh.switchToStaged = () => {};
  age(low, high.peerID, REKEY_AT_MS + 1_000);
  // Both at once: msg3 crosses the fabric after the low side stages, so the
  // high side adopts and holds the old session tens of milliseconds later.
  s.check(
    "the low side staged a new session while the high side, already switched, holds the old one",
    await waitFor(
      s.world,
      () =>
        lowMesh.pendingSwitches.has(high.peerID) &&
        (internals(high).heldSessions.get(low.peerID) ?? []).length > 0,
      REKEY_CHECK_INTERVAL_MS + 10_000,
    ),
  );

  // A panic wipe starts with destroyMeshService, which is what a kill runs.
  const highMesh = internals(high);
  low.kill();
  high.kill();
  for (const [name, m] of [
    ["low", lowMesh],
    ["high", highMesh],
  ] as const) {
    s.check(
      `${name}: nothing staged, held or bound`,
      m.pendingSwitches.size === 0 &&
        m.heldSessions.size === 0 &&
        m.drStates.size === 0,
    );
  }
  s.check(
    "and no session left in the registry",
    lowMesh.registry.sessionFor(high.peerID) === undefined &&
      highMesh.registry.sessionFor(low.peerID) === undefined,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});

test("SK08 a handshake alone earns no Nostr key; a DM exchanged does, and it lands on the contact", async () => {
  // Anyone in range can complete a handshake and prove the ratchet bit. The
  // npub ties this phone to its internet inbox, so it goes only to a contact
  // or to a peer a DM has passed with.
  const s = (scenario = new Scenario({
    id: "SK08",
    title: "the Nostr key waits for a DM",
    seed: 1308,
  }));
  const { alice, bob } = pair(s);
  s.check("alice and bob hear each other", await met(s, alice, bob));

  // A thread opened, nothing sent: the session the thread asks for ahead of
  // the first message.
  internals(bob).prepareDmSession(alice.peerID);
  s.check(
    "the session and both proofs complete",
    await waitFor(
      s.world,
      () =>
        internals(alice).peerRunsAirhop(bob.peerID) &&
        internals(bob).peerRunsAirhop(alice.peerID),
      20_000,
    ),
  );
  await advanceFor(s.world, 2_000);
  s.check(
    "neither handed the other its Nostr key",
    internals(alice).registry.nostrPubkeyFor(bob.peerID) === undefined &&
      internals(bob).registry.nostrPubkeyFor(alice.peerID) === undefined,
  );

  s.check("bob's first DM gets through", await delivered(s, bob, alice, "hi"));
  await advanceFor(s.world, 2_000);
  s.check(
    "each now holds the other's key, sent once the DM passed",
    internals(alice).registry.nostrPubkeyFor(bob.peerID) === bob.nostrPubkey &&
      internals(bob).registry.nostrPubkeyFor(alice.peerID) ===
        alice.nostrPubkey,
  );

  type Contacts = Record<
    string,
    { nostrPubkeyHex?: string; provenAirhop?: boolean }
  >;
  const contactOf = (d: SimDevice, peerID: string) =>
    (d.store("contactsStore").getState().contacts as Contacts)[peerID];
  s.check(
    "bob saved alice by writing to her, with her key and her app",
    contactOf(bob, alice.peerID)?.nostrPubkeyHex === alice.nostrPubkey &&
      contactOf(bob, alice.peerID)?.provenAirhop === true,
  );
  s.check("alice's reply gets through", await delivered(s, alice, bob, "hey"));
  s.check(
    "and alice saved bob the same way",
    contactOf(alice, bob.peerID)?.nostrPubkeyHex === bob.nostrPubkey &&
      contactOf(alice, bob.peerID)?.provenAirhop === true,
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});
