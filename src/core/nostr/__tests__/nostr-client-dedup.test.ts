// One hostile relay must not be able to hide an event that honest relays carry.
//
// nostr-tools 2.25.2 records an event ID as seen before it verifies the event,
// in one set shared by every relay a pool call spans, and writes a reconnect's
// `since` into one filter object shared the same way. So a relay that sent a
// bad-signature copy under a genuine ID suppressed the real event from every
// other relay, and a rejected far-future event moved every relay's cursor.
// These run the real SimplePool over a scripted socket, so the library's own
// dedup, verification and reconnect are what is under test.

import type { Event } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { Filter } from "nostr-tools/filter";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { NostrClient } from "../nostr-client";

const HOSTILE = "wss://hostile.example";
const HONEST = "wss://honest.example";
const SINCE = 1_700_000_000;

// A relay socket the test drives: it answers a REQ with whatever `stored`
// holds, then EOSE, and `push` sends a live event on every open subscription.
class ScriptedSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = ScriptedSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  readonly reqs: { id: string; filters: Filter[] }[] = [];
  readonly closedSubs: string[] = [];

  constructor(readonly url: string) {
    sockets.push(this);
    setTimeout(() => {
      this.readyState = ScriptedSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(raw: string): void {
    const [verb, id, ...filters] = JSON.parse(raw) as [string, string, Filter];
    if (verb === "CLOSE") this.closedSubs.push(id);
    if (verb !== "REQ") return;
    this.reqs.push({ id, filters });
    const stored = storedOn.get(relayOf(this.url)) ?? [];
    setTimeout(
      () => {
        for (const event of stored) this.frame(["EVENT", id, event]);
        this.frame(["EOSE", id]);
      },
      replyDelayMs.get(relayOf(this.url)) ?? 0,
    );
  }

  push(event: object): void {
    for (const { id } of this.reqs) this.frame(["EVENT", id, event]);
  }

  // The relay went away without a close frame.
  drop(): void {
    this.readyState = ScriptedSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }

  close(): void {
    this.readyState = ScriptedSocket.CLOSED;
  }

  private frame(message: unknown[]): void {
    if (this.readyState !== ScriptedSocket.OPEN) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let sockets: ScriptedSocket[] = [];
const storedOn = new Map<string, object[]>();
const replyDelayMs = new Map<string, number>();

// nostr-tools normalises a relay URL with a trailing slash.
function relayOf(url: string): string {
  return url.replace(/\/$/, "");
}

function socketFor(relay: string): ScriptedSocket {
  const found = sockets.filter((s) => relayOf(s.url) === relay).at(-1);
  if (found === undefined) throw new Error(`no socket for ${relay}`);
  return found;
}

const author = generateSecretKey();

function signed(content: string, createdAt = SINCE + 60): Event {
  return finalizeEvent(
    { kind: 1, created_at: createdAt, tags: [], content },
    author,
  );
}

// The genuine ID and body under a signature that does not verify. The ID is
// what nostr-tools reads from the raw frame before it parses anything.
function forgedCopyOf(event: Event): Event {
  return { ...event, sig: "0".repeat(128) };
}

// The pool's verifier, wrapped so a test can count calls. It is handed to each
// relay as the relay is created, so this runs before any subscribe.
function spyOnVerify(client: NostrClient): jest.Mock {
  const pool = (
    client as unknown as {
      pool: { verifyEvent: (event: Event) => boolean };
    }
  ).pool;
  const spy = jest.fn(pool.verifyEvent);
  pool.verifyEvent = spy;
  return spy;
}

async function settle(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeAll(() => {
  useWebSocketImplementation(ScriptedSocket);
});

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  storedOn.clear();
  replyDelayMs.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("a subscription across several relays", () => {
  it("still delivers an event after a hostile relay sent a forged copy under its ID", async () => {
    const client = new NostrClient({ relays: [] });
    const genuine = signed("hello");
    const seen: string[] = [];
    client.subscribe(
      [{ kinds: [1], since: SINCE }],
      (e) => seen.push(e.content),
      undefined,
      [HOSTILE, HONEST],
    );
    await settle();

    socketFor(HOSTILE).push(forgedCopyOf(genuine));
    socketFor(HONEST).push(genuine);
    await settle();

    expect(seen).toEqual(["hello"]);
    client.close();
  });

  it("delivers an honest duplicate once and verifies it once", async () => {
    const client = new NostrClient({ relays: [] });
    const verify = spyOnVerify(client);
    const genuine = signed("hello");
    const seen: string[] = [];
    client.subscribe(
      [{ kinds: [1], since: SINCE }],
      (e) => seen.push(e.id),
      undefined,
      [HONEST, HOSTILE],
    );
    await settle();

    socketFor(HONEST).push(genuine);
    socketFor(HOSTILE).push(genuine);
    await settle();

    expect(seen).toEqual([genuine.id]);
    expect(verify).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("does not let a rejected far-future event move another relay's since", async () => {
    const client = new NostrClient({ relays: [] });
    client.subscribe(
      [{ kinds: [1], since: SINCE }],
      () => undefined,
      undefined,
      [HOSTILE, HONEST],
    );
    await settle();

    // Rejected on signature, but nostr-tools still advances the cursor it
    // writes into `since` on the next reconnect.
    const farFuture = SINCE + 10 * 365 * 24 * 3600;
    socketFor(HOSTILE).push(forgedCopyOf(signed("later", farFuture)));
    socketFor(HOSTILE).drop();
    await settle(10_001);
    socketFor(HONEST).drop();
    await settle(10_001);

    const honestReqs = socketFor(HONEST).reqs;
    expect(honestReqs.length).toBeGreaterThan(0);
    for (const { filters } of honestReqs) {
      expect(filters[0].since).toBe(SINCE);
    }
    client.close();
  });

  it("delivers from another relay an event the full pump refused", async () => {
    const client = new NostrClient({ relays: [] });
    // Filler that skips Schnorr, so a full queue costs no signing.
    const verify = spyOnVerify(client);
    const realVerify = verify.getMockImplementation() as (e: Event) => boolean;
    verify.mockImplementation((e: Event) =>
      e.content === "filler" ? true : realVerify(e),
    );
    const genuine = signed("hello");
    const seen: string[] = [];
    client.subscribe(
      [{ kinds: [1], since: SINCE }],
      (e) => {
        if (e.content !== "filler") seen.push(e.content);
      },
      undefined,
      [HOSTILE, HONEST],
    );
    await settle();

    // 4,000 is the pump's ceiling (MAX_PENDING_EVENTS).
    const hostile = socketFor(HOSTILE);
    for (let i = 0; i < 4_000; i++) {
      hostile.push({
        ...genuine,
        id: i.toString(16).padStart(64, "0"),
        content: "filler",
      });
    }
    // Arrives with the queue full, so it is dropped rather than queued.
    hostile.push(genuine);
    await settle();
    expect(seen).toEqual([]);

    socketFor(HONEST).push(genuine);
    await settle();
    expect(seen).toEqual(["hello"]);
    client.close();
  });

  it("reports EOSE once, after every relay has finished its backfill", async () => {
    replyDelayMs.set(HONEST, 50);
    const client = new NostrClient({ relays: [] });
    const eose = jest.fn();
    client.subscribe([{ kinds: [1], since: SINCE }], () => undefined, eose, [
      HOSTILE,
      HONEST,
    ]);

    await settle(10);
    expect(eose).not.toHaveBeenCalled();
    await settle(50);
    expect(eose).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("closes every relay's subscription through the one closer, and close() drops every socket", async () => {
    const client = new NostrClient({ relays: [] });
    const closer = client.subscribe(
      [{ kinds: [1], since: SINCE }],
      () => undefined,
      undefined,
      [HOSTILE, HONEST],
    );
    await settle();

    closer.close();
    await settle();
    for (const relay of [HOSTILE, HONEST]) {
      const socket = socketFor(relay);
      expect(socket.closedSubs).toEqual(socket.reqs.map((r) => r.id));
    }

    client.close();
    for (const socket of sockets) {
      expect(socket.readyState).toBe(ScriptedSocket.CLOSED);
    }
  });
});

describe("queryEvents", () => {
  it("returns the genuine event despite a relay that answers with a forged copy first", async () => {
    const genuine = signed("zap");
    storedOn.set(HOSTILE, [forgedCopyOf(genuine)]);
    storedOn.set(HONEST, [genuine]);
    replyDelayMs.set(HONEST, 20);
    const client = new NostrClient({ relays: [HOSTILE, HONEST] });

    const result = client.queryEvents({ kinds: [1], since: SINCE });
    await settle(100);

    expect((await result).map((e) => e.id)).toEqual([genuine.id]);
    client.close();
  });

  it("merges copies from several relays by ID", async () => {
    const genuine = signed("zap");
    const other = signed("other");
    storedOn.set(HOSTILE, [genuine]);
    storedOn.set(HONEST, [genuine, other]);
    const client = new NostrClient({ relays: [HOSTILE, HONEST] });

    const result = client.queryEvents({ kinds: [1], since: SINCE });
    await settle(100);

    expect((await result).map((e) => e.id).sort()).toEqual(
      [genuine.id, other.id].sort(),
    );
    client.close();
  });
});
