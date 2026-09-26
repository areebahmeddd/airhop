/**
 * @jest-environment node
 */
// NIP-61 nutzap tests: event shapes and hostile-input parsing.
//
// Nutzap events are public, unauthenticated apart from their signature, and
// carry money. The parsing tests are therefore mostly about what must be
// *rejected*: a nutzap that parses into something plausible but unspendable is
// worse than one that does not parse at all, because the UI would show it as
// incoming value.

import { Amount, type Proof } from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import type { NostrClient } from "../../nostr/nostr-client";
import {
  KIND_NUTZAP,
  KIND_NUTZAP_INFO,
  fetchNutzapInfo,
  parseNutzap,
  parseNutzapInfo,
  publishNutzap,
  subscribeNutzaps,
} from "../nutzap";

const MINT = "https://mint.example.com";
// 33-byte compressed secp256k1 key: what NIP-61 locks proofs to.
const P2PK = "02" + "ab".repeat(32);
// 32-byte x-only Nostr key: valid as an author, invalid as a P2PK lock.
const NOSTR_PUB = "ab".repeat(32);

function event(overrides: Partial<Event>): Event {
  return {
    id: "f".repeat(64),
    pubkey: NOSTR_PUB,
    created_at: 1_700_000_000,
    kind: KIND_NUTZAP,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...overrides,
  } as Event;
}

function proofTag(amount: number, secret = "s1"): string[] {
  return [
    "proof",
    JSON.stringify({
      id: "00ad268c4d1f5826",
      amount,
      secret,
      C: "02" + "cd".repeat(32),
    }),
  ];
}

describe("parseNutzapInfo", () => {
  it("reads mints, relays and the P2PK key", () => {
    const info = parseNutzapInfo(
      event({
        kind: KIND_NUTZAP_INFO,
        tags: [
          ["relay", "wss://relay.example"],
          ["mint", MINT, "sat"],
          ["pubkey", P2PK],
        ],
      }),
    );

    expect(info).not.toBeNull();
    expect(info?.mintUrls).toEqual([MINT]);
    expect(info?.relays).toEqual(["wss://relay.example"]);
    expect(info?.p2pkPubkey).toBe(P2PK);
    expect(info?.pubkey).toBe(NOSTR_PUB);
  });

  it("rejects an x-only Nostr key in the pubkey tag", () => {
    // Locking proofs to a 32-byte key produces ecash nobody can ever unlock,
    // including the sender. Falling back to event.pubkey would do exactly that.
    const info = parseNutzapInfo(
      event({
        kind: KIND_NUTZAP_INFO,
        tags: [
          ["mint", MINT],
          ["pubkey", NOSTR_PUB],
        ],
      }),
    );
    expect(info).toBeNull();
  });

  it("rejects an event with no mint, since we cannot know what they accept", () => {
    const info = parseNutzapInfo(
      event({ kind: KIND_NUTZAP_INFO, tags: [["pubkey", P2PK]] }),
    );
    expect(info).toBeNull();
  });

  it("ignores non-http mint tags and non-ws relay tags", () => {
    const info = parseNutzapInfo(
      event({
        kind: KIND_NUTZAP_INFO,
        tags: [
          ["mint", "javascript:alert(1)"],
          ["mint", MINT],
          ["relay", "http://not-a-relay"],
          ["pubkey", P2PK],
        ],
      }),
    );
    expect(info?.mintUrls).toEqual([MINT]);
    expect(info?.relays).toEqual([]);
  });

  it("returns null for the wrong kind", () => {
    expect(parseNutzapInfo(event({ kind: 1 }))).toBeNull();
  });
});

describe("parseNutzap", () => {
  it("reads proofs from proof tags and the mint from the u tag", () => {
    const zap = parseNutzap(
      event({
        tags: [proofTag(2), proofTag(8, "s2"), ["u", MINT], ["p", NOSTR_PUB]],
        content: "thanks!",
      }),
    );

    expect(zap).not.toBeNull();
    expect(zap?.proofs).toHaveLength(2);
    expect(zap?.amount).toBe(10);
    expect(zap?.mintUrl).toBe(MINT);
    expect(zap?.unit).toBe("sat");
    expect(zap?.comment).toBe("thanks!");
  });

  it("reads NIP-61's unit tag, lowercased, and refuses a label that is not a code", () => {
    const base = [proofTag(2), ["u", MINT]];
    expect(parseNutzap(event({ tags: [...base, ["unit", "USD"]] }))?.unit).toBe(
      "usd",
    );
    expect(
      parseNutzap(event({ tags: [...base, ["unit", "1 BTC\n+"]] }))?.unit,
    ).toBe("sat");
  });

  it("returns null without a mint, since the proofs could not be redeemed", () => {
    expect(parseNutzap(event({ tags: [proofTag(1)] }))).toBeNull();
  });

  it("returns null with no proofs", () => {
    expect(parseNutzap(event({ tags: [["u", MINT]] }))).toBeNull();
  });

  it("drops malformed proof tags rather than half-crediting them", () => {
    const zap = parseNutzap(
      event({
        tags: [
          ["proof", "not json"],
          ["proof", JSON.stringify({ id: "x", amount: 5 })], // missing secret/C
          ["proof", JSON.stringify({ ...JSON.parse(proofTag(4)[1]), C: "zz" })],
          proofTag(16),
          ["u", MINT],
        ],
      }),
    );
    expect(zap?.proofs).toHaveLength(1);
    expect(zap?.amount).toBe(16);
  });

  it("rejects a non-positive or non-integer amount", () => {
    expect(parseNutzap(event({ tags: [proofTag(0), ["u", MINT]] }))).toBeNull();
    expect(
      parseNutzap(event({ tags: [proofTag(-5), ["u", MINT]] })),
    ).toBeNull();
  });

  it("keeps the first u tag only, so a second cannot redirect redemption", () => {
    const zap = parseNutzap(
      event({
        tags: [proofTag(1), ["u", MINT], ["u", "https://evil.example"]],
      }),
    );
    expect(zap?.mintUrl).toBe(MINT);
  });

  it("carries the zapped event id when one is tagged", () => {
    const target = "a".repeat(64);
    const zap = parseNutzap(
      event({ tags: [proofTag(1), ["u", MINT], ["e", target]] }),
    );
    expect(zap?.targetEventId).toBe(target);
  });

  it("returns null for the wrong kind", () => {
    expect(
      parseNutzap(event({ kind: 1, tags: [proofTag(1), ["u", MINT]] })),
    ).toBeNull();
  });

  it("caps the comment so a hostile sender cannot flood the UI", () => {
    const zap = parseNutzap(
      event({ tags: [proofTag(1), ["u", MINT]], content: "x".repeat(1000) }),
    );
    expect(zap?.comment?.length).toBe(280);
  });
});

describe("fetchNutzapInfo", () => {
  function info10019(created_at: number, id: string, p2pk = P2PK): Event {
    return event({
      kind: KIND_NUTZAP_INFO,
      created_at,
      id,
      tags: [
        ["mint", MINT, "sat"],
        ["pubkey", p2pk],
      ],
    });
  }

  function clientAnswering(events: Event[]): NostrClient {
    return {
      queryEvents: jest.fn(() => Promise.resolve(events)),
    } as unknown as NostrClient;
  }

  it("takes the newest copy, not the fastest relay's", async () => {
    const newer = "02" + "ee".repeat(32);
    const info = await fetchNutzapInfo(
      NOSTR_PUB,
      clientAnswering([
        info10019(100, "a".repeat(64)),
        info10019(200, "b".repeat(64), newer),
      ]),
    );
    expect(info?.p2pkPubkey).toBe(newer);
  });

  it("breaks a tie on the lowest id, as NIP-01 says", async () => {
    const lower = "02" + "11".repeat(32);
    const info = await fetchNutzapInfo(
      NOSTR_PUB,
      clientAnswering([
        info10019(100, "b".repeat(64)),
        info10019(100, "a".repeat(64), lower),
      ]),
    );
    expect(info?.p2pkPubkey).toBe(lower);
  });

  it("honours a newer event that opts out, rather than an older valid one", async () => {
    const optOut = event({
      kind: KIND_NUTZAP_INFO,
      created_at: 300,
      id: "c".repeat(64),
      tags: [],
    });
    const info = await fetchNutzapInfo(
      NOSTR_PUB,
      clientAnswering([info10019(100, "a".repeat(64)), optOut]),
    );
    expect(info).toBeNull();
  });
});

describe("publishNutzap", () => {
  it("carries each proof's DLEQ witness with r, and the unit", async () => {
    const publish = jest.fn(() => Promise.resolve());
    const dleq = { e: "01".repeat(32), s: "02".repeat(32), r: "03".repeat(32) };
    const published = await publishNutzap({
      proofs: [
        {
          id: "00ad268c4d1f5826",
          amount: Amount.from(8),
          secret: "s1",
          C: "02" + "cd".repeat(32),
          dleq,
        } as unknown as Proof,
      ],
      mintUrl: MINT,
      unit: "sat",
      recipientPubkey: NOSTR_PUB,
      senderPrivKey: generateSecretKey(),
      client: { publish } as unknown as NostrClient,
    });

    const proofTagJson = published.tags.find((t) => t[0] === "proof")?.[1];
    expect(JSON.parse(proofTagJson ?? "{}").dleq).toEqual(dleq);
    expect(published.tags).toContainEqual(["unit", "sat"]);
    // And our own parser reads it back, witness included.
    expect(parseNutzap(published)?.proofs[0]?.dleq).toEqual(dleq);
  });
});

describe("subscribeNutzaps", () => {
  it("asks relays only for nutzaps from the mints we list (NIP-61 #u)", () => {
    const subscribe = jest.fn(() => ({ close: jest.fn() }));
    const client = { subscribe } as unknown as NostrClient;
    subscribeNutzaps(NOSTR_PUB, [MINT], client, () => {});
    const [filters] = subscribe.mock.calls[0] as unknown as [
      Record<string, unknown>[],
    ];
    expect(filters[0]).toMatchObject({
      kinds: [KIND_NUTZAP],
      "#p": [NOSTR_PUB],
      "#u": [MINT],
    });
  });
});

describe("key shapes", () => {
  it("a Nostr identity key is not a valid P2PK lock key", () => {
    // Documents the distinction the parser enforces: nostr-tools' getPublicKey
    // returns the 32-byte x-only form, which is never a valid `pubkey` tag.
    const nostrPub = getPublicKey(generateSecretKey());
    expect(nostrPub).toHaveLength(64);
    expect(/^0[23][0-9a-f]{64}$/.test(nostrPub)).toBe(false);
  });
});
