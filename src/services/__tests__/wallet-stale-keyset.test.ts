/**
 * @jest-environment node
 */
// A mint that rotated its keyset after this phone cached the list.
//
// Swaps are prepared offline against the cached snapshot, so the outputs are
// blinded to the old active keyset and the mint refuses them (NUT-02, 12002).
// The swap is atomic: nothing moved, and the inputs are as good as before.
// cashu-ts refreshes its snapshot and asks for the operation to be run again,
// so each staged swap runs once more on the new keyset rather than failing,
// sitting in doubt, or refusing coins that were never in question.
//
// Runs the real wallet service against the simulated mint.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { t } from "@i18n";
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
} from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  initWalletService,
  lockProofsForNutzap,
  payLightningInvoice,
  quoteLightningWithdrawal,
  receiveToken,
  reconcile,
  resetWalletService,
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
const RECIPIENT_P2PK = "02" + "11".repeat(32);

let world: World;
let fabric: MintFabric;

function spendable(): number {
  return (
    useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? []
  ).reduce((sum, p) => sum + p.amount, 0);
}

function reservedTotal(): number {
  return Object.values(useWalletStore.getState().reserved).reduce(
    (sum, entry) => sum + entry.proofs.reduce((s, p) => s + p.amount, 0),
    0,
  );
}

function rows(kind: string) {
  return useWalletStore.getState().history.filter((tx) => tx.kind === kind);
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

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  world = new World({ seed: 61, name: "wallet-stale-keyset" });
  fabric = new MintFabric(world, "https://stale.test");
  fabric.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  fabric.setConditions({ offline: false, latencyMs: 0 });
  useSettingsStore.setState({ internetEnabled: true, torEnabled: false });
  resetWalletService();
  // The NUT-13 cursor survives: the phrase does, so starting it over would
  // re-derive outputs the mint has already signed.
  const counters = useWalletStore.getState().counters;
  useWalletStore.getState().clearAll();
  useWalletStore.setState({ counters });
  expect(await initWalletService()).toBe(true);
  await addMint(fabric.url);
});

describe("a claim after the mint rotated", () => {
  it("is swapped on the new keyset, with one receipt", async () => {
    const token = await strangersToken(8);
    fabric.rotateKeyset();

    expect((await receiveToken(token)).outcome).toBe("swapped");

    expect(spendable()).toBe(8);
    expect(rows("receive").map((tx) => tx.status)).toEqual(["completed"]);
  });

  it("is refused in the wallet's own words when the keys cannot be refreshed, leaving the token claimable", async () => {
    const first = await strangersToken(8);
    const second = await strangersToken(4);
    fabric.rotateKeyset();
    expect((await receiveToken(first)).outcome).toBe("swapped");

    // cashu-ts refreshes a snapshot at most once a minute, so a second
    // rotation inside that window is one it declines to repair.
    fabric.rotateKeyset();
    await expect(receiveToken(second)).rejects.toMatchObject({
      code: "mint-error",
      message: t("wallet.svc.keyset_rotated"),
    });

    expect(rows("receive").map((tx) => tx.status)).toEqual(["completed"]);
    expect(
      useWalletStore
        .getState()
        .history.some((tx) => tx.swapPreview !== undefined),
    ).toBe(false);
    expect(spendable()).toBe(8);
  });
});

describe("a nutzap lock after the mint rotated", () => {
  it("locks on the new keyset rather than calling the payment in doubt", async () => {
    expect((await receiveToken(await strangersToken(16))).outcome).toBe(
      "swapped",
    );
    fabric.rotateKeyset();

    const { locked } = await lockProofsForNutzap({
      amount: 8,
      mintUrl: fabric.url,
      unit: UNIT,
      recipientPubkey: RECIPIENT_P2PK,
    });

    expect(locked.reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(8);
    expect(rows("nutzap-out")).toHaveLength(1);
    expect(reservedTotal()).toBe(0);
    expect(spendable()).toBe(8);
  });
});

describe("an offline receipt redeemed after the mint rotated", () => {
  it("is swapped on the next pass, never refused or left to replay", async () => {
    const token = await strangersToken(8);
    useSettingsStore.setState({ internetEnabled: false });
    try {
      expect((await receiveToken(token)).outcome).toBe("stored");
    } finally {
      useSettingsStore.setState({ internetEnabled: true });
    }
    fabric.rotateKeyset();

    // The automatic redeem prices from the cached keysets, so it meets the
    // rotation mid-swap.
    await reconcile();
    await reconcile();

    expect(spendable()).toBe(8);
    const coins =
      useWalletStore.getState().proofs[accountKey(fabric.url, UNIT)] ?? [];
    expect(coins.every((p) => p.verified === true)).toBe(true);
    expect(rows("swap").map((tx) => tx.status)).toEqual(["completed"]);
    expect(rows("receive").map((tx) => tx.status)).toEqual(["completed"]);
  });
});

describe("a Lightning payment after the mint rotated", () => {
  it("pays, breaking the coins up on the new keyset", async () => {
    expect((await receiveToken(await strangersToken(64))).outcome).toBe(
      "swapped",
    );
    const quote = await quoteLightningWithdrawal({
      invoice: simInvoice(32),
      mintUrl: fabric.url,
    });
    fabric.rotateKeyset();

    const paid = await payLightningInvoice(quote);

    expect(paid.paid).toBe(32);
    expect(spendable()).toBe(64 - 32 - paid.fee);
    expect(reservedTotal()).toBe(0);
    expect(
      useWalletStore
        .getState()
        .history.some((tx) => tx.swapPreview !== undefined),
    ).toBe(false);
  });
});
