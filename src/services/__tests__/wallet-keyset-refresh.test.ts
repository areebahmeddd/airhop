/**
 * @jest-environment node
 */
// A token signed under a keyset this wallet has not fetched yet.
//
// A `cashuB` token carries a v2 keyset id as its first 8 bytes, which only the
// mint's keyset list expands, so after a mint rotates keysets the full decode
// fails until the list is refreshed. For a held mint the wallet fetches it and
// reads the token, says so when the mint is out of reach, and never contacts a
// mint the user has not added.

import { getEncodedToken, Mint, Wallet, type Token } from "@cashu/cashu-ts";
import { decodeToken } from "@core/payments/cashu";
import { t } from "@i18n";
import {
  bootstrapWalletStorage,
  selectKeysetRefs,
  useWalletStore,
  whenWalletHydrated,
} from "@store/wallet-store";
import { MintFabric } from "../../__tests__/simulation/harness/mint-fabric";
import { World } from "../../__tests__/simulation/harness/world";
import {
  addMint,
  fetchKeysetsForTokenText,
  initWalletService,
  receiveToken,
  resetWalletService,
} from "../wallet-service";

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

let world: World;
let held: MintFabric;
let stranger: MintFabric;

async function tokenFrom(fabric: MintFabric, sats: number): Promise<string> {
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

// What a rotation leaves behind: the mint is held, its keyset list is not.
function forgetCachedKeysets(url: string): void {
  const mints = useWalletStore.getState().mints;
  const record = mints[url];
  const cache = record.keysetCache as { keysets: unknown[] };
  useWalletStore.setState({
    mints: {
      ...mints,
      [url]: { ...record, keysetCache: { ...cache, keysets: [] } },
    },
  });
  // Drop the in-memory Wallet too, so nothing answers from it.
  resetWalletService();
}

function readable(token: string): boolean {
  return (
    decodeToken(token, selectKeysetRefs(useWalletStore.getState())) !== null
  );
}

beforeAll(async () => {
  await bootstrapWalletStorage();
  await whenWalletHydrated();
  expect(await initWalletService()).toBe(true);
  world = new World({ seed: 11, name: "wallet-keyset-refresh" });
  held = new MintFabric(world, "https://held.test", { keysetVersion: 1 });
  stranger = new MintFabric(world, "https://stranger.test", {
    keysetVersion: 1,
  });
  held.install();
  stranger.install();
});

afterAll(() => {
  world.close();
});

beforeEach(async () => {
  held.setConditions({ offline: false, latencyMs: 0 });
  useWalletStore.getState().clearAll();
  expect(await initWalletService()).toBe(true);
  await addMint(held.url);
});

describe("a token under a keyset the wallet has not fetched", () => {
  it("is read after fetching its mint's keysets, and received", async () => {
    const token = await tokenFrom(held, 16);
    forgetCachedKeysets(held.url);
    expect(readable(token)).toBe(false);

    const result = await receiveToken(token);

    expect(result.outcome).toBe("swapped");
    expect(result.amount).toBe(16);
    expect(readable(token)).toBe(true);
  });

  it("says the mint is out of reach rather than calling it unreadable", async () => {
    const token = await tokenFrom(held, 8);
    forgetCachedKeysets(held.url);
    held.setConditions({ offline: true });

    await expect(receiveToken(token)).rejects.toMatchObject({
      code: "offline",
      message: t("wallet.svc.keyset_unknown"),
    });
  });

  it("turns into a readable chat token once the keysets are fetched", async () => {
    const token = await tokenFrom(held, 4);
    forgetCachedKeysets(held.url);

    await fetchKeysetsForTokenText(`here you go ${token}`);

    expect(readable(token)).toBe(true);
  });

  it("does not put a wiped wallet's mint back when the fetch lands late", async () => {
    const token = await tokenFrom(held, 4);
    forgetCachedKeysets(held.url);
    held.setConditions({ latencyMs: 50 });

    const fetching = fetchKeysetsForTokenText(token);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // What the panic wipe does to the wallet service and store.
    resetWalletService();
    useWalletStore.getState().clearAll();
    await fetching;

    expect(useWalletStore.getState().mints).toEqual({});
  });

  it("never contacts a mint the user has not added", async () => {
    const token = await tokenFrom(stranger, 4);
    const fetch = jest.spyOn(globalThis, "fetch");

    await fetchKeysetsForTokenText(token);
    await expect(receiveToken(token)).rejects.toMatchObject({
      code: "no-mint",
    });

    const contacted = fetch.mock.calls.some(([input]) =>
      String(input).startsWith(stranger.url),
    );
    fetch.mockRestore();
    expect(contacted).toBe(false);
  });
});
