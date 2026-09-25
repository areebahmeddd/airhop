/**
 * @jest-environment node
 */
// What a received token must be before any of it counts as balance: coins in
// the currency its label names, and coins this wallet can actually spend.
// Both are decided before anything is stored, because a coin stored as
// balance is shown, counted and offered to the next send.
//
// Runs the real wallet service against the simulated mint.

import {
  getEncodedToken,
  Mint,
  Wallet,
  type Proof,
  type Token,
} from "@cashu/cashu-ts";
import { KEYCHAIN_ITEMS, writeSecret } from "@core/crypto/keychain";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  accountKey,
  bootstrapWalletStorage,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import { MintFabric } from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  initWalletService,
  receiveToken,
  resetWalletService,
} from "../wallet-service";

// The map lives in the factory: the store reads the keychain while the imports
// above are still loading, before any module-scope `const` here exists.
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
// The wallet's own NIP-61 lock key, planted so a test can lock coins to it.
const OUR_KEY = bytesToHex(new Uint8Array(32).fill(5));
const OUR_PUB = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
);
const THEIR_PUB = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(6), true),
);

let world: World;
let fabric: MintFabric;

function held(): number {
  return (
    useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? []
  ).reduce((sum, p) => sum + p.amount, 0);
}

function receipts(): number {
  return useWalletStore.getState().history.filter((t) => t.kind === "receive")
    .length;
}

async function mintedProofs(sats: number): Promise<{
  sender: Wallet;
  proofs: Proof[];
}> {
  const sender = new Wallet(new Mint(fabric.url), { unit: UNIT });
  await sender.loadMint();
  const quote = await sender.createMintQuoteBolt11(sats);
  return { sender, proofs: await sender.mintProofsBolt11(sats, quote) };
}

function encode(proofs: Proof[], unit = UNIT): string {
  return getEncodedToken({
    mint: fabric.url,
    unit,
    proofs,
  } as unknown as Token);
}

// Coins P2PK-locked to `pubkey`, as a nutzap sender makes them.
async function lockedToken(sats: number, pubkey: string): Promise<string> {
  const { sender, proofs } = await mintedProofs(sats);
  const preview = await sender.prepareSwapToSend(
    sats,
    proofs,
    {},
    { send: { type: "p2pk", options: { pubkey } } },
  );
  const { send } = await sender.completeSwap(preview);
  return encode(send);
}

beforeAll(async () => {
  await writeSecret(KEYCHAIN_ITEMS.walletP2pkKey, OUR_KEY);
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 21, name: "wallet-receive-guards" });
  fabric = new MintFabric(world, "https://guards.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  fabric.setConditions({ offline: false, latencyMs: 0 });
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
});

describe("a token whose label disagrees with its coins", () => {
  it("is refused as the wrong currency and nothing is stored", async () => {
    // 150 sats relabelled as 150 cents: shown as $1.50 and filed under usd
    // if the label were believed.
    const { proofs } = await mintedProofs(150);
    const relabelled = encode(proofs, "usd");

    await expect(receiveToken(relabelled)).rejects.toMatchObject({
      code: "forged-token",
    });
    expect(held()).toBe(0);
    expect(
      useWalletStore.getState().proofs[accountKey(fabric.url, "usd")],
    ).toBeUndefined();
    expect(receipts()).toBe(0);
  });
});

describe("coins locked to a key", () => {
  it("refuses coins locked to someone else, online or not", async () => {
    const token = await lockedToken(16, THEIR_PUB);
    await expect(receiveToken(token)).rejects.toMatchObject({
      code: "forged-token",
    });
    fabric.setConditions({ offline: true });
    await expect(receiveToken(token)).rejects.toMatchObject({
      code: "forged-token",
    });
    expect(held()).toBe(0);
    expect(receipts()).toBe(0);
  });

  it("claims coins locked to us online, signing them", async () => {
    const token = await lockedToken(16, OUR_PUB);
    const result = await receiveToken(token);
    expect(result.outcome).toBe("swapped");
    expect(held()).toBe(16);
  });

  it("asks for a connection rather than storing coins locked to us", async () => {
    // Stored, they would count as balance nothing but a signing swap can
    // spend, and a send could hand them on as a worthless token.
    const token = await lockedToken(16, OUR_PUB);
    fabric.setConditions({ offline: true });
    await expect(receiveToken(token)).rejects.toMatchObject({
      code: "offline",
    });
    expect(held()).toBe(0);
    expect(useWalletStore.getState().claimedTokens).toHaveLength(0);

    fabric.setConditions({ offline: false });
    const result = await receiveToken(token);
    expect(result.outcome).toBe("swapped");
    expect(held()).toBe(16);
  });
});

describe("the mint's unit list", () => {
  it("is not rewritten by a receive", async () => {
    // Only the mint's own keysets say which units it issues.
    useWalletStore.getState().updateMint(fabric.url, { units: ["sat", "usd"] });
    const { proofs } = await mintedProofs(8);
    fabric.setConditions({ offline: true });
    expect((await receiveToken(encode(proofs))).outcome).toBe("stored");
    fabric.setConditions({ offline: false });
    const more = await mintedProofs(4);
    expect((await receiveToken(encode(more.proofs))).outcome).toBe("swapped");

    expect(useWalletStore.getState().mints[fabric.url]?.units).toEqual([
      "sat",
      "usd",
    ]);
  });
});
