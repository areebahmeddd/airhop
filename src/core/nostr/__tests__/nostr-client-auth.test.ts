// Relay sign-in (NIP-42). A relay that demands it is served with the key the
// caller names, never another, and one connection never proves two of this
// phone's keys. These run the real SimplePool over a scripted relay that
// challenges on connect, so the library's own AUTH handling is under test too.

import type { Event, EventTemplate } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import type { Filter } from "nostr-tools/filter";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { NostrClient } from "../nostr-client";

const RELAY = "wss://auth.example";
const OPEN_RELAY = "wss://open.example";

interface RelayRules {
  // Reads and writes need a signed-in key.
  readsNeedAuth: boolean;
  writesNeedAuth: boolean;
  // The proof is refused.
  rejectProof: boolean;
  // Still refused after a good proof, as a relay that wants a key it knows.
  refuseAfterAuth: boolean;
  challenge: string;
  replyDelayMs: number;
  // What a guarded relay serves a signed-in read before its EOSE.
  stored: Event[];
  // Proofs that get no answer at all, as over a circuit too slow for the
  // client to wait out.
  unansweredProofs: number;
}

const defaults: RelayRules = {
  readsNeedAuth: true,
  writesNeedAuth: true,
  rejectProof: false,
  refuseAfterAuth: false,
  challenge: "challenge-1",
  replyDelayMs: 0,
  stored: [],
  unansweredProofs: 0,
};

let rules: RelayRules = { ...defaults };

class AuthSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = AuthSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  readonly reqs: string[] = [];
  readonly closedSubs: string[] = [];
  readonly published: string[] = [];
  readonly proofs: Event[] = [];
  readonly authed = new Set<string>();

  constructor(readonly url: string) {
    sockets.push(this);
    setTimeout(() => {
      this.readyState = AuthSocket.OPEN;
      this.onopen?.();
      if (!this.url.startsWith(OPEN_RELAY)) {
        this.frame(["AUTH", rules.challenge]);
      }
    }, 0);
  }

  private get guarded(): boolean {
    return !this.url.startsWith(OPEN_RELAY);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as [string, ...unknown[]];
    const [verb] = message;
    if (verb === "CLOSE") this.closedSubs.push(message[1] as string);
    if (verb === "REQ") {
      const id = message[1] as string;
      this.reqs.push(id);
      setTimeout(() => {
        if (this.guarded && rules.readsNeedAuth && !this.allowed()) {
          this.frame(["CLOSED", id, "auth-required: sign in first"]);
          return;
        }
        if (this.guarded) {
          for (const event of rules.stored) this.frame(["EVENT", id, event]);
        }
        this.frame(["EOSE", id]);
      }, rules.replyDelayMs);
    }
    if (verb === "EVENT") {
      const event = message[1] as Event;
      this.published.push(event.id);
      setTimeout(() => {
        if (this.guarded && rules.writesNeedAuth && !this.allowed()) {
          this.frame(["OK", event.id, false, "auth-required: sign in first"]);
          return;
        }
        this.frame(["OK", event.id, true, ""]);
      }, 0);
    }
    if (verb === "AUTH") {
      const proof = message[1] as Event;
      this.proofs.push(proof);
      if (rules.unansweredProofs > 0) {
        rules.unansweredProofs -= 1;
        return;
      }
      const challenge = proof.tags.find((t) => t[0] === "challenge")?.[1];
      const ok =
        !rules.rejectProof &&
        verifyEvent(proof) &&
        proof.kind === 22242 &&
        challenge === rules.challenge;
      if (ok) this.authed.add(proof.pubkey);
      setTimeout(
        () => this.frame(["OK", proof.id, ok, ok ? "" : "invalid: no"]),
        0,
      );
    }
  }

  drop(): void {
    this.readyState = AuthSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }

  close(): void {
    this.readyState = AuthSocket.CLOSED;
  }

  private allowed(): boolean {
    return this.authed.size > 0 && !rules.refuseAfterAuth;
  }

  private frame(message: unknown[]): void {
    if (this.readyState !== AuthSocket.OPEN) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let sockets: AuthSocket[] = [];

function socketFor(relay: string): AuthSocket {
  const found = sockets
    .filter((s) => s.url.replace(/\/$/, "") === relay)
    .at(-1);
  if (found === undefined) throw new Error(`no socket for ${relay}`);
  return found;
}

const filter: Filter = { kinds: [1059], since: 1_700_000_000 };

function note(content: string, key = generateSecretKey()): Event {
  return finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content },
    key,
  );
}

// A sign-in is a chain of relay round trips, each a timer here, and a timer
// set for 0 ms is due 1 ms later.
async function settle(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(1);
}

beforeAll(() => {
  useWebSocketImplementation(AuthSocket);
});

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  rules = { ...defaults };
});

afterEach(() => {
  jest.useRealTimers();
});

describe("reads", () => {
  test("a refused read signs in with its own key and reopens once, under its closer", async () => {
    const client = new NostrClient();
    const key = generateSecretKey();
    const sub = client.subscribe([filter], () => {}, undefined, [RELAY], key);
    await settle();
    const socket = socketFor(RELAY);
    expect(socket.proofs.map((p) => p.pubkey)).toEqual([getPublicKey(key)]);
    expect(socket.proofs[0].tags).toContainEqual([
      "challenge",
      rules.challenge,
    ]);
    expect(socket.reqs).toHaveLength(2);
    // The reopened subscription is the one closing the call closes.
    sub.close();
    await settle();
    expect(socket.closedSubs).toEqual([socket.reqs[1]]);
    client.close();
  });

  test("a read with no key never signs in", async () => {
    const client = new NostrClient();
    client.subscribe([filter], () => {}, undefined, [RELAY]);
    await settle(60_000);
    expect(socketFor(RELAY).proofs).toEqual([]);
    client.close();
  });

  test("a relay that never asks is never shown a key", async () => {
    const client = new NostrClient();
    client.subscribe(
      [filter],
      () => {},
      undefined,
      [OPEN_RELAY],
      generateSecretKey(),
    );
    await settle();
    expect(socketFor(OPEN_RELAY).proofs).toEqual([]);
    client.close();
  });

  test("one connection never carries two of this phone's keys", async () => {
    const client = new NostrClient();
    const main = generateSecretKey();
    const cell = generateSecretKey();
    client.subscribe([filter], () => {}, undefined, [RELAY], main);
    client.subscribe([filter], () => {}, undefined, [RELAY], cell);
    // Past several backoffs: the second key stays refused on this socket.
    await settle(20 * 60_000);
    const socket = socketFor(RELAY);
    expect(new Set(socket.proofs.map((p) => p.pubkey))).toEqual(
      new Set([getPublicKey(main)]),
    );
    client.close();
  });

  test("a relay that refuses the proof stays refused", async () => {
    rules.rejectProof = true;
    const client = new NostrClient();
    client.subscribe(
      [filter],
      () => {},
      undefined,
      [RELAY],
      generateSecretKey(),
    );
    await settle(20 * 60_000);
    const socket = socketFor(RELAY);
    expect(socket.proofs).toHaveLength(1);
    expect(socket.authed.size).toBe(0);
    client.close();
  });

  // A timeout is not a refusal: the relay may never have seen the proof.
  test("a proof the relay never answered is sent again by the same key", async () => {
    rules.unansweredProofs = 1;
    const client = new NostrClient();
    const key = generateSecretKey();
    client.subscribe([filter], () => {}, undefined, [RELAY], key);
    await settle(20 * 60_000);
    const socket = socketFor(RELAY);
    expect(socket.proofs.map((p) => p.pubkey)).toEqual([
      getPublicKey(key),
      getPublicKey(key),
    ]);
    expect(socket.authed.size).toBe(1);
    client.close();
  });

  test("a read kept open across a reconnect signs in again at once", async () => {
    const client = new NostrClient();
    const key = generateSecretKey();
    client.subscribe([filter], () => {}, undefined, [RELAY], key);
    await settle();
    socketFor(RELAY).drop();
    rules.challenge = "challenge-2";
    // nostr-tools redials 10 s after a drop and sends the read again.
    await settle(10_000);
    const socket = socketFor(RELAY);
    expect(socket.proofs.map((p) => p.pubkey)).toEqual([getPublicKey(key)]);
    expect(socket.reqs).toHaveLength(2);
    client.close();
  });

  test("a refused read's backfill counts toward EOSE in its refusal's place", async () => {
    const backfill = finalizeEvent(
      { kind: 1059, created_at: 1_700_000_100, tags: [], content: "x" },
      generateSecretKey(),
    );
    rules.stored = [backfill];
    const client = new NostrClient();
    const seen: string[] = [];
    client.subscribe(
      [filter],
      (event) => seen.push(event.id),
      () => seen.push("EOSE"),
      [RELAY, OPEN_RELAY],
      generateSecretKey(),
    );
    await settle(1_000);
    // EOSE once, and only after what the relay served once signed in.
    expect(seen).toEqual([backfill.id, "EOSE"]);
    client.close();
  });

  test("a reconnect forgets the sign-in, so another key may sign in", async () => {
    const client = new NostrClient();
    const main = generateSecretKey();
    const cell = generateSecretKey();
    const first = client.subscribe(
      [filter],
      () => {},
      undefined,
      [RELAY],
      main,
    );
    await settle();
    first.close();
    socketFor(RELAY).drop();
    rules.challenge = "challenge-2";
    // The pool redials after its backoff and the poll sees the drop first.
    await settle(30_000);
    client.subscribe([filter], () => {}, undefined, [RELAY], cell);
    await settle();
    const socket = socketFor(RELAY);
    expect(socket.proofs.map((p) => p.pubkey)).toEqual([getPublicKey(cell)]);
    client.close();
  });

  test("an oversized challenge is never signed", async () => {
    rules.challenge = "x".repeat(5_000);
    const client = new NostrClient();
    client.subscribe(
      [filter],
      () => {},
      undefined,
      [RELAY],
      generateSecretKey(),
    );
    await settle(60_000);
    expect(socketFor(RELAY).proofs).toEqual([]);
    client.close();
  });

  test("nothing is signed once the client is closed", async () => {
    // A panic wipe while the relay's refusal is still on its way.
    rules.replyDelayMs = 50;
    const client = new NostrClient();
    client.subscribe(
      [filter],
      () => {},
      undefined,
      [RELAY],
      generateSecretKey(),
    );
    await settle();
    expect(socketFor(RELAY).reqs).toHaveLength(1);
    client.close();
    await settle(60_000);
    expect(sockets.flatMap((s) => s.proofs)).toEqual([]);
  });
});

describe("posts", () => {
  test("a refused post signs in with a throwaway key and is resent once, unchanged", async () => {
    const client = new NostrClient();
    const author = generateSecretKey();
    const event = note("hello", author);
    const result = client.publish(event, [RELAY], "throwaway");
    await settle();
    await expect(result).resolves.toMatchObject({ ok: true });
    const socket = socketFor(RELAY);
    expect(socket.published).toEqual([event.id, event.id]);
    expect(socket.proofs).toHaveLength(1);
    expect(socket.proofs[0].pubkey).not.toBe(getPublicKey(author));
    client.close();
  });

  test("a post refused again after sign-in is not resent again", async () => {
    rules.refuseAfterAuth = true;
    const client = new NostrClient();
    const event = note("hello");
    const result = client.publish(event, [RELAY], "throwaway");
    const rejected = expect(result).rejects.toThrow();
    await settle(10_000);
    await rejected;
    expect(socketFor(RELAY).published).toEqual([event.id, event.id]);
    client.close();
  });

  test("a post with no key is refused as before", async () => {
    const client = new NostrClient();
    const event = note("hello");
    const result = client.publish(event, [RELAY]);
    const rejected = expect(result).rejects.toThrow();
    await settle(10_000);
    await rejected;
    const socket = socketFor(RELAY);
    expect(socket.published).toEqual([event.id]);
    expect(socket.proofs).toEqual([]);
    client.close();
  });

  test("a post on a connection signed in as someone else is not proven again", async () => {
    rules.readsNeedAuth = true;
    const client = new NostrClient();
    const cell = generateSecretKey();
    client.subscribe([filter], () => {}, undefined, [RELAY], cell);
    await settle();
    // Signed in as the cell: the relay takes the post without a second proof.
    const event = note("hello");
    await expect(
      Promise.all([client.publish(event, [RELAY], "throwaway"), settle()]),
    ).resolves.toBeDefined();
    const socket = socketFor(RELAY);
    expect(socket.proofs.map((p) => p.pubkey)).toEqual([getPublicKey(cell)]);
    expect(socket.published).toEqual([event.id]);
    client.close();
  });

  test("concurrent refusals on one relay share a single sign-in", async () => {
    const client = new NostrClient();
    const events = [note("a"), note("b"), note("c")];
    const results = events.map((e) => client.publish(e, [RELAY], "throwaway"));
    await settle();
    for (const r of results)
      await expect(r).resolves.toMatchObject({ ok: true });
    expect(socketFor(RELAY).proofs).toHaveLength(1);
    client.close();
  });
});

// The proof a signer is handed is the relay's own template, so a key signs
// only kind 22242 with the challenge the relay sent.
test("the signed proof is a kind 22242 event naming the relay", async () => {
  const client = new NostrClient();
  const key = generateSecretKey();
  client.subscribe([filter], () => {}, undefined, [RELAY], key);
  await settle();
  const [proof] = socketFor(RELAY).proofs;
  const template: EventTemplate = proof;
  expect(template.kind).toBe(22242);
  expect(template.tags).toContainEqual(["relay", `${RELAY}/`]);
  client.close();
});
