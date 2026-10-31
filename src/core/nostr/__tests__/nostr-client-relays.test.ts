// Which relays NostrClient actually contacts.
//
// A custom relay added while geo-relay discovery is on (the default) must be
// contacted. mergeGeoRelays appends custom relays after the cell's interop set,
// which is already exactly 5, the size of the default DM pool, so re-capping a
// per-call relay list to that size trims precisely the user's entries: the
// settings row reads "1 added" and nothing ever opens a socket to it.
//
// mergeGeoRelays is unit-tested on its own (see geo-relay.test.ts, "interop
// relays never dropped"), but the contract can break one layer down. So these
// assert the relays NostrClient targets, not the ones the caller asked for.

import type { Event } from "nostr-tools";
import {
  GEO_RELAY_COUNT,
  MAX_CUSTOM_RELAYS,
  mergeGeoRelays,
} from "../geo-relay";
import { NostrClient } from "../nostr-client";

const mockPublishTargets: string[][] = [];
const mockSubscribeTargets: string[][] = [];
// Socket state per pool key, as nostr-tools reports it.
const mockStatus = new Map<string, boolean>();

jest.mock("nostr-tools/pool", () => ({
  SimplePool: class {
    onRelayConnectionSuccess?: () => void;
    onRelayConnectionFailure?: () => void;
    publish(relays: string[]): Promise<void>[] {
      mockPublishTargets.push(relays);
      return relays.map(() => Promise.resolve());
    }
    subscribeMany(relays: string[]): { close: () => void } {
      mockSubscribeTargets.push(relays);
      return { close: () => undefined };
    }
    listConnectionStatus(): Map<string, boolean> {
      return new Map(mockStatus);
    }
    destroy(): void {}
  },
}));

// Closed after each test: a live client holds its connection poll open.
const clients: NostrClient[] = [];
function open(): NostrClient {
  const client = new NostrClient({ relays: [] });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

// Five nearest relays for a cell, as GeoRelayDirectory would return them.
const NEAREST = ["wss://n1", "wss://n2", "wss://n3", "wss://n4", "wss://n5"];
const CUSTOM = ["wss://my-own-relay.example.com"];

const EVENT = {
  id: "e",
  kind: 1,
  pubkey: "p",
  created_at: 0,
  tags: [],
  content: "",
  sig: "s",
} as unknown as Event;

beforeEach(() => {
  mockPublishTargets.length = 0;
  mockSubscribeTargets.length = 0;
  mockStatus.clear();
});

describe("NostrClient relay targeting", () => {
  // The exact list the geohash services hand down with discovery left on.
  const geoSet = mergeGeoRelays(NEAREST, CUSTOM, true, GEO_RELAY_COUNT);

  test("publish contacts the custom relay alongside the whole interop set", async () => {
    const client = open();
    await client.publish(EVENT, geoSet);

    expect(mockPublishTargets).toHaveLength(1);
    const targets = mockPublishTargets[0];
    // The one a re-cap would trim off the tail.
    expect(targets).toContain(CUSTOM[0]);
    // And it must not have come at the cost of the rendezvous set.
    for (const relay of NEAREST) expect(targets).toContain(relay);
  });

  test("subscribe contacts the custom relay alongside the whole interop set", () => {
    const client = open();
    client.subscribe([{ kinds: [20000] }], () => undefined, undefined, geoSet);

    // One pool subscription per relay (see NostrClient.subscribe).
    for (const call of mockSubscribeTargets) expect(call).toHaveLength(1);
    const targets = mockSubscribeTargets.flat();
    expect(targets).toContain(CUSTOM[0]);
    for (const relay of NEAREST) expect(targets).toContain(relay);
  });

  test("a full custom list still fits beside the interop set", async () => {
    const full = Array.from(
      { length: MAX_CUSTOM_RELAYS },
      (_, i) => `wss://c${i}.example.com`,
    );
    const client = open();
    await client.publish(
      EVENT,
      mergeGeoRelays(NEAREST, full, true, GEO_RELAY_COUNT),
    );

    const targets = mockPublishTargets[0];
    for (const relay of [...NEAREST, ...full]) expect(targets).toContain(relay);
  });

  test("the override ceiling still bounds a pathological list", async () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `wss://r${i}.example.com`,
    );
    const client = open();
    await client.publish(EVENT, many);

    expect(mockPublishTargets[0]).toHaveLength(
      GEO_RELAY_COUNT + MAX_CUSTOM_RELAYS,
    );
  });

  test("the default DM pool is unchanged: defaults only, no override applied", async () => {
    const client = open();
    expect(client.activeRelays).toEqual([
      "wss://nos.lol",
      "wss://offchain.pub",
      "wss://relay.damus.io",
      "wss://relay.primal.net",
    ]);

    await client.publish(EVENT);
    expect(mockPublishTargets[0]).toEqual(client.activeRelays);
  });
});

// nostr-tools opens a connect of its own on a relay in reconnect backoff when
// asked to publish there, and on failure drops it from the pool while it goes
// on reconnecting unseen, so the pool never reports it back.
describe("NostrClient publish during an outage", () => {
  test("skips a relay that was live and dropped, still tries one never live", async () => {
    const client = open();
    // nostr-tools keys a bare host with a trailing slash.
    mockStatus.set("wss://n1/", true);
    await client.publish(EVENT, ["wss://n1"]);
    mockStatus.set("wss://n1/", false);
    // Still on its first connect, which a publish joins rather than restarts.
    mockStatus.set("wss://n2/", false);
    mockPublishTargets.length = 0;
    await client.publish(EVENT, ["wss://n1", "wss://n2", "wss://n3"]);
    expect(mockPublishTargets).toEqual([["wss://n2", "wss://n3"]]);
  });

  test("rejects at once when every target is reconnecting", async () => {
    const client = open();
    mockStatus.set("wss://n1/", true);
    await client.publish(EVENT, ["wss://n1"]);
    mockStatus.set("wss://n1/", false);
    mockPublishTargets.length = 0;
    await expect(client.publish(EVENT, ["wss://n1"])).rejects.toThrow();
    expect(mockPublishTargets).toEqual([]);
  });
});
