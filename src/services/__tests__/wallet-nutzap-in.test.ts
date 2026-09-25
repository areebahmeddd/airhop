/**
 * @jest-environment node
 */
// Incoming NIP-61 nutzaps. Any Nostr key can publish a kind 9321 naming us,
// so everything checkable offline is checked before a row is written or the
// mint is asked, a refusal is final (the event is never tried again), and
// events are redeemed one at a time. A genuine nutzap still redeems without a
// DLEQ witness, since NDK-based senders strip it.
//
// Runs the real wallet service against the simulated mint, with the Nostr
// subscription replaced by a hand that delivers events.

import { Mint, Wallet, type Proof } from "@cashu/cashu-ts";
import { KEYCHAIN_ITEMS, writeSecret } from "@core/crypto/keychain";
import type { NostrClient } from "@core/nostr/nostr-client";
import { KIND_NUTZAP } from "@core/payments/nutzap";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  accountKey,
  bootstrapWalletStorage,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import type { Event } from "nostr-tools";
import { MintFabric } from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  initWalletService,
  resetWalletService,
  startNutzapWatcher,
} from "../wallet-service";

jest.mock("@core/crypto/keychain", () => {
  const secrets = new Map<string, string>();
  return {
    ...jest.requireActual("@core/crypto/keychain"),
    readSecret: jest.fn((item: string) =>
      Promise.resolve(secrets.get(item) ?? null),
    ),
    writeSecret: jest.fn((item: string, value: string) => {
      secrets.set(item, value);
      return Promise.resolve();
    }),
  };
});

jest.mock("react-native-mmkv", () => {
  class MockMMKV {
    private store = new Map<string, string>();
    getString(key: string): string | undefined {
      return this.store.get(key);
    }
    set(key: string, value: string): void {
      this.store.set(key, value);
    }
    remove(key: string): void {
      this.store.delete(key);
    }
    encrypt(): void {}
    clearAll(): void {
      this.store.clear();
    }
  }
  const instances = new Map<string, MockMMKV>();
  return {
    createMMKV: ({ id = "default" }: { id?: string } = {}) => {
      if (!instances.has(id)) instances.set(id, new MockMMKV());
      return instances.get(id)!;
    },
    deleteMMKV: jest.fn(() => true),
  };
});

jest.setTimeout(60_000);

const UNIT = "sat";
const OUR_KEY = bytesToHex(new Uint8Array(32).fill(7));
const OUR_PUB = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(7), true),
);
const THEIR_PUB = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(8), true),
);
const ME = "ab".repeat(32);

let world: World;
let fabric: MintFabric;
let deliver: (event: Event) => void = () => {};
let subscribedFilters: Record<string, unknown>[] = [];
let stop: () => void = () => {};
let eventCounter = 0;

const client = {
  subscribe: (filters: Record<string, unknown>[], onEvent: typeof deliver) => {
    subscribedFilters = filters;
    deliver = onEvent;
    return { close: () => {} };
  },
} as unknown as NostrClient;

function held(): number {
  return (
    useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? []
  ).reduce((sum, p) => sum + p.amount, 0);
}

function nutzapRows() {
  return useWalletStore
    .getState()
    .history.filter((t) => t.kind === "nutzap-in");
}

function settled(eventId: string): boolean {
  return useWalletStore
    .getState()
    .settledNutzaps.some((entry) => entry.id === eventId);
}

// Coins P2PK-locked to `pubkey`, as a nutzap sender makes them. `withDleq`
// false is what NDK's send hands over.
async function lockedProofs(
  sats: number,
  pubkey: string,
  opts: { withDleq?: boolean } = {},
): Promise<Proof[]> {
  const sender = new Wallet(new Mint(fabric.url), { unit: UNIT });
  await sender.loadMint();
  const quote = await sender.createMintQuoteBolt11(sats);
  const proofs = await sender.mintProofsBolt11(sats, quote);
  const preview = await sender.prepareSwapToSend(
    sats,
    proofs,
    {},
    { send: { type: "p2pk", options: { pubkey } } },
  );
  const { send } = await sender.completeSwap(preview);
  return opts.withDleq === false
    ? send.map((p) => ({ ...p, dleq: undefined }))
    : send;
}

// Coins locked to our key that no mint ever signed.
function forgedLockedProofs(template: Proof[]): Proof[] {
  return template.map((p) => ({
    ...p,
    C: bytesToHex(
      secp256k1.getPublicKey(crypto.getRandomValues(new Uint8Array(32)), true),
    ),
    dleq: undefined,
  }));
}

function nutzapEvent(proofs: Proof[], extraTags: string[][] = []): Event {
  eventCounter += 1;
  return {
    id: eventCounter.toString(16).padStart(64, "0"),
    pubkey: "cd".repeat(32),
    created_at: Math.floor(Date.now() / 1000),
    kind: KIND_NUTZAP,
    tags: [
      ...proofs.map((p) => [
        "proof",
        JSON.stringify({
          id: p.id,
          amount: Number(p.amount),
          secret: p.secret,
          C: p.C,
          ...(p.dleq ? { dleq: p.dleq } : {}),
        }),
      ]),
      ["u", fabric.url],
      ["p", ME],
      ...extraTags,
    ],
    content: "",
    sig: "0".repeat(128),
  } as Event;
}

async function settle(): Promise<void> {
  // The watcher's queue runs on its own; give it the turns it needs.
  for (let i = 0; i < 400; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  await writeSecret(KEYCHAIN_ITEMS.walletP2pkKey, OUR_KEY);
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 51, name: "wallet-nutzap-in" });
  fabric = new MintFabric(world, "https://nutzap.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  stop();
  fabric.setConditions({ offline: false, latencyMs: 0 });
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
  stop = startNutzapWatcher({ myPubkey: ME, client });
});

describe("a genuine nutzap", () => {
  it("is redeemed, with or without a DLEQ witness", async () => {
    const withWitness = nutzapEvent(await lockedProofs(8, OUR_PUB));
    const stripped = nutzapEvent(
      await lockedProofs(16, OUR_PUB, { withDleq: false }),
    );
    deliver(withWitness);
    deliver(stripped);
    await settle();

    expect(held()).toBe(24);
    expect(settled(withWitness.id) && settled(stripped.id)).toBe(true);
    expect(nutzapRows().every((t) => t.status === "completed")).toBe(true);
  });

  it("is asked for only from the mints we hold", () => {
    expect(subscribedFilters[0]?.["#u"]).toEqual([fabric.url]);
  });
});

describe("a nutzap we cannot take", () => {
  it("writes no row and is never tried again: locked to someone else", async () => {
    const event = nutzapEvent(await lockedProofs(8, THEIR_PUB));
    deliver(event);
    await settle();

    expect(nutzapRows()).toHaveLength(0);
    expect(settled(event.id)).toBe(true);
  });

  it("writes no row and is never tried again: the wrong unit", async () => {
    const event = nutzapEvent(await lockedProofs(8, OUR_PUB), [
      ["unit", "usd"],
    ]);
    deliver(event);
    await settle();

    expect(nutzapRows()).toHaveLength(0);
    expect(settled(event.id)).toBe(true);
    expect(held()).toBe(0);
  });

  it("writes no row for a mint we do not hold, and says nothing", async () => {
    const event = nutzapEvent(await lockedProofs(8, OUR_PUB));
    event.tags = event.tags.map((tag) =>
      tag[0] === "u" ? ["u", "https://stranger.test"] : tag,
    );
    deliver(event);
    await settle();

    expect(useWalletStore.getState().history).toHaveLength(0);
    expect(settled(event.id)).toBe(true);
  });

  it("closes a mint refusal, leaves no row, and never asks the mint again", async () => {
    const forged = nutzapEvent(
      forgedLockedProofs(await lockedProofs(8, OUR_PUB)),
    );
    deliver(forged);
    await settle();
    const swapsAfterFirst = fabric.swapCount;

    expect(nutzapRows()).toHaveLength(0);
    expect(settled(forged.id)).toBe(true);

    // A relay replays it on the next subscription.
    deliver(forged);
    await settle();
    expect(fabric.swapCount).toBe(swapsAfterFirst);
  });
});

describe("a burst of nutzaps", () => {
  it("is redeemed one at a time", async () => {
    const events: Event[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(nutzapEvent(await lockedProofs(1, OUR_PUB)));
    }
    fabric.setConditions({ latencyMs: 5 });
    let active = 0;
    let peak = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const isSwap = String(input).includes("/v1/swap");
      if (isSwap) peak = Math.max(peak, ++active);
      try {
        return await inner(input as RequestInfo, init as RequestInit);
      } finally {
        if (isSwap) active -= 1;
      }
    }) as typeof globalThis.fetch;
    try {
      for (const event of events) deliver(event);
      // A relay's duplicate while the first copy is in flight.
      deliver(events[0]!);
      await settle();
    } finally {
      globalThis.fetch = inner;
    }

    expect(peak).toBe(1);
    expect(held()).toBe(20);
  });
});
