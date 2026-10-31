// NUT-13 counters across phrase changes, restores and mints met late. A
// counter is the cursor a phrase's secrets derive from: one left ahead of the
// phrase puts its coins past the reach of a restore, and one left behind
// re-derives outputs the mint has signed (10002), which must cost a retry and
// never the coins. Also: a restore of the phrase in use reports nothing new.
//
// Runs the real wallet service against the simulated mint, which refuses a
// blinded message it has signed before.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { generateRecoveryPhrase } from "@core/payments/wallet-seed";
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
  claimLightningDeposit,
  createLightningDeposit,
  getRecoveryPhrase,
  initWalletService,
  receiveToken,
  resetWalletService,
  restoreFromRecoveryPhrase,
} from "../wallet-service";

jest.setTimeout(120_000);

const UNIT = "sat";

let world: World;
let fabric: MintFabric;

function spendable(): number {
  return (
    useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? []
  ).reduce((sum, p) => sum + p.amount, 0);
}

function pendingPreviews(): number {
  return useWalletStore
    .getState()
    .history.filter((t) => t.status === "pending" && t.swapPreview).length;
}

function activeKeysetId(): string {
  const cache = useWalletStore.getState().mints[fabric.url]?.keysetCache as
    { keysets: { id: string; active: boolean }[] } | undefined;
  const active = cache?.keysets.find((k) => k.active);
  if (active === undefined) throw new Error("no active keyset cached");
  return active.id;
}

async function fund(sats: number): Promise<void> {
  const deposit = await createLightningDeposit({
    amount: sats,
    mintUrl: fabric.url,
  });
  await claimLightningDeposit(fabric.url, UNIT, deposit.quoteId);
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

// A coin under the mint's real keyset that the mint never signed, with no
// witness, so nothing offline can tell it from a genuine one.
function forgedToken(): string {
  return getEncodedToken({
    mint: fabric.url,
    unit: UNIT,
    proofs: [
      {
        id: activeKeysetId(),
        amount: 8,
        secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        C: bytesToHex(
          secp256k1.getPublicKey(
            crypto.getRandomValues(new Uint8Array(32)),
            true,
          ),
        ),
      },
    ],
  } as unknown as Token);
}

// Another phone, or this one after a wipe that kept the phrase: the wallet's
// own records gone, the phrase and the mint's records intact.
async function freshPhoneSamePhrase(): Promise<void> {
  resetWalletService();
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 71, name: "wallet-counters" });
  fabric = new MintFabric(world, "https://counters.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  fabric.setConditions({ offline: false, latencyMs: 0 });
  await freshPhoneSamePhrase();
  await addMint(fabric.url);
});

describe("restoring a different phrase", () => {
  it("leaves the new phrase's coins where a later restore finds them", async () => {
    await fund(8);
    // The replaced phrase had been in use for a while.
    useWalletStore.getState().advanceCounter(activeKeysetId(), 240);

    const phrase = generateRecoveryPhrase();
    await restoreFromRecoveryPhrase({ phrase, mintUrls: [fabric.url] });
    await fund(16);

    await freshPhoneSamePhrase();
    await addMint(fabric.url);
    const restored = await restoreFromRecoveryPhrase({
      phrase,
      mintUrls: [fabric.url],
    });
    expect(restored.recovered[UNIT]).toBe(16);
  });
});

describe("restoring the phrase already in use", () => {
  it("reports and records nothing it already held", async () => {
    // A phrase with no history at the mint, so every coin it can find is
    // one this wallet holds.
    await restoreFromRecoveryPhrase({
      phrase: generateRecoveryPhrase(),
      mintUrls: [fabric.url],
    });
    useWalletStore.getState().clearAll();
    await addMint(fabric.url);
    await fund(16);
    const phrase = await getRecoveryPhrase();
    expect(phrase).not.toBeNull();

    const restored = await restoreFromRecoveryPhrase({
      phrase: phrase ?? "",
      mintUrls: [fabric.url],
    });

    expect(restored.recovered[UNIT] ?? 0).toBe(0);
    expect(restored.proofCount).toBe(0);
    expect(restored.alreadyHeld).toBeGreaterThan(0);
    expect(spendable()).toBe(16);
    // Only the deposit: no "Restored" credit for coins that were here.
    expect(
      useWalletStore.getState().history.filter((t) => t.kind === "receive"),
    ).toHaveLength(0);
  });
});

describe("a mint met after the phrase was used there elsewhere", () => {
  it("is caught up when added, so the next deposit is not refused", async () => {
    await fund(16);
    await freshPhoneSamePhrase();

    await addMint(fabric.url);
    await fund(8);

    expect(spendable()).toBe(8);
  });
});

describe("a claim whose outputs reuse a counter the mint has signed", () => {
  it("catches the counters up and claims, leaving nothing in doubt", async () => {
    await fund(16);
    useWalletStore.getState().resetCounters();

    const received = await receiveToken(await strangersToken(8));

    expect(received.outcome).toBe("swapped");
    expect(spendable()).toBe(24);
    expect(pendingPreviews()).toBe(0);
  });
});

describe("a claim the mint refuses outright", () => {
  it("is over: no preview is left for a replay to misread", async () => {
    await expect(receiveToken(forgedToken())).rejects.toMatchObject({
      code: "mint-error",
    });

    expect(pendingPreviews()).toBe(0);
    const row = useWalletStore
      .getState()
      .history.find((t) => t.kind === "receive");
    expect(row?.status).toBe("failed");
    expect(spendable()).toBe(0);
  });
});
