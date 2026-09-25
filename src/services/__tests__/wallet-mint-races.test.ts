/**
 * @jest-environment node
 */
// Two operations wanting the same coins, or a mint answer that goes missing
// while the wallet carries on.
//
// Runs the real wallet service against the simulated mint (real blinding,
// double-spend refusal, NUT-19 cache and NUT-09 restore): the risk here is
// ordering between wallet and mint, which a stub would simply agree with.
//
// The invariant: a coin is spendable, or held against the one operation that
// may have spent it, or gone because the mint says so. Exactly one.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { generateRecoveryPhrase } from "@core/payments/wallet-seed";
import { useSettingsStore } from "@store/settings-store";
import {
  accountKey,
  bootstrapWalletStorage,
  useWalletStore,
  whenWalletHydrated,
  wipeWalletStorage,
} from "@store/wallet-store";
import {
  MintFabric,
  simInvoice,
} from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  claimLightningDeposit,
  createLightningDeposit,
  initWalletService,
  lockProofsForNutzap,
  payLightningInvoice,
  prepareSend,
  quoteLightningWithdrawal,
  receiveToken,
  reconcile,
  refreshAccount,
  resetWalletService,
  restoreFromRecoveryPhrase,
} from "../wallet-service";

// Only the two accessors are replaced; see wallet-send-lifecycle for why.
jest.mock("@core/crypto/keychain", () => {
  const secrets = new Map<string, string>();
  return {
    ...jest.requireActual("@core/crypto/keychain"),
    readSecret: jest.fn((item: string) => secrets.get(item) ?? null),
    writeSecret: jest.fn((item: string, value: string) => {
      secrets.set(item, value);
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
    // Nothing is encrypted in the mock.
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
    deleteMMKV: jest.fn((id: string) => instances.delete(id)),
  };
});

jest.setTimeout(60_000);

const UNIT = "sat";
const RECIPIENT_P2PK = "02" + "11".repeat(32);

let world: World;
let fabric: MintFabric;

function key(): string {
  return accountKey(fabric.url, UNIT);
}

function spendable(): number {
  return (useWalletStore.getState().proofs[key()] ?? []).reduce(
    (sum, p) => sum + p.amount,
    0,
  );
}

function reservedTotal(): number {
  return Object.values(useWalletStore.getState().reserved).reduce(
    (sum, entry) => sum + entry.proofs.reduce((s, p) => s + p.amount, 0),
    0,
  );
}

function tx(id: string) {
  return useWalletStore.getState().history.find((t) => t.id === id);
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// Coins this wallet was paid by somebody else: minted by a separate wallet at
// the same mint and handed over as a token string.
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

async function fund(sats: number): Promise<void> {
  const deposit = await createLightningDeposit({
    amount: sats,
    mintUrl: fabric.url,
  });
  await claimLightningDeposit(fabric.url, UNIT, deposit.quoteId);
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  expect(await initWalletService()).toBe(true);
  world = new World({ seed: 7, name: "wallet-mint-races" });
  fabric = new MintFabric(world, "https://races.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  fabric.setConditions({
    latencyMs: 0,
    offline: false,
    swapResponseLost: false,
    inputFeePpk: 0,
  });
  // The NUT-13 cursor survives, as it does in the app: the seed is still
  // loaded, so starting it over would re-derive secrets the mint has already
  // seen spent in an earlier case.
  const counters = useWalletStore.getState().counters;
  useWalletStore.getState().clearAll();
  useWalletStore.setState({ counters });
  await addMint(fabric.url);
});

describe("replaying a lost swap", () => {
  it("does not replay a receive whose coins were passed on in the meantime", async () => {
    // Taken in with no signal: the swap was staged, never reached the mint, and
    // the token was kept offline so it could still be spent. Then it was.
    const token = await strangersToken(8);
    fabric.setConditions({ offline: true });
    const received = await receiveToken(token);
    expect(received.outcome).toBe("stored");
    const receipt = useWalletStore
      .getState()
      .history.find((t) => t.kind === "receive");
    expect(receipt?.swapPreview).toBeDefined();

    const forwarded = await prepareSend({ amount: 8 });
    const secrets = useWalletStore
      .getState()
      .reserved[forwarded.txId]!.proofs.map((p) => p.secret);

    // Back online. A replay now would be a brand new swap to the mint, and it
    // would spend the coins sitting in the token somebody else is holding.
    fabric.setConditions({ offline: false });
    await reconcile();

    for (const secret of secrets) expect(fabric.isSpent(secret)).toBe(false);
    // The receive stands as the offline receive it was; the send is untouched.
    expect(tx(receipt!.id)?.swapPreview).toBeUndefined();
    expect(tx(receipt!.id)?.status).toBe("pending");
    expect(tx(forwarded.txId)?.status).toBe("pending");
    expect(reservedTotal()).toBe(8);
  });

  it("settles a swap that did happen, and closes the send it killed", async () => {
    // Here the mint DID swap, and only its answer was lost, so the coins the
    // user then forwarded were already spent. The value came back to us, and
    // the send is not "delivered": its token can never be claimed.
    const token = await strangersToken(8);
    fabric.setConditions({ swapResponseLost: true });
    const received = await receiveToken(token);
    expect(received.outcome).toBe("stored");
    const forwarded = await prepareSend({ amount: 8 });

    fabric.setConditions({ swapResponseLost: false });
    await reconcile();

    expect(tx(forwarded.txId)?.status).toBe("failed");
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(8);
    const receipt = useWalletStore
      .getState()
      .history.find((t) => t.kind === "receive");
    expect(receipt?.status).toBe("completed");
  });
});

describe("swaps hold their inputs", () => {
  it("keeps a refresh's coins out of reach of a send while the mint answers", async () => {
    const token = await strangersToken(8);
    // Internet off: stored with no swap staged, so only a refresh swaps it.
    useSettingsStore.setState({ internetEnabled: false });
    const stored = await receiveToken(token);
    useSettingsStore.setState({ internetEnabled: true });
    expect(stored.outcome).toBe("stored");

    fabric.setConditions({ latencyMs: 40 });
    const refresh = refreshAccount(fabric.url, UNIT);
    await waitFor(() => reservedTotal() > 0);

    // The refresh is swapping these right now. A token built from them would
    // be dead the moment the swap lands.
    await expect(prepareSend({ amount: 8 })).rejects.toMatchObject({
      code: "insufficient",
    });

    const result = await refresh;
    expect(result.swapped).toBe(8);
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(8);
  });

  it("holds a lock's inputs while its answer is missing, then settles them", async () => {
    await fund(16);
    fabric.setConditions({ swapResponseLost: true });

    await expect(
      lockProofsForNutzap({
        amount: 8,
        mintUrl: fabric.url,
        unit: UNIT,
        recipientPubkey: RECIPIENT_P2PK,
      }),
    ).rejects.toMatchObject({ inDoubt: true });

    // Whatever the lock spent is held, not spendable, so nothing else can pick
    // it while the mint's answer is outstanding.
    expect(reservedTotal()).toBeGreaterThan(0);
    expect(spendable() + reservedTotal()).toBe(16);

    fabric.setConditions({ swapResponseLost: false });
    await reconcile();

    // The lock happened: the locked token is on the transaction to hand over,
    // the change is back, and nothing is held any more.
    const lock = useWalletStore
      .getState()
      .history.find((t) => t.kind === "nutzap-out");
    expect(lock?.token).toBeDefined();
    expect(lock?.swapPreview).toBeUndefined();
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(8);
  });

  it("gives a refused lock's coins straight back", async () => {
    await fund(16);
    // The mint raised its fee after the wallet cached the old one, so it
    // refuses the swap outright as underpaid. A refusal is an answer: nothing
    // was spent, and nothing needs holding.
    fabric.setConditions({ inputFeePpk: 1000 });

    await expect(
      lockProofsForNutzap({
        amount: 8,
        mintUrl: fabric.url,
        unit: UNIT,
        recipientPubkey: RECIPIENT_P2PK,
      }),
    ).rejects.toMatchObject({ code: "mint-error", inDoubt: false });

    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(16);
    const lock = useWalletStore
      .getState()
      .history.find((t) => t.kind === "nutzap-out");
    expect(lock?.status).toBe("failed");
    expect(lock?.swapPreview).toBeUndefined();
  });

  it("keeps holding the coins when the answer is 'already spent'", async () => {
    // That answer may describe our own first attempt, which succeeded, so the
    // preview and the held coins stay for reconcile to settle.
    await fund(16);
    for (const proof of useWalletStore.getState().proofs[key()] ?? []) {
      fabric.markSpent(proof.secret);
    }

    await expect(
      lockProofsForNutzap({
        amount: 8,
        mintUrl: fabric.url,
        unit: UNIT,
        recipientPubkey: RECIPIENT_P2PK,
      }),
    ).rejects.toMatchObject({ inDoubt: true });

    expect(reservedTotal()).toBeGreaterThan(0);
  });
});

describe("a melt in flight", () => {
  it("is left alone by a reconcile that runs before the mint marks it pending", async () => {
    await fund(64);
    const quote = await quoteLightningWithdrawal({
      invoice: simInvoice(32),
      mintUrl: fabric.url,
    });

    // The melt request takes the long way to the mint, so a quote check sent
    // after it is answered first, while the quote still reads UNPAID. Believing
    // that would put the proofs back just before the melt spends them.
    const direct = globalThis.fetch;
    let meltArrived = false;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      if (String(input).endsWith("/v1/melt/bolt11")) {
        await waitFor(() => meltArrived);
      }
      return direct(input as RequestInfo, init as RequestInit);
    }) as typeof globalThis.fetch;
    try {
      const paying = payLightningInvoice(quote);
      await waitFor(() =>
        useWalletStore
          .getState()
          .history.some(
            (t) => t.kind === "melt" && t.meltOutputs !== undefined,
          ),
      );
      await reconcile();
      meltArrived = true;
      await paying;
    } finally {
      globalThis.fetch = direct;
    }

    const melt = useWalletStore
      .getState()
      .history.find((t) => t.kind === "melt");
    expect(melt?.status).toBe("completed");
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(32);
  });
});

describe("redeeming a token twice", () => {
  it("reports the second as a duplicate and opens no receipt for it", async () => {
    const token = await strangersToken(8);
    expect((await receiveToken(token)).outcome).toBe("swapped");
    const swaps = fabric.swapCount;
    const rows = useWalletStore.getState().history.length;

    const again = await receiveToken(token);

    expect(again.outcome).toBe("duplicate");
    expect(fabric.swapCount).toBe(swaps);
    expect(useWalletStore.getState().history).toHaveLength(rows);
    expect(
      useWalletStore
        .getState()
        .history.some((t) => t.kind === "receive" && t.status === "pending"),
    ).toBe(false);
  });
});

describe("restoring a different phrase", () => {
  it("stops counting the coins held now as covered", async () => {
    await fund(16);
    const held = useWalletStore.getState().proofs[key()] ?? [];
    expect(held.every((p) => p.derived === true)).toBe(true);

    await restoreFromRecoveryPhrase({
      phrase: generateRecoveryPhrase(),
      mintUrls: [fabric.url],
      unit: UNIT,
    });

    // The new words cannot rebuild these, so they read as uncovered until a
    // refresh re-issues them under the new phrase.
    const after = useWalletStore.getState().proofs[key()] ?? [];
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((p) => p.derived !== true)).toBe(true);

    const refreshed = await refreshAccount(fabric.url, UNIT);
    expect(refreshed.securedForBackup).toBe(16);
    expect(
      (useWalletStore.getState().proofs[key()] ?? []).every(
        (p) => p.derived === true,
      ),
    ).toBe(true);
  });
});

// Last, because it tears the storage down.
describe("a panic wipe during a mint round trip", () => {
  it("does not let the operation write the old wallet back", async () => {
    const token = await strangersToken(8);
    fabric.setConditions({ latencyMs: 60 });
    const receiving = receiveToken(token);
    await waitFor(() =>
      useWalletStore.getState().history.some((t) => t.kind === "receive"),
    );

    // What the panic wipe does to the wallet, in its order.
    resetWalletService();
    useWalletStore.getState().clearAll();
    wipeWalletStorage();

    await expect(receiving).rejects.toMatchObject({ code: "locked" });
    expect(useWalletStore.getState().proofs).toEqual({});
    expect(useWalletStore.getState().history).toEqual([]);

    // The wipe drops to onboarding in the same process, and the next identity
    // unlocks the wallet again. That must read the new partition at once, not
    // wait out the hydration timeout.
    const started = Date.now();
    expect(await initWalletService()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(useWalletStore.getState().history).toEqual([]);

    await addMint(fabric.url);
    await fund(8);
    expect(spendable()).toBe(8);
  });
});
