/**
 * @jest-environment node
 */
// Location-channel DMs across a real relay pool.
//
// A geohash DM goes out from the per-cell identity, never from the phone's
// durable npub, or the pseudonym the cell exists to provide is tied to the
// person behind it. These pin that a retry holds to that as the first send
// does.

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
  deriveGeohashIdentity,
  deriveGeohashSeed,
} from "@core/nostr/geohash-identity";
import { unwrapDm } from "@core/nostr/gift-wrap";
import { ed25519 } from "@noble/curves/ed25519.js";
import { SimDevice } from "../harness/device";
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

const GIFT_WRAP_KIND = 1059;

test("G01 a geohash DM retried from the outbox still leaves from the cell identity", async () => {
  const s = (scenario = new Scenario({
    id: "G01",
    title: "a refused geohash DM is retried under its pseudonym",
    seed: 901,
  }));
  const radio = new RadioFabric(s.world);
  const relay = new RelayFabric(s.world);
  const alice = SimDevice.create(
    s.world,
    { id: "alice", platform: "android", seedByte: 11, internetEnabled: true },
    relay,
  );
  radio.add(alice);
  s.track(alice);
  alice.launch();
  s.check(
    "alice is online",
    await waitForCoarse(s.world, () => relay.connectionCount("alice") > 0),
  );

  // Somebody alice met in a location channel, known only by their cell key.
  const cell = "u4pruy";
  const stranger = deriveGeohashIdentity(
    deriveGeohashSeed(ed25519.utils.randomSecretKey()),
    cell,
  );
  const thread = `nostr_${stranger.pubKeyHex}`;
  (
    alice.store("chatStore").getState().setGeoDmCell as (
      pubkey: string,
      geohash: string,
    ) => void
  )(stranger.pubKeyHex, cell);

  const mesh = alice.mesh as unknown as {
    publishNostrDm: (...args: unknown[]) => boolean;
    flushOutbox: (peerID: string) => void;
  };
  let mainIdentitySends = 0;
  const publishNostrDm = mesh.publishNostrDm.bind(mesh);
  mesh.publishNostrDm = (...args: unknown[]) => {
    mainIdentitySends++;
    return publishNostrDm(...args);
  };
  const pending = (): { id: string }[] =>
    alice.store("outboxStore").getState().pending as { id: string }[];

  // No relay acknowledges it, so it is parked for the retry sweep.
  relay.setAllRelayConditions({ withholdOk: true });
  alice.sendDm(thread, "meet at the plaza", "g01-msg");
  const parked = await waitForCoarse(
    s.world,
    () => pending().some((m) => m.id === "g01-msg"),
    30_000,
  );
  s.check("the refused DM waits in the outbox", parked);

  relay.setAllRelayConditions({ withholdOk: false });
  const before = relay.eventsOfKind(GIFT_WRAP_KIND).length;
  mesh.flushOutbox(thread);
  await s.world.advance(5_000);

  const retried = relay
    .eventsOfKind(GIFT_WRAP_KIND)
    .slice(before)
    .flatMap((event) => {
      try {
        return [
          unwrapDm(event as never, stranger.privKey, Number.POSITIVE_INFINITY),
        ];
      } catch {
        return [];
      }
    });
  s.check("the retry reached the stranger's cell key", retried.length > 0);
  s.check(
    "and was written by a key other than alice's npub",
    retried.every((dm) => dm.senderPubkey !== alice.nostrPubkey),
  );
  s.check(
    "the main identity was never asked to carry it",
    mainIdentitySends === 0,
    `sends=${String(mainIdentitySends)}`,
  );
  s.check(
    "a retry that went out leaves the queue",
    !pending().some((m) => m.id === "g01-msg"),
  );

  s.expectNone("process health", noCrashes([alice]));
  s.assert(true);
});
