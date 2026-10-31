// What a recovery pass does when the mint answers with something other than a
// NUT error. A 5xx, a 429 or a reverse proxy's HTML page in front of the mint
// says nothing about what the mint did, so the stored outputs that are the
// only way back to the coins must survive it, and a melt in that state must
// not be handed back as spendable. Nor may a melt the mint says is still
// paying, whether in a 200 or in a retry's "quote is pending". Also: a
// replayed melt swap-down, and removing a mint with payments still open there.
//
// Runs the real wallet service against the simulated mint.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { useSettingsStore } from "@store/settings-store";
import {
  accountKey,
  bootstrapWalletStorage,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import {
  MintFabric,
  simInvoice,
  type HttpFailure,
} from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  claimLightningDeposit,
  createLightningDeposit,
  initWalletService,
  mintHoldings,
  payLightningInvoice,
  quoteLightningWithdrawal,
  receiveToken,
  reconcile,
  removeMint,
  resetWalletService,
} from "../wallet-service";

// cashu-ts retries a 5xx on the NUT-19 endpoints with backoff, in real time.
jest.setTimeout(180_000);

const UNIT = "sat";
const FAILURES: HttpFailure[] = ["server-error", "rate-limited", "proxy-page"];

let world: World;
let fabric: MintFabric;

function spendable(): number {
  return (
    useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? []
  ).reduce((sum, p) => sum + p.amount, 0);
}

function unverified(): number {
  return (useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? [])
    .filter((p) => p.verified !== true)
    .reduce((sum, p) => sum + p.amount, 0);
}

function reservedTotal(): number {
  return Object.values(useWalletStore.getState().reserved).reduce(
    (sum, entry) => sum + entry.proofs.reduce((s, p) => s + p.amount, 0),
    0,
  );
}

function pendingPreviews(): number {
  return useWalletStore
    .getState()
    .history.filter((t) => t.status === "pending" && t.swapPreview).length;
}

function depositRow() {
  return useWalletStore.getState().history.find((t) => t.kind === "mint");
}

function meltRow() {
  return useWalletStore.getState().history.find((t) => t.kind === "melt");
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

async function fund(sats: number): Promise<void> {
  const deposit = await createLightningDeposit({
    amount: sats,
    mintUrl: fabric.url,
  });
  await claimLightningDeposit(fabric.url, UNIT, deposit.quoteId);
}

// A claim whose swap the mint made, and whose answer never arrived.
async function claimWithLostAnswer(sats: number): Promise<void> {
  fabric.setConditions({ swapResponseLost: true });
  try {
    const received = await receiveToken(await strangersToken(sats));
    expect(received.outcome).toBe("stored");
  } finally {
    fabric.setConditions({ swapResponseLost: false });
  }
  expect(pendingPreviews()).toBe(1);
}

// A mint that does not cache, as the wallet learns it from /v1/info.
async function withoutResponseCache(): Promise<void> {
  fabric.setConditions({ nut19: false });
  await addMint(fabric.url);
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 61, name: "wallet-recovery" });
  fabric = new MintFabric(world, "https://recovery.test");
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
    mintResponseLost: false,
    nut19: true,
    nut09: true,
    meltFeeReserve: 0,
    meltActualFee: 0,
    meltVanishes: false,
    meltRoutesSlowly: null,
    meltPendingCode: 20005,
    depositUnpaid: false,
    httpFailures: {},
  });
  useSettingsStore.setState({
    internetEnabled: true,
    torEnabled: false,
    allowMintOverClearnet: false,
  });
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
});

describe("a lost swap whose replay meets an HTTP failure", () => {
  it.each(FAILURES)(
    "keeps the preview and the balance through a %s on the replay and the restore",
    async (failure) => {
      await claimWithLostAnswer(8);
      fabric.setConditions({
        httpFailures: {
          "/v1/swap": { failure, when: "before" },
          "/v1/restore": { failure, when: "before" },
        },
      });
      await reconcile();

      // Nothing was decided: the claim still waits on the mint, and the coins
      // it took in are still counted.
      expect(pendingPreviews()).toBe(1);
      expect(spendable()).toBe(8);

      fabric.setConditions({ httpFailures: {} });
      await reconcile();
      expect(pendingPreviews()).toBe(0);
      expect(spendable()).toBe(8);
      expect(unverified()).toBe(0);
    },
  );

  it.each(FAILURES)(
    "does not read a %s from NUT-09 as a mint without it",
    async (failure) => {
      // No response cache, so the replay is refused as spent and only NUT-09
      // can return the outputs.
      await withoutResponseCache();
      await claimWithLostAnswer(8);
      fabric.setConditions({
        httpFailures: { "/v1/restore": { failure, when: "before" } },
      });
      await reconcile();
      expect(pendingPreviews()).toBe(1);
      expect(spendable()).toBe(8);

      fabric.setConditions({ httpFailures: {} });
      await reconcile();
      expect(pendingPreviews()).toBe(0);
      expect(spendable()).toBe(8);
      expect(unverified()).toBe(0);
    },
  );

  it("closes the claim once the mint answers NUT-09 with a 404", async () => {
    await withoutResponseCache();
    await claimWithLostAnswer(8);
    // Its /v1/info still lists NUT-09 from when it was added.
    fabric.setConditions({ nut09: false });
    await reconcile();

    // Nothing can rebuild the outputs, so the claim stops waiting and the
    // coins it took in are left to the receipt's own refresh.
    expect(pendingPreviews()).toBe(0);
  });
});

describe("a lost deposit answer whose recovery meets an HTTP failure", () => {
  it.each(FAILURES)(
    "keeps the outputs through a %s on the replay and the restore",
    async (failure) => {
      fabric.setConditions({ mintResponseLost: true });
      await expect(fund(64)).rejects.toBeDefined();
      fabric.setConditions({
        mintResponseLost: false,
        httpFailures: {
          "/v1/mint/bolt11": { failure, when: "before" },
          "/v1/restore": { failure, when: "before" },
        },
      });
      await reconcile();
      expect(spendable()).toBe(0);
      expect(depositRow()?.status).toBe("pending");
      expect(depositRow()?.mintOutputs).toBeDefined();

      fabric.setConditions({ httpFailures: {} });
      await reconcile();
      expect(spendable()).toBe(64);
      expect(depositRow()?.status).toBe("completed");
    },
  );

  it.each(FAILURES)(
    "keeps the outputs through a %s on NUT-09 after the replay is refused",
    async (failure) => {
      await withoutResponseCache();
      fabric.setConditions({ mintResponseLost: true });
      await expect(fund(64)).rejects.toBeDefined();
      fabric.setConditions({
        mintResponseLost: false,
        httpFailures: { "/v1/restore": { failure, when: "before" } },
      });
      await reconcile();
      expect(depositRow()?.status).toBe("pending");
      expect(depositRow()?.mintOutputs).toBeDefined();

      fabric.setConditions({ httpFailures: {} });
      await reconcile();
      expect(spendable()).toBe(64);
    },
  );
});

describe("a melt answered by something other than the mint", () => {
  it("is not handed back when a proxy's 504 page arrives after the mint paid", async () => {
    fabric.setConditions({ meltFeeReserve: 4, meltActualFee: 1 });
    await fund(64);
    const quote = await quoteLightningWithdrawal({
      invoice: simInvoice(32),
      mintUrl: fabric.url,
    });
    fabric.setConditions({
      httpFailures: {
        "/v1/melt/bolt11": { failure: "proxy-page", when: "after" },
      },
    });

    await expect(payLightningInvoice(quote)).rejects.toMatchObject({
      inDoubt: true,
    });
    // The mint burned these coins, so none of them is spendable, and the
    // blanks that carry the change are kept.
    expect(spendable() + reservedTotal()).toBe(64);
    expect(reservedTotal()).toBeGreaterThanOrEqual(36);
    expect(meltRow()?.status).toBe("pending");
    expect(meltRow()?.meltOutputs).toBeDefined();

    fabric.setConditions({ httpFailures: {} });
    await reconcile();
    expect(meltRow()?.status).toBe("completed");
    expect(reservedTotal()).toBe(0);
    // 32 paid, 1 to the route; the unused reserve came back as change.
    expect(spendable()).toBe(64 - 33);
  });

  it("is released once the quote says unpaid, after a rate limit kept it from the mint", async () => {
    await fund(64);
    const quote = await quoteLightningWithdrawal({
      invoice: simInvoice(32),
      mintUrl: fabric.url,
    });
    fabric.setConditions({
      httpFailures: {
        "/v1/melt/bolt11": { failure: "rate-limited", when: "before" },
      },
    });

    await expect(payLightningInvoice(quote)).rejects.toMatchObject({
      inDoubt: true,
    });
    expect(meltRow()?.status).toBe("pending");

    fabric.setConditions({ httpFailures: {} });
    await reconcile();
    expect(meltRow()?.status).toBe("failed");
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(64);
  });
});

describe("a melt the mint is still paying", () => {
  // A 32 invoice with a 4 reserve, from 64 held; settled, the route costs 1.
  async function quoteWhileRouting(
    routing: "answered" | "gateway",
  ): Promise<Awaited<ReturnType<typeof quoteLightningWithdrawal>>> {
    fabric.setConditions({ meltFeeReserve: 4, meltActualFee: 1 });
    await fund(64);
    const quote = await quoteLightningWithdrawal({
      invoice: simInvoice(32),
      mintUrl: fabric.url,
    });
    fabric.setConditions({ meltRoutesSlowly: routing });
    return quote;
  }

  function expectHeldWithBlanks(): void {
    expect(spendable() + reservedTotal()).toBe(64);
    expect(reservedTotal()).toBeGreaterThanOrEqual(36);
    expect(meltRow()?.status).toBe("pending");
    expect(meltRow()?.meltOutputs).toBeDefined();
  }

  // NUT-05's 20005, a generic code with only the wording, and no code at all.
  it.each([20005, 11000, null])(
    "is held, not refused, when the retry after a gateway timeout meets 'quote is pending' (code %s)",
    async (code) => {
      const quote = await quoteWhileRouting("gateway");
      fabric.setConditions({ meltPendingCode: code });

      await expect(payLightningInvoice(quote)).rejects.toMatchObject({
        inDoubt: true,
      });
      expectHeldWithBlanks();

      // Still routing, so the quote decides nothing yet.
      fabric.setConditions({ meltRoutesSlowly: null });
      await reconcile();
      expectHeldWithBlanks();

      fabric.settlePendingMelts("paid");
      await reconcile();
      expect(meltRow()?.status).toBe("completed");
      expect(reservedTotal()).toBe(0);
      expect(spendable()).toBe(64 - 33);
    },
  );

  it("is not booked as paid when the mint answers 200 with the quote PENDING", async () => {
    const quote = await quoteWhileRouting("answered");

    await expect(payLightningInvoice(quote)).rejects.toMatchObject({
      inDoubt: true,
    });
    expectHeldWithBlanks();

    fabric.setConditions({ meltRoutesSlowly: null });
    fabric.settlePendingMelts("paid");
    await reconcile();
    expect(meltRow()?.status).toBe("completed");
    expect(reservedTotal()).toBe(0);
    // The change comes back from the blanks kept through the PENDING answer.
    expect(spendable()).toBe(64 - 33);
  });

  it("is released once a payment the mint answered PENDING fails", async () => {
    const quote = await quoteWhileRouting("answered");
    await expect(payLightningInvoice(quote)).rejects.toMatchObject({
      inDoubt: true,
    });

    fabric.setConditions({ meltRoutesSlowly: null });
    fabric.settlePendingMelts("failed");
    await reconcile();
    expect(meltRow()?.status).toBe("failed");
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(64);
  });
});

describe("a melt swap-down whose answer was lost", () => {
  it("credits both halves on replay, as the live path does", async () => {
    // 64 held as one coin, a 32 invoice with a 4 reserve: 28 over, enough to
    // break the coin up before the melt.
    fabric.setConditions({ meltFeeReserve: 4, meltActualFee: 1 });
    await fund(64);
    const quote = await quoteLightningWithdrawal({
      invoice: simInvoice(32),
      mintUrl: fabric.url,
    });
    fabric.setConditions({ swapResponseLost: true });
    await expect(payLightningInvoice(quote)).rejects.toBeDefined();
    fabric.setConditions({ swapResponseLost: false });
    expect(pendingPreviews()).toBe(1);

    await reconcile();

    // Every coin is the user's own and unlocked; none sits in a row as a
    // token "locked to their key".
    expect(pendingPreviews()).toBe(0);
    expect(spendable()).toBe(64);
    const swap = useWalletStore
      .getState()
      .history.find((t) => t.kind === "swap");
    expect(swap?.status).toBe("completed");
    expect(swap?.token).toBeUndefined();
  });
});

describe("removing a mint", () => {
  it("names every unit and open payment, then leaves the mint alone", async () => {
    await fund(16);
    fabric.setConditions({ depositUnpaid: true });
    await createLightningDeposit({ amount: 8, mintUrl: fabric.url });
    useWalletStore.getState().addProofs(fabric.url, "usd", [
      {
        id: "00ad268c4d1f5826",
        amount: 5,
        secret: "usd-coin",
        C: "02" + "ab".repeat(32),
        verified: true,
      },
    ]);

    expect(mintHoldings(fabric.url)).toEqual({
      held: [
        { unit: UNIT, amount: 16 },
        { unit: "usd", amount: 5 },
      ],
      pending: 1,
    });

    removeMint(fabric.url);
    const contacted: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      if (String(input).startsWith(fabric.url)) contacted.push(String(input));
      return inner(input as RequestInfo, init as RequestInit);
    }) as typeof globalThis.fetch;
    try {
      await reconcile();
    } finally {
      globalThis.fetch = inner;
    }

    expect(contacted).toEqual([]);
    expect(useWalletStore.getState().mints[fabric.url]).toBeUndefined();
    expect(depositRow()?.status).toBe("failed");
    expect(mintHoldings(fabric.url)).toEqual({ held: [], pending: 0 });
  });
});
