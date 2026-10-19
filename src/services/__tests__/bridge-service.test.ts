// The mesh bridge's policy, against a fake relay pool: which identity it signs
// with, which cells it hears, when it carries a remote message onto the radio,
// what it holds while the relays are down, and what relay or radio ingress can
// cost it. The multi-phone properties (two bridges on one island, a phone with
// the bridge off) are in the gateway-bridge simulation.

import {
  CarrierDirection,
  decodeNostrCarrier,
  type NostrCarrierPacket,
} from "@core/mesh/wire/nostr-carrier";
import { createBridgeMeshEvent } from "@core/nostr/bridge-event";
import {
  deriveGeohashIdentity,
  deriveGeohashSeed,
} from "@core/nostr/geohash-identity";
import { encodeGeohash } from "@core/nostr/geohash-presence";
import type { NostrClient } from "@core/nostr/nostr-client";
import { geohashNeighbours } from "@utils/geohash-grid";
import {
  finalizeEvent,
  generateSecretKey,
  type Event as NostrEvent,
} from "nostr-tools";
import {
  BridgeService,
  INBOUND_EVENTS_PER_MINUTE_PER_SIGNER,
  MAX_PARTICIPANTS,
  MAX_QUEUED_UPLINKS,
  MAX_QUEUED_UPLINKS_PER_DEPOSITOR,
  SIGNATURE_CHECKS_PER_MINUTE,
  type BridgeHooks,
  type BridgeInboundMessage,
  type BridgeStatus,
} from "../bridge-service";

// Bengaluru, so the cell is one the relay directory has neighbours for.
const mockCoords = { lat: 12.9716, lng: 77.5946 };
jest.mock("../location-service", () => ({
  getCoarseLocation: () => Promise.resolve(mockCoords),
}));

// Every Schnorr check the bridge pays for, so a bound on them can be counted.
const mockVerified: string[] = [];
jest.mock("nostr-tools", () => {
  const actual =
    jest.requireActual<typeof import("nostr-tools")>("nostr-tools");
  return {
    ...actual,
    verifyEvent: (event: Parameters<typeof actual.verifyEvent>[0]) => {
      mockVerified.push(event.id);
      return actual.verifyEvent(event);
    },
  };
});

const CELL = encodeGeohash(mockCoords.lat, mockCoords.lng, 6);

interface FakeSub {
  filters: { "#r"?: string[] }[];
  onEvent: (event: NostrEvent) => void;
  closed: boolean;
}

class FakeClient {
  readonly subs: FakeSub[] = [];
  readonly published: NostrEvent[] = [];

  subscribe(
    filters: FakeSub["filters"],
    onEvent: FakeSub["onEvent"],
  ): { close: () => void } {
    const sub: FakeSub = { filters, onEvent, closed: false };
    this.subs.push(sub);
    return {
      close: () => {
        sub.closed = true;
      },
    };
  }

  publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
    return Promise.resolve();
  }

  // What a relay hands back: plain JSON, with nothing cached about whether the
  // signature was already checked.
  deliver(event: NostrEvent): void {
    const live = this.subs.filter((s) => !s.closed);
    for (const sub of live) sub.onEvent(fromWire(event));
  }

  get live(): FakeSub | undefined {
    return this.subs.filter((s) => !s.closed).at(-1);
  }
}

function fromWire(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function asClient(fake: FakeClient): NostrClient {
  return fake as unknown as NostrClient;
}

interface Rig {
  bridge: BridgeService;
  client: FakeClient;
  injected: BridgeInboundMessage[];
  downlinks: Uint8Array[];
  deposits: { payload: Uint8Array; peerID: string }[];
  status: BridgeStatus[];
  cellChanges: { value: number };
  online: { value: boolean };
  signingKey: Uint8Array<ArrayBuffer>;
}

function rig(signingKey = new Uint8Array(32).fill(7)): Rig {
  const r = {
    client: new FakeClient(),
    injected: [] as BridgeInboundMessage[],
    downlinks: [] as Uint8Array[],
    deposits: [] as { payload: Uint8Array; peerID: string }[],
    status: [] as BridgeStatus[],
    cellChanges: { value: 0 },
    online: { value: true },
    signingKey,
  };
  const hooks: BridgeHooks = {
    injectMessage: (m) => r.injected.push(m),
    firstReachableBridge: () => ({ peerID: "aa".repeat(8) }),
    advertisedBridgeCell: () => undefined,
    sendCarrierToBridge: (payload, peerID) =>
      r.deposits.push({ payload, peerID }),
    broadcastCarrierFromBridge: (payload) => r.downlinks.push(payload),
    relaysConnected: () => r.online.value,
    nickname: () => "me",
    onStatus: (s) => r.status.push(s),
    onActiveCellChanged: () => {
      r.cellChanges.value++;
    },
  };
  return { ...r, bridge: new BridgeService(signingKey, hooks) };
}

// A bridge that is on, online, and subscribed to its cell.
async function online(r: Rig): Promise<void> {
  r.bridge.attachClient(asClient(r.client));
  r.bridge.setEnabled(true);
  await jest.advanceTimersByTimeAsync(0);
}

// A message from somebody on another island, signed by their own key.
function remoteMessage(
  content: string,
  opts: { cell?: string; key?: Uint8Array } = {},
): NostrEvent {
  return createBridgeMeshEvent({
    content,
    cell: opts.cell ?? CELL,
    privKey: opts.key ?? generateSecretKey(),
    nickname: "far",
    meshSenderID: "0123456789abcdef",
    meshTimestampMs: Date.now(),
  });
}

function carrier(
  direction: CarrierDirection,
  event: NostrEvent,
  geohash = CELL,
): NostrCarrierPacket {
  return {
    direction,
    geohash,
    eventJSON: new TextEncoder().encode(JSON.stringify(event)),
  };
}

function eventIn(payload: Uint8Array): NostrEvent {
  const decoded = decodeNostrCarrier(payload);
  if (decoded === null) throw new Error("not a carrier");
  return JSON.parse(new TextDecoder().decode(decoded.eventJSON)) as NostrEvent;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockVerified.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the rendezvous identity", () => {
  it("is not the location-channel identity for the same cell", async () => {
    // The bridged event carries the durable mesh peer ID in its `m` tag. Signed
    // with the #neighborhood key, it would link that pseudonym to the peer ID.
    const r = rig();
    await online(r);
    void r.bridge.bridgeOutgoing(
      "hello",
      "0123456789abcdef",
      Date.now(),
      false,
    );
    const sent = r.client.published.find((e) => e.kind === 20000);
    const seed = deriveGeohashSeed(r.signingKey);
    expect(sent).toBeDefined();
    expect(sent?.pubkey).not.toBe(deriveGeohashIdentity(seed, CELL).pubKeyHex);
    expect(sent?.pubkey).toBe(
      deriveGeohashIdentity(seed, `bridge|${CELL}`).pubKeyHex,
    );
  });

  it("still recognises its own events after a restart", async () => {
    // A fresh instance has an empty published-ID cache, so only the derived
    // key can tell that a relay backfill is ours.
    const before = rig();
    await online(before);
    void before.bridge.bridgeOutgoing(
      "from before the restart",
      "0123456789abcdef",
      Date.now(),
      false,
    );
    const own = before.client.published.find((e) => e.kind === 20000)!;

    const after = rig(before.signingKey);
    await online(after);
    after.client.deliver(own);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(after.injected).toHaveLength(0);
    expect(after.downlinks).toHaveLength(0);

    // And the location-channel key for the cell is somebody else to it.
    const neighbourhoodKey = deriveGeohashIdentity(
      deriveGeohashSeed(before.signingKey),
      CELL,
    ).privKey;
    after.client.deliver(
      remoteMessage("signed with the channel key", { key: neighbourhoodKey }),
    );
    expect(after.injected.map((m) => m.text)).toEqual([
      "signed with the channel key",
    ]);
  });
});

describe("the neighbour ring", () => {
  it("subscribes to the own cell and its eight neighbours", async () => {
    const r = rig();
    await online(r);
    const cells = r.client.live?.filters[0]["#r"] ?? [];
    expect(new Set(cells)).toEqual(
      new Set([CELL, ...geohashNeighbours(CELL).map((n) => n.geohash)]),
    );
    expect(cells).toHaveLength(9);
  });

  it("hears a neighbouring cell and ignores a far one", async () => {
    const r = rig();
    await online(r);
    const next = geohashNeighbours(CELL)[0].geohash;
    r.client.deliver(remoteMessage("across the street", { cell: next }));
    r.client.deliver(remoteMessage("across the world", { cell: "u4pruy" }));
    expect(r.injected.map((m) => m.text)).toEqual(["across the street"]);
  });

  it("publishes to its own cell only", async () => {
    const r = rig();
    await online(r);
    void r.bridge.bridgeOutgoing("mine", "0123456789abcdef", Date.now(), false);
    const sent = r.client.published.filter((e) => e.kind === 20000);
    expect(sent).toHaveLength(1);
    expect(sent[0].tags.filter((t) => t[0] === "r")).toEqual([["r", CELL]]);
  });
});

describe("carrying a remote message onto the radio", () => {
  it("waits out a holdoff before it sends", async () => {
    const r = rig();
    await online(r);
    r.client.deliver(remoteMessage("from the far island"));
    expect(r.injected).toHaveLength(1);
    expect(r.downlinks).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(r.downlinks).toHaveLength(1);
  });

  it("stands down when another bridge carried it first", async () => {
    const r = rig();
    await online(r);
    const event = remoteMessage("heard by two bridges");
    r.client.deliver(event);
    // The other bridge on this island won the holdoff race.
    r.bridge.handleMeshCarrier(
      carrier(CarrierDirection.FROM_BRIDGE, event),
      "bb".repeat(8),
      false,
    );
    await jest.advanceTimersByTimeAsync(2_000);
    expect(r.downlinks).toHaveLength(0);
    expect(r.injected).toHaveLength(1);
  });

  it("stands down when the radio copy arrived during the holdoff", async () => {
    const r = rig();
    await online(r);
    const sentAt = Date.now();
    const event = createBridgeMeshEvent({
      content: "also on the radio",
      cell: CELL,
      privKey: generateSecretKey(),
      meshSenderID: "0123456789abcdef",
      meshTimestampMs: sentAt,
    });
    r.client.deliver(event);
    r.bridge.noteRadioMessage("0123456789abcdef", sentAt, "also on the radio");
    await jest.advanceTimersByTimeAsync(2_000);
    expect(r.downlinks).toHaveLength(0);
  });

  it("drops what it owed when the bridge goes off or the pool goes", async () => {
    const off = rig();
    await online(off);
    off.client.deliver(remoteMessage("owed, then switched off"));
    off.bridge.setEnabled(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(off.downlinks).toHaveLength(0);

    const detached = rig();
    await online(detached);
    detached.client.deliver(remoteMessage("owed, then the pool went"));
    detached.bridge.attachClient(null);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(detached.downlinks).toHaveLength(0);
  });
});

describe("a new relay pool", () => {
  it("keeps what the old one already handled", async () => {
    const r = rig();
    await online(r);
    const event = remoteMessage("before the handoff");
    r.client.deliver(event);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(r.injected).toHaveLength(1);
    expect(r.downlinks).toHaveLength(1);

    // A network handoff: the new pool's subscription replays the backlog.
    const next = new FakeClient();
    r.bridge.attachClient(asClient(next));
    await jest.advanceTimersByTimeAsync(0);
    expect(next.live?.filters[0]["#r"]).toContain(CELL);
    next.deliver(event);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(r.injected).toHaveLength(1);
    expect(r.downlinks).toHaveLength(1);
  });
});

describe("a deposit while the relays are down", () => {
  function deposit(
    r: Rig,
    content: string,
    depositor = "cc".repeat(8),
  ): NostrEvent {
    const event = remoteMessage(content);
    r.bridge.handleMeshCarrier(
      carrier(CarrierDirection.TO_BRIDGE, event),
      depositor,
      true,
    );
    return event;
  }

  it("is held, then published once a relay is live", async () => {
    const r = rig();
    await online(r);
    r.online.value = false;
    const held = deposit(r, "deposited in the lift");
    expect(r.client.published.some((e) => e.id === held.id)).toBe(false);
    r.online.value = true;
    r.bridge.flushQueuedUplinks();
    expect(r.client.published.some((e) => e.id === held.id)).toBe(true);
  });

  it("is dropped at flush once it is stale", async () => {
    const r = rig();
    await online(r);
    r.online.value = false;
    const held = deposit(r, "too long in the bag");
    await jest.advanceTimersByTimeAsync(16 * 60 * 1000);
    r.online.value = true;
    r.bridge.flushQueuedUplinks();
    expect(r.client.published.some((e) => e.id === held.id)).toBe(false);
  });

  it("is bounded per depositor and in total", async () => {
    const r = rig();
    await online(r);
    r.online.value = false;
    const one = Array.from(
      { length: MAX_QUEUED_UPLINKS_PER_DEPOSITOR + 3 },
      (_, i) => deposit(r, `one depositor ${String(i)}`),
    );
    const many = Array.from({ length: MAX_QUEUED_UPLINKS }, (_, i) =>
      deposit(r, `many ${String(i)}`, i.toString(16).padStart(16, "0")),
    );
    r.online.value = true;
    r.bridge.flushQueuedUplinks();
    const out = new Set(r.client.published.map((e) => e.id));
    expect(one.filter((e) => out.has(e.id)).length).toBeLessThanOrEqual(
      MAX_QUEUED_UPLINKS_PER_DEPOSITOR,
    );
    expect([...one, ...many].filter((e) => out.has(e.id))).toHaveLength(
      MAX_QUEUED_UPLINKS,
    );
  });

  it("is refused with the internet off, and the bag goes with it", async () => {
    const r = rig();
    await online(r);
    r.online.value = false;
    const held = deposit(r, "held, then the internet went off");
    r.bridge.attachClient(null);
    r.bridge.dropQueuedUplinks();
    deposit(r, "made with the internet off");
    expect(mockVerified).toHaveLength(1);
    r.online.value = true;
    r.bridge.attachClient(asClient(r.client));
    r.bridge.flushQueuedUplinks();
    expect(r.client.published.some((e) => e.id === held.id)).toBe(false);
  });
});

describe("receiving a bridged message over the radio", () => {
  it("works with the bridge off and no internet", () => {
    const r = rig();
    r.bridge.handleMeshCarrier(
      carrier(CarrierDirection.FROM_BRIDGE, remoteMessage("carried to us")),
      "bb".repeat(8),
      false,
    );
    expect(r.injected.map((m) => m.text)).toEqual(["carried to us"]);
  });

  it("never shows our own message back to us as bridged", async () => {
    // After a restart, a bridge on the island that heard it from a relay
    // carries it down to us. Only the derived key says it is ours.
    const before = rig();
    await online(before);
    void before.bridge.bridgeOutgoing(
      "mine, from before",
      "0123456789abcdef",
      Date.now(),
      false,
    );
    const own = before.client.published.find((e) => e.kind === 20000)!;
    const after = rig(before.signingKey);
    after.bridge.handleMeshCarrier(
      carrier(CarrierDirection.FROM_BRIDGE, own),
      "bb".repeat(8),
      false,
    );
    expect(after.injected).toHaveLength(0);
  });
});

describe("what ingress can cost", () => {
  it("bounds accepted events per signer", async () => {
    const r = rig();
    await online(r);
    const key = generateSecretKey();
    for (let i = 0; i < INBOUND_EVENTS_PER_MINUTE_PER_SIGNER + 10; i++) {
      r.client.deliver(remoteMessage(`flood ${String(i)}`, { key }));
    }
    expect(r.injected).toHaveLength(INBOUND_EVENTS_PER_MINUTE_PER_SIGNER);
  });

  it("bounds signature checks, valid or not", async () => {
    const r = rig();
    await online(r);
    const forged = fromWire(remoteMessage("forged"));
    forged.sig = "00".repeat(64);
    for (let i = 0; i < SIGNATURE_CHECKS_PER_MINUTE + 50; i++) {
      r.client.deliver(forged);
    }
    expect(mockVerified).toHaveLength(SIGNATURE_CHECKS_PER_MINUTE);
  });

  it("caps the people counted across the bridge", async () => {
    const r = rig();
    await online(r);
    for (let i = 0; i < MAX_PARTICIPANTS + 20; i++) {
      r.client.deliver(
        finalizeEvent(
          {
            kind: 20001,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["r", CELL]],
            content: "",
          },
          generateSecretKey(),
        ),
      );
    }
    expect(r.status.at(-1)?.peopleAcross).toBe(MAX_PARTICIPANTS);
  });

  it("checks a carrier's cell before any signature", () => {
    // Each event is signed for the cell its carrier names, so nothing but the
    // cell itself is wrong with it.
    const r = rig();
    for (const geohash of ["tdr1va", "TDR1V9", "tdr1v9tdr1v9t", "tdr 1v"]) {
      const event = remoteMessage(`for ${geohash}`, { cell: geohash });
      r.bridge.handleMeshCarrier(
        carrier(CarrierDirection.FROM_BRIDGE, event, geohash),
        "bb".repeat(8),
        false,
      );
    }
    expect(mockVerified).toHaveLength(0);
    expect(r.injected).toHaveLength(0);
  });
});

describe("the advertised cell", () => {
  it("re-announces when the cell becomes known and when it goes", async () => {
    const r = rig();
    await online(r);
    expect(r.cellChanges.value).toBe(1);
    expect(r.bridge.advertisedBridgeGeohash()).toBe(CELL);
    r.bridge.setEnabled(false);
    expect(r.cellChanges.value).toBe(2);
    expect(r.bridge.advertisedBridgeGeohash()).toBeUndefined();
  });
});

describe("what goes down a downlink", () => {
  it("is the remote event, unchanged, under its own cell", async () => {
    const r = rig();
    await online(r);
    const event = remoteMessage("verbatim");
    r.client.deliver(event);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(eventIn(r.downlinks[0]).id).toBe(event.id);
    expect(decodeNostrCarrier(r.downlinks[0])?.geohash).toBe(CELL);
  });
});
