// Geohash channels: which channels are location channels and at what
// precision, what a typed geohash is accepted as, where the presence heartbeat
// goes and when, and how a flood in a cell is limited.
//
// The cell maths and relay selection underneath live in core and are pinned by
// geohash-presence.test.ts and geo-relay.test.ts.

import { KIND_PRESENCE } from "@core/nostr/geohash-presence";
import type { NostrClient } from "@core/nostr/nostr-client";
import { ed25519 } from "@noble/curves/ed25519.js";
import { useChatStore } from "@store/chat-store";
import { useSettingsStore } from "@store/settings-store";
import type { Event } from "nostr-tools";
import {
  GEO_CHANNEL_PRECISION,
  GeohashChannelService,
  geohashLevelName,
  isGeoChannel,
  isValidGeohash,
  normalizeGeohash,
} from "../geohash-channel-service";

// Fixed, so the heartbeat tests resolve #city to one known cell. The "mock"
// prefix lets the hoisted factory below close over it.
const mockCoords = { lat: 51.5074, lng: -0.1278 };

jest.mock("../location-service", () => ({
  getCoarseLocation: () => Promise.resolve(mockCoords),
}));

describe("which channels are geo channels", () => {
  it("never bridges #bluetooth", () => {
    // #bluetooth is the offline-only channel; bridging it to the internet
    // would break the one guarantee it makes.
    expect(isGeoChannel("#bluetooth")).toBe(false);
  });

  it("treats unknown channels as non-geo", () => {
    expect(isGeoChannel("#my-custom-room")).toBe(false);
    expect(isGeoChannel("dm:aabbccdd00112233")).toBe(false);
  });

  it("treats a teleported cell as a geo channel", () => {
    expect(isGeoChannel("geohash:tdr1k")).toBe(true);
  });

  // Character counts read off a real bitchat-ios handset in Bengaluru, which
  // showed #tdr1kyp, #tdr1ky, #tdr1k, #tdr1 and #td for its five channels. A
  // mismatch puts the two apps in different cells and they silently never meet.
  it("maps each channel to the precision bitchat uses", () => {
    expect(GEO_CHANNEL_PRECISION["#block"]).toBe("tdr1kyp".length);
    expect(GEO_CHANNEL_PRECISION["#neighborhood"]).toBe("tdr1ky".length);
    expect(GEO_CHANNEL_PRECISION["#city"]).toBe("tdr1k".length);
    expect(GEO_CHANNEL_PRECISION["#province"]).toBe("tdr1".length);
    expect(GEO_CHANNEL_PRECISION["#region"]).toBe("td".length);
  });
});

describe("teleport: typed geohashes", () => {
  it("normalises user input the way bitchat does", () => {
    // Lowercase, drop a leading #, discard out-of-alphabet chars, cap at 12.
    expect(normalizeGeohash("#TDR1K")).toBe("tdr1k");
    expect(normalizeGeohash("  u4pruy  ")).toBe("u4pruy");
    // a, i, l, o are not in the geohash alphabet and are stripped.
    expect(normalizeGeohash("taile")).toBe("te");
    expect(normalizeGeohash("bcdefghjkmnpqrstuvwxyz")).toHaveLength(12);
  });

  it("accepts geohashes of 2 to 12 valid chars", () => {
    expect(isValidGeohash("td")).toBe(true);
    expect(isValidGeohash("tdr1k")).toBe(true);
    expect(isValidGeohash("u4pruydqqvj8")).toBe(true); // 12
  });

  it("rejects too short, too long, or out-of-alphabet geohashes", () => {
    expect(isValidGeohash("t")).toBe(false); // 1 char
    expect(isValidGeohash("u4pruydqqvj8x")).toBe(false); // 13 chars
    expect(isValidGeohash("tail")).toBe(false); // a, i, l not allowed
    expect(isValidGeohash("")).toBe(false);
  });

  it("maps geohash length to the same coverage level as bitchat", () => {
    // bitchat GeohashChannelLevel.level(forLength:): 0-2 region, 3-4 province,
    // 5 city, 6 neighborhood, 7 block, 8+ building. Same buckets; the length-7
    // label reads "City block" to match the #block default channel's wording.
    expect(geohashLevelName("t")).toBe("Region");
    expect(geohashLevelName("td")).toBe("Region");
    expect(geohashLevelName("tdr")).toBe("Province");
    expect(geohashLevelName("tdr1")).toBe("Province");
    expect(geohashLevelName("tdr1k")).toBe("City");
    expect(geohashLevelName("tdr1ke")).toBe("Neighborhood");
    expect(geohashLevelName("tdr1ke7")).toBe("City block");
    expect(geohashLevelName("tdr1ke7x")).toBe("Building");
  });
});

// Presence is read from the cell's relays by everyone in the cell, bitchat-ios
// included. A heartbeat on the default DM relays is never counted, and tells
// those relays which cell this cell's key is in.
describe("presence heartbeat relays", () => {
  // Past the longest jittered gap before the first round.
  const HEARTBEAT_ROUND_MS = 80_000;

  interface Published {
    kind: number;
    tags: string[][];
    relays: string[] | undefined;
  }

  function newService(published: Published[]): GeohashChannelService {
    const client = {
      subscribe: () => ({ close: () => undefined }),
      publish: async (event: Event, relays?: string[]) => {
        published.push({ kind: event.kind, tags: event.tags, relays });
        return { relay: "", ok: true };
      },
    } as unknown as NostrClient;
    return new GeohashChannelService(
      client,
      ed25519.utils.randomSecretKey(),
      "alice",
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    useSettingsStore.getState().setGeoRelayDiscovery(true);
    useChatStore.setState({ channels: ["#city"] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends each round's heartbeat to the cell's relays", async () => {
    const published: Published[] = [];
    const service = newService(published);
    await service.refresh();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_ROUND_MS);

    const cell = service.geohashFor("#city");
    expect(cell).not.toBeNull();
    const heartbeats = published.filter((p) => p.kind === KIND_PRESENCE);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0].tags).toEqual([["g", cell]]);
    expect(heartbeats[0].relays).toEqual(
      service.relaysForGeohash(cell as string),
    );
    expect(heartbeats[0].relays?.length).toBeGreaterThan(0);
    service.stop();
  });

  it("skips the heartbeat for a cell with no relays", async () => {
    const published: Published[] = [];
    const service = newService(published);
    jest.spyOn(service, "relaysForGeohash").mockReturnValue([]);
    await service.refresh();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_ROUND_MS);

    expect(published.filter((p) => p.kind === KIND_PRESENCE)).toEqual([]);
    service.stop();
  });

  it("goes quiet in the background and resumes on return", async () => {
    const published: Published[] = [];
    const service = newService(published);
    await service.refresh();
    service.setForeground(false);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_ROUND_MS * 3);
    expect(published.filter((p) => p.kind === KIND_PRESENCE)).toEqual([]);

    service.setForeground(true);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_ROUND_MS);
    expect(published.filter((p) => p.kind === KIND_PRESENCE)).toHaveLength(1);
    service.stop();
  });

  it("does not start in the background", async () => {
    const published: Published[] = [];
    const service = newService(published);
    service.setForeground(false);
    await service.refresh();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_ROUND_MS * 3);
    expect(published.filter((p) => p.kind === KIND_PRESENCE)).toEqual([]);
    service.stop();
  });
});

describe("location channel flood limit", () => {
  interface Subscription {
    onEvent: (event: Event) => void;
    onEose?: () => void;
    kinds: number[];
  }

  function newService(subs: Subscription[]): GeohashChannelService {
    const client = {
      subscribe: (
        filters: { kinds: number[] }[],
        onEvent: (event: Event) => void,
        onEose?: () => void,
      ) => {
        subs.push({ onEvent, onEose, kinds: filters[0].kinds });
        return { close: () => undefined };
      },
      publish: async () => ({ relay: "", ok: true }),
    } as unknown as NostrClient;
    return new GeohashChannelService(
      client,
      ed25519.utils.randomSecretKey(),
      "alice",
    );
  }

  // Unrelated text per message, so only the rate limits are in play and not the
  // spam filter's near-copy check.
  function distinctText(n: number): string {
    let seed = n + 1;
    let out = "";
    for (let i = 0; i < 24; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      out += String.fromCharCode(97 + (seed % 26));
      if (i % 6 === 5) out += " ";
    }
    return out.trim();
  }

  // `ageSeconds` dates a history event in the past. A real replay is a
  // conversation spread over time, and the spam filter judges each message at
  // the time it was sent.
  function chat(n: number, pubkey = "b".repeat(64), ageSeconds = 0): Event {
    return {
      id: n.toString(16).padStart(64, "0"),
      pubkey,
      created_at: Math.floor(Date.now() / 1000) - ageSeconds,
      kind: 20000,
      tags: [],
      content: distinctText(n),
      sig: "",
    };
  }

  beforeEach(() => {
    useSettingsStore.getState().setGeoRelayDiscovery(true);
    useChatStore.setState({ channels: ["#city"], messages: {} });
  });

  it("keeps the whole history replay, then limits a live flood", async () => {
    const subs: Subscription[] = [];
    const service = newService(subs);
    await service.refresh();
    const room = subs.find((s) => s.kinds.includes(20000));
    expect(room).toBeDefined();

    for (let i = 0; i < 20; i++) {
      room!.onEvent(chat(i, undefined, (20 - i) * 60));
    }
    expect(useChatStore.getState().messages["#city"]).toHaveLength(20);

    room!.onEose?.();
    for (let i = 20; i < 40; i++) room!.onEvent(chat(i));
    // bitchat-ios's burst of five.
    expect(useChatStore.getState().messages["#city"]).toHaveLength(25);
    service.stop();
  });

  it("keeps a history replay that lands after a slow connect", async () => {
    jest.useFakeTimers();
    try {
      const subs: Subscription[] = [];
      const service = newService(subs);
      await service.refresh();
      const room = subs.find((s) => s.kinds.includes(20000));
      // Relays still connecting over Tor, well past the grace.
      jest.setSystemTime(Date.now() + 30_000);

      for (let i = 0; i < 20; i++) {
        room!.onEvent(chat(i, undefined, (20 - i) * 60));
      }
      expect(useChatStore.getState().messages["#city"]).toHaveLength(20);
      service.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  // bitchat hides a public message over its spam filter's 1200 characters a
  // minute, so Airhop does too, and the same text from a third identity.
  it("hides spam the way bitchat's filter does", async () => {
    const subs: Subscription[] = [];
    const service = newService(subs);
    await service.refresh();
    const room = subs.find((s) => s.kinds.includes(20000))!;
    room.onEose?.();

    room.onEvent({ ...chat(1), content: distinctText(1).repeat(60) });
    const copy = "free sats for everyone at the corner shop";
    for (const [i, pubkey] of ["c", "d", "e", "f"].entries()) {
      room.onEvent({ ...chat(10 + i, pubkey.repeat(64)), content: copy });
    }
    const shown = useChatStore.getState().messages["#city"] ?? [];
    expect(shown.map((m) => m.text)).toEqual([copy, copy, copy]);
    service.stop();
  });

  it("limits a flood ferried by a gateway carrier", async () => {
    const subs: Subscription[] = [];
    const service = newService(subs);
    await service.refresh();
    const geohash = service.geohashFor("#city");
    expect(geohash).not.toBeNull();

    for (let i = 0; i < 20; i++) {
      service.ingestCarriedEvent({ ...chat(i), tags: [["g", geohash!]] });
    }
    expect(useChatStore.getState().messages["#city"]).toHaveLength(5);
    service.stop();
  });
});
