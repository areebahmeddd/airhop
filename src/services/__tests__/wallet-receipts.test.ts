/**
 * @jest-environment node
 */
// Refreshing an account swaps each offline receipt on its own. A receipt is
// the unit of refusal, as in CDK and Nutshell: a stranger's forged token can
// cost only itself, never block the honest receipts beside it or every later
// refresh. And a coin is verified only by a swap that completed, never by a
// state check (NUT-07 calls a coin it has never seen unspent).
//
// Runs the real wallet service against the simulated mint, which verifies
// every input it is handed.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useSettingsStore } from "@store/settings-store";
import {
  accountKey,
  bootstrapWalletStorage,
  keysetRefsOf,
  useWalletStore,
  whenWalletHydrated,
  type StoredProof,
} from "@store/wallet-store";
import { MintFabric } from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  claimLightningDeposit,
  createLightningDeposit,
  initWalletService,
  prepareSend,
  receiveToken,
  reclaimSend,
  refreshAccount,
  resetWalletService,
  settleReclaim,
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

let world: World;
let fabric: MintFabric;

function held(): StoredProof[] {
  return useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? [];
}

function sum(proofs: StoredProof[]): number {
  return proofs.reduce((s, p) => s + p.amount, 0);
}

// Every coin this account holds, spendable or reserved.
function everyCoin(): StoredProof[] {
  const reserved = Object.values(useWalletStore.getState().reserved).flatMap(
    (entry) => entry.proofs,
  );
  return [...held(), ...reserved];
}

function row(id: string) {
  return useWalletStore.getState().history.find((t) => t.id === id);
}

function receiptOf(sats: number): string | undefined {
  return held().find((p) => p.amount === sats)?.receiptTxId;
}

async function strangersToken(sats: number): Promise<string> {
  const sender = new Wallet(new Mint(fabric.url), { unit: UNIT });
  await sender.loadMint();
  const quote = await sender.createMintQuoteBolt11(sats);
  const proofs = await sender.mintProofsBolt11(sats, quote);
  return getEncodedToken({
    mint: fabric.url,
    unit: UNIT,
    proofs,
  } as unknown as Token);
}

// Coins nobody signed, in a real keyset and denomination, carrying no witness:
// offline, nothing tells them from a genuine transfer.
function forgedToken(sats: number): string {
  const keysetId = keysetRefsOf(useWalletStore.getState().mints)[0]?.id ?? "";
  const C = bytesToHex(
    secp256k1.getPublicKey(crypto.getRandomValues(new Uint8Array(32)), true),
  );
  return getEncodedToken({
    mint: fabric.url,
    unit: UNIT,
    proofs: [
      {
        id: keysetId,
        amount: sats,
        secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        C,
      },
    ],
  } as unknown as Token);
}

// Received with the internet off: stored as a receipt of its own, no swap
// staged, so only a refresh redeems it.
async function receiveOffline(token: string): Promise<void> {
  useSettingsStore.setState({ internetEnabled: false });
  try {
    const result = await receiveToken(token);
    expect(result.outcome).toBe("stored");
  } finally {
    useSettingsStore.setState({ internetEnabled: true });
  }
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 41, name: "wallet-receipts" });
  fabric = new MintFabric(world, "https://receipts.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  fabric.setConditions({
    offline: false,
    latencyMs: 0,
    swapResponseLost: false,
    inputFeePpk: 0,
  });
  useSettingsStore.setState({ internetEnabled: true, torEnabled: false });
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
});

describe("one forged receipt among honest ones", () => {
  it("is refused on its own, and the honest ones are swapped", async () => {
    await receiveOffline(await strangersToken(8));
    await receiveOffline(await strangersToken(16));
    await receiveOffline(forgedToken(32));
    const honest = [receiptOf(8)!, receiptOf(16)!];
    const forged = receiptOf(32)!;
    expect(sum(held())).toBe(56);

    const result = await refreshAccount(fabric.url, UNIT);

    expect(result.swapped).toBe(24);
    expect(result.refused).toBe(32);
    expect(result.receipts[forged]).toBe("refused");
    expect(sum(held())).toBe(24);
    expect(held().every((p) => p.verified === true)).toBe(true);
    for (const id of honest) expect(row(id)?.status).toBe("completed");
    // Not destroyed: the row keeps them as a token to hand back.
    expect(row(forged)?.status).toBe("failed");
    expect(row(forged)?.token).toMatch(/^cashuB/);
  });

  it("leaves the next refresh with nothing to fail on", async () => {
    await receiveOffline(forgedToken(32));
    await refreshAccount(fabric.url, UNIT);

    await receiveOffline(await strangersToken(8));
    const second = await refreshAccount(fabric.url, UNIT);
    expect(second.refused).toBe(0);
    expect(second.swapped).toBe(8);
  });
});

describe("verified", () => {
  it("is never granted by a state check while the swap is in doubt", async () => {
    await receiveOffline(await strangersToken(8));
    fabric.setConditions({ swapResponseLost: true });

    await expect(refreshAccount(fabric.url, UNIT)).rejects.toMatchObject({
      code: "offline",
    });

    // Held against the staged swap for `reconcile`, and still unconfirmed.
    expect(everyCoin().length).toBeGreaterThan(0);
    expect(everyCoin().every((p) => p.verified !== true)).toBe(true);
  });

  it("is never granted to coins whose swap cannot even be prepared", async () => {
    // A keyset the mint does not know: NUT-07 still says UNSPENT (it has no
    // record), and the swap is refused before it is built.
    const token = getEncodedToken({
      mint: fabric.url,
      unit: UNIT,
      proofs: [
        {
          id: "00" + "ee".repeat(7),
          amount: 8,
          secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
          C: bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(4))),
        },
      ],
    } as unknown as Token);
    await receiveOffline(token);
    const receipt = receiptOf(8)!;

    const result = await refreshAccount(fabric.url, UNIT);

    expect(result.receipts[receipt]).toBe("refused");
    expect(everyCoin().some((p) => p.verified === true)).toBe(false);
  });

  it("is never granted to coins the mint will not take", async () => {
    await receiveOffline(forgedToken(16));
    await refreshAccount(fabric.url, UNIT);
    expect(everyCoin()).toHaveLength(0);
  });
});

describe("a receipt worth no more than its fee", () => {
  it("is left unconfirmed rather than swapped at a loss or refused", async () => {
    fabric.setConditions({ inputFeePpk: 1000 });
    await addMint(fabric.url);
    await receiveOffline(await strangersToken(1));
    const dust = receiptOf(1)!;

    const result = await refreshAccount(fabric.url, UNIT);

    expect(result.receipts[dust]).toBe("skipped");
    expect(result.stillUnverified).toBe(1);
    expect(row(dust)?.status).toBe("pending");
  });
});

describe("settling a reclaim", () => {
  it("swaps the reclaimed coins even behind a queue of older receipts", async () => {
    // Nine older receipts, one more than a refresh swaps in one go.
    for (let i = 0; i < 9; i++) {
      await receiveOffline(await strangersToken(1));
    }
    const deposit = await createLightningDeposit({
      amount: 64,
      mintUrl: fabric.url,
    });
    await claimLightningDeposit(fabric.url, UNIT, deposit.quoteId);
    const send = await prepareSend({ amount: 64 });
    expect(reclaimSend(send.txId)).toBe(true);

    expect(await settleReclaim(send.txId)).toBe("secured");
    expect(
      held()
        .filter((p) => p.amount === 64)
        .every((p) => p.verified === true),
    ).toBe(true);
  });
});
